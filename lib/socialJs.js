'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const rest = require('./socialRest');

/**
 * The JavaScript stand-in for the native Discord Social SDK bridge.
 *
 * No macOS build of the Social SDK exists, so on darwin the launcher speaks to the same
 * HTTP lobby surface directly (see lib/socialRest.js, modelled on
 * `@minesa-org/mini-interaction`'s DiscordRestClient). It emits the same newline-JSON
 * protocol events the native binary would print, so lib/social.js treats both the same:
 *
 *   ready | auth | lobby_ready | channel_linked | channel_link_failed | chat | send_result | status
 *
 * The player authorizes once in their browser (PKCE, loopback redirect); the token is
 * cached beside the native bridge's own cache, so the approval is asked for once.
 */

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MESSAGE_PAGE_LIMIT = 50;
const TOKEN_EXPIRY_SLACK_MS = 60 * 1000;

function defaultOpenUrl(url) {
    try {
        // Electron main process. Tests inject their own opener instead.
        const { shell } = require('electron');
        void shell.openExternal(url);
    } catch {
        // Nowhere to open a browser; the authorize URL is on the auth event anyway.
    }
}

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readTokenCache(tokenCachePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function writeTokenCache(tokenCachePath, cache) {
    try {
        fs.mkdirSync(path.dirname(tokenCachePath), { recursive: true });
        fs.writeFileSync(tokenCachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    } catch {
        // An unwritable cache only costs the player a re-authorize next launch.
    }
}

function tokenIsUsable(cache) {
    return Boolean(
        cache &&
        cache.access_token &&
        Number(cache.expires_at) - TOKEN_EXPIRY_SLACK_MS > Date.now()
    );
}

function snowflakeGreaterThan(candidate, reference) {
    try {
        return BigInt(candidate) > BigInt(reference);
    } catch {
        return String(candidate) > String(reference);
    }
}

class JsSocialBridge extends EventEmitter {
    constructor({ openUrl } = {}) {
        super();
        this.openUrl = openUrl || defaultOpenUrl;
        this.server = null;
        this.serverPort = 0;
        this.pollTimer = null;
        this.pollLoopResolve = null;
        this.stopped = true;
        this.pendingAuth = null;
        this.resolveCallback = null;
        this.userToken = '';
        this.userId = '';
        this.currentLobbyId = '';
        this.lastMessageId = '0';
        this.awaitingSelf = null;
    }

    /** Protocol event shorthands, mirroring the native bridge's stdout lines. */
    emitStatus(text) {
        this.emit('status', { text: String(text).slice(0, 300) });
    }

    emitChat(username, message) {
        this.emit('chat', { username: String(username || 'Discord'), message: String(message || '') });
    }

    /**
     * Runs the whole flow: authorize -> identify -> create-or-join the lobby ->
     * link the configured channel -> poll for messages. An expired session recovers
     * in place -- refresh, then a fresh browser authorization -- instead of dead-ending;
     * two authorization attempts per start keep a bad token from looping forever.
     */
    async start(config) {
        this.stopped = false;
        this.emit('ready', {});

        // No secret configured means every launcher of this application should land in
        // the same lobby; a stable per-app value does that without extra setup.
        config.lobbySecret = String(config.lobbySecret || '').trim() || `launcher-${config.appId}`;
        config.scopes = Array.isArray(config.scopes) && config.scopes.length
            ? config.scopes
            : ['openid', 'identify', 'sdk.social_layer'];

        try {
            await this.ensureServer(config);
        } catch (error) {
            this.emitStatus(`Cannot listen for the Discord redirect: ${error.message}`);
            return;
        }

        let token = await this.ensureAuthorized(config);
        for (let attempt = 0; attempt < 2 && !this.stopped; attempt += 1) {
            if (!token) {
                return;
            }

            const outcome = await this.enterLobby(config, token);
            if (this.stopped) {
                return;
            }
            if (outcome === 'ok') {
                // Resolves when stopped, or when the session expires for good.
                if ((await this.pollLoop(config)) !== 'unauthorized') {
                    return;
                }
            } else if (outcome !== 'unauthorized') {
                return;
            }

            // 401 somewhere: refresh the cached token, else ask the browser again.
            this.emitStatus('Discord session expired. Re-authorizing...');
            token = (await this.refreshSession(config)) || (await this.authorizeInBrowser(config));
        }
    }

    stop() {
        this.stopped = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        // A stop between ticks leaves the poll promise pending; settle it so start()
        // -- and anyone awaiting it -- returns instead of hanging.
        if (this.pollLoopResolve) {
            this.pollLoopResolve('stopped');
            this.pollLoopResolve = null;
        }
        if (this.resolveCallback) {
            this.resolveCallback(null);
            this.resolveCallback = null;
        }
        this.pendingAuth = null;
        if (this.server) {
            this.server.close();
            this.server = null;
            this.serverPort = 0;
        }
    }

    /** Sends one chat message; resolves after Discord answers. */
    async sendChat(config, message) {
        const text = String(message || '').trim();
        if (!text || !this.userToken || !config.lobbyId) {
            return { ok: false, message: 'The lobby is not connected yet.' };
        }

        try {
            const sent = await rest.sendLobbyMessage(this.userToken, config.lobbyId, text, {
                apiBaseUrl: config.apiBaseUrl
            });
            // Skip our own copy when the poll sees it.
            this.awaitingSelf = sent && sent.id ? { id: sent.id, at: Date.now() } : null;
            return { ok: true };
        } catch (error) {
            this.emit('send_result', { ok: false, error: error.message });
            return { ok: false, message: error.message };
        }
    }

    /** Links a different channel on request (`link_channel` inbound message). */
    async linkChannel(config, channelId) {
        const id = String(channelId || '').trim();
        if (!id || !this.userToken || !config.lobbyId) {
            this.emit('channel_link_failed', { error: 'No channel or lobby to link.' });
            return;
        }

        try {
            await rest.linkChannelToLobby(this.userToken, config.lobbyId, id, { apiBaseUrl: config.apiBaseUrl });
            this.emit('channel_linked', {});
        } catch (error) {
            this.emit('channel_link_failed', { error: error.message });
        }
    }

    /** Binds the loopback redirect listener for the whole driver lifetime. */
    ensureServer(config) {
        if (this.server) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const server = http.createServer((request, response) => this.handleCallback(request, response));
            server.on('error', reject);
            // An ephemeral port: Discord matches loopback redirects by path, and two
            // launchers on one machine must not fight over a fixed port.
            server.listen(0, '127.0.0.1', () => {
                this.server = server;
                this.serverPort = server.address().port;
                resolve();
            });
            void config;
        });
    }

    handleCallback(request, response) {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');

        if (url.pathname !== '/callback') {
            response.statusCode = 404;
            response.end('Not found');
            return;
        }

        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        const error = url.searchParams.get('error') || '';
        response.statusCode = 200;
        response.end('<!DOCTYPE html><title>Dungeon Blitz: R</title><p>Discord authorization received. You can close this window.</p>');

        if (!this.pendingAuth || this.pendingAuth.state !== state) {
            this.emitStatus('Discord redirect did not match the pending authorization.');
            return;
        }

        const pending = this.pendingAuth;
        this.pendingAuth = null;
        pending.tokenUrl = this.pendingTokenUrl;
        if (error || !code) {
            this.emitStatus(`Discord authorization failed: ${error || 'no code'}.`);
            if (this.resolveCallback) {
                this.resolveCallback(null);
                this.resolveCallback = null;
            }
            return;
        }

        this.exchangeCode(pending, code);
    }

    async exchangeCode(pending, code) {
        try {
            const tokens = await rest.exchangeAuthorizationCode({
                clientId: pending.clientId,
                clientSecret: pending.clientSecret,
                code,
                codeVerifier: pending.codeVerifier,
                redirectUri: pending.redirectUri,
                tokenUrl: pending.tokenUrl
            });

            const cache = {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || '',
                expires_at: Date.now() + Number(tokens.expires_in || 0) * 1000,
                scope: tokens.scope || ''
            };
            writeTokenCache(pending.tokenCachePath, cache);
            this.userToken = cache.access_token;
            this.emitStatus('Discord authorization complete.');
            if (this.resolveCallback) {
                this.resolveCallback(cache.access_token);
                this.resolveCallback = null;
            }
        } catch (error) {
            this.emitStatus(`Discord token exchange failed: ${error.message}`);
            if (this.resolveCallback) {
                this.resolveCallback(null);
                this.resolveCallback = null;
            }
        }
    }

    /**
     * Resolves with a usable user token: from the cache, a refresh, or a fresh
     * browser authorization. Resolves null when authorization did not happen.
     */
    async ensureAuthorized(config) {
        let cache = readTokenCache(config.tokenCachePath);

        if (!tokenIsUsable(cache) && cache && cache.refresh_token) {
            try {
                const refreshed = await rest.refreshAccessToken({
                    clientId: config.appId,
                    clientSecret: config.clientSecret,
                    refreshToken: cache.refresh_token
                });
                cache = {
                    access_token: refreshed.access_token,
                    refresh_token: refreshed.refresh_token || cache.refresh_token,
                    expires_at: Date.now() + Number(refreshed.expires_in || 0) * 1000,
                    scope: refreshed.scope || cache.scope
                };
                writeTokenCache(config.tokenCachePath, cache);
            } catch {
                cache = null;
            }
        }

        if (tokenIsUsable(cache)) {
            this.userToken = cache.access_token;
            return cache.access_token;
        }

        return this.authorizeInBrowser(config);
    }

    /** Opens the player's browser and waits for the loopback redirect. */
    authorizeInBrowser(config) {
        const codeVerifier = base64url(crypto.randomBytes(32));
        const state = base64url(crypto.randomBytes(16));
        const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
        const redirectUri = `http://127.0.0.1:${this.serverPort}/callback`;

        const authorizeUrl = rest.buildAuthorizeUrl({
            clientId: config.appId,
            redirectUri,
            scopes: config.scopes,
            state,
            codeChallenge
        });

        // Discord matches loopback redirects by path; register
        // `http://127.0.0.1/callback` for the application in the developer portal.
        this.pendingTokenUrl = config.tokenUrl;
        this.pendingAuth = {
            clientId: config.appId,
            clientSecret: config.clientSecret,
            tokenCachePath: config.tokenCachePath,
            codeVerifier,
            state,
            redirectUri
        };
        this.emit('auth', { verificationUri: authorizeUrl, userCode: '' });
        this.emitStatus('Waiting for Discord authorization in your browser...');
        this.openUrl(authorizeUrl);

        return new Promise((resolve) => {
            this.resolveCallback = resolve;
        });
    }

    /**
     * Resolves the player, then creates or rejoins the lobby and links the channel.
     * Returns 'ok', 'unauthorized' (worth a refresh/re-auth), or 'failed' (dead end).
     */
    async enterLobby(config, token) {
        let me = null;
        try {
            me = await rest.getCurrentUser(token, { apiBaseUrl: config.apiBaseUrl });
        } catch (error) {
            this.emitStatus(`Discord did not accept the session: ${error.message}`);
            return error.status === 401 || error.status === 403 ? 'unauthorized' : 'failed';
        }
        if (this.stopped) {
            return 'failed';
        }

        this.userId = me.id;

        const joined = await this.joinOrCreateLobby(config, token);
        if (joined === 'unauthorized') {
            return 'unauthorized';
        }
        if (!joined) {
            return 'failed';
        }

        await this.linkConfiguredChannel(config, token, joined);
        return 'ok';
    }

    async joinOrCreateLobby(config, token) {
        try {
            const lobby = await rest.createOrJoinLobby(token, {
                secret: config.lobbySecret,
                apiBaseUrl: config.apiBaseUrl
            });
            config.lobbyId = lobby.id;
            this.currentLobbyId = lobby.id;
            this.emit('lobby_ready', { lobbyId: lobby.id, userId: this.userId });
            this.emitStatus('Lobby chat connected.');
            return lobby;
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                return 'unauthorized';
            }
            this.emitStatus(`The Discord lobby could not be joined: ${error.message}`);
            return null;
        }
    }

    async linkConfiguredChannel(config, token, lobby) {
        if (!config.enableChannelLinking || !config.channelId) {
            return;
        }
        // Linked-channel calls are capped hard while the app is unapproved
        // (20 per 2 hours), so only ever link when the lobby's channel differs.
        if (lobby.linked_channel && lobby.linked_channel.id === config.channelId) {
            this.emit('channel_linked', {});
            return;
        }

        try {
            await rest.linkChannelToLobby(token, config.lobbyId, config.channelId, { apiBaseUrl: config.apiBaseUrl });
            this.emit('channel_linked', {});
        } catch (error) {
            // Lobby chat still works without a linked channel.
            this.emit('channel_link_failed', { error: error.message });
        }
    }

    /**
     * Polls the lobby for new messages until stopped. Transient errors never end the
     * loop; an unrecoverable 401 ends it with 'unauthorized' so start() can re-auth.
     */
    pollLoop(config) {
        return new Promise((resolve) => {
            this.pollLoopResolve = resolve;
            const tick = async () => {
                if (this.stopped) {
                    resolve('stopped');
                    return;
                }

                try {
                    const messages = await rest.getLobbyMessages(this.userToken, config.lobbyId, {
                        limit: MESSAGE_PAGE_LIMIT,
                        apiBaseUrl: config.apiBaseUrl
                    });

                    for (const message of messages || []) {
                        this.deliverMessage(message);
                    }
                } catch (error) {
                    if (error.status === 401) {
                        resolve('unauthorized');
                        return;
                    }
                    this.emitStatus(`Lobby poll failed: ${error.message}`);
                }

                if (!this.stopped) {
                    this.pollTimer = setTimeout(tick, config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
                    if (typeof this.pollTimer.unref === 'function') {
                        this.pollTimer.unref();
                    }
                } else {
                    resolve('stopped');
                }
            };

            tick();
        });
    }

    /** One silent token refresh on a 401; the poll loop continues when it succeeds. */
    async refreshSession(config) {
        const cache = readTokenCache(config.tokenCachePath);
        if (!cache || !cache.refresh_token) {
            return false;
        }
        try {
            const refreshed = await rest.refreshAccessToken({
                clientId: config.appId,
                clientSecret: config.clientSecret,
                refreshToken: cache.refresh_token
            });
            const next = {
                access_token: refreshed.access_token,
                refresh_token: refreshed.refresh_token || cache.refresh_token,
                expires_at: Date.now() + Number(refreshed.expires_in || 0) * 1000,
                scope: refreshed.scope || cache.scope
            };
            writeTokenCache(config.tokenCachePath, next);
            this.userToken = next.access_token;
            return true;
        } catch {
            return false;
        }
    }

    deliverMessage(message) {
        if (!message || !message.id) {
            return;
        }
        // The send path already surfaced our own copy.
        if (this.awaitingSelf && this.awaitingSelf.id === message.id) {
            this.awaitingSelf = null;
            this.lastMessageId = message.id;
            return;
        }
        if (message.author && message.author.id === this.userId) {
            this.lastMessageId = message.id;
            return;
        }
        if (!snowflakeGreaterThan(message.id, this.lastMessageId)) {
            return;
        }
        this.lastMessageId = message.id;

        const author = message.author || {};
        const username =
            (message.lobby_member && message.lobby_member.additional_name) ||
            author.global_name ||
            author.username ||
            'Discord';
        this.emitChat(username, message.content);
    }
}

module.exports = { JsSocialBridge, DEFAULT_POLL_INTERVAL_MS };

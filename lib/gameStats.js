'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

/**
 * Asks the game server to write this player's Discord Game Stats widget profile.
 *
 * Discord renders the widget from an *Application Identity Profile*, and the only writer
 * for one is `PATCH /applications/{app}/users/{user}/identities/{player}/profile` with the
 * application's **bot token**. A bot token shipped inside a desktop app is a token anyone
 * can read out of the bundle, so the write stays on the server; this side only asks for it
 * and reports what came back:
 *
 *   POST /api/discord/stats/sync   { token }   -> { ok, written, username, updatedAt, fields }
 *
 * The failure is worded from the status code, because each one names a different missing
 * half: 404 is a server without the route at all, 401/403 a launcher the server will not
 * vouch for, and `ok: false` with `reason: 'discord-not-linked'` a player whose Discord
 * account is not linked to their game account yet -- which is what the widget needs before
 * anything can be written for them. Discord creates the profile record on the first write,
 * so a widget that has never been written is empty for everyone who looks at it, the
 * player and their friends alike.
 */

const REQUEST_TIMEOUT_MS = 10000;

class GameStats extends EventEmitter {
    constructor() {
        super();
        this.serverUrl = '';
        this.getLauncherToken = null;
        this.syncing = false;
        this.state = {
            running: false,
            state: 'idle',
            written: false,
            username: '',
            updatedAt: 0,
            lastError: ''
        };
    }

    snapshot() {
        return { ...this.state };
    }

    patch(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('state', this.snapshot());
    }

    /**
     * @param {{ serverUrl?: string, getLauncherToken?: () => string }} [options] The server to
     *   ask, and the device token it knows this player by.
     */
    start({ serverUrl = '', getLauncherToken } = {}) {
        const base = normalizeBaseUrl(serverUrl);
        if (!base) {
            this.patch({ running: false, state: 'idle', lastError: '' });
            return { started: false, reason: 'no-server' };
        }

        this.serverUrl = base;
        this.getLauncherToken = typeof getLauncherToken === 'function' ? getLauncherToken : null;
        // A new session starts from "nothing written yet": a previous session's result would
        // otherwise be reported as if it belonged to the server now selected.
        this.patch({ running: true, state: 'idle', written: false, username: '', updatedAt: 0, lastError: '' });
        return { started: true };
    }

    stop() {
        this.serverUrl = '';
        this.getLauncherToken = null;
        this.syncing = false;
        this.patch({ running: false, state: 'idle', written: false, username: '', updatedAt: 0, lastError: '' });
    }

    /**
     * Asks the server to write (or refresh) the player's widget profile. Safe to call before
     * the player has linked an account: the server answers what is missing.
     */
    async sync() {
        if (this.syncing) {
            return { ok: false, reason: 'busy' };
        }
        if (!this.serverUrl) {
            this.patch({ state: 'idle', lastError: 'The launcher is not attached to a game session yet.' });
            return { ok: false, reason: 'no-server' };
        }

        this.syncing = true;
        this.patch({ state: 'syncing', lastError: '' });

        const token = this.getLauncherToken ? this.getLauncherToken() : '';
        const result = await requestJson(
            'POST',
            `${this.serverUrl}/api/discord/stats/sync`,
            { token: token || undefined },
            REQUEST_TIMEOUT_MS
        );
        this.syncing = false;

        if (!result.ok) {
            // The server could not vouch for this launcher, or the game account behind it:
            // opening the game is what registers the caller, so that is the instruction.
            if (result.status === 401 || result.status === 403) {
                this.patch({
                    state: 'error',
                    written: false,
                    lastError: 'The server does not recognise this launcher yet. Open the game once, then try again.'
                });
                return this.snapshot();
            }
            // 409 is the linked-account half missing, answered as an HTTP error rather than a
            // body by a server that prefers that; both spellings mean the same thing.
            if (result.status === 409) {
                this.markUnlinked();
                return this.snapshot();
            }
            if (result.status === 404) {
                this.patch({
                    state: 'unsupported',
                    written: false,
                    lastError: 'This server cannot write Discord widget stats yet.'
                });
                return this.snapshot();
            }
            this.patch({
                state: 'error',
                written: false,
                lastError: `The widget profile could not be written (${result.status || result.error || 'no answer'}).`
            });
            return this.snapshot();
        }

        const body = result.body || {};
        if (body.ok !== true) {
            const reason = String(body.reason || '').trim();
            const message = String(body.message || '').trim();
            if (reason === 'discord-not-linked') {
                this.markUnlinked();
                return this.snapshot();
            }
            this.patch({
                state: 'error',
                written: false,
                lastError: message || `The server would not write the widget profile (${reason || 'no reason given'}).`
            });
            return this.snapshot();
        }

        this.patch({
            state: 'written',
            written: true,
            username: String(body.username || '').trim(),
            // A server that answers without a timestamp still just wrote it.
            updatedAt: Number(body.updatedAt) || Date.now(),
            lastError: ''
        });
        return this.snapshot();
    }

    markUnlinked() {
        this.patch({
            state: 'unlinked',
            written: false,
            lastError: 'Sign in with Discord in the game so the widget has an account to write.'
        });
    }
}

function normalizeBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }
        if (parsed.username || parsed.password) {
            return '';
        }
        // The route is appended, so a trailing slash would double up.
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

/** A tiny JSON request helper: Electron 11's Node has no global fetch. */
function requestJson(method, url, body, timeoutMs) {
    return new Promise((resolve) => {
        let request = null;
        let payload = null;
        try {
            const parsed = new URL(url);
            const client = parsed.protocol === 'https:' ? https : http;
            payload = body === null || body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

            request = client.request(
                parsed,
                {
                    method,
                    headers: payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
                        : { Accept: 'application/json' },
                    timeout: timeoutMs
                },
                (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsedBody = null;
                        try {
                            parsedBody = text ? JSON.parse(text) : null;
                        } catch {
                            parsedBody = null;
                        }

                        const ok = response.statusCode >= 200 && response.statusCode < 300;
                        resolve({
                            ok: ok && parsedBody !== null,
                            status: response.statusCode,
                            body: parsedBody,
                            error: ok && parsedBody === null ? 'invalid-json' : ''
                        });
                    });
                }
            );
        } catch (error) {
            resolve({ ok: false, status: 0, body: null, error: String((error && error.message) || error) });
            return;
        }

        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', (error) =>
            resolve({ ok: false, status: 0, body: null, error: String((error && error.message) || error) })
        );
        request.end(payload || undefined);
    });
}

module.exports = { GameStats, REQUEST_TIMEOUT_MS, normalizeBaseUrl, requestJson };

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { LAUNCHER_ROOT, SERVER_ROOT, readJson } = require('./config');
const { JsSocialBridge } = require('./socialJs');

// A packaged launcher has no server checkout next to it, so it carries its own copy of
// the Social SDK settings; a checkout still prefers the server's file so both sides of
// the bridge agree on the app and channel.
const SOCIAL_CONFIG_PATH = path.join(LAUNCHER_ROOT, 'social.config.json');
const SERVER_SOCIAL_CONFIG_PATH = path.join(SERVER_ROOT, 'discord-social-bridge.config.json');

/**
 * Talks to the same native Discord Social SDK bridge the multiplayer server uses
 * (`src/server/native_bridge`), over the same newline-delimited JSON protocol:
 *
 *   launcher -> bridge : initialize | outbound_chat | use_lobby | link_channel
 *   bridge -> launcher : ready | auth | status | chat | lobby_ready |
 *                        channel_linked | channel_link_failed | send_result
 *
 * Running it from the launcher rather than the server is what makes lobby chat a
 * per-player thing: each player authorizes their own Discord account and joins the lobby
 * as themselves. The token is cached, so that approval is asked for once.
 */

const EXECUTABLE_NAME = process.platform === 'win32' ? 'discord_social_bridge.exe' : 'discord_social_bridge';

// Where a packaged launcher carries the bridge, and where a checkout builds it. The
// packaged copy is an extra resource rather than an asar entry, because the operating
// system cannot execute a file from inside the archive.
const EXECUTABLE_CANDIDATES = [];
if (process.resourcesPath) {
    EXECUTABLE_CANDIDATES.push(path.join(process.resourcesPath, 'vendor', 'social', process.platform, EXECUTABLE_NAME));
}
EXECUTABLE_CANDIDATES.push(
    path.join(LAUNCHER_ROOT, 'vendor', 'social', process.platform, EXECUTABLE_NAME),
    path.join(SERVER_ROOT, 'native_bridge', 'build', EXECUTABLE_NAME),
    path.join(SERVER_ROOT, 'native_bridge', 'build', 'Release', EXECUTABLE_NAME)
);

function resolveExecutablePath(configuredPath) {
    const configured = String(configuredPath || '').trim();
    const candidates = configured ? [configured, ...EXECUTABLE_CANDIDATES] : EXECUTABLE_CANDIDATES;

    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Try the next location.
        }
    }

    return '';
}

class SocialBridge extends EventEmitter {
    constructor({ tokenCachePath, openUrl }) {
        super();
        this.tokenCachePath = tokenCachePath;
        this.openUrl = openUrl;
        this.child = null;
        this.jsBridge = null;
        this.executablePath = '';
        this.state = {
            available: false,
            running: false,
            ready: false,
            lobbyReady: false,
            lobbyId: '',
            userId: '',
            username: '',
            auth: null,
            lastStatus: ''
        };
        this.messages = [];
    }

    /** The bridge is optional: the JS driver covers platforms without a native binary. */
    isAvailable() {
        if (this.readConfig().jsBridge !== false) {
            return true;
        }
        return Boolean(resolveExecutablePath(this.readConfig().executablePath));
    }

    readConfig() {
        const base = readJson(SOCIAL_CONFIG_PATH, {});
        const fromServer = readJson(SERVER_SOCIAL_CONFIG_PATH, null);
        if (!fromServer) {
            return base;
        }

        // Only the fields both sides share are taken over; the server's own `enabled`
        // and relay-mode switches govern the server, not this launcher.
        return {
            ...base,
            appId: fromServer.appId || base.appId,
            channelId: fromServer.channelId || base.channelId,
            lobbySecret: fromServer.lobbySecret || base.lobbySecret,
            enableChannelLinking: fromServer.enableChannelLinking === true,
            executablePath: fromServer.executablePath || base.executablePath
        };
    }

    snapshot() {
        return {
            ...this.state,
            available: this.isAvailable(),
            executablePath: this.executablePath,
            messages: this.messages.slice(-200)
        };
    }

    patchState(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('state', this.snapshot());
    }

    appendMessage(message) {
        this.messages.push(message);
        if (this.messages.length > 500) {
            this.messages.splice(0, this.messages.length - 500);
        }
        this.emit('message', message);
    }

    start() {
        if (this.child || this.jsBridge) {
            return { started: true };
        }

        const config = this.readConfig();
        const executablePath = resolveExecutablePath(config.executablePath);
        if (!executablePath && config.jsBridge !== false) {
            return this.startJsBridge(config);
        }
        if (!executablePath) {
            this.patchState({ available: false, lastStatus: 'Native Social SDK bridge binary not found.' });
            return { started: false, reason: 'missing-binary' };
        }

        const appId = String(config.appId || '').trim();
        if (!appId) {
            this.patchState({ lastStatus: 'discord-social-bridge.config.json has no appId.' });
            return { started: false, reason: 'missing-app-id' };
        }

        this.executablePath = executablePath;

        try {
            this.child = spawn(executablePath, [], {
                cwd: path.dirname(executablePath),
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            this.child = null;
            this.patchState({ running: false, lastStatus: String((error && error.message) || error) });
            return { started: false, reason: 'spawn-failed' };
        }

        readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
        this.child.stderr.on('data', (chunk) => {
            const text = String(chunk).trim();
            if (text) {
                this.patchState({ lastStatus: text.slice(0, 300) });
            }
        });

        this.child.on('exit', (code) => {
            this.child = null;
            this.patchState({
                running: false,
                ready: false,
                lobbyReady: false,
                auth: null,
                lastStatus: `Native bridge exited (code ${code ?? 'null'}).`
            });
        });

        this.patchState({ running: true, available: true, lastStatus: 'Native bridge starting...' });

        this.send({
            type: 'initialize',
            appId,
            channelId: String(config.channelId || '').trim(),
            lobbySecret: String(config.lobbySecret || '').trim(),
            // Browser PKCE, not the device flow. The device path needs the Discord
            // application to allow device authorization, and when it does not the SDK
            // aborts the whole process on a failed `CanAuthorizeDevice` check rather than
            // returning an error. The browser flow needs no such capability: the player
            // approves in their browser and the SDK takes the redirect.
            deviceFlow: config.deviceFlow === true,
            gameWindowPid: 0,
            enableChannelLinking: config.enableChannelLinking === true,
            tokenCachePath: this.tokenCachePath
        });

        return { started: true };
    }

    /**
     * Starts the JavaScript driver: same protocol events as the native binary, but
     * spoken straight to Discord's HTTP lobby API from this process. No macOS build of
     * the Social SDK exists, so this is what darwin ships with.
     */
    startJsBridge(config) {
        const jsBridge = new JsSocialBridge({ openUrl: this.openUrl });
        // The driver emits the exact protocol events the native binary prints, so the
        // existing handleLine switch drives the state for both.
        for (const type of ['ready', 'auth', 'lobby_ready', 'channel_linked', 'channel_link_failed', 'chat', 'send_result', 'status']) {
            jsBridge.on(type, (payload) => this.handlePayload({ type, ...payload }));
        }
        jsBridge.on('lobby_ready', () => {
            this.patchState({ running: true, available: true });
        });

        this.jsBridge = jsBridge;
        this.patchState({ running: true, available: true, lastStatus: 'JavaScript social bridge starting...' });

        void jsBridge.start({
            appId: String(config.appId || '').trim(),
            channelId: String(config.channelId || '').trim(),
            lobbySecret: String(config.lobbySecret || '').trim(),
            enableChannelLinking: config.enableChannelLinking === true,
            clientSecret: String(config.clientSecret || '').trim(),
            // Authorization goes through the Discord client's own consent dialog unless
            // that is turned off; the browser flow is opt-in, never a surprise.
            discordIpc: config.discordIpc !== false,
            browserFallback: config.browserFallback === true,
            scopes: Array.isArray(config.scopes) && config.scopes.length ? config.scopes : ['openid', 'identify', 'sdk.social_layer'],
            pollIntervalMs: Number(config.pollIntervalMs) || undefined,
            apiBaseUrl: String(config.apiBaseUrl || '').trim() || undefined,
            tokenCachePath: this.tokenCachePath
        });

        return { started: true };
    }

    stop() {
        if (this.jsBridge) {
            this.jsBridge.stop();
            this.jsBridge = null;
        }
        if (!this.child) {
            this.patchState({ running: false, ready: false, lobbyReady: false, auth: null });
            return;
        }
        try {
            this.child.kill();
        } catch {
            // A failed kill only leaves a stray child behind; nothing to recover here.
        }
        this.child = null;
        this.patchState({ running: false, ready: false, lobbyReady: false, auth: null });
    }

    send(payload) {
        if (this.jsBridge) {
            return this.sendToJsBridge(payload);
        }
        if (!this.child || !this.child.stdin.writable) {
            return false;
        }
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
        return true;
    }

    sendToJsBridge(payload) {
        const config = this.readConfig();
        const driverConfig = {
            lobbyId: this.jsBridge.currentLobbyId,
            apiBaseUrl: String(config.apiBaseUrl || '').trim() || undefined
        };

        if (payload.type === 'outbound_chat') {
            void this.jsBridge.sendChat(driverConfig, payload.message).then((result) => {
                if (result && result.ok) {
                    this.emit('send_result', { ok: true });
                }
            });
            return true;
        }
        if (payload.type === 'link_channel') {
            void this.jsBridge.linkChannel(driverConfig, payload.channelId);
            return true;
        }
        return true;
    }

    sendChat(senderName, message) {
        const text = String(message || '').trim();
        if (!text) {
            return { ok: false, message: 'Refusing to send an empty message.' };
        }
        if (!this.state.lobbyReady) {
            return { ok: false, message: 'The lobby is not ready yet.' };
        }

        const name = String(senderName || '').trim() || 'Player';
        if (!this.send({ type: 'outbound_chat', senderName: name, message: text })) {
            return { ok: false, message: 'The native bridge is not running.' };
        }

        this.appendMessage({ from: 'self', username: name, message: text, at: Date.now() });
        return { ok: true };
    }

    handleLine(line) {
        const trimmed = String(line || '').trim();
        if (!trimmed) {
            return;
        }

        let payload = null;
        try {
            payload = JSON.parse(trimmed);
        } catch {
            this.patchState({ lastStatus: trimmed.slice(0, 300) });
            return;
        }

        this.handlePayload(payload);
    }

    /** One parsed protocol message -- a native stdout line, or a JS driver event. */
    handlePayload(payload) {
        switch (payload && payload.type) {
            case 'ready':
                this.patchState({ ready: true, lastStatus: 'Social bridge ready.' });
                break;
            case 'auth':
                this.patchState({
                    auth: {
                        verificationUri: String(payload.verificationUri || ''),
                        userCode: String(payload.userCode || '')
                    },
                    lastStatus: 'Waiting for Discord authorization.'
                });
                break;
            case 'lobby_ready':
                this.patchState({
                    lobbyReady: true,
                    auth: null,
                    lobbyId: String(payload.lobbyId || ''),
                    userId: String(payload.userId || ''),
                    // The Discord account behind the lobby: the launcher shows it instead of
                    // the sign-in button once it is known.
                    username: String(payload.username || ''),
                    lastStatus: 'Lobby chat connected.'
                });
                break;
            case 'channel_linked':
                this.patchState({ lastStatus: 'Discord channel linked to the lobby.' });
                break;
            case 'channel_link_failed':
            case 'channel_link_conflict':
                this.patchState({
                    lastStatus: `Channel link failed: ${payload.summary || payload.error || payload.errorCode || 'unknown error'}`
                });
                break;
            case 'chat':
                this.appendMessage({
                    from: 'discord',
                    username: String(payload.username || 'Discord'),
                    message: String(payload.message || ''),
                    at: Date.now()
                });
                break;
            case 'send_result':
                if (payload.ok !== true) {
                    this.patchState({ lastStatus: `Message was not sent: ${payload.error || 'unknown error'}` });
                }
                break;
            case 'status':
                this.patchState({ lastStatus: String(payload.text || '').slice(0, 300) });
                break;
            default:
                break;
        }
    }
}

module.exports = {
    EXECUTABLE_CANDIDATES,
    SOCIAL_CONFIG_PATH,
    SocialBridge,
    resolveExecutablePath
};

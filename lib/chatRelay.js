'use strict';

const http = require('http');
const { URL } = require('url');
const { EventEmitter } = require('events');

/**
 * Mirrors chat between the game and the player's Discord lobby, for as long as the game
 * window is open.
 *
 * Flash chat cannot be read from the launcher, and the server's own relay needs either the
 * native Discord Social SDK (which has no macOS build) or a bot token. So the game server
 * publishes the player's own public chat lines on a small HTTP feed, and takes lines back
 * for printing in-game:
 *
 *   GET  /api/chat/outbound?since=<cursor>[&lobby=<id>]
 *                                            -> { cursor, messages: [{ senderName, message }] }
 *   POST /api/chat/inbound                  -> prints "[Discord] name: message" in game
 *
 * Only the local player's own words come down the feed, so a line is mirrored exactly once
 * -- by its author's launcher -- instead of once per player in the room. `lobby` is the
 * Discord lobby the bridge is sitting in; the server leaves the posting to the launcher
 * while that poll keeps saying so.
 *
 * 404 is two different things here, and the reply says which: `{"reason":"no-game-session"}`
 * is the feed working with no session behind this caller yet -- the game window is still
 * loading, or the character has not spawned -- so it is retried soon rather than parked. A
 * 404 with any other body is a server that has no such feed at all, which will not start
 * being able to mid-session, so the relay says so once instead of polling forever.
 */

const POLL_INTERVAL_MS = 2500;
const REQUEST_TIMEOUT_MS = 8000;
// A server that cannot do this will not start being able to mid-session; one retry much
// later covers a deployment landing while the launcher is open.
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
// The feed exists but has no game session behind the caller yet: the game window is
// still loading, or the character has not spawned. That fixes itself, so retry soon.
const NO_SESSION_RETRY_MS = 15 * 1000;
const MAX_PENDING = 50;

class ChatRelay extends EventEmitter {
    /**
     * @param {{ social: { snapshot: Function, sendChat: Function, on: Function } }} options
     */
    constructor({ social }) {
        super();
        this.social = social;
        this.serverUrl = '';
        this.cursor = null;
        // The highest seq ever taken off the feed, so a retry that arrives before the
        // cursor moved can never be mirrored twice.
        this.lastSeq = 0;
        this.pending = new Map();
        this.pollTimer = null;
        this.running = false;
        this.supported = null;
        this.state = {
            running: false,
            supported: null,
            relayed: 0,
            received: 0,
            lastRelayed: '',
            lastError: ''
        };

        // A line from the player's lobby belongs in their game chat.
        if (this.social && typeof this.social.on === 'function') {
            this.social.on('chat', (payload) => void this.deliverInbound(payload));
        }
    }

    snapshot() {
        return { ...this.state };
    }

    patch(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('state', this.snapshot());
    }

    isRunning() {
        return this.running;
    }

    start({ serverUrl = '' } = {}) {
        const base = normalizeBaseUrl(serverUrl);
        if (!base) {
            this.patch({ running: false, supported: false, lastError: 'No server to mirror chat with.' });
            return { started: false, reason: 'no-server' };
        }

        if (this.running && this.serverUrl === base) {
            return { started: true };
        }

        this.stop();

        this.serverUrl = base;
        this.cursor = null;
        this.lastSeq = 0;
        this.pending.clear();
        this.running = true;
        this.supported = null;
        this.patch({ running: true, supported: null, lastError: '' });

        this.schedule(0);
        return { started: true };
    }

    stop() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.running = false;
        this.pending.clear();
        this.cursor = null;
        this.patch({ running: false });
    }

    schedule(delayMs) {
        if (!this.running) {
            return;
        }
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.poll();
        }, delayMs);
        if (typeof this.pollTimer.unref === 'function') {
            this.pollTimer.unref();
        }
    }

    async poll() {
        if (!this.running) {
            return;
        }

        // The lobby has to be up before a message can be mirrored; until then the last
        // pulled batch stays queued rather than being dropped.
        if (this.isLobbyReady()) {
            await this.flush();
        }

        const params = [];
        if (this.cursor !== null) {
            params.push(`since=${encodeURIComponent(this.cursor)}`);
        }
        // With the channel-linked lobby up, the server leaves this player's lines to us
        // instead of posting them itself -- for as long as these polls keep saying so.
        const linkedLobbyId = this.linkedLobbyId();
        if (linkedLobbyId) {
            params.push(`lobby=${encodeURIComponent(linkedLobbyId)}`);
        }
        const query = params.length ? `?${params.join('&')}` : '';
        const result = await requestJson('GET', `${this.serverUrl}/api/chat/outbound${query}`, null, REQUEST_TIMEOUT_MS);

        if (!result.ok) {
            // 404 has two meanings: a server without the feed at all, and the feed's own
            // "no game session behind this caller yet" (`no-game-session`). The first
            // never fixes itself mid-session; the second does, the moment the character
            // spawns, so it retries soon instead of being parked for ten minutes -- which
            // is how the window used to end up stuck on "server has no chat feed" for a
            // player whose game was actually fine.
            const noSessionYet =
                result.status === 404 &&
                result.body &&
                result.body.reason === 'no-game-session';
            if (noSessionYet) {
                this.supported = null;
                this.patch({
                    supported: null,
                    lastError: 'Waiting for the game session to come up...'
                });
                this.schedule(NO_SESSION_RETRY_MS);
                return;
            }

            this.supported = false;
            this.patch({
                supported: false,
                lastError:
                    result.status === 404
                        ? 'This server does not mirror game chat to Discord yet.'
                        : `Chat feed unreachable (${result.status || result.error || 'no answer'}).`
            });
            this.schedule(UNSUPPORTED_RETRY_MS);
            return;
        }

        if (this.supported !== true) {
            this.supported = true;
            this.patch({ supported: true, lastError: '' });
        }

        const messages = Array.isArray(result.body && result.body.messages) ? result.body.messages : [];
        const nextCursor = Number(result.body && result.body.cursor);

        // A cursor of `null` on the first poll means "start here": the server hands back
        // its head without any messages. If it did send some, they are queued as usual.
        if (this.cursor === null && Number.isFinite(nextCursor)) {
            this.cursor = nextCursor;
        }

        for (const message of messages) {
            const seq = Number(message && message.seq);
            const text = String((message && message.message) || '').trim();
            if (!Number.isFinite(seq) || !text || seq <= this.lastSeq) {
                continue;
            }
            this.lastSeq = seq;
            this.pending.set(seq, {
                seq,
                senderName: String((message && message.senderName) || '').trim() || 'Player',
                message: text
            });
            while (this.pending.size > MAX_PENDING) {
                this.pending.delete([...this.pending.keys()].sort((a, b) => a - b)[0]);
            }
        }

        // The cursor follows the server even when a send is still queued: the queue is what
        // retries it, so moving on cannot lose it -- and staying put would re-fetch it.
        if (Number.isFinite(nextCursor)) {
            this.cursor = nextCursor;
        }

        if (this.pending.size > 0 && this.isLobbyReady()) {
            await this.flush();
        }

        this.schedule(POLL_INTERVAL_MS);
    }

    linkedLobbyId() {
        const snapshot = this.social && typeof this.social.snapshot === 'function' ? this.social.snapshot() : null;
        return snapshot && snapshot.lobbyReady && snapshot.linkedLobby ? String(snapshot.lobbyId || '') : '';
    }

    isLobbyReady() {
        const snapshot = this.social && typeof this.social.snapshot === 'function' ? this.social.snapshot() : null;
        return Boolean(snapshot && snapshot.lobbyReady);
    }

    /** Sends queued game chat to the lobby, oldest first, stopping at the first failure. */
    async flush() {
        if (!this.social || typeof this.social.sendChat !== 'function') {
            return;
        }

        const queued = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
        for (const entry of queued) {
            const result = this.social.sendChat(entry.senderName, entry.message);
            if (!result || result.ok !== true) {
                this.patch({ lastError: (result && result.message) || 'The lobby refused the message.' });
                return;
            }

            this.pending.delete(entry.seq);
            this.state.relayed += 1;
            this.state.lastRelayed = entry.message.slice(0, 120);
            this.patch({ lastError: '' });
        }
    }

    /** Prints a lobby message in the game, through the server the player is on. */
    async deliverInbound(payload) {
        if (!this.running || !this.serverUrl) {
            return;
        }

        const message = String((payload && payload.message) || '').trim();
        if (!message) {
            return;
        }

        const senderName = String((payload && payload.username) || '').trim() || 'Discord';
        const result = await requestJson(
            'POST',
            `${this.serverUrl}/api/chat/inbound`,
            { senderName, message },
            REQUEST_TIMEOUT_MS
        );

        if (!result.ok) {
            this.patch({
                lastError:
                    result.status === 404
                        ? 'This server does not print Discord chat in game yet.'
                        : `Discord chat could not be shown in game (${result.status || result.error || 'no answer'}).`
            });
            return;
        }

        this.state.received += 1;
        this.patch({ lastError: '' });
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
        // The feed paths are appended, so a trailing slash would double up.
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
            const client = parsed.protocol === 'https:' ? require('https') : http;
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

module.exports = { ChatRelay, NO_SESSION_RETRY_MS, POLL_INTERVAL_MS, UNSUPPORTED_RETRY_MS, normalizeBaseUrl, requestJson };

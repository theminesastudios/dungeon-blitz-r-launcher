'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Talks to the Discord desktop client over its local RPC socket, so a player approves
 * the launcher's access inside Discord instead of a browser tab. This is the transport
 * the official client exposes on every machine (IPC), and the only way to authorize
 * without leaving Discord.
 *
 *   handshake (opcode 0)  { v: 1, client_id }
 *        -> READY event
 *   AUTHORIZE (opcode 1)  { cmd: 'AUTHORIZE', args: { client_id, scopes,
 *                           code_challenge, code_challenge_method, state, nonce, pid } }
 *        -> the client shows its own consent dialog
 *        -> { cmd: 'AUTHORIZE', data: { code } }
 *
 * AUTHORIZE accepts a PKCE `code_challenge`, so the code is swapped for a token with the
 * matching verifier and no client secret ever has to ship with the launcher.
 *
 * Frames are a 4-byte little-endian opcode, a 4-byte little-endian length, then JSON.
 * A socket read can split a frame, so bytes are buffered until a whole frame is there.
 */

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;
const OPCODE_CLOSE = 2;
const OPCODE_PING = 3;
const OPCODE_PONG = 4;

const SOCKET_NAME = 'discord-ipc-';
const SOCKET_ATTEMPTS = 10;
const READY_TIMEOUT_MS = 10000;
const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;

class DiscordIpcError extends Error {
    constructor(code, message) {
        super(message || `Discord RPC error ${code}`);
        this.name = 'DiscordIpcError';
        this.code = code;
    }
}

/**
 * Where Discord keeps its RPC socket. macOS and Linux use a directory from the
 * environment (TMPDIR ends with a separator on macOS); Windows uses named pipes, in both
 * forms Node and Discord accept.
 */
function socketPaths() {
    if (process.platform === 'win32') {
        const paths = [];
        for (let index = 0; index < SOCKET_ATTEMPTS; index += 1) {
            paths.push(`\\\\?\\pipe\\${SOCKET_NAME}${index}`);
            paths.push(`\\\\.\\pipe\\${SOCKET_NAME}${index}`);
        }
        return paths;
    }

    const directory =
        process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';

    const paths = [];
    for (let index = 0; index < SOCKET_ATTEMPTS; index += 1) {
        paths.push(path.join(directory, `${SOCKET_NAME}${index}`));
    }
    return paths;
}

function encodeFrame(opcode, payload) {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.alloc(8 + json.length);
    frame.writeUInt32LE(opcode, 0);
    frame.writeUInt32LE(json.length, 4);
    json.copy(frame, 8);
    return frame;
}

function nonce() {
    return crypto.randomBytes(16).toString('hex');
}

class DiscordIpcClient extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pending = new Map();
        this.ready = false;
    }

    /** Connects to the first socket Discord answers on, and completes the handshake. */
    connect({ clientId, timeoutMs = READY_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            const candidates = socketPaths();
            let index = 0;
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    this.close();
                    reject(new DiscordIpcError(0, 'Discord did not answer the RPC handshake.'));
                }
            }, timeoutMs);

            const finish = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (error) {
                    this.close();
                    reject(error);
                } else {
                    resolve();
                }
            };

            const tryNext = () => {
                if (settled) {
                    return;
                }
                if (index >= candidates.length) {
                    finish(new DiscordIpcError(0, 'Discord is not running.'));
                    return;
                }

                const candidate = candidates[index];
                index += 1;

                const socket = net.createConnection(candidate);
                const onError = () => {
                    socket.destroy();
                    tryNext();
                };

                socket.once('error', onError);
                socket.once('connect', () => {
                    socket.removeListener('error', onError);
                    socket.on('error', (error) => this.failPending(error));
                    socket.on('close', () => this.failPending(new DiscordIpcError(0, 'Discord closed the connection.')));
                    socket.on('data', (chunk) => this.handleData(chunk));
                    this.socket = socket;
                    this.once('ready', () => finish(null));
                    this.send(OPCODE_HANDSHAKE, { v: 1, client_id: String(clientId || '') });
                });
            };

            tryNext();
        });
    }

    /**
     * Asks the Discord client to authorize the application. Resolves with the OAuth2 code
     * after the player approves the dialog; rejects when Discord refuses or time runs out.
     */
    async authorize({
        clientId,
        scopes,
        codeChallenge,
        codeChallengeMethod = 'S256',
        state,
        pid,
        timeoutMs = AUTHORIZE_TIMEOUT_MS
    } = {}) {
        const response = await this.request(
            'AUTHORIZE',
            {
                client_id: String(clientId || ''),
                scopes: Array.isArray(scopes) ? scopes : [],
                code_challenge: codeChallenge,
                code_challenge_method: codeChallengeMethod,
                state,
                nonce: nonce(),
                // Lets Discord overlay its consent dialog on the launcher window.
                ...(pid ? { pid } : {})
            },
            timeoutMs
        );

        const code = response && response.data && response.data.code;
        if (!code) {
            throw new DiscordIpcError(0, 'Discord did not return an authorization code.');
        }
        return String(code);
    }

    /** One command/response round trip, matched by nonce. */
    request(cmd, args, timeoutMs = READY_TIMEOUT_MS) {
        if (!this.socket) {
            return Promise.reject(new DiscordIpcError(0, 'Not connected to Discord.'));
        }

        const id = nonce();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DiscordIpcError(0, `Discord did not answer ${cmd} in time.`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (payload) => {
                    clearTimeout(timer);
                    resolve(payload);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            });

            this.send(OPCODE_FRAME, { cmd, args, nonce: id });
        });
    }

    send(opcode, payload) {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        this.socket.write(encodeFrame(opcode, payload));
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.buffer.length >= 8) {
            const opcode = this.buffer.readUInt32LE(0);
            const length = this.buffer.readUInt32LE(4);
            if (this.buffer.length < 8 + length) {
                return;
            }

            const payload = this.buffer.subarray(8, 8 + length).toString('utf8');
            this.buffer = this.buffer.subarray(8 + length);
            this.handleFrame(opcode, payload);
        }
    }

    handleFrame(opcode, payload) {
        if (opcode === OPCODE_PING) {
            this.send(OPCODE_PONG, JSON.parse(payload));
            return;
        }
        if (opcode === OPCODE_CLOSE) {
            this.failPending(new DiscordIpcError(0, 'Discord closed the connection.'));
            this.close();
            return;
        }
        if (opcode !== OPCODE_FRAME) {
            return;
        }

        let message = null;
        try {
            message = JSON.parse(payload);
        } catch {
            return;
        }

        if (message.evt === 'READY' || (message.cmd === 'DISPATCH' && message.data)) {
            if (!this.ready) {
                this.ready = true;
                this.emit('ready', message.data || {});
            }
            // Subscribed events (ACTIVITY_JOIN, ACTIVITY_JOIN_REQUEST, ...) arrive as
            // dispatches too, so the first one is not the only one worth forwarding.
            if (message.evt && message.evt !== 'READY') {
                this.emit('event', message);
                this.emit(message.evt, message.data || {});
            }
            return;
        }

        if (message.evt === 'ERROR') {
            const error = new DiscordIpcError(message.data && message.data.code, message.data && message.data.message);
            const waiting = message.nonce ? this.pending.get(message.nonce) : null;
            if (waiting) {
                this.pending.delete(message.nonce);
                waiting.reject(error);
            } else {
                this.emit('rpc-error', error);
            }
            return;
        }

        if (message.nonce && this.pending.has(message.nonce)) {
            const waiting = this.pending.get(message.nonce);
            this.pending.delete(message.nonce);
            waiting.resolve(message);
        }
    }

    failPending(error) {
        for (const [id, waiting] of this.pending) {
            this.pending.delete(id);
            waiting.reject(error);
        }
    }

    close() {
        if (this.socket) {
            const socket = this.socket;
            this.socket = null;
            try {
                socket.destroy();
            } catch {
                // Nothing left to release.
            }
        }
        this.ready = false;
        this.buffer = Buffer.alloc(0);
    }
}

module.exports = {
    AUTHORIZE_TIMEOUT_MS,
    DiscordIpcClient,
    DiscordIpcError,
    OPCODE_FRAME,
    OPCODE_HANDSHAKE,
    OPCODE_PING,
    OPCODE_PONG,
    encodeFrame,
    socketPaths
};

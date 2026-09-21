#!/usr/bin/env node
'use strict';

/**
 * Integration test for the JavaScript social bridge (lib/socialJs.js + lib/socialRest.js)
 * against local mocks of Discord's HTTP lobby API and its RPC socket. No real Discord
 * traffic, no consent dialog, no Electron, no browser.
 *
 * Phase 1: authorization through the Discord client (lib/discordIpc.js) -- the default.
 * Phase 2: authorization through the browser flow -- still supported, now opt-in.
 *
 * Usage: node tools/test-social-bridge.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const { JsSocialBridge } = require('../lib/socialJs');
const { encodeFrame } = require('../lib/discordIpc');

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;

const MOCK_TOKEN = {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_in: 3600,
    scope: 'openid identify sdk.social_layer'
};

/** The lobby half of Discord, over plain http. */
function createMockApi() {
    const calls = [];
    let messagePage = [];
    let selfMessage = null;

    const server = http.createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://mock');
        calls.push(`${request.method} ${url.pathname}${url.search}`);
        response.setHeader('Content-Type', 'application/json');

        const readBody = () =>
            new Promise((resolve) => {
                let text = '';
                request.on('data', (chunk) => {
                    text += chunk;
                });
                request.on('end', () => resolve(text));
            });

        if (url.pathname === '/oauth2/token') {
            void readBody().then((body) => {
                const form = new URLSearchParams(body);
                // Both paths use PKCE; neither is allowed to ship a client secret.
                assert.ok(form.get('code_verifier'), 'the exchange must carry the PKCE verifier');
                assert.strictEqual(form.get('client_secret'), null);
                response.end(JSON.stringify(MOCK_TOKEN));
            });
            return;
        }
        if (url.pathname === '/users/@me') {
            response.end(JSON.stringify({ id: 'u-1', username: 'tester', global_name: 'Tester' }));
            return;
        }
        if (url.pathname === '/lobbies' && request.method === 'PUT') {
            void readBody().then((body) => {
                assert.strictEqual(JSON.parse(body).secret, 'launcher-app-1');
                response.end(
                    JSON.stringify({ id: 'lobby-1', application_id: 'app-1', members: [], linked_channel: null })
                );
            });
            return;
        }
        if (url.pathname === '/lobbies/lobby-1/channel-linking') {
            response.end(JSON.stringify({ id: 'lobby-1', members: [], linked_channel: { id: 'chan-9' } }));
            return;
        }
        if (url.pathname === '/lobbies/lobby-1/messages' && request.method === 'POST') {
            void readBody().then((body) => {
                selfMessage = {
                    id: 'msg-1',
                    content: JSON.parse(body).content,
                    author: { id: 'u-1', username: 'tester' },
                    lobby_id: 'lobby-1'
                };
                response.end(JSON.stringify(selfMessage));
            });
            return;
        }
        if (url.pathname === '/lobbies/lobby-1/messages' && request.method === 'GET') {
            response.end(JSON.stringify(messagePage));
            return;
        }
        response.statusCode = 404;
        response.end('{}');
    });

    return { server, calls, setMessages: (page) => (messagePage = page), getSelfMessage: () => selfMessage };
}

/** The RPC half of Discord: a unix socket that answers the handshake and AUTHORIZE. */
function startMockDiscordIpc(directory) {
    const seen = { authorize: null };

    const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 8) {
                const opcode = buffer.readUInt32LE(0);
                const length = buffer.readUInt32LE(4);
                if (buffer.length < 8 + length) {
                    return;
                }
                const payload = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'));
                buffer = buffer.subarray(8 + length);

                if (opcode === OPCODE_HANDSHAKE) {
                    socket.write(
                        encodeFrame(OPCODE_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } })
                    );
                    continue;
                }
                if (opcode === OPCODE_FRAME && payload.cmd === 'AUTHORIZE') {
                    seen.authorize = payload;
                    socket.write(
                        encodeFrame(OPCODE_FRAME, {
                            cmd: 'AUTHORIZE',
                            data: { code: 'rpc-code-1' },
                            nonce: payload.nonce
                        })
                    );
                }
            }
        });
    });

    return new Promise((resolve) => {
        // Windows has no unix sockets: the mock takes the named-pipe form, under the
        // same test-only name the socket-name override gave socketPaths().
        const endpoint =
            process.platform === 'win32'
                ? '\\\\.\\pipe\\dblr-test-discord-ipc-0'
                : path.join(directory, 'discord-ipc-0');
        server.listen(endpoint, () => resolve({ server, seen }));
    });
}

function waitForEvent(bridge, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${type}"`)), timeoutMs);
        bridge.once(type, (payload) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectEvents(bridge) {
    const events = [];
    for (const type of [
        'ready',
        'auth',
        'lobby_ready',
        'channel_linked',
        'channel_link_failed',
        'chat',
        'send_result',
        'status'
    ]) {
        bridge.on(type, (payload) => events.push({ type, ...payload }));
    }
    return events;
}

function baseConfig({ tokenCachePath, mockUrl, overrides }) {
    return {
        appId: 'app-1',
        channelId: 'chan-9',
        enableChannelLinking: true,
        lobbySecret: '',
        tokenCachePath,
        pollIntervalMs: 50,
        apiBaseUrl: mockUrl,
        tokenUrl: `${mockUrl}/oauth2/token`,
        ...overrides
    };
}

/** Phase 1: the Discord client authorizes, no browser and no redirect involved. */
async function testDiscordAuthorization(mock, mockUrl, tmp) {
    // macOS caps a unix socket path at ~104 characters, so this one lives directly
    // under /tmp rather than inside the test's own (long) temp directory. Windows has
    // no such cap -- it uses named pipes -- and has no /tmp, so it gets the temp dir.
    const socketRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    const directory = fs.mkdtempSync(path.join(socketRoot, 'dipc-'));
    // Both of the variables discordIpc.js consults, in its order of preference.
    //
    // Setting TMPDIR alone passes on macOS and fails on any Linux with a systemd user
    // session -- a CI runner included -- because XDG_RUNTIME_DIR wins there, so the bridge
    // went looking in the runner's real runtime directory, never found the mock socket, and
    // the test timed out on a lobby that was never authorized. The precedence itself is
    // right: that is where Discord actually keeps its socket on Linux.
    const previousEnv = {
        TMPDIR: process.env.TMPDIR,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DUNGEON_BLITZ_DISCORD_SOCKET_NAME: process.env.DUNGEON_BLITZ_DISCORD_SOCKET_NAME
    };
    process.env.TMPDIR = `${directory}/`;
    process.env.XDG_RUNTIME_DIR = directory;
    // A name of our own, so a real Discord running on this machine -- which holds
    // discord-ipc-0 outright on Windows -- and the mock never fight over a pipe.
    process.env.DUNGEON_BLITZ_DISCORD_SOCKET_NAME = 'dblr-test-';
    const ipc = await startMockDiscordIpc(directory);

    const tokenCachePath = path.join(tmp, 'token-discord.json');
    const bridge = new JsSocialBridge({ openUrl: () => assert.fail('no browser may be opened') });
    const events = collectEvents(bridge);

    const started = bridge.start(baseConfig({ tokenCachePath, mockUrl, overrides: {} }));

    const lobbyReady = await waitForEvent(bridge, 'lobby_ready');
    assert.strictEqual(lobbyReady.lobbyId, 'lobby-1');
    assert.strictEqual(lobbyReady.userId, 'u-1');
    await waitForEvent(bridge, 'channel_linked');

    try {
        // The authorize request must ask for the lobby scopes and carry a PKCE challenge.
        assert.ok(ipc.seen.authorize, 'Discord must have been asked to authorize');
        assert.deepStrictEqual(ipc.seen.authorize.args.scopes, ['openid', 'identify', 'sdk.social_layer']);
        assert.strictEqual(ipc.seen.authorize.args.code_challenge_method, 'S256');
        assert.ok(ipc.seen.authorize.args.code_challenge);
        assert.strictEqual(ipc.seen.authorize.args.client_id, 'app-1');
        assert.ok(ipc.seen.authorize.args.pid, 'the dialog is overlaid on this process');

        // No browser was opened, and the token landed in the same cache as always.
        assert.ok(!events.some((event) => event.type === 'open'));
        assert.strictEqual(JSON.parse(fs.readFileSync(tokenCachePath, 'utf8')).access_token, 'at-1');

        // Chat still flows both ways on this path.
        const sent = await bridge.sendChat({ lobbyId: 'lobby-1', apiBaseUrl: mockUrl }, 'gg wp');
        assert.ok(sent.ok);
        await sleep(150);
        assert.ok(!events.some((event) => event.type === 'chat'), 'own message is not echoed back');

        mock.setMessages([
            {
                id: 'msg-2',
                content: 'hello from discord',
                author: { id: 'u-2', username: 'other', global_name: 'Other' },
                lobby_id: 'lobby-1'
            }
        ]);
        const chat = await waitForEvent(bridge, 'chat');
        assert.strictEqual(chat.username, 'Other');
        assert.strictEqual(chat.message, 'hello from discord');
    } finally {
        bridge.stop();
        await started;
        ipc.server.close();
        // Restored exactly, including "was not set": assigning undefined would leave the
        // string "undefined" behind and send the next lookup to a directory of that name.
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }

    console.log('[test-social-bridge] Discord-client authorization + lobby + chat: OK');
}

/**
 * Closing the game window stops the lobby; playing again must start a session that actually
 * mirrors chat. The launcher's wrapper used to keep the old driver's listeners, so the
 * second session's events went nowhere and the window kept showing a lobby that was gone.
 */
async function testLobbyRestart(mock, mockUrl, tmp) {
    // Same as phase 1: /tmp on POSIX for the socket path cap, the temp dir on Windows, and
    // the mock's own pipe name so a running Discord never answers instead.
    const directory = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'dipc3-'));
    const previousEnv = {
        TMPDIR: process.env.TMPDIR,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DUNGEON_BLITZ_DISCORD_SOCKET_NAME: process.env.DUNGEON_BLITZ_DISCORD_SOCKET_NAME
    };
    process.env.TMPDIR = `${directory}/`;
    process.env.XDG_RUNTIME_DIR = directory;
    process.env.DUNGEON_BLITZ_DISCORD_SOCKET_NAME = 'dblr-test-';
    const ipc = await startMockDiscordIpc(directory);
    const tokenCachePath = path.join(tmp, 'token-restart.json');
    const openUrl = () => assert.fail('no browser may be opened');

    try {
        const first = new JsSocialBridge({ openUrl });
        const firstStart = first.start(baseConfig({ tokenCachePath, mockUrl, overrides: {} }));
        const firstLobby = await waitForEvent(first, 'lobby_ready');
        assert.strictEqual(firstLobby.lobbyId, 'lobby-1');
        first.stop();
        await firstStart;

        // A second session, as after closing the game window and playing again: the cached
        // token is reused, so no second consent dialog may be needed.
        const second = new JsSocialBridge({ openUrl });
        const secondStart = second.start(baseConfig({ tokenCachePath, mockUrl, overrides: {} }));
        const secondLobby = await waitForEvent(second, 'lobby_ready');
        assert.strictEqual(secondLobby.lobbyId, 'lobby-1', 'the second session joins the lobby again');

        mock.setMessages([
            {
                id: 'msg-r2',
                content: 'after restart',
                author: { id: 'u-2', username: 'other', global_name: 'Other' },
                lobby_id: 'lobby-1'
            }
        ]);
        const chat = await waitForEvent(second, 'chat');
        assert.strictEqual(chat.message, 'after restart', 'the restarted session mirrors chat');

        second.stop();
        await secondStart;

        // The wrapper must detach the previous driver on stop: a listener left behind is
        // how a dead session kept steering the status after a restart.
        const { SocialBridge } = require('../lib/social');
        const wrapper = new SocialBridge({ tokenCachePath: path.join(tmp, 'wrapper.json'), openUrl });
        let detached = false;
        wrapper.jsBridge = {
            removeAllListeners: () => {
                detached = true;
            },
            stop: () => {}
        };
        wrapper.stop();
        assert.ok(detached, 'stop() must detach the previous driver');
    } finally {
        ipc.server.close();
        for (const [name, value] of Object.entries(previousEnv)) {
            if (value === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = value;
            }
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }

    console.log('[test-social-bridge] closing the game and playing again restarts the lobby: OK');
}

/** Phase 2: the browser flow still works when it is explicitly enabled. */
async function testBrowserAuthorization(mock, mockUrl, tmp) {
    const tokenCachePath = path.join(tmp, 'token-browser.json');
    const opened = [];
    const bridge = new JsSocialBridge({ openUrl: (url) => opened.push(url) });
    const events = collectEvents(bridge);

    const started = bridge.start(
        baseConfig({ tokenCachePath, mockUrl, overrides: { discordIpc: false, browserFallback: true } })
    );

    const authEvent = await waitForEvent(bridge, 'auth');
    const authorizeUrl = new URL(authEvent.verificationUri);
    assert.strictEqual(authorizeUrl.searchParams.get('client_id'), 'app-1');
    assert.ok(authorizeUrl.searchParams.get('scope').includes('sdk.social_layer'));
    assert.strictEqual(opened.length, 1, 'the browser is opened once, on request');

    const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri'));
    await new Promise((resolve, reject) => {
        const request = http.get(
            `http://127.0.0.1:${redirect.port}${redirect.pathname}?code=good-code&state=${authorizeUrl.searchParams.get('state')}`,
            resolve
        );
        request.on('error', reject);
    });

    const lobbyReady = await waitForEvent(bridge, 'lobby_ready');
    assert.strictEqual(lobbyReady.lobbyId, 'lobby-1');

    try {
        // POSIX mode bits only exist there; Windows keeps the file private through the
        // user's own profile directory instead of a 0o600 bit.
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(tokenCachePath).mode & 0o777, 0o600, 'the token cache stays private');
        }
        // Outbound chat still works on this path too.
        const sent = await bridge.sendChat({ lobbyId: 'lobby-1', apiBaseUrl: mockUrl }, 'browser path');
        assert.ok(sent.ok);
        assert.strictEqual(mock.getSelfMessage().content, 'browser path');
    } finally {
        bridge.stop();
        await started;
    }

    console.log('[test-social-bridge] browser authorization (opt-in) + lobby + chat: OK');
}

async function main() {
    const mock = createMockApi();
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const mockUrl = `http://127.0.0.1:${mock.server.address().port}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-bridge-test-'));

    try {
        await testDiscordAuthorization(mock, mockUrl, tmp);
        await testBrowserAuthorization(mock, mockUrl, tmp);
        await testLobbyRestart(mock, mockUrl, tmp);
    } finally {
        mock.server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.ok(mock.calls.includes('PUT /lobbies'), 'the lobby was created through the API');
    console.log('[test-social-bridge] all assertions passed');
    process.exit(0);
}

main().catch((error) => {
    console.error('[test-social-bridge] FAILED:', error.message);
    process.exit(1);
});

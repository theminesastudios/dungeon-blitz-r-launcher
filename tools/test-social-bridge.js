#!/usr/bin/env node
'use strict';

/**
 * Integration test for the JavaScript social bridge (lib/socialJs.js + lib/socialRest.js)
 * against a local mock of Discord's lobby API. No real Discord traffic, no Electron.
 *
 * Usage: node tools/test-social-bridge.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { JsSocialBridge } = require('../lib/socialJs');

const MOCK_TOKEN = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'openid identify sdk.social_layer' };
const events = [];

function createMockServer() {
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
            response.end(JSON.stringify(MOCK_TOKEN));
            return;
        }
        if (url.pathname === '/users/@me') {
            assert.strictEqual(request.headers.authorization, 'Bearer at-1');
            response.end(JSON.stringify({ id: 'u-1', username: 'tester', global_name: 'Tester' }));
            return;
        }
        if (url.pathname === '/lobbies' && request.method === 'PUT') {
            void readBody().then((body) => {
                assert.strictEqual(JSON.parse(body).secret, 'launcher-app-1');
                response.end(JSON.stringify({ id: 'lobby-1', application_id: 'app-1', members: [], linked_channel: null }));
            });
            return;
        }
        if (url.pathname === '/lobbies/lobby-1/channel-linking') {
            response.end(JSON.stringify({ id: 'lobby-1', members: [], linked_channel: { id: 'chan-9' } }));
            return;
        }
        if (url.pathname === '/lobbies/lobby-1/messages' && request.method === 'POST') {
            void readBody().then((body) => {
                selfMessage = { id: 'msg-1', content: JSON.parse(body).content, author: { id: 'u-1', username: 'tester' }, lobby_id: 'lobby-1' };
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

async function main() {
    const mock = createMockServer();
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const mockUrl = `http://127.0.0.1:${mock.server.address().port}`;

    const tokenCachePath = path.join(os.tmpdir(), `social-bridge-test-${process.pid}.json`);

    const bridge = new JsSocialBridge({
        openUrl: (url) => events.push({ type: 'open', url })
    });
    for (const type of ['ready', 'auth', 'lobby_ready', 'channel_linked', 'channel_link_failed', 'chat', 'send_result', 'status']) {
        bridge.on(type, (payload) => events.push({ type, ...payload }));
    }

    const started = bridge.start({
        appId: 'app-1',
        channelId: 'chan-9',
        enableChannelLinking: true,
        lobbySecret: '',
        tokenCachePath,
        pollIntervalMs: 50,
        apiBaseUrl: mockUrl,
        tokenUrl: `${mockUrl}/oauth2/token`
    });

    // The driver must have asked a browser to open the authorize URL.
    const authEvent = await waitForEvent(bridge, 'auth');
    const authorizeUrl = new URL(authEvent.verificationUri);
    assert.strictEqual(authorizeUrl.searchParams.get('client_id'), 'app-1');
    assert.strictEqual(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizeUrl.searchParams.get('scope').includes('sdk.social_layer'));
    assert.ok(events.some((event) => event.type === 'open' && event.url === authEvent.verificationUri));

    // Simulate Discord redirecting back to the loopback listener.
    const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri'));
    await new Promise((resolve, reject) => {
        const request = http.get(`${'http://127.0.0.1'}:${redirect.port}${redirect.pathname}?code=good-code&state=${authorizeUrl.searchParams.get('state')}`, resolve);
        request.on('error', reject);
    });

    const lobbyReady = await waitForEvent(bridge, 'lobby_ready');
    assert.strictEqual(lobbyReady.lobbyId, 'lobby-1');
    assert.strictEqual(lobbyReady.userId, 'u-1');

    await waitForEvent(bridge, 'channel_linked');
    assert.ok(mock.calls.includes('PATCH /lobbies/lobby-1/channel-linking'));

    // Cache written and locked down to the owner.
    const cache = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
    assert.strictEqual(cache.access_token, 'at-1');
    assert.strictEqual(fs.statSync(tokenCachePath).mode & 0o777, 0o600);

    // Outbound chat: send, then the poll must not echo our own copy back.
    const sent = await bridge.sendChat({ lobbyId: 'lobby-1', apiBaseUrl: mockUrl }, 'gg wp');
    assert.ok(sent.ok);
    assert.strictEqual(mock.getSelfMessage().content, 'gg wp');
    await sleep(150);
    assert.ok(!events.some((event) => event.type === 'chat'));

    // Inbound chat from another player arrives as a chat event.
    mock.setMessages([{ id: 'msg-2', content: 'hello from discord', author: { id: 'u-2', username: 'other', global_name: 'Other' }, lobby_id: 'lobby-1' }]);
    const chat = await waitForEvent(bridge, 'chat');
    assert.strictEqual(chat.username, 'Other');
    assert.strictEqual(chat.message, 'hello from discord');

    bridge.stop();
    await started;
    mock.server.close();

    assert.ok(mock.calls.includes('PUT /lobbies'));
    assert.ok(mock.calls.includes('POST /users/@me') === false);
    console.log('[test-social-bridge] all assertions passed');
    process.exit(0);
}

main().catch((error) => {
    console.error('[test-social-bridge] FAILED:', error.message);
    console.error('[test-social-bridge] events so far:', JSON.stringify(events, null, 2));
    process.exit(1);
});

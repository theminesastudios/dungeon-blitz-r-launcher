'use strict';

/**
 * Joining the lobby that is linked to the Discord channel, through the game server.
 *
 * The launcher cannot join that lobby by itself (it is the bot's, and a lobby joined by secret
 * can never be linked), so it asks the server to add its Discord account. This drives
 * lib/socialJs.js against a mock game server and a mock Discord API:
 *
 *   - the server's lobby is used, with the device token and the Discord user id sent along
 *   - the channel is not linked again (it already is, and linking is rate limited hard)
 *   - "who are you" is retried until the game session is up
 *   - a server without the lobby, or one refusing the account, falls back to the secret lobby
 *   - the chat feed poll carries the lobby id while the linked lobby is up
 */

const assert = require('assert');
const http = require('http');

const { JsSocialBridge } = require('../lib/socialJs');
const { ChatRelay } = require('../lib/chatRelay');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    });
}

function readBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(text ? JSON.parse(text) : null);
            } catch {
                resolve(null);
            }
        });
    });
}

function send(response, status, body) {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
}

async function main() {
    const discordCalls = [];
    const discord = await listen(async (request, response) => {
        discordCalls.push(`${request.method} ${request.url.split('?')[0]}`);
        if (request.url === '/users/@me') {
            send(response, 200, { id: '555000111222', username: 'player', global_name: 'Player' });
            return;
        }
        if (request.url === '/lobbies' && request.method === 'PUT') {
            send(response, 200, { id: 'secret-lobby' });
            return;
        }
        send(response, 200, {});
    });

    const joins = [];
    let joinAnswers = [];
    const game = await listen(async (request, response) => {
        if (request.url === '/api/discord/lobby/join' && request.method === 'POST') {
            joins.push(await readBody(request));
            const [status, body] = joinAnswers.shift() || [500, { ok: false }];
            send(response, status, body);
            return;
        }
        send(response, 404, { ok: false });
    });

    function config(overrides = {}) {
        return {
            appId: '1447954255452311695',
            channelId: '000000000000000000',
            enableChannelLinking: true,
            lobbySecret: 'launcher-test',
            apiBaseUrl: discord.url,
            serverUrl: game.url,
            getLauncherToken: () => 'device-token',
            ...overrides
        };
    }

    async function enter(bridge, cfg) {
        bridge.stopped = false;
        const events = [];
        bridge.on('lobby_ready', (payload) => events.push(payload));
        const outcome = await bridge.enterLobby(cfg, 'user-token');
        return { outcome, events };
    }

    // The server adds us to its linked lobby: that lobby is used, and nothing is relinked.
    joinAnswers = [[200, { ok: true, lobbyId: '1486840108173758666', linkedChannelId: '000000000000000000' }]];
    let bridge = new JsSocialBridge({ openUrl() {} });
    let cfg = config();
    let result = await enter(bridge, cfg);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(joins[0], { token: 'device-token', userId: '555000111222' }, 'the device token and Discord id are sent');
    assert.equal(cfg.lobbyId, '1486840108173758666', 'the linked lobby is the one used');
    assert.equal(result.events[0].linked, true, 'lobby_ready says the lobby is linked');
    assert.ok(!discordCalls.includes('PUT /lobbies'), 'no secret lobby is made');
    assert.ok(!discordCalls.some((call) => call.includes('channel-linking')), 'the channel is not linked again');

    // Not recognised yet (the game is still loading): asked again, then joined.
    joins.length = 0;
    joinAnswers = [
        [401, { ok: false, reason: 'unknown-requester' }],
        [200, { ok: true, lobbyId: '1486840108173758666', linkedChannelId: '000000000000000000' }]
    ];
    bridge = new JsSocialBridge({ openUrl() {} });
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
        result = await enter(bridge, config());
    } finally {
        global.setTimeout = realSetTimeout;
    }
    assert.equal(joins.length, 2, 'an unknown requester is retried');
    assert.equal(result.events[0].linked, true);

    // A server with no linked lobby, or one that will not vouch for this account: the secret lobby.
    for (const answer of [[404, { ok: false, reason: 'no-lobby' }], [403, { ok: false, reason: 'discord-account-mismatch' }]]) {
        discordCalls.length = 0;
        joinAnswers = [answer];
        bridge = new JsSocialBridge({ openUrl() {} });
        cfg = config({ enableChannelLinking: false });
        result = await enter(bridge, cfg);
        assert.equal(cfg.lobbyId, 'secret-lobby', `${answer[1].reason} falls back to the secret lobby`);
        assert.ok(!result.events[0].linked, 'and says it is not linked');
        assert.ok(discordCalls.includes('PUT /lobbies'));
    }

    // No server to ask (an old caller): straight to the secret lobby, no request made.
    joins.length = 0;
    bridge = new JsSocialBridge({ openUrl() {} });
    cfg = config({ serverUrl: '', enableChannelLinking: false });
    await enter(bridge, cfg);
    assert.equal(joins.length, 0);
    assert.equal(cfg.lobbyId, 'secret-lobby');

    // The chat feed poll names the linked lobby while it is up, and only then.
    const polls = [];
    const feed = await listen((request, response) => {
        polls.push(request.url);
        send(response, 200, { cursor: 0, messages: [] });
    });
    let snapshot = { lobbyReady: true, linkedLobby: true, lobbyId: '1486840108173758666' };
    const social = { snapshot: () => snapshot, sendChat: () => ({ ok: true }), on() {} };
    const relay = new ChatRelay({ social });
    relay.running = true;
    relay.serverUrl = feed.url;
    relay.schedule = () => {};
    await relay.poll();
    assert.equal(polls[0], '/api/chat/outbound?lobby=1486840108173758666', 'the first poll names the lobby');
    await relay.poll();
    assert.equal(polls[1], '/api/chat/outbound?since=0&lobby=1486840108173758666');
    snapshot = { lobbyReady: true, linkedLobby: false, lobbyId: 'secret-lobby' };
    await relay.poll();
    assert.equal(polls[2], '/api/chat/outbound?since=0', 'a private lobby is not named');

    discord.server.close();
    game.server.close();
    feed.server.close();
    console.log('[test-linked-lobby] all assertions passed');
}

main().catch((error) => {
    console.error(`[test-linked-lobby] FAILED: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * Drives lib/chatRelay.js against a mock of the game server's chat endpoints and a fake
 * social bridge, so the mirroring rules are pinned down without Electron, Discord or a
 * running game: only the local player's own game chat is relayed, once, and only while the
 * lobby is up; lobby chat is printed back in game; a server without the feed says so.
 *
 * Usage: node tools/test-chat-relay.js
 */

const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');

const { ChatRelay } = require('../lib/chatRelay');

class FakeSocial extends EventEmitter {
    constructor() {
        super();
        this.lobbyReady = false;
        this.sent = [];
    }

    snapshot() {
        return { lobbyReady: this.lobbyReady };
    }

    sendChat(senderName, message) {
        if (!this.lobbyReady) {
            return { ok: false, message: 'The lobby is not ready yet.' };
        }
        this.sent.push({ senderName, message });
        return { ok: true };
    }
}

/** A stand-in for the game server: a chat feed, an inbound printer, or neither. */
function startMockServer({ withFeed = true } = {}) {
    const state = { feed: [], head: 0, inbound: [], outboundPolls: 0 };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const respond = (status, body) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        };

        if (url.pathname === '/api/chat/outbound' && withFeed) {
            state.outboundPolls += 1;
            const rawSince = url.searchParams.get('since');
            if (rawSince === null || rawSince === '') {
                respond(200, { ok: true, cursor: state.head, messages: [] });
                return;
            }
            const messages = state.feed.filter((entry) => entry.seq > Number(rawSince));
            respond(200, { ok: true, cursor: state.head, messages });
            return;
        }

        if (url.pathname === '/api/chat/inbound') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                state.inbound.push(JSON.parse(body || '{}'));
                respond(200, { ok: true, delivered: 1 });
            });
            return;
        }

        respond(404, { ok: false, reason: 'not-found' });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                state,
                url: `http://127.0.0.1:${port}`,
                push: (senderName, message) => {
                    state.head += 1;
                    state.feed.push({ seq: state.head, senderName, message, atMs: Date.now() });
                    return state.head;
                },
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const game = await startMockServer();
    const social = new FakeSocial();
    const relay = new ChatRelay({ social });
    const states = [];
    relay.on('state', (snapshot) => states.push(snapshot));

    // Nothing is relayed before the lobby is up, and the first poll only adopts the cursor.
    game.push('OtherPlayer', 'eski mesaj');
    relay.start({ serverUrl: game.url });
    await relay.poll();
    assert.deepStrictEqual(social.sent, [], 'a launcher that opens mid-session replays nothing');
    assert.strictEqual(relay.snapshot().supported, true, 'the feed is recognised as available');

    // With the lobby up, the player's own new line is mirrored once.
    social.lobbyReady = true;
    game.push('BridgeProbe', 'merhaba dunya');
    await relay.poll();
    assert.deepStrictEqual(social.sent, [{ senderName: 'BridgeProbe', message: 'merhaba dunya' }]);

    // Polling again does not send it a second time.
    await relay.poll();
    assert.strictEqual(social.sent.length, 1, 'each chat line is mirrored exactly once');
    assert.strictEqual(relay.snapshot().relayed, 1);

    // A line that arrives while the lobby is down waits, then goes out once it is back.
    social.lobbyReady = false;
    game.push('BridgeProbe', 'lobi kapaliyken');
    await relay.poll();
    assert.strictEqual(social.sent.length, 1, 'nothing is sent while the lobby is down');
    social.lobbyReady = true;
    await relay.poll();
    assert.deepStrictEqual(
        social.sent.map((entry) => entry.message),
        ['merhaba dunya', 'lobi kapaliyken']
    );

    // Lobby chat goes the other way, into the game.
    social.emit('chat', { username: 'DiscordFriend', message: 'selam oyuncu' });
    await sleep(150);
    assert.deepStrictEqual(game.state.inbound, [{ senderName: 'DiscordFriend', message: 'selam oyuncu' }]);
    assert.strictEqual(relay.snapshot().received, 1);

    // Stopping ends the polling and the inbound printing.
    relay.stop();
    const pollsWhenStopped = game.state.outboundPolls;
    const inboundWhenStopped = game.state.inbound.length;
    social.emit('chat', { username: 'DiscordFriend', message: 'artik gelmemeli' });
    await sleep(100);
    assert.strictEqual(game.state.outboundPolls, pollsWhenStopped, 'no polling after stop()');
    assert.strictEqual(game.state.inbound.length, inboundWhenStopped, 'no inbound printing after stop()');

    await game.close();

    // A server that has not been redeployed with the feed: one clear state, no crash, no
    // endless polling.
    const bare = await startMockServer({ withFeed: false });
    const bareRelay = new ChatRelay({ social: new FakeSocial() });
    const bareStates = [];
    bareRelay.on('state', (snapshot) => bareStates.push(snapshot));
    bareRelay.start({ serverUrl: bare.url });
    await bareRelay.poll();
    assert.strictEqual(bareRelay.snapshot().supported, false);
    assert.ok(bareRelay.snapshot().lastError.length > 0, 'the reason is state the window can show');
    bareRelay.stop();
    await bare.close();

    assert.ok(states.length > 0, 'the relay reports its state to the window');

    console.log('[test-chat-relay] mirrors own game chat once, prints lobby chat in game, and reports unsupported servers');
    console.log('[test-chat-relay] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

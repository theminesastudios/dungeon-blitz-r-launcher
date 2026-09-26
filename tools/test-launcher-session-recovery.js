#!/usr/bin/env node
'use strict';

/**
 * Drives lib/launcherSessionRecovery.js against a mock of the game server's device-token
 * route, so the fix for "the widget is written for some players and never for others" is
 * pinned down without Electron, a Discord account or a running game.
 *
 * The players it is about are the ones who signed in with Discord *inside the game*: they have
 * no device token, and every route that identifies a player by that token answered 401 for
 * them while working for the ones who used the launcher's sign-in button. The server hands a
 * token to whoever asks from an address that has just signed in with Discord, so the launcher
 * takes one the moment the game session says who is playing -- and keeps asking, because the
 * server only remembers that sign-in for two minutes.
 *
 * Usage: node tools/test-launcher-session-recovery.js
 */

const assert = require('assert');
const http = require('http');

const discordAuth = require('../lib/discordAuth');
const { createLauncherSessionRecovery } = require('../lib/launcherSessionRecovery');

const TOKEN = 'device-token-from-the-game-session';

/**
 * A stand-in for `GET /api/auth/launcher/session`: it issues a device token when a Discord
 * sign-in is still fresh at this address, and 401s when there is nothing pending.
 */
function startMockServer({ pending = true } = {}) {
    const state = { calls: 0 };

    const server = http.createServer((req, res) => {
        const respond = (code, body) => {
            res.statusCode = code;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        };

        if (req.url.startsWith('/api/auth/launcher/session')) {
            state.calls += 1;
            if (!pending) {
                respond(401, { ok: false, reason: 'no-pending-login' });
                return;
            }
            respond(200, { ok: true, token: TOKEN, email: 'Player@Example.com', expiresAt: Date.now() + 60000 });
            return;
        }

        respond(404, { ok: false, reason: 'not-found' });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                state,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

/** The launcher's device-token cache, in memory for the test. */
function fakeCache(initial = '') {
    const state = { token: initial, email: '', writes: [] };
    return {
        state,
        read: () => state.token,
        write: (token, email) => {
            state.token = token;
            state.email = email;
            state.writes.push({ token, email });
        }
    };
}

async function testAnExistingTokenIsNotTradedAgain() {
    const game = await startMockServer();
    const cache = fakeCache('already-here');
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        issueSession: () => discordAuth.issueSession(game.url),
        onCaptured: cache.write
    });

    const result = await recovery.capture();
    assert.strictEqual(result.captured, false);
    assert.strictEqual(result.reason, 'already-have-token');
    assert.strictEqual(game.state.calls, 0, 'a launcher that already has a token asks for nothing');
    assert.deepStrictEqual(cache.state.writes, []);
    await game.close();
}

async function testAFreshInGameSignInBecomesADeviceToken() {
    const game = await startMockServer();
    const cache = fakeCache('');
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        issueSession: () => discordAuth.issueSession(game.url),
        onCaptured: cache.write
    });

    const result = await recovery.capture({ email: 'fallback@example.com' });
    assert.strictEqual(result.captured, true, 'the token the game session earned is taken');
    assert.strictEqual(result.token, TOKEN);
    assert.strictEqual(cache.state.token, TOKEN, 'and stored, which is what the widget sync reads');
    assert.strictEqual(cache.state.email, 'Player@Example.com', "the server's own spelling of the account wins");
    assert.strictEqual(game.state.calls, 1);

    // The next ask is answered from the cache: one device token, not one per poll.
    const again = await recovery.capture();
    assert.strictEqual(again.reason, 'already-have-token');
    assert.strictEqual(game.state.calls, 1);
    await game.close();
}

async function testNothingPendingLeavesTheLauncherAsItWas() {
    const game = await startMockServer({ pending: false });
    const cache = fakeCache('');
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        issueSession: () => discordAuth.issueSession(game.url),
        onCaptured: cache.write
    });

    const result = await recovery.capture();
    assert.strictEqual(result.captured, false);
    assert.strictEqual(result.reason, 'no-pending-sign-in');
    assert.strictEqual(cache.state.token, '', 'no token is invented when the server has none to give');
    assert.deepStrictEqual(cache.state.writes, []);
    assert.strictEqual(game.state.calls, 1);
    await game.close();
}

async function testTheAskIsThrottledAndRepeatedForALateSignIn() {
    const game = await startMockServer();
    const cache = fakeCache('');
    let clock = 1_000_000;
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        issueSession: () => discordAuth.issueSession(game.url),
        onCaptured: cache.write,
        intervalMs: 30000,
        now: () => clock
    });

    // The first in-game sign-in is captured without waiting.
    assert.strictEqual((await recovery.capture()).captured, true);
    assert.strictEqual(game.state.calls, 1);

    // A player who signs in a minute into the session: the poll asks again, so the window is
    // not missed -- and a token that has since been refused is replaced.
    cache.write('', '');
    clock += 5000;
    const early = await recovery.capture();
    assert.strictEqual(early.reason, 'too-soon', 'the poll runs every 5s and must not ask on every tick');
    assert.strictEqual(game.state.calls, 1);

    clock += 30000;
    const late = await recovery.capture();
    assert.strictEqual(late.captured, true, 'a sign-in completed later in the session is still captured');
    assert.strictEqual(game.state.calls, 2);
    await game.close();
}

async function testANewSessionCanAskImmediately() {
    const game = await startMockServer();
    const cache = fakeCache('');
    let clock = 5_000_000;
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        issueSession: () => discordAuth.issueSession(game.url),
        onCaptured: cache.write,
        intervalMs: 30000,
        now: () => clock
    });

    await recovery.capture();
    cache.write('', '');
    clock += 1000;
    assert.strictEqual((await recovery.capture()).reason, 'too-soon');

    recovery.reset();
    const afterReset = await recovery.capture();
    assert.strictEqual(afterReset.captured, true, 'a new game window starts its own window, not the last one\'s');
    assert.strictEqual(game.state.calls, 2);
    await game.close();
}

async function testAServerWithoutTheRouteIsNotAnError() {
    const cache = fakeCache('');
    const recovery = createLauncherSessionRecovery({
        readToken: cache.read,
        // 404 and a dead server both answer null, which is what "no token there" looks like.
        issueSession: async () => null,
        onCaptured: cache.write
    });

    const result = await recovery.capture();
    assert.strictEqual(result.captured, false);
    assert.strictEqual(cache.state.token, '');
}

async function main() {
    await testAnExistingTokenIsNotTradedAgain();
    await testAFreshInGameSignInBecomesADeviceToken();
    await testNothingPendingLeavesTheLauncherAsItWas();
    await testTheAskIsThrottledAndRepeatedForALateSignIn();
    await testANewSessionCanAskImmediately();
    await testAServerWithoutTheRouteIsNotAnError();
    console.log('launcher session recovery: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

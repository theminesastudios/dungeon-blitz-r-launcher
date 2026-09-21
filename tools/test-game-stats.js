#!/usr/bin/env node
'use strict';

/**
 * Drives lib/gameStats.js against a mock of the game server's widget-stats route, so the
 * states the launcher window shows are pinned down without Discord, a bot token or a
 * running game: a written profile, a player with no linked account (as a body and as a
 * status code), a launcher the server will not vouch for, a server without the route, and
 * a server that says no for its own reasons.
 *
 * Usage: node tools/test-game-stats.js
 */

const assert = require('assert');
const http = require('http');

const { GameStats } = require('../lib/gameStats');

/** A stand-in for the game server's `/api/discord/stats/sync`. */
function startMockServer({ answer = 'written', withRoute = true, status = 200 } = {}) {
    const state = { calls: [] };

    const server = http.createServer((req, res) => {
        const respond = (code, body) => {
            res.statusCode = code;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body));
        };

        if (req.url.startsWith('/api/discord/stats/sync') && withRoute) {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                state.calls.push({ method: req.method, body: JSON.parse(body || '{}') });
                if (status !== 200) {
                    respond(status, { ok: false, reason: reasonFor(status) });
                    return;
                }
                if (answer === 'unlinked') {
                    respond(200, { ok: false, reason: 'discord-not-linked' });
                    return;
                }
                if (answer === 'refused') {
                    respond(200, { ok: false, reason: 'discord-rejected', message: 'Discord said no.' });
                    return;
                }
                respond(200, {
                    ok: true,
                    written: true,
                    username: 'BridgeProbe',
                    updatedAt: 1700000000000,
                    fields: ['rank_name']
                });
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
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function reasonFor(status) {
    return status === 401 ? 'unknown-requester' : 'discord-rejected';
}

async function main() {
    // Nothing to ask yet: the launcher is on the sign-in screen, and sync() must not pretend
    // it tried. A URL that is not a server is the same thing.
    const lonely = new GameStats();
    assert.deepStrictEqual(lonely.start({ serverUrl: '' }), { started: false, reason: 'no-server' });
    assert.deepStrictEqual(await lonely.sync(), { ok: false, reason: 'no-server' });
    assert.strictEqual(lonely.snapshot().state, 'idle');
    assert.strictEqual(
        new GameStats().start({ serverUrl: 'ftp://example.test/' }).started,
        false,
        'only http(s) servers are accepted'
    );

    // The happy path: the server writes the profile and the window can say so.
    const game = await startMockServer();
    const stats = new GameStats();
    const states = [];
    stats.on('state', (snapshot) => states.push(snapshot));

    stats.start({ serverUrl: `${game.url}/`, getLauncherToken: () => 'device-token' });
    assert.strictEqual(stats.snapshot().running, true);
    const written = await stats.sync();
    assert.strictEqual(written.state, 'written');
    assert.strictEqual(written.written, true);
    assert.strictEqual(written.username, 'BridgeProbe');
    assert.strictEqual(written.updatedAt, 1700000000000);
    assert.strictEqual(stats.snapshot().lastError, '');
    assert.deepStrictEqual(game.state.calls[0], {
        method: 'POST',
        body: { token: 'device-token' }
    }, 'the launcher device token is what the server identifies the player by');

    // A new session starts from "nothing written yet" rather than reporting the last one.
    stats.start({ serverUrl: game.url, getLauncherToken: () => 'device-token' });
    assert.strictEqual(stats.snapshot().state, 'idle');
    assert.strictEqual(stats.snapshot().written, false);

    // No linked Discord account: the widget has nobody to be written for, and that is a
    // different fix from a server fault.
    const unlinkedGame = await startMockServer({ answer: 'unlinked' });
    const unlinked = new GameStats();
    unlinked.start({ serverUrl: unlinkedGame.url });
    assert.strictEqual((await unlinked.sync()).state, 'unlinked');
    assert.match(unlinked.snapshot().lastError, /Sign in with Discord/);
    await unlinkedGame.close();

    // The same missing link, answered as an HTTP error instead of a body.
    const conflictGame = await startMockServer({ status: 409 });
    const conflict = new GameStats();
    conflict.start({ serverUrl: conflictGame.url });
    assert.strictEqual((await conflict.sync()).state, 'unlinked');
    await conflictGame.close();

    // The server does not know this launcher: opening the game once is the fix.
    const strangerGame = await startMockServer({ status: 401 });
    const stranger = new GameStats();
    stranger.start({ serverUrl: strangerGame.url });
    assert.strictEqual((await stranger.sync()).state, 'error');
    assert.match(stranger.snapshot().lastError, /does not recognise this launcher/);
    await strangerGame.close();

    // A server that has the route but Discord refused the write: the server's own words are
    // what the window shows.
    const refusedGame = await startMockServer({ answer: 'refused' });
    const refused = new GameStats();
    refused.start({ serverUrl: refusedGame.url });
    assert.strictEqual((await refused.sync()).state, 'error');
    assert.strictEqual(refused.snapshot().lastError, 'Discord said no.');
    await refusedGame.close();

    // A server that has not been redeployed with the route at all.
    const bare = await startMockServer({ withRoute: false });
    const bareStats = new GameStats();
    bareStats.start({ serverUrl: bare.url });
    assert.strictEqual((await bareStats.sync()).state, 'unsupported');
    assert.match(bareStats.snapshot().lastError, /cannot write Discord widget stats yet/);
    await bare.close();

    // A server that is gone: an error state with a reason, never a thrown request.
    const gone = await startMockServer();
    const goneStats = new GameStats();
    goneStats.start({ serverUrl: gone.url });
    await gone.close();
    assert.strictEqual((await goneStats.sync()).state, 'error');
    assert.ok(goneStats.snapshot().lastError.length > 0, 'the failure is state the window can show');

    // Closing the game takes the session with it; a later sync has nothing to ask.
    stats.stop();
    assert.strictEqual(stats.snapshot().running, false);
    assert.deepStrictEqual(await stats.sync(), { ok: false, reason: 'no-server' });

    assert.ok(states.length > 0, 'the service reports its state to the window');
    assert.ok(
        states.some((snapshot) => snapshot.state === 'written'),
        'the written state reaches the window'
    );

    await game.close();

    console.log('[test-game-stats] writes through the server, and reports unlinked, unauthorized and unsupported servers');
    console.log('[test-game-stats] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

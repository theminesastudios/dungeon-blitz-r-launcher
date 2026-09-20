#!/usr/bin/env node
'use strict';

/**
 * Drives lib/presence.js against a mock of Discord's local RPC socket: the same handshake
 * the real client answers, the same SET_ACTIVITY frames the real client receives.
 *
 * This is the path that used to fail silently -- the launcher spawned the game server's own
 * bridge with Electron's Node 12, which cannot load its dependencies, and its output was
 * discarded, so rich presence simply never appeared. The test pins down that the launcher's
 * own bridge speaks the protocol, maps the game page's payload onto an activity, and only
 * answers origins the game page could plausibly be served from.
 *
 * Usage: node tools/test-presence.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;

function encodeFrame(opcode, payload) {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.alloc(8 + json.length);
    frame.writeUInt32LE(opcode, 0);
    frame.writeUInt32LE(json.length, 4);
    json.copy(frame, 8);
    return frame;
}

/**
 * A stand-in for the Discord client's IPC socket. It records the handshake and every
 * SET_ACTIVITY it is sent, and answers like the client does.
 */
function startMockDiscord(socketPath) {
    const state = { handshake: null, activities: [], commands: [], ready: false };

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

                const body = buffer.subarray(8, 8 + length).toString('utf8');
                buffer = buffer.subarray(8 + length);

                if (opcode === OPCODE_HANDSHAKE) {
                    state.handshake = JSON.parse(body);
                    // The first frame Discord sends back is the READY event.
                    socket.write(encodeFrame(OPCODE_FRAME, { evt: 'READY', data: { v: 1, user: { id: '1', username: 'tester' } } }));
                    continue;
                }

                if (opcode !== OPCODE_FRAME) {
                    continue;
                }

                const message = JSON.parse(body);
                state.commands.push(message.cmd);
                if (message.cmd === 'SET_ACTIVITY') {
                    state.activities.push(message.args);
                }
                socket.write(encodeFrame(OPCODE_FRAME, { cmd: message.cmd, data: {}, nonce: message.nonce }));
            }
        });

        socket.on('error', () => {
            // The bridge closes its side on stop(); nothing to clean up here.
        });
    });

    return new Promise((resolve) => {
        server.listen(socketPath, () => {
            state.ready = true;
            resolve({ state, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

function post(port, pathname, payload, origin) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (origin) {
            headers.Origin = origin;
        }

        const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (response) => {
            let text = '';
            response.on('data', (chunk) => {
                text += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
        });
        request.on('error', (error) => resolve({ status: 0, body: { error: error.message } }));
        request.end(body);
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const GAME_ORIGIN = 'http://play.example.test';
const { LEVEL_AREA_IMAGE_KEYS } = require('../lib/presence');
const PRESENCE_PAYLOAD = {
    characterName: 'BridgeProbe',
    characterClass: 'Warrior',
    details: 'Home',
    state: 'Idling in town',
    startedAtMs: Date.now() - 60000,
    partyId: 7,
    partySize: 2,
    partyMax: 4,
    joinSecret: 'join-secret',
    levelKey: 'CraftTown',
    levelName: 'Home',
    activityKind: 'zone',
    areaKey: 'home',
    disciplineKey: 'warrior',
    portraitUrl: ''
};

async function main() {
    // socketPaths() reads the temporary directory from the environment, so a private one
    // keeps the test away from a real Discord client that happens to be running.
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbr-ipc-'));
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    const discord = await startMockDiscord(path.join(runtimeDir, 'discord-ipc-0'));

    const { PresenceBridge } = require('../lib/presence');
    const bridge = new PresenceBridge({
        launcherConfig: {},
        config: {
            appId: 'test-app-id',
            port: 0,
            allowedPresenceOrigins: ['example.test'],
            playGameUrl: 'https://theminesa.studio/dungeon-blitz-r',
            logPayloads: false
        }
    });

    const states = [];
    bridge.on('state', (snapshot) => states.push(snapshot));

    bridge.start({ serverUrl: GAME_ORIGIN, gameWindowPid: process.pid });
    await sleep(500);

    assert.ok(discord.state.handshake, 'the bridge must complete the Discord handshake');
    assert.strictEqual(discord.state.handshake.client_id, 'test-app-id');
    assert.strictEqual(bridge.snapshot().ready, true, 'Discord answering READY is the ready state');
    assert.ok(discord.state.commands.includes('SUBSCRIBE'), 'party joins are subscribed to');
    const port = bridge.snapshot().port;
    assert.ok(port > 0, 'the bound port is reported for the window');

    // What the game page pushes becomes one activity, mapped the way Discord expects.
    const updated = await post(port, '/presence', PRESENCE_PAYLOAD, GAME_ORIGIN);
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.updated, true);
    assert.strictEqual(discord.state.activities.length, 1);

    // Asserted in the shape the RPC socket actually takes, which is the whole point: these
    // used to check the flat camelCase the discord-rpc library accepted, so they passed
    // while Discord silently dropped every field it did not recognise -- artwork, party and
    // join all missing from a presence whose text looked perfectly right.
    const activity = discord.state.activities[0].activity;
    assert.strictEqual(activity.details, 'Home');
    assert.strictEqual(activity.state, 'Idling in town');
    assert.strictEqual(activity.party.id, '7');
    assert.deepStrictEqual(activity.party.size, [2, 4], 'party size is a [current, max] pair');
    // No join secret: Discord hides `buttons` behind Ask to Join the moment an activity
    // carries `secrets`, and the Play Game button is the presence players actually had.
    assert.strictEqual(activity.secrets, undefined, 'no join secret, so the button survives');
    assert.strictEqual(activity.assets.small_image, 'warrior');
    assert.strictEqual(activity.assets.small_text, 'BridgeProbe - Warrior');
    assert.strictEqual(activity.assets.large_image, 'home', 'CraftTown falls back to the home artwork');
    assert.strictEqual(activity.assets.large_text, 'Home');

    // Every area the game can name gets its own artwork, not the generic dungeon image.
    // These pushed used to all render as `indungeon` because resolveLargeImageKey only
    // knew three keys.
    for (const area of ['blackrosemire', 'castlehocke', 'cemeteryhill', 'emeraldglades', 'fellbridge', 'shazaridesert', 'stormshardmountain', 'valhaven']) {
        const pushed = await post(port, '/presence', { ...PRESENCE_PAYLOAD, areaKey: area }, GAME_ORIGIN);
        assert.strictEqual(pushed.status, 200);
        const activityForArea = discord.state.activities[discord.state.activities.length - 1].activity;
        assert.strictEqual(activityForArea.assets.large_image, area, `${area} shows its own artwork`);
        // A level key alone -- no separate area key -- resolves the same way.
        const byLevelKey = LEVEL_AREA_IMAGE_KEYS[area];
        assert.ok(byLevelKey, `the table itself covers ${area}`);
    }

    // The dungeon/level keys and the class disciplines are covered too, including their
    // exact spellings from the asset list.
    for (const key of ['dungeon_blitz', 'embedded_background', 'embedded_cover', 'indungeon', 'newbieroad', 'flameseer', 'frostbringer', 'justicar', 'mage', 'necromancer', 'paladin', 'rogue', 'sentinel', 'shadowbringer', 'soulthieft', 'templar', 'viperblade']) {
        assert.ok(Object.values(LEVEL_AREA_IMAGE_KEYS).includes(key), `artwork key "${key}" is mapped`);
    }

    // Unknown areas fall through to the page's raw key (forward compatibility with art
    // uploaded after this build) -- and that is exactly what DUNGEON_BLITZ_LOG_PRESENCE=1
    // is for: it prints the keys the page actually sends, so a mismatch with the uploaded
    // asset names can be spotted and the table extended.
    const unknown = await post(port, '/presence', { ...PRESENCE_PAYLOAD, areaKey: 'moomooplain', levelKey: 'MoomooPlain' }, GAME_ORIGIN);
    assert.strictEqual(unknown.status, 200);
    const unknownActivity = discord.state.activities[discord.state.activities.length - 1].activity;
    assert.strictEqual(unknownActivity.assets.large_image, 'moomooplain', 'an unknown area key passes through unchanged');

    // A published portrait does not take the large image away from the area artwork. It used
    // to win that slot, which showed a character on a plain background and lost the one thing
    // the small icon does not already say: where the player is.
    //
    // Built directly rather than pushed, because every activity count below this point is
    // absolute and one more push would shift them all.
    {
        const portraitActivity = bridge.buildActivity({
            ...PRESENCE_PAYLOAD,
            areaKey: 'blackrosemire',
            levelKey: 'SwampRoadNorth',
            levelName: 'Black Rose Mire',
            portraitUrl: 'http://dungeonblitzr.theminesa.studio/portraits/telahair.png'
        });
        assert.strictEqual(portraitActivity.assets.large_image, 'blackrosemire', 'the area keeps the large image');
        assert.strictEqual(portraitActivity.assets.large_text, 'Black Rose Mire');
        assert.strictEqual(portraitActivity.assets.small_image, 'warrior', 'and the class keeps the small one');
        assert.strictEqual(portraitActivity.secrets, undefined, 'and no join secret hides the button');
        assert.ok(portraitActivity.buttons && portraitActivity.buttons.length === 1, 'the button is still there');
    }

    // Back to the original area, so the dedupe check below compares like with like.
    await post(port, '/presence', PRESENCE_PAYLOAD, GAME_ORIGIN);
    assert.strictEqual(typeof activity.timestamps.start, 'number', 'the start time is epoch milliseconds');
    assert.ok(activity.timestamps.start > 0);
    assert.strictEqual(activity.buttons[0].url, 'https://theminesa.studio/dungeon-blitz-r');

    // Nothing may go out under the library's old field names: Discord ignores them without
    // complaining, which is exactly how this went unnoticed.
    for (const stale of ['largeImageKey', 'smallImageKey', 'partyId', 'partySize', 'partyMax', 'joinSecret', 'startTimestamp']) {
        assert.strictEqual(activity[stale], undefined, `${stale} is not a field the socket understands`);
    }
    assert.ok(Number.isFinite(discord.state.activities[0].pid), 'an activity is attributed to a pid');

    // The same payload again is not a second update: the page pushes every four seconds.
    // (Eleven SET_ACTIVITY frames so far: the original push, one per area probed, and the
    // return to the original area.)
    const repeated = await post(port, '/presence', PRESENCE_PAYLOAD, GAME_ORIGIN);
    assert.strictEqual(repeated.status, 202);
    assert.strictEqual(repeated.body.updated, false);
    assert.strictEqual(discord.state.activities.length, 11);

    // /clear is the page's own "no session" case, and a second one is a no-op.
    await post(port, '/clear', { clear: true }, GAME_ORIGIN);
    assert.strictEqual(discord.state.activities.length, 12);
    assert.strictEqual(discord.state.activities[11].activity, null);
    await post(port, '/clear', { clear: true }, GAME_ORIGIN);
    assert.strictEqual(discord.state.activities.length, 12, 'clearing an empty profile sends nothing');

    // A payload without a character (the game page on its sign-in screen) means the same.
    await post(port, '/presence', PRESENCE_PAYLOAD, GAME_ORIGIN);
    assert.strictEqual(discord.state.activities.length, 13);
    const cleared = await post(port, '/presence', { characterName: '', details: '', state: '', startedAtMs: 0 }, GAME_ORIGIN);
    assert.strictEqual(cleared.status, 202);
    assert.strictEqual(cleared.body.cleared, true);
    assert.strictEqual(discord.state.activities.length, 14);
    assert.strictEqual(discord.state.activities[13].activity, null);

    // Any other game page gets nothing: a browser tab on some other site cannot write to
    // the player's Discord profile through this endpoint.
    const refused = await post(port, '/presence', PRESENCE_PAYLOAD, 'http://evil.example.test');
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.body.reason, 'origin-not-allowed');
    assert.strictEqual(discord.state.activities.length, 14, 'a refused origin never reaches Discord');

    // /configure is what the page uses to learn where to send a party join.
    const configured = await post(port, '/configure', { characterName: 'BridgeProbe' }, GAME_ORIGIN);
    assert.strictEqual(configured.status, 200);
    // The server it is playing on is where the online roster lives, and the character the
    // page just named is what the poll is narrowed to.
    assert.strictEqual(
        configured.body.presenceUrl,
        `${GAME_ORIGIN}/api/presence/discord-target?character=BridgeProbe`
    );
    assert.strictEqual(configured.body.joinUrl, `${GAME_ORIGIN}/api/presence/discord-join`);

    const missing = await post(port, '/nope', {}, GAME_ORIGIN);
    assert.strictEqual(missing.status, 404);

    // Stopping clears the activity: the launcher outlives the game window, so leaving it
    // would keep the player shown as playing a game they closed.
    bridge.stop();
    await sleep(300);
    assert.strictEqual(discord.state.activities.length, 14, 'nothing was left to clear on stop()');
    assert.strictEqual(bridge.snapshot().running, false);

    // A game that was running when the window closed is cleared on the way out, so the
    // profile does not keep saying the player is in a game they closed.
    const second = new PresenceBridge({
        launcherConfig: {},
        config: { appId: 'test-app-id', port: 0, allowedPresenceOrigins: ['example.test'], playGameUrl: 'https://example.test/play' }
    });
    second.start({ serverUrl: GAME_ORIGIN, gameWindowPid: process.pid });
    await sleep(400);
    await post(second.snapshot().port, '/presence', PRESENCE_PAYLOAD, GAME_ORIGIN);
    assert.strictEqual(discord.state.activities.length, 15);
    second.stop();
    await sleep(300);
    assert.strictEqual(discord.state.activities.length, 16);
    assert.strictEqual(discord.state.activities[15].activity, null);

    await discord.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });

    assert.ok(states.length > 0, 'the bridge reports its state to the window');

    console.log('[test-presence] the launcher publishes, dedupes, refuses foreign origins and clears presence');
    console.log('[test-presence] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

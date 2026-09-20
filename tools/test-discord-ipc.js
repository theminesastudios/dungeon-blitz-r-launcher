#!/usr/bin/env node
'use strict';

/**
 * Tests lib/discordIpc.js against a mock Discord RPC socket: the handshake, the
 * AUTHORIZE payload, PING/PONG, and the "Discord is not running" path. Nothing here
 * touches the real Discord client, and no consent dialog is ever shown.
 *
 * Usage: node tools/test-discord-ipc.js
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const { DiscordIpcClient, encodeFrame } = require('../lib/discordIpc');

const OPCODE_HANDSHAKE = 0;
const OPCODE_FRAME = 1;
const OPCODE_PING = 3;
const OPCODE_PONG = 4;

function readFrames(socket, onFrame) {
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
            onFrame(opcode, payload, socket);
        }
    });
}

/** Starts a mock Discord socket at $TMPDIR/discord-ipc-0 and records what it receives. */
function startMockDiscord(directory) {
    const seen = { handshake: null, authorize: null, pongs: 0 };
    const server = net.createServer((socket) => {
        readFrames(socket, (opcode, payload) => {
            if (opcode === OPCODE_HANDSHAKE) {
                seen.handshake = payload;
                socket.write(
                    encodeFrame(OPCODE_FRAME, {
                        cmd: 'DISPATCH',
                        evt: 'READY',
                        data: { v: 1, user: { id: 'u-1', username: 'tester' } }
                    })
                );
                // The client must answer a PING with the same payload.
                socket.write(encodeFrame(OPCODE_PING, { probe: 'alive' }));
                return;
            }
            if (opcode === OPCODE_PONG) {
                seen.pongs += 1;
                return;
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
        });
    });

    return new Promise((resolve) => {
        server.listen(path.join(directory, 'discord-ipc-0'), () => resolve({ server, seen }));
    });
}

function tempDirectory() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-ipc-test-'));
}

async function testHandshakeAndAuthorize() {
    const directory = tempDirectory();
    const previous = process.env.TMPDIR;
    // socketPaths() reads TMPDIR, so the mock looks like Discord's own socket.
    process.env.TMPDIR = `${directory}/`;

    const { server, seen } = await startMockDiscord(directory);
    const client = new DiscordIpcClient();

    try {
        await client.connect({ clientId: 'app-1' });
        assert.strictEqual(seen.handshake.client_id, 'app-1');
        assert.strictEqual(seen.handshake.v, 1);

        const code = await client.authorize({
            clientId: 'app-1',
            scopes: ['openid', 'identify', 'sdk.social_layer'],
            codeChallenge: 'challenge-1',
            state: 'state-1',
            pid: 4242
        });

        assert.strictEqual(code, 'rpc-code-1');
        assert.strictEqual(seen.authorize.args.client_id, 'app-1');
        assert.deepStrictEqual(seen.authorize.args.scopes, ['openid', 'identify', 'sdk.social_layer']);
        assert.strictEqual(seen.authorize.args.code_challenge, 'challenge-1');
        assert.strictEqual(seen.authorize.args.code_challenge_method, 'S256');
        assert.strictEqual(seen.authorize.args.state, 'state-1');
        assert.strictEqual(seen.authorize.args.pid, 4242);
        assert.ok(seen.authorize.nonce, 'every command carries a nonce');

        // The PING the mock sent must have been answered.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(seen.pongs, 1);
    } finally {
        client.close();
        server.close();
        process.env.TMPDIR = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function testDiscordNotRunning() {
    const directory = tempDirectory();
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = `${directory}/`;

    const client = new DiscordIpcClient();
    try {
        await assert.rejects(
            () => client.connect({ clientId: 'app-1', timeoutMs: 2000 }),
            /Discord is not running/
        );
    } finally {
        client.close();
        process.env.TMPDIR = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function main() {
    await testHandshakeAndAuthorize();
    console.log('[test-discord-ipc] handshake, AUTHORIZE payload and PING/PONG: OK');

    await testDiscordNotRunning();
    console.log('[test-discord-ipc] missing Discord is reported, not hung: OK');

    console.log('[test-discord-ipc] all assertions passed');
    process.exit(0);
}

main().catch((error) => {
    console.error('[test-discord-ipc] FAILED:', error.message);
    process.exit(1);
});

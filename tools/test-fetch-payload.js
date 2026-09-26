#!/usr/bin/env node
'use strict';

/**
 * Drives tools/fetch-payload.js against a mock store, so the rules that matter for a step
 * that downloads executables into a shipped installer are pinned down without a real
 * store, a token or a network: only the platform being built is fetched, a file already on
 * disk with the right digest is not fetched again, a wrong digest is refused rather than
 * written, the store token is never sent to a host a redirect names, and a manifest cannot
 * name a path outside payload/.
 *
 * Usage: node tools/test-fetch-payload.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
    PayloadError,
    fetchPayload,
    hasLocalPayload,
    parseStoreUrl,
    safeRelativePath
} = require('./fetch-payload');
const { buildManifest } = require('./build-payload-store');

const FLASH_DLL = Buffer.from('not really a pe dll, but it has the right digest');
const BRIDGE_EXE = Buffer.from('not really a bridge either');

function digest(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** A manifest plus a file server, which is the shape of the real store. */
function startMockStore({ files = [], requireToken = '', redirectTo = '', corruptDigest = false } = {}) {
    const requests = [];
    const byPath = new Map(files.map((file) => [`/${file.kind}/${file.platform}/${file.path}`, file.body]));

    const server = http.createServer((req, res) => {
        requests.push({ path: req.url, authorization: req.headers.authorization || '' });

        if (requireToken && req.headers.authorization !== `Bearer ${requireToken}`) {
            res.statusCode = 401;
            res.end('no');
            return;
        }

        if (redirectTo) {
            res.statusCode = 302;
            res.setHeader('Location', `${redirectTo}${req.url}`);
            res.end();
            return;
        }

        if (req.url === '/manifest.json') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(
                JSON.stringify({
                    version: 1,
                    files: files.map((file) => ({
                        kind: file.kind,
                        platform: file.platform,
                        path: file.path,
                        sha256: corruptDigest ? digest(Buffer.from('something else')) : digest(file.body),
                        size: file.body.length
                    }))
                })
            );
            return;
        }

        const body = byPath.get(req.url);
        if (body) {
            res.statusCode = 200;
            res.end(body);
            return;
        }

        res.statusCode = 404;
        res.end('missing');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}/`,
                requests,
                close: () => new Promise((done) => server.close(done))
            });
        });
    });
}

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-payload-'));
}

async function rejects(promise, fragment) {
    try {
        await promise;
    } catch (error) {
        assert.ok(
            error instanceof PayloadError,
            `expected a PayloadError, got ${error && error.name}: ${error && error.message}`
        );
        assert.ok(
            String(error.message).includes(fragment),
            `expected the error to mention "${fragment}", got: ${error.message}`
        );
        return error;
    }
    throw new Error(`expected a rejection mentioning "${fragment}", but the call succeeded`);
}

async function main() {
    // A manifest is a remote document, so its paths are checked before they become paths.
    assert.strictEqual(safeRelativePath('flash/x/pepflashplayer64.dll'), path.join('flash', 'x', 'pepflashplayer64.dll'));
    for (const hostile of ['../escape', '/etc/passwd', 'a/../../b', 'https://evil.test/x', '']) {
        let refused = false;
        try {
            safeRelativePath(hostile);
        } catch {
            refused = true;
        }
        assert.ok(refused, `the store must not be able to write "${hostile}"`);
    }

    // The store carries a token, so the scheme is refused before a request is made.
    assert.throws(() => parseStoreUrl('http://payloads.example.test/'), /must be https/);
    assert.strictEqual(parseStoreUrl('http://127.0.0.1:9/').hostname, '127.0.0.1', 'a loopback mirror may be plain http');
    assert.throws(() => parseStoreUrl(''), /No payload store configured/);
    assert.throws(() => parseStoreUrl('https://user:pw@store.test/'), /must not carry credentials/);

    // The ordinary case: one platform's files land under payload/, and the ones belonging
    // to another platform are not fetched at all.
    const target = tempRoot();
    const store = await startMockStore({
        files: [
            { kind: 'flash', platform: 'win32', path: 'pepflashplayer64.dll', body: FLASH_DLL },
            { kind: 'social', platform: 'win32', path: 'discord_social_bridge.exe', body: BRIDGE_EXE },
            { kind: 'social', platform: 'linux', path: 'discord_social_bridge', body: BRIDGE_EXE },
            { kind: 'flash', platform: 'darwin', path: 'PepperFlashPlayer.plugin', body: Buffer.from('mach-o') }
        ]
    });

    let result = await fetchPayload({ storeUrl: store.url, platform: 'win32', targetRoot: target });
    assert.deepStrictEqual(
        result.results.map((entry) => entry.action),
        ['downloaded', 'downloaded'],
        'both win32 files were fetched'
    );
    assert.strictEqual(
        store.requests.some((request) => request.path.includes('darwin')),
        false,
        'the darwin plugin is not downloaded when building for win32'
    );
    assert.deepStrictEqual(
        fs.readFileSync(path.join(target, 'flash', 'win32', 'pepflashplayer64.dll')),
        FLASH_DLL,
        'the plugin is written where stage-vendor.js looks for it'
    );

    // A checkout that staged its own binaries still builds with no store configured, so
    // `predist` can call this unconditionally.
    assert.strictEqual(hasLocalPayload('win32', target), true, 'a staged platform is recognised');
    assert.strictEqual(hasLocalPayload('darwin', target), false, 'one that was not staged is not');

    // A bridge that cannot be launched is a confusing failure much later, so the bit is
    // set. The extensionless name is the one that is actually executed in place; the
    // Windows `.exe` is covered by the same pattern but the bit means nothing there.
    await fetchPayload({ storeUrl: store.url, platform: 'linux', targetRoot: target });
    const bridgePath = path.join(target, 'social', 'linux', 'discord_social_bridge');
    if (process.platform !== 'win32') {
        assert.ok(fs.statSync(bridgePath).mode & 0o111, 'the bridge is written executable');
    }

    // Second run: the files are already right, so they are not fetched again. The manifest
    // is still re-read -- that is how the run knows what to skip.
    const fileRequests = () => store.requests.filter((request) => request.path !== '/manifest.json').length;
    const before = fileRequests();
    result = await fetchPayload({ storeUrl: store.url, platform: 'win32', targetRoot: target });
    assert.deepStrictEqual(
        result.results.map((entry) => entry.action),
        ['present', 'present'],
        'a file already on disk with the right digest is left alone'
    );
    assert.strictEqual(fileRequests(), before, 'and it is not re-requested');

    // --force is the way to repair a file that is there but wrong.
    fs.writeFileSync(path.join(target, 'flash', 'win32', 'pepflashplayer64.dll'), 'truncated');
    result = await fetchPayload({ storeUrl: store.url, platform: 'win32', targetRoot: target, force: true });
    assert.deepStrictEqual(
        result.results.map((entry) => entry.action),
        ['downloaded', 'downloaded'],
        '--force re-fetches even a file that is present'
    );
    assert.deepStrictEqual(fs.readFileSync(path.join(target, 'flash', 'win32', 'pepflashplayer64.dll')), FLASH_DLL);

    await store.close();
    fs.rmSync(target, { recursive: true, force: true });

    // A file that does not match the manifest is never written: this is a build step that
    // ends up inside an installer, so a wrong digest has to stop it rather than warn.
    const badTarget = tempRoot();
    const badStore = await startMockStore({
        files: [{ kind: 'flash', platform: 'linux', path: 'libpepflashplayer.so', body: Buffer.from('real') }],
        corruptDigest: true
    });
    await rejects(
        fetchPayload({ storeUrl: badStore.url, platform: 'linux', targetRoot: badTarget }),
        'Checksum mismatch'
    );
    assert.strictEqual(
        fs.existsSync(path.join(badTarget, 'flash', 'linux', 'libpepflashplayer.so')),
        false,
        'a file that failed its checksum is not left on disk'
    );

    // A platform the manifest does not carry is an error, not a silently empty build.
    await rejects(
        fetchPayload({ storeUrl: badStore.url, platform: 'darwin', targetRoot: badTarget }),
        'no darwin files'
    );
    await badStore.close();
    fs.rmSync(badTarget, { recursive: true, force: true });

    // A store that wants a token says so in terms the release log can act on.
    const authTarget = tempRoot();
    const authStore = await startMockStore({
        files: [{ kind: 'flash', platform: 'win32', path: 'pepflashplayer64.dll', body: FLASH_DLL }],
        requireToken: 's3cret'
    });
    await rejects(fetchPayload({ storeUrl: authStore.url, platform: 'win32', targetRoot: authTarget }), 'HTTP 401');
    await rejects(
        fetchPayload({ storeUrl: authStore.url, token: 'wrong', platform: 'win32', targetRoot: authTarget }),
        'HTTP 401'
    );
    // The two rejections above deliberately went out without, and with the wrong, token;
    // only the successful run is meant to carry it.
    const beforeAuthed = authStore.requests.length;
    const authed = await fetchPayload({
        storeUrl: authStore.url,
        token: 's3cret',
        platform: 'win32',
        targetRoot: authTarget
    });
    assert.strictEqual(authed.results[0].action, 'downloaded');
    const authedRequests = authStore.requests.slice(beforeAuthed);
    assert.ok(authedRequests.length > 0, 'the successful run talked to the store');
    assert.ok(
        authedRequests.every((request) => request.authorization === 'Bearer s3cret'),
        'every request in the authenticated run carries the token'
    );
    await authStore.close();
    fs.rmSync(authTarget, { recursive: true, force: true });

    // The shape a hostile store would use to catch the token: answer with a redirect to
    // somewhere else. Following it would send the bearer to a host of its choosing.
    const redirectTarget = tempRoot();
    const other = await startMockStore({
        files: [{ kind: 'flash', platform: 'win32', path: 'pepflashplayer64.dll', body: FLASH_DLL }]
    });
    const redirecting = await startMockStore({
        files: [{ kind: 'flash', platform: 'win32', path: 'pepflashplayer64.dll', body: FLASH_DLL }],
        requireToken: 's3cret',
        redirectTo: other.url
    });
    await rejects(
        fetchPayload({ storeUrl: redirecting.url, token: 's3cret', platform: 'win32', targetRoot: redirectTarget }),
        'the store token would be sent to another host'
    );
    assert.deepStrictEqual(other.requests, [], 'the redirect target is never contacted');
    await redirecting.close();
    await other.close();
    fs.rmSync(redirectTarget, { recursive: true, force: true });

    // The manifest builder and the fetcher are a pair: what one writes, the other has to
    // accept. Round-tripping them here is what stops a change to either from quietly
    // producing a store the release job cannot read.
    const pairRoot = tempRoot();
    const payloadDir = path.join(pairRoot, 'payload');
    const staged = [
        ['flash', 'win32', path.join('pepflashplayer64.dll')],
        ['social', 'win32', path.join('discord_social_bridge.exe')]
    ];
    for (const [kind, platform, relative] of staged) {
        const file = path.join(payloadDir, kind, platform, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(`body of ${kind}/${platform}/${relative}`));
    }
    const manifestPath = path.join(payloadDir, 'manifest.json');
    const { manifest } = buildManifest(payloadDir);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const pairStore = await new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
            const file = path.join(payloadDir, rel);
            if (!file.startsWith(payloadDir) || !fs.existsSync(file)) {
                res.statusCode = 404;
                return res.end();
            }
            res.end(fs.readFileSync(file));
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const pairUrl = `http://127.0.0.1:${pairStore.address().port}/`;

    const roundTrip = tempRoot();
    const fetched = await fetchPayload({ storeUrl: pairUrl, platform: 'win32', targetRoot: roundTrip });
    assert.strictEqual(fetched.results.length, 2, 'both staged win32 files were fetched');
    for (const [kind, platform, relative] of staged) {
        const landed = path.join(roundTrip, kind, platform, relative);
        assert.deepStrictEqual(
            fs.readFileSync(landed),
            fs.readFileSync(path.join(payloadDir, kind, platform, relative)),
            `${kind}/${platform}/${relative} round-trips byte for byte`
        );
    }

    await new Promise((done) => pairStore.close(done));
    fs.rmSync(pairRoot, { recursive: true, force: true });
    fs.rmSync(roundTrip, { recursive: true, force: true });

    console.log('[test-fetch-payload] one platform at a time, digest-checked, token never leaves the store: OK');
    console.log('[test-fetch-payload] the built manifest round-trips through the fetcher: OK');
    console.log('[test-fetch-payload] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

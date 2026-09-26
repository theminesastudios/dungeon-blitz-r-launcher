#!/usr/bin/env node
'use strict';

/**
 * Writes `payload/manifest.json`, which turns the staged binaries into something
 * `tools/fetch-payload.js` can consume.
 *
 * The store layout is the payload tree itself with a manifest at its root, so hosting it
 * is "upload payload/" and nothing is duplicated:
 *
 *   <store>/manifest.json
 *   <store>/<kind>/<platform>/<path>
 *
 * That is deliberate. A manifest rather than an archive so a build runner downloads only
 * the platform it is building, and so every file is checksummed on its own -- the fetcher
 * refuses a file whose digest does not match, which is the only thing standing between a
 * corrupted or substituted store and a shipped installer.
 *
 * It walks what is actually staged, so a platform that was never staged is simply absent
 * from the manifest and the release job for it fails at preflight, which is the honest
 * outcome -- rather than advertising a file that is not there.
 *
 * Usage:
 *   node tools/build-payload-store.js [--payload <dir>] [--out <file>] [--check]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PAYLOAD = path.join(LAUNCHER_ROOT, 'payload');

const KINDS = ['flash', 'social'];
const PLATFORMS = ['darwin', 'linux', 'win32'];

/** Every regular file under payload/, relative to it, POSIX-separated. */
function walk(root, relative = '') {
    const found = [];
    const directory = path.join(root, relative);
    let entries;
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return found;
    }

    for (const entry of entries) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            found.push(...walk(root, next));
        } else if (entry.isFile()) {
            found.push(next);
        }
    }
    return found;
}

function describe(payloadRoot, relative) {
    const absolute = path.join(payloadRoot, ...relative.split('/'));
    const stat = fs.statSync(absolute);
    const hash = crypto.createHash('sha256');
    // Streamed: these are 30MB binaries and reading them whole to hash them is a waste.
    const descriptor = fs.openSync(absolute, 'r');
    try {
        const buffer = Buffer.alloc(1 << 20);
        let read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        while (read > 0) {
            hash.update(buffer.subarray(0, read));
            read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        }
    } finally {
        fs.closeSync(descriptor);
    }

    return {
        kind: relative.split('/')[0],
        platform: relative.split('/')[1],
        path: relative.split('/').slice(2).join('/'),
        sha256: hash.digest('hex'),
        size: stat.size
    };
}

function buildManifest(payloadRoot) {
    const entries = [];
    const problems = [];

    for (const kind of KINDS) {
        for (const platform of PLATFORMS) {
            const prefix = `${kind}/${platform}/`;
            const files = walk(payloadRoot).filter((relative) => relative.startsWith(prefix));
            if (files.length === 0) {
                problems.push(`${kind}/${platform}: nothing staged`);
                continue;
            }
            for (const relative of files.sort()) {
                entries.push(describe(payloadRoot, relative));
            }
        }
    }

    return { manifest: { version: 1, files: entries }, problems };
}

function render(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
    const args = process.argv.slice(2);
    const payloadRoot = args.includes('--payload') ? args[args.indexOf('--payload') + 1] : DEFAULT_PAYLOAD;
    const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(payloadRoot, 'manifest.json');
    const checkOnly = args.includes('--check');

    if (!fs.existsSync(payloadRoot)) {
        console.error(`[build-payload-store] No payload directory at ${payloadRoot}.`);
        console.error('[build-payload-store] Stage the binaries first -- see the README, "Staging the binaries".');
        process.exit(1);
    }

    const { manifest, problems } = buildManifest(payloadRoot);

    console.log(`[build-payload-store] payload: ${payloadRoot}`);
    for (const entry of manifest.files) {
        console.log(
            `[build-payload-store]   ${entry.kind}/${entry.platform}/${entry.path}  ${entry.size}  sha256:${entry.sha256.slice(0, 16)}…`
        );
    }

    if (problems.length) {
        console.warn(`[build-payload-store] Not staged: ${problems.join('; ')}`);
        console.warn('[build-payload-store] A release job for one of these will fail at preflight, which is the point.');
    }

    const body = render(manifest);

    if (checkOnly) {
        const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
        console.log(
            current === body
                ? `[build-payload-store] ${outPath} is up to date.`
                : `[build-payload-store] ${outPath} is STALE.`
        );
        process.exit(current === body ? 0 : 1);
    }

    fs.writeFileSync(outPath, body, 'utf8');
    console.log(`[build-payload-store] wrote ${manifest.files.length} entries to ${outPath}`);
    console.log('[build-payload-store] Host this directory read-only: that directory IS the store.');
}

if (require.main === module) {
    main();
}

module.exports = { buildManifest, walk };

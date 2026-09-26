#!/usr/bin/env node
'use strict';

/**
 * Fetches the proprietary binaries a package ships into `payload/`, from a store this
 * repository does not contain.
 *
 * Why a store and not the repository: the Flash plugin and the Discord Partner SDK are
 * not ours to redistribute, and this repository is public, so the binaries cannot ride
 * along in the checkout. This is the step that replaced `lfs: true` on the release job's
 * checkout. What lands in `payload/` is exactly what `tools/stage-vendor.js` already
 * expects, so nothing downstream of that changed.
 *
 * The store is a plain static host -- an S3 prefix, a private GitHub release, anything
 * that serves files. Two things are read from it:
 *
 *   <store>/manifest.json
 *     { "version": 1, "files": [ { kind, platform, path, sha256, size }, ... ] }
 *   <store>/<kind>/<platform>/<path>
 *
 * The manifest is a plain list rather than an archive so a runner downloads only the one
 * platform it is building, and so each file can be checksummed on its own.
 *
 * `PAYLOAD_STORE_URL` and `PAYLOAD_STORE_TOKEN` come from the environment. The token is
 * sent only to the store's own host, never to a redirect target, and a plain http store is
 * refused unless it is loopback -- a local mirror during development. Both are because
 * this thing downloads executables that end up inside a shipped installer: the trust
 * boundary is the store plus its token, so nothing here widens it by accident.
 *
 * Usage:
 *   node tools/fetch-payload.js [--platform win32|darwin|linux] [--force] [--store <url>]
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGET_ROOT = path.join(LAUNCHER_ROOT, 'payload');

const KINDS = ['flash', 'social'];
const PLATFORMS = ['darwin', 'linux', 'win32'];
const MAX_REDIRECTS = 3;

class PayloadError extends Error {}

function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * The store carries a token, so the scheme is checked before the first request rather than
 * left to whatever the environment happens to point at. Loopback is exempted so a local
 * mirror works over plain http.
 */
function parseStoreUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new PayloadError(
            'No payload store configured. Set PAYLOAD_STORE_URL (and PAYLOAD_STORE_TOKEN if it needs one).'
        );
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new PayloadError(`PAYLOAD_STORE_URL is not a URL: ${raw}`);
    }

    if (parsed.username || parsed.password) {
        throw new PayloadError('PAYLOAD_STORE_URL must not carry credentials; use PAYLOAD_STORE_TOKEN.');
    }

    const loopback = isLoopbackHost(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
        throw new PayloadError(
            `PAYLOAD_STORE_URL must be https (got ${parsed.protocol}//${parsed.host}). Plain http is only allowed for a loopback mirror.`
        );
    }

    return parsed;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * One request, no redirect following: a redirect is handed back so the caller can decide
 * whether the target is still the store. That is what keeps the token from being replayed
 * to a host the redirect chose.
 */
function request(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(url, { headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(60_000, () => {
            req.destroy(new Error(`timed out after 60s`));
        });
    });
}

function sameOrigin(a, b) {
    return a.protocol === b.protocol && a.host === b.host;
}

async function fetchWithRedirects(startUrl, { token } = {}, redirectsLeft = MAX_REDIRECTS) {
    let url = startUrl;
    for (let hop = 0; hop <= redirectsLeft; hop += 1) {
        const headers = {};
        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }

        const response = await request(url, headers);

        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            const next = new URL(response.headers.location, url);
            if (!sameOrigin(url, next)) {
                // A cross-origin redirect is the shape a hostile store would use to catch
                // the token, so it is refused rather than followed. The caller retries
                // without credentials only if the file turns out to be public.
                throw new PayloadError(
                    `Refusing to follow ${url.host} -> ${next.host} on redirect: the store token would be sent to another host.`
                );
            }
            if (hop === redirectsLeft) {
                throw new PayloadError(`Too many redirects fetching ${startUrl.href}`);
            }
            url = next;
            continue;
        }

        return { ...response, url };
    }

    throw new PayloadError(`Too many redirects fetching ${startUrl.href}`);
}

function parseManifest(text, source) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new PayloadError(`${source} is not valid JSON.`);
    }

    if (!parsed || !Array.isArray(parsed.files)) {
        throw new PayloadError(`${source} has no "files" array.`);
    }

    return parsed;
}

/**
 * A manifest is a list of paths from a remote document, so every entry is checked before
 * it becomes a path: no absolute paths, no `..`, no nested escapes out of payload/.
 */
function safeRelativePath(value) {
    const raw = String(value || '');
    if (!raw) {
        throw new PayloadError('A manifest entry has an empty path.');
    }
    if (path.isAbsolute(raw) || /^[a-z]+:/i.test(raw) || raw.includes('\0')) {
        throw new PayloadError(`Refusing absolute path in manifest: ${raw}`);
    }

    const segments = raw.split(/[\\/]+/);
    if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
        throw new PayloadError(`Refusing path that escapes payload/: ${raw}`);
    }

    return segments.join(path.sep);
}

function validateEntry(entry, index) {
    const kind = String((entry && entry.kind) || '');
    const platform = String((entry && entry.platform) || '');
    if (!KINDS.includes(kind)) {
        throw new PayloadError(`Manifest entry ${index} has unknown kind: ${kind || '(none)'}`);
    }
    if (!PLATFORMS.includes(platform)) {
        throw new PayloadError(`Manifest entry ${index} has unknown platform: ${platform || '(none)'}`);
    }

    return {
        kind,
        platform,
        path: safeRelativePath(entry.path),
        sha256: String(entry.sha256 || '').toLowerCase(),
        size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null
    };
}

function fileForPlatform(manifest, platform) {
    return manifest.files
        .map((entry, index) => validateEntry(entry, index))
        .filter((entry) => entry.platform === platform);
}

function isUpToDate(targetPath, entry) {
    let existing;
    try {
        existing = fs.readFileSync(targetPath);
    } catch {
        return false;
    }

    // Size first so a large mismatched file is not read twice, then the digest, which is
    // what actually decides.
    if (entry.size !== null && existing.length !== entry.size) {
        return false;
    }
    return entry.sha256 ? sha256(existing) === entry.sha256 : true;
}

function targetPathFor(targetRoot, entry) {
    const target = path.resolve(targetRoot, entry.kind, entry.platform, entry.path);
    const base = path.resolve(targetRoot) + path.sep;
    if (!target.startsWith(base)) {
        throw new PayloadError(`Refusing to write outside payload/: ${entry.path}`);
    }
    return target;
}

/**
 * Downloads the manifest's files for one platform into `targetRoot`, skipping any that are
 * already there with the right digest. Returns what happened per file so a caller can
 * report it.
 */
async function fetchPayload({
    storeUrl,
    token = '',
    platform = process.platform,
    force = false,
    targetRoot = DEFAULT_TARGET_ROOT,
    log = () => {}
} = {}) {
    if (!PLATFORMS.includes(platform)) {
        throw new PayloadError(`Unknown platform: ${platform}. Expected one of ${PLATFORMS.join(', ')}.`);
    }

    const store = parseStoreUrl(storeUrl);
    const manifestUrl = new URL('manifest.json', store.href.endsWith('/') ? store.href : `${store.href}/`);
    const manifestResponse = await fetchWithRedirects(manifestUrl, { token });

    if (manifestResponse.status === 401 || manifestResponse.status === 403) {
        throw new PayloadError(
            `The payload store refused the request (HTTP ${manifestResponse.status}). Check PAYLOAD_STORE_TOKEN.`
        );
    }
    if (manifestResponse.status !== 200) {
        throw new PayloadError(`Could not read the manifest: HTTP ${manifestResponse.status} from ${manifestUrl.href}`);
    }

    const manifest = parseManifest(manifestResponse.body.toString('utf8'), manifestUrl.href);
    const wanted = fileForPlatform(manifest, platform);
    if (wanted.length === 0) {
        throw new PayloadError(`The manifest lists no ${platform} files.`);
    }

    const results = [];
    for (const entry of wanted) {
        const target = targetPathFor(targetRoot, entry);

        if (!force && isUpToDate(target, entry)) {
            results.push({ entry, target, action: 'present' });
            log(`[fetch-payload] present  ${entry.kind}/${entry.platform}/${entry.path}`);
            continue;
        }

        const fileUrl = new URL(`${entry.kind}/${entry.platform}/${entry.path}`, manifestUrl);
        const response = await fetchWithRedirects(fileUrl, { token });
        if (response.status !== 200) {
            throw new PayloadError(
                `Could not download ${entry.kind}/${entry.platform}/${entry.path}: HTTP ${response.status}`
            );
        }

        if (entry.sha256) {
            const actual = sha256(response.body);
            if (actual !== entry.sha256) {
                throw new PayloadError(
                    `Checksum mismatch for ${entry.kind}/${entry.platform}/${entry.path}.\n` +
                        `[fetch-payload]   expected sha256 ${entry.sha256}\n` +
                        `[fetch-payload]   actual   sha256 ${actual}\n` +
                        '[fetch-payload] Refusing to write it. The store is corrupt or not the one you meant.'
                );
            }
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        // The bridge is launched in place; a write does not carry the mode across every
        // filesystem, and an unexecutable bridge is a confusing failure much later. The
        // Windows bridge carries an extension, so match it too -- the bit is meaningless
        // there, but leaving it out means the pattern quietly stops matching.
        fs.writeFileSync(target, response.body);
        if (/discord_social_bridge(\.exe)?$/.test(entry.path)) {
            fs.chmodSync(target, 0o755);
        }

        results.push({ entry, target, action: 'downloaded' });
        log(`[fetch-payload] fetched  ${entry.kind}/${entry.platform}/${entry.path} (${response.body.length} bytes)`);
    }

    return { platform, results };
}

function parseArgs(argv) {
    const args = { platform: process.platform, force: false, store: process.env.PAYLOAD_STORE_URL || '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--store' && argv[index + 1]) {
            args.store = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--force') {
            args.force = true;
        }
    }
    return args;
}

/**
 * True when payload/ already holds something for this platform, however it got there:
 * an earlier fetch, a manual copy, or a run of `npm run extract-flash`.
 */
function hasLocalPayload(platform, targetRoot = DEFAULT_TARGET_ROOT) {
    for (const kind of KINDS) {
        const directory = path.join(targetRoot, kind, platform);
        try {
            if (fs.readdirSync(directory).length > 0) {
                return true;
            }
        } catch {
            // Not staged for this kind; the other one may still be.
        }
    }
    return false;
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    // Wired into `predist`, so a checkout that staged its binaries by hand -- from a
    // FlashBrowser install, or a previous fetch -- must still build with no store
    // configured. Only a store-less build with nothing staged is a real problem, and
    // preflight says so better than this does.
    if (!args.store && hasLocalPayload(args.platform)) {
        console.log(`[fetch-payload] ${args.platform}: no store configured, using what is already in payload/`);
        return;
    }

    fetchPayload({
        storeUrl: args.store,
        token: process.env.PAYLOAD_STORE_TOKEN || '',
        platform: args.platform,
        force: args.force,
        log: (line) => console.log(line)
    })
        .then((result) => {
            const downloaded = result.results.filter((entry) => entry.action === 'downloaded').length;
            const present = result.results.length - downloaded;
            console.log(`[fetch-payload] ${result.platform}: ${downloaded} downloaded, ${present} already present`);
        })
        .catch((error) => {
            console.error('');
            console.error(`[fetch-payload] ERROR: ${error instanceof PayloadError ? error.message : error}`);
            console.error('');
            process.exit(1);
        });
}

if (require.main === module) {
    main();
}

module.exports = {
    DEFAULT_TARGET_ROOT,
    PayloadError,
    fetchPayload,
    hasLocalPayload,
    isUpToDate,
    parseArgs,
    parseManifest,
    parseStoreUrl,
    safeRelativePath,
    validateEntry
};

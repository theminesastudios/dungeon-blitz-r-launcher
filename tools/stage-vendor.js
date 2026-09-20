#!/usr/bin/env node
'use strict';

/**
 * Fills `src/launcher/vendor/<kind>/<platform>/` -- the folders electron-builder ships as
 * extra resources -- from the two places the binaries come from:
 *
 *   payload/flash/<platform>/   committed (Git LFS)      -> vendor/flash/<platform>/
 *   payload/social/<platform>/  committed (Git LFS)      -> vendor/social/<platform>/
 *   <cmake build dir>           built during the job     -> vendor/social/<platform>/
 *
 * `vendor/` stays a build output that nobody commits, so a local checkout that ran
 * tools/extract-flash.js and a CI job that unpacked the payload end up identical.
 *
 * Usage:
 *   node tools/stage-vendor.js [--platform linux] [--bridge-build <dir>]
 */

const fs = require('fs');
const path = require('path');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const PAYLOAD_ROOT = path.join(LAUNCHER_ROOT, 'payload');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor');

// What a built bridge consists of on each platform: the executable plus the SDK runtime
// library it loads from its own directory.
const BRIDGE_FILES = {
    win32: ['discord_social_bridge.exe', 'discord_partner_sdk.dll'],
    darwin: ['discord_social_bridge', 'libdiscord_partner_sdk.dylib'],
    linux: ['discord_social_bridge', 'libdiscord_partner_sdk.so']
};

function parseArgs(argv) {
    const args = { platform: process.platform, bridgeBuild: '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--bridge-build' && argv[index + 1]) {
            args.bridgeBuild = String(argv[index + 1]);
            index += 1;
        }
    }
    return args;
}

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function copyRecursive(source, target) {
    if (isDirectory(source)) {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(target, entry));
        }
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    // The bridge has to stay executable; copyFileSync does not carry the mode over on
    // every filesystem CI runs on.
    if (/discord_social_bridge$/.test(source)) {
        fs.chmodSync(target, 0o755);
    }
}

function stagePayload(kind, platform) {
    const source = path.join(PAYLOAD_ROOT, kind, platform);
    if (!isDirectory(source)) {
        return [];
    }

    const target = path.join(VENDOR_ROOT, kind, platform);
    const copied = [];
    for (const entry of fs.readdirSync(source)) {
        copyRecursive(path.join(source, entry), path.join(target, entry));
        copied.push(entry);
    }
    return copied;
}

function stageBridgeBuild(buildDir, platform) {
    if (!buildDir || !isDirectory(buildDir)) {
        return [];
    }

    const target = path.join(VENDOR_ROOT, 'social', platform);
    const copied = [];
    for (const name of BRIDGE_FILES[platform] || []) {
        const source = path.join(buildDir, name);
        try {
            fs.statSync(source);
        } catch {
            continue;
        }
        copyRecursive(source, path.join(target, name));
        copied.push(name);
    }
    return copied;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!BRIDGE_FILES[args.platform]) {
        console.error(`[stage-vendor] Bilinmeyen platform: ${args.platform}`);
        process.exit(1);
    }

    const flash = stagePayload('flash', args.platform);
    const socialPayload = stagePayload('social', args.platform);
    const socialBuilt = stageBridgeBuild(args.bridgeBuild, args.platform);

    console.log(`[stage-vendor] platform: ${args.platform}`);
    console.log(`[stage-vendor] flash:   ${flash.length ? flash.join(', ') : '(payload yok)'}`);
    console.log(
        `[stage-vendor] social:  ${
            socialBuilt.length
                ? `${socialBuilt.join(', ')} (derlemeden)`
                : socialPayload.length
                  ? `${socialPayload.join(', ')} (payload)`
                  : '(yok - lobby chat calismaz)'
        }`
    );
}

main();

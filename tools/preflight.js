#!/usr/bin/env node
'use strict';

/**
 * Checks that a build's target platform has a Flash plugin in vendor/ before
 * electron-builder runs.
 *
 * A package built without the plugin still runs -- the launcher falls back to scanning
 * the player's own Flash installs -- but most players have none: 1.0.3's macOS build
 * shipped that way and landed every player on the refusal dialog. A missing plugin
 * therefore fails the build; a deliberate Flash-less package has to say so with
 * DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.
 *
 * Usage: node tools/preflight.js [--platform win32|darwin|linux]
 */

const fs = require('fs');
const path = require('path');

const { pluginArchitectures } = require('../lib/flash');
const { findUnpackagedFiles } = require('../lib/packageFiles');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'flash');

const EXPECTED = {
    win32: 'pepflashplayer64.dll (or pepflashplayer.dll)',
    darwin: 'PepperFlashPlayer.plugin',
    linux: 'libpepflashplayer.so'
};

function parsePlatform(argv) {
    const index = argv.indexOf('--platform');
    if (index >= 0 && argv[index + 1]) {
        return String(argv[index + 1]);
    }
    return process.platform;
}

function describeVendor(platform) {
    const directory = path.join(VENDOR_ROOT, platform);

    let entries = [];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return { directory, found: [] };
    }

    const found = entries.filter((entry) => /^(pepflashplayer|libpepflashplayer|PepperFlashPlayer)/i.test(entry));
    return { directory, found };
}

// The packaged launcher is x64 on every platform, and a PPAPI plugin is loaded
// in-process, so the vendored plugin has to match. Parse the binary headers and warn
// loudly instead of shipping a package whose Flash can never start.
function warnIfArchUnsupported(platform, directory, pluginName) {
    const architectures = pluginArchitectures(path.join(directory, pluginName));
    if (!architectures.length || architectures.includes('x64')) {
        return;
    }

    console.warn('');
    console.warn(
        `[preflight] WARNING: ${pluginName} supports only ${architectures.join('/')}, not x64.`
    );
    console.warn(`[preflight] The ${platform} package is x64, so this plugin cannot load. Produce an x86_64`);
    console.warn('[preflight] plugin and copy it into vendor/ with `npm run extract-flash`.');
    console.warn('');
}

/**
 * A file the launcher reads at runtime that `build.files` does not match is absent from
 * the packaged app, and the feature it configures fails in a way that looks like a bug in
 * that feature rather than a packaging mistake. That is a broken release, so this stops
 * the build instead of warning about it.
 */
function checkPackagedFiles() {
    const buildConfig = require(path.join(LAUNCHER_ROOT, 'package.json')).build || {};
    const { missingFiles, missingDirectories } = findUnpackagedFiles(buildConfig.files);
    const missing = [...missingFiles, ...missingDirectories.map((directory) => `${directory}/`)];

    if (missing.length === 0) {
        console.log('[preflight] build.files covers every runtime file');
        return true;
    }

    console.error('');
    console.error(`[preflight] ERROR: build.files does not package: ${missing.join(', ')}`);
    console.error('[preflight] Without them the package runs but its features fail silently. Fix the list in');
    console.error('[preflight] package.json -> build.files.');
    console.error('');
    return false;
}

function checkFlash(platform) {
    const { directory, found } = describeVendor(platform);

    if (found.length) {
        console.log(`[preflight] ${platform}: Flash ready -> ${found.join(', ')}`);
        warnIfArchUnsupported(platform, directory, found[0]);
        return true;
    }

    if (process.env.DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH === '1') {
        console.warn(`[preflight] ${platform}: no Flash plugin in vendor/ -- building anyway, DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.`);
        return true;
    }

    console.error('');
    console.error(`[preflight] ERROR: no Flash plugin for ${platform} in vendor/.`);
    console.error(`[preflight] Expected: ${directory}${path.sep}${EXPECTED[platform]}`);
    console.error('[preflight] A package without it cannot play: the packaged launcher refuses to start and');
    console.error('[preflight] names the build incomplete. Put the plugin in payload/flash/' + platform + '/ or run');
    console.error('[preflight] `npm run extract-flash` on this machine, then rebuild.');
    console.error('[preflight] A deliberate Flash-less package needs DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.');
    console.error('');
    return false;
}

function main() {
    const platform = parsePlatform(process.argv.slice(2));
    if (!EXPECTED[platform]) {
        console.error(`[preflight] Unknown platform: ${platform}`);
        console.error('[preflight] Expected one of: win32, darwin, linux');
        process.exit(1);
    }

    // Both run either way, so fixing one failure does not hide the other.
    const filesOk = checkPackagedFiles();
    const flashOk = checkFlash(platform);
    if (!filesOk || !flashOk) {
        process.exit(1);
    }
}

main();

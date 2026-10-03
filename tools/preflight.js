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
 * Usage: node tools/preflight.js [--platform win32|darwin|linux] [--arch x64|ia32]
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

/**
 * The architecture this invocation is building, if the caller named one.
 *
 * The two Windows architectures are built by two separate electron-builder runs, because
 * one run packaging both also emits a universal installer that doubles the download for
 * every updating player (see README "Releases"). The config therefore only lists x64, so
 * the arch has to come from the command line for this to check the ia32 run honestly.
 *
 * @param {string[]} argv
 * @returns {string} '' when no `--arch` was passed.
 */
function parseArch(argv) {
    const index = argv.indexOf('--arch');
    if (index >= 0 && argv[index + 1]) {
        return String(argv[index + 1]);
    }
    return '';
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

// A PPAPI plugin is loaded in-process, so the vendored plugin has to match the
// architecture of the package hosting it. Parse the binary headers and warn loudly rather
// than shipping a package whose Flash can never start.
//
// The Windows targets are x64 and ia32 together, so this compares against the
// architectures actually configured in package.json rather than an assumed x64: a
// plugin matching neither is a broken build, and a plugin matching only some of them
// leaves the rest installing and then refusing to play, which is the 32-bit situation
// documented in README "32-bit Windows".
function warnIfArchUnsupported(platform, directory, pluginName, arch) {
    const architectures = pluginArchitectures(path.join(directory, pluginName));
    if (!architectures.length) {
        return;
    }

    // One architecture per invocation, so the check is against what this run builds.
    const targets = arch ? [arch] : configuredArchitectures(platform);
    const matching = targets.filter((target) => architectures.includes(target));
    if (matching.length === targets.length) {
        return;
    }

    const unmatched = targets.filter((target) => !architectures.includes(target));

    if (!matching.length) {
        console.warn('');
        console.warn(
            `[preflight] WARNING: ${pluginName} supports only ${architectures.join('/')}, but the ${platform}`
        );
        console.warn(`[preflight] packages are ${targets.join('/')}. No build of this platform can load it.`);
        console.warn('[preflight] Produce a matching plugin and copy it into vendor/ with `npm run extract-flash`.');
        console.warn('');
        return;
    }

    console.warn('');
    console.warn(
        `[preflight] NOTE: ${pluginName} supports ${architectures.join('/')}, so the ${unmatched.join('/')} ` +
        `package${unmatched.length === 1 ? '' : 's'} for ${platform} install but cannot play.`
    );
    console.warn(`[preflight] The ${matching.join('/')} package is unaffected. See README "32-bit Windows".`);
    console.warn('');
}

/**
 * The architectures package.json builds for a platform, flattened across its targets.
 *
 * @param {string} platform
 * @returns {string[]} e.g. ['x64'] for win32. Only what the config itself names: the ia32
 *   Windows packages come from a second electron-builder run, not from this list.
 */
function configuredArchitectures(platform) {
    const buildConfig = require(path.join(LAUNCHER_ROOT, 'package.json')).build || {};
    const config = buildConfig[platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'];
    if (!config) {
        return [];
    }

    const targets = Array.isArray(config.target) ? config.target : [config.target];
    const architectures = new Set();

    for (const target of targets) {
        // A target is either a string ("nsis") or an object with its own arch list.
        const list = target && typeof target === 'object' ? target.arch : undefined;
        for (const arch of list || []) {
            architectures.add(arch);
        }
    }

    return Array.from(architectures);
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

function checkFlash(platform, arch) {
    const { directory, found } = describeVendor(platform);

    if (found.length) {
        console.log(`[preflight] ${platform}: Flash ready -> ${found.join(', ')}`);
        warnIfArchUnsupported(platform, directory, found[0], arch);
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
    console.error('[preflight] names the build incomplete. Put the plugin in payload/flash/<platform>/ or run');
    console.error('[preflight] `npm run extract-flash` on this machine, then rebuild.');
    console.error('[preflight] A deliberate Flash-less package needs DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.');
    console.error('');
    return false;
}

function main() {
    const argv = process.argv.slice(2);
    const platform = parsePlatform(argv);
    const arch = parseArch(argv);
    if (!EXPECTED[platform]) {
        console.error(`[preflight] Unknown platform: ${platform}`);
        console.error('[preflight] Expected one of: win32, darwin, linux');
        process.exit(1);
    }

    // Both run either way, so fixing one failure does not hide the other.
    const filesOk = checkPackagedFiles();
    const flashOk = checkFlash(platform, arch);
    if (!filesOk || !flashOk) {
        process.exit(1);
    }
}

main();

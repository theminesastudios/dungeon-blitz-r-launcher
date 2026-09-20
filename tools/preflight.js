#!/usr/bin/env node
'use strict';

/**
 * Reports whether the Flash plugin for a build's target platform is present in vendor/.
 *
 * A package built without it still runs -- the launcher falls back to scanning the
 * player's own Flash installs -- but most players have none, so a silent Flash-less
 * package is the easiest way to ship something that cannot play the game. This prints a
 * loud warning instead of failing, so a deliberate Flash-less build stays possible.
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
    win32: 'pepflashplayer64.dll (veya pepflashplayer.dll)',
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
        `[preflight] UYARI: ${pluginName} yalnizca ${architectures.join('/')} destekliyor, x64 yok.`
    );
    console.warn(`[preflight] ${platform} paketi x64; bu eklenti yuklenemez. x86_64 bir`);
    console.warn('[preflight] eklenti uretip `npm run extract-flash` ile vendor/ altina kopyalayin.');
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
        console.log('[preflight] Pakete dahil olmasi gereken dosyalar: tamam');
        return true;
    }

    console.error('');
    console.error(`[preflight] HATA: build.files su dosyalari paketlemiyor: ${missing.join(', ')}`);
    console.error('[preflight] Bu dosyalar olmadan paket calisir ama ozellikleri sessizce');
    console.error('[preflight] devre disi kalir. package.json -> build.files listesini duzelt.');
    console.error('');
    return false;
}

function main() {
    const platform = parsePlatform(process.argv.slice(2));
    if (!EXPECTED[platform]) {
        console.error(`[preflight] Bilinmeyen platform: ${platform}`);
        process.exit(1);
    }

    if (!checkPackagedFiles()) {
        process.exit(1);
    }

    const { directory, found } = describeVendor(platform);

    if (found.length) {
        console.log(`[preflight] ${platform}: Flash hazir -> ${found.join(', ')}`);
        warnIfArchUnsupported(platform, directory, found[0]);
        return;
    }

    console.warn('');
    console.warn(`[preflight] UYARI: ${platform} icin Flash eklentisi yok.`);
    console.warn(`[preflight] Beklenen: ${directory}${path.sep}${EXPECTED[platform]}`);
    console.warn('[preflight] Paket yine de uretilir, ama oyuncunun kendi Flash kurulumu');
    console.warn('[preflight] yoksa oyun acilmaz. Hedef platformda `npm run extract-flash`');
    console.warn('[preflight] calistirip tekrar paketle.');
    console.warn('');
}

main();

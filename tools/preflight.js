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

function main() {
    const platform = parsePlatform(process.argv.slice(2));
    if (!EXPECTED[platform]) {
        console.error(`[preflight] Bilinmeyen platform: ${platform}`);
        process.exit(1);
    }

    const { directory, found } = describeVendor(platform);

    if (found.length) {
        console.log(`[preflight] ${platform}: Flash hazir -> ${found.join(', ')}`);
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

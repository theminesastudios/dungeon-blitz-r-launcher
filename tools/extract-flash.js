#!/usr/bin/env node
'use strict';

/**
 * Copies the PPAPI Flash plugin out of a FlashBrowser installation into
 * `src/launcher/vendor/flash/<platform>/`, where the launcher and electron-builder both
 * look for it.
 *
 * FlashBrowser ships Flash 32.0.0.363 -- the last build before Adobe's 2021-01-12 kill
 * switch -- so it is the one copy that still plays content. The binary stays out of the
 * repository (vendor/ is gitignored); every machine extracts its own.
 *
 * Usage:
 *   node tools/extract-flash.js                       # find FlashBrowser automatically
 *   node tools/extract-flash.js --from <path>         # a FlashBrowser install or any folder
 *   node tools/extract-flash.js --platform darwin     # write into another platform's slot
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'flash');

const PLUGIN_NAMES = {
    win32: ['pepflashplayer64.dll', 'pepflashplayer32.dll', 'pepflashplayer.dll'],
    darwin: ['PepperFlashPlayer.plugin'],
    linux: ['libpepflashplayer.so']
};

function parseArgs(argv) {
    const args = { from: '', platform: process.platform, force: false };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--from') {
            args.from = String(argv[index + 1] || '');
            index += 1;
        } else if (token === '--platform') {
            args.platform = String(argv[index + 1] || '');
            index += 1;
        } else if (token === '--force') {
            args.force = true;
        }
    }

    return args;
}

function exists(candidate) {
    try {
        fs.statSync(candidate);
        return true;
    } catch {
        return false;
    }
}

function isDirectory(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function defaultInstallRoots() {
    if (process.platform === 'win32') {
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const localAppData = process.env.LOCALAPPDATA || '';
        const roots = [
            path.join(programFilesX86, 'FlashBrowser'),
            path.join(programFiles, 'FlashBrowser')
        ];
        if (localAppData) {
            roots.push(path.join(localAppData, 'Programs', 'FlashBrowser'));
        }
        return roots;
    }

    if (process.platform === 'darwin') {
        return [
            '/Applications/Flash Browser.app',
            '/Applications/FlashBrowser.app',
            path.join(os.homedir(), 'Applications', 'Flash Browser.app')
        ];
    }

    return ['/opt/FlashBrowser', '/usr/lib/flashbrowser', path.join(os.homedir(), '.local', 'share', 'FlashBrowser')];
}

/**
 * Walks a FlashBrowser install looking for any of the plugin names. The layout differs
 * between the Windows, macOS and Linux packages, so the search is by name rather than by
 * a hard-coded `resources/app/flashver` path.
 */
function findPlugin(root, wantedNames, depth = 0) {
    if (!isDirectory(root) || depth > 6) {
        return '';
    }

    let entries = [];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return '';
    }

    for (const entry of entries) {
        if (wantedNames.includes(entry.name)) {
            return path.join(root, entry.name);
        }
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        // Skipping the heaviest, plugin-free trees keeps the scan to a second or two.
        if (entry.name === 'node_modules' || entry.name === 'locales' || entry.name === 'swiftshader') {
            continue;
        }
        const found = findPlugin(path.join(root, entry.name), wantedNames, depth + 1);
        if (found) {
            return found;
        }
    }

    return '';
}

function copyRecursive(source, target) {
    if (isDirectory(source)) {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(target, entry));
        }
        return;
    }

    fs.copyFileSync(source, target);
}

function sha256(filePath) {
    if (isDirectory(filePath)) {
        return '';
    }
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readWindowsVersion(filePath) {
    if (process.platform !== 'win32' || isDirectory(filePath)) {
        return '';
    }

    try {
        const output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Item -LiteralPath ${JSON.stringify(filePath)}).VersionInfo.FileVersion`
            ],
            { encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
        return String(output || '').trim().replace(/,\s*/g, '.');
    } catch {
        return '';
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const wantedNames = PLUGIN_NAMES[args.platform];

    if (!wantedNames) {
        console.error(`[extract-flash] Unknown platform: ${args.platform}`);
        console.error('[extract-flash] Expected one of: win32, darwin, linux');
        process.exit(1);
    }

    const roots = args.from ? [args.from] : defaultInstallRoots();
    let source = '';

    for (const root of roots) {
        if (!exists(root)) {
            continue;
        }
        source = findPlugin(root, wantedNames);
        if (source) {
            break;
        }
    }

    if (!source) {
        console.error('[extract-flash] No Flash plugin found.');
        console.error(`[extract-flash] Looked for ${wantedNames.join(', ')} under:`);
        for (const root of roots) {
            console.error(`  - ${root}${exists(root) ? '' : ' (missing)'}`);
        }
        console.error('[extract-flash] Install FlashBrowser, or pass --from <folder>.');
        process.exit(1);
    }

    const targetDirectory = path.join(VENDOR_ROOT, args.platform);
    const target = path.join(targetDirectory, path.basename(source));

    if (exists(target) && !args.force) {
        console.log(`[extract-flash] Already extracted: ${target}`);
        console.log('[extract-flash] Pass --force to overwrite it.');
        return;
    }

    fs.mkdirSync(targetDirectory, { recursive: true });
    if (exists(target)) {
        fs.rmSync(target, { recursive: true, force: true });
    }
    copyRecursive(source, target);

    const version = readWindowsVersion(target);
    const digest = sha256(target);

    console.log(`[extract-flash] Source:  ${source}`);
    console.log(`[extract-flash] Target:  ${target}`);
    if (version) {
        console.log(`[extract-flash] Version: ${version}`);
    }
    if (digest) {
        console.log(`[extract-flash] SHA-256: ${digest}`);
    }

    // 32.0.0.371 and later carry Adobe's end-of-life timer; anything older still plays.
    if (version && /^32\.0\.0\.(3[7-9]\d|[4-9]\d\d)$/.test(version)) {
        console.warn('[extract-flash] WARNING: this build contains the 2021-01-12 kill switch.');
        console.warn('[extract-flash] Prefer a build older than 32.0.0.371 (FlashBrowser ships 32.0.0.363).');
    }
}

main();

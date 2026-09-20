'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Chromium dropped the PPAPI Flash host in 88, so the launcher ships on Electron 11
// (Chromium 87). The plugin binary never enters the repository -- tools/extract-flash.js
// pulls it out of a FlashBrowser install into vendor/, which is where a packaged build
// picks it up. Failing that we take one the player already has installed, and failing
// that they point at it by hand.

// Builds newer than this refuse to start on or after 2021-01-12 -- Adobe's end-of-life
// kill switch lives inside the plugin, so no launcher flag can turn it off.
const KILL_SWITCH_FIRST_BUILD = [32, 0, 0, 371];

const PLUGIN_FILENAME_PATTERN = /^(pepflashplayer|libpepflashplayer).*\.(dll|so)$/i;

// Where tools/extract-flash.js drops the plugin it pulls out of a FlashBrowser install.
// This is the copy a launcher ships with, so it always wins the scan. A packaged build
// carries it as an extra resource, because Chromium cannot load a plugin from inside the
// asar archive.
const VENDOR_DIRECTORIES = [];
if (process.resourcesPath) {
    VENDOR_DIRECTORIES.push(path.join(process.resourcesPath, 'vendor', 'flash', process.platform));
}
VENDOR_DIRECTORIES.push(path.join(__dirname, '..', 'vendor', 'flash', process.platform));

function fileExists(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function directoryExists(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function pluginFileNames() {
    if (process.platform === 'win32') {
        return ['pepflashplayer.dll', 'pepflashplayer64.dll'];
    }
    if (process.platform === 'darwin') {
        return ['PepperFlashPlayer.plugin'];
    }
    return ['libpepflashplayer.so'];
}

// A Macromed/PepperFlash directory holds one versioned file per install, so we take
// whatever matches rather than guessing the exact build in the name.
function pluginInDirectory(directory, depth = 0) {
    if (!directoryExists(directory)) {
        return '';
    }

    if (process.platform === 'darwin') {
        const bundle = path.join(directory, 'PepperFlashPlayer.plugin');
        if (directoryExists(bundle)) {
            return bundle;
        }
    }

    let entries = [];
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return '';
    }

    const matches = entries.filter((entry) => PLUGIN_FILENAME_PATTERN.test(entry)).sort();
    for (const match of matches) {
        const candidate = path.join(directory, match);
        if (fileExists(candidate)) {
            return candidate;
        }
    }

    if (depth >= 2) {
        return '';
    }

    // Chrome nests the plugin under a version directory; newest version sorts last.
    for (const entry of entries.sort().reverse()) {
        const nested = path.join(directory, entry);
        if (!directoryExists(nested)) {
            continue;
        }
        const nestedMatch = pluginInDirectory(nested, depth + 1);
        if (nestedMatch) {
            return nestedMatch;
        }
    }

    return '';
}

function windowsSearchDirectories() {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const directories = [
        path.join(systemRoot, 'System32', 'Macromed', 'Flash'),
        path.join(systemRoot, 'SysWOW64', 'Macromed', 'Flash')
    ];

    if (localAppData) {
        directories.push(
            path.join(localAppData, 'Google', 'Chrome', 'User Data', 'PepperFlash'),
            path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'PepperFlash'),
            path.join(localAppData, 'Chromium', 'User Data', 'PepperFlash')
        );
    }

    directories.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'PepperFlash'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'PepperFlash'),
        path.join(programFilesX86, 'Opera', 'PepperFlash')
    );

    return directories;
}

function macSearchDirectories() {
    const home = os.homedir();
    return [
        '/Library/Internet Plug-Ins/PepperFlashPlayer',
        '/Library/Internet Plug-Ins',
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'PepperFlash')
    ];
}

function linuxSearchDirectories() {
    const home = os.homedir();
    return [
        '/usr/lib/pepperflashplugin-nonfree',
        '/usr/lib/adobe-flashplugin',
        '/usr/lib/PepperFlash',
        '/opt/google/chrome/PepperFlash',
        path.join(home, '.config', 'google-chrome', 'PepperFlash')
    ];
}

function searchDirectories(extraDirectories) {
    const directories = VENDOR_DIRECTORIES.slice();
    if (Array.isArray(extraDirectories)) {
        directories.push(...extraDirectories);
    }

    if (process.platform === 'win32') {
        directories.push(...windowsSearchDirectories());
    } else if (process.platform === 'darwin') {
        directories.push(...macSearchDirectories());
    } else {
        directories.push(...linuxSearchDirectories());
    }

    return directories;
}

function versionFromManifest(pluginPath) {
    const manifestPath = path.join(path.dirname(pluginPath), 'manifest.json');
    if (!fileExists(manifestPath)) {
        return '';
    }

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return String(manifest.version || '').trim();
    } catch {
        return '';
    }
}

function versionFromFileName(pluginPath) {
    const match = path.basename(pluginPath).match(/(\d+)[._](\d+)[._](\d+)[._](\d+)/);
    return match ? `${match[1]}.${match[2]}.${match[3]}.${match[4]}` : '';
}

function versionFromWindowsMetadata(pluginPath) {
    if (process.platform !== 'win32') {
        return '';
    }

    try {
        const output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Item -LiteralPath ${JSON.stringify(pluginPath)}).VersionInfo.FileVersion`
            ],
            { encoding: 'utf8', timeout: 15000, windowsHide: true }
        );
        return String(output || '').trim().replace(/,\s*/g, '.');
    } catch {
        return '';
    }
}

function detectVersion(pluginPath) {
    return (
        versionFromManifest(pluginPath) ||
        versionFromFileName(pluginPath) ||
        versionFromWindowsMetadata(pluginPath) ||
        // Chromium only repeats this string back to the page; a plausible value still
        // loads the plugin when the real build number cannot be read.
        '32.0.0.363'
    );
}

function parseVersion(version) {
    const parts = String(version || '')
        .split('.')
        .map((part) => Number.parseInt(part, 10));
    while (parts.length < 4) {
        parts.push(0);
    }
    return parts.map((part) => (Number.isFinite(part) ? part : 0));
}

function hasKillSwitch(version) {
    const parsed = parseVersion(version);
    for (let index = 0; index < KILL_SWITCH_FIRST_BUILD.length; index += 1) {
        if (parsed[index] > KILL_SWITCH_FIRST_BUILD[index]) {
            return true;
        }
        if (parsed[index] < KILL_SWITCH_FIRST_BUILD[index]) {
            return false;
        }
    }
    return true;
}

function describe(pluginPath, source) {
    const version = detectVersion(pluginPath);
    return {
        path: pluginPath,
        version,
        source,
        killSwitch: hasKillSwitch(version)
    };
}

/**
 * Resolves the Flash plugin the launcher hands to Chromium.
 *
 * @param {{ preferredPath?: string, extraDirectories?: string[] }} options
 * @returns {{ path: string, version: string, source: string, killSwitch: boolean } | null}
 */
function findFlashPlugin(options = {}) {
    const preferred = String(options.preferredPath || '').trim();
    if (preferred) {
        if (fileExists(preferred) || (process.platform === 'darwin' && directoryExists(preferred))) {
            return describe(preferred, 'manual');
        }
        const inPreferredDirectory = pluginInDirectory(preferred);
        if (inPreferredDirectory) {
            return describe(inPreferredDirectory, 'manual');
        }
    }

    for (const directory of searchDirectories(options.extraDirectories)) {
        const candidate = pluginInDirectory(directory);
        if (candidate) {
            return describe(candidate, VENDOR_DIRECTORIES.includes(directory) ? 'vendor' : 'auto');
        }
    }

    return null;
}

module.exports = {
    VENDOR_DIRECTORIES,
    findFlashPlugin,
    hasKillSwitch,
    KILL_SWITCH_FIRST_BUILD
};

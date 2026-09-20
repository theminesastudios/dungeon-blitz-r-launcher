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

// A macOS PepperFlashPlayer.bundle carries its build number in CFBundleVersion. There is
// no manifest.json next to a FlashBrowser-extracted bundle, so without this the version
// would be a guess -- and the kill-switch check would never see the real build.
function versionFromMacBundle(pluginPath) {
    try {
        const infoPlist = path.join(pluginPath, 'Contents', 'Info.plist');
        const plist = fs.readFileSync(infoPlist, 'utf8');
        const match = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
        return match ? match[1].trim() : '';
    } catch {
        return '';
    }
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
        versionFromMacBundle(pluginPath) ||
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
    const architectures = pluginArchitectures(pluginPath);
    return {
        path: pluginPath,
        version,
        source,
        killSwitch: hasKillSwitch(version),
        architectures,
        archMismatch: architectures.length > 0 && !architectures.includes(process.arch)
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

// ---------------------------------------------------------------------------
// Architecture support
// ---------------------------------------------------------------------------

// The last Flash plugin is an Intel binary, and a PPAPI plugin is loaded in-process: it
// has to match the architecture of the Electron process. An arm64 launcher cannot load an
// x86_64 plugin -- arming succeeds, and the page just shows a dead plugin box. Parsing
// the binary headers lets the launcher and the packaging preflight warn about it up
// front instead.

const MACH_CPU_TYPES = new Map([
    [0x00000007, 'ia32'],
    [0x01000007, 'x64'],
    [0x0100000c, 'arm64']
]);
const PE_MACHINE_TYPES = new Map([
    [0x014c, 'ia32'],
    [0x8664, 'x64'],
    [0xaa64, 'arm64']
]);
const ELF_MACHINE_TYPES = new Map([
    [0x0003, 'ia32'],
    [0x003e, 'x64'],
    [0x00b7, 'arm64']
]);

function readBinaryHeader(filePath, bytes) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(bytes);
        const read = fs.readSync(descriptor, header, 0, bytes, 0);
        return header.subarray(0, read);
    } catch {
        return null;
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Nothing to recover; the header read already failed.
            }
        }
    }
}

function readMachOArchitectures(header) {
    if (header.length < 8) {
        return [];
    }

    const magic = header.readUInt32LE(0);
    if (magic === 0xfeedfacf) {
        const arch = MACH_CPU_TYPES.get(header.readUInt32LE(4));
        return arch ? [arch] : [];
    }

    // A universal binary carries one header entry per architecture, all big-endian.
    if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
        return [];
    }

    const entrySize = magic === 0xcafebabf ? 32 : 20;
    const count = header.readUInt32BE(4);
    const architectures = [];
    for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * entrySize;
        if (header.length < offset + 4) {
            break;
        }
        const arch = MACH_CPU_TYPES.get(header.readUInt32BE(offset));
        if (arch && !architectures.includes(arch)) {
            architectures.push(arch);
        }
    }
    return architectures;
}

function readPEArchitectures(header) {
    if (header.length < 0x40 || header.toString('ascii', 0, 2) !== 'MZ') {
        return [];
    }

    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > header.length || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
        return [];
    }

    const arch = PE_MACHINE_TYPES.get(header.readUInt16LE(peOffset + 4));
    return arch ? [arch] : [];
}

function readELFArchitectures(header) {
    if (header.length < 20 || header.toString('ascii', 0, 4) !== '\x7fELF') {
        return [];
    }

    const arch = ELF_MACHINE_TYPES.get(header.readUInt16LE(18));
    return arch ? [arch] : [];
}

function parseBinaryArchitectures(filePath) {
    // 4 KiB covers every fixed header above, including a PE optional header that sits
    // behind a DOS stub.
    const header = readBinaryHeader(filePath, 4096);
    if (!header) {
        return [];
    }

    // A format that matches returns its architectures; an empty result means "not this
    // format", so the remaining readers still get a look at the header.
    for (const read of [readMachOArchitectures, readPEArchitectures, readELFArchitectures]) {
        const architectures = read(header);
        if (architectures.length) {
            return architectures;
        }
    }
    return [];
}

function macBundleExecutable(pluginPath) {
    if (!directoryExists(pluginPath)) {
        return pluginPath;
    }

    const macOsDirectory = path.join(pluginPath, 'Contents', 'MacOS');
    let entries = [];
    try {
        entries = fs.readdirSync(macOsDirectory);
    } catch {
        return '';
    }

    // A plugin bundle has exactly one main executable; the first file in MacOS/ is it.
    for (const entry of entries) {
        const candidate = path.join(macOsDirectory, entry);
        if (fileExists(candidate)) {
            return candidate;
        }
    }
    return '';
}

/**
 * Architectures a Flash plugin binary supports, as process.arch names ('x64', 'arm64',
 * 'ia32'). Empty when the format is unknown -- a guess must never produce a warning.
 */
function pluginArchitectures(pluginPath) {
    const executable = macBundleExecutable(pluginPath);
    return executable ? parseBinaryArchitectures(executable) : [];
}

module.exports = {
    VENDOR_DIRECTORIES,
    findFlashPlugin,
    hasKillSwitch,
    pluginArchitectures,
    KILL_SWITCH_FIRST_BUILD
};

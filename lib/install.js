'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where this copy of the launcher is running from.
 *
 * A player who opens the app straight out of a mounted .dmg, or from the Downloads folder
 * it was unzipped into, is playing a copy that the next build silently replaces: the
 * launcher that "stopped working" is a stale one nobody noticed was stale. Detecting the
 * two places that happen and offering to move the app into place turns that into one click.
 */

const BUNDLE_SUFFIX = '.app';
// Both separators, so a path written for another platform still tells the truth about
// where it lives.
const SEPARATORS = /[\\/]+/;

/** The `.app` bundle root for a path inside one, or the path itself. */
function bundlePathOf(appPath) {
    const normalized = String(appPath || '').trim();
    const marker = `${BUNDLE_SUFFIX}/`;
    const index = normalized.replace(/\\/g, '/').indexOf(marker);
    if (index === -1) {
        return normalized;
    }
    return normalized.slice(0, index + BUNDLE_SUFFIX.length);
}

/** The last meaningful path segment, for either separator. */
function lastSegment(value) {
    const segments = String(value || '').split(SEPARATORS).filter(Boolean);
    return segments[segments.length - 1] || '';
}

function defaultApplicationsDir(platform) {
    if (platform === 'darwin') {
        return '/Applications';
    }
    if (platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs');
    }
    return path.join(os.homedir(), '.local', 'bin');
}

/**
 * @param {{ isPackaged: boolean, appPath: string, platform?: string, homeDir?: string,
 *           applicationsDir?: string }} options
 * @returns {{ relocate: boolean, reason: '' | 'disk-image' | 'downloads', bundlePath: string,
 *             targetPath: string, message: string }}
 */
function inspectInstallLocation({
    isPackaged,
    appPath,
    platform = process.platform,
    homeDir = os.homedir(),
    applicationsDir = defaultApplicationsDir(platform)
} = {}) {
    const bundlePath = bundlePathOf(appPath);
    const unchanged = { relocate: false, reason: '', bundlePath, targetPath: '', message: '' };

    // A development checkout is meant to be run in place.
    if (!isPackaged || !bundlePath) {
        return unchanged;
    }

    const normalizedPath = bundlePath.replace(/\\/g, '/');
    const segments = normalizedPath.split(SEPARATORS).filter(Boolean);
    const volumeMount = platform === 'darwin' && normalizedPath.startsWith('/Volumes/');
    const downloads = segments.includes('Downloads');
    // Only a macOS `.app` is something the launcher can pick up and put somewhere better;
    // an unpacked Windows or Linux folder is a warning, not a move.
    const portable = platform === 'darwin' && bundlePath.endsWith(BUNDLE_SUFFIX);
    const targetPath = portable ? path.join(applicationsDir, lastSegment(bundlePath)) : '';

    // An app that already sits where it would be moved to has nothing to fix.
    if (targetPath && path.resolve(bundlePath) === path.resolve(targetPath)) {
        return unchanged;
    }

    if (volumeMount) {
        return {
            relocate: true,
            reason: 'disk-image',
            bundlePath,
            targetPath,
            message:
                'The launcher is running from a mounted disk image. It will stop working once the ' +
                'image is ejected, and it cannot be updated in place.'
        };
    }

    if (downloads) {
        return {
            relocate: true,
            reason: 'downloads',
            bundlePath,
            targetPath,
            message: portable
                ? `The launcher is running from ${path.join(homeDir, 'Downloads')}. Copies left there are ` +
                  'easy to lose track of, and an outdated one cannot tell you it is outdated.'
                : 'The launcher is running from an unpacked Downloads copy. Install it properly so ' +
                  'the build you open is the build you have.'
        };
    }

    return unchanged;
}

function isWritableDirectory(directory) {
    try {
        fs.accessSync(directory, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function exists(target) {
    try {
        fs.accessSync(target, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    bundlePathOf,
    defaultApplicationsDir,
    lastSegment,
    exists,
    inspectInstallLocation,
    isWritableDirectory
};

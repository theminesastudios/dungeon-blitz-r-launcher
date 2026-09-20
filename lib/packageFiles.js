'use strict';

/**
 * The files a packaged launcher reads at runtime, and whether `build.files` actually ships
 * them.
 *
 * electron-builder only packs what `build.files` matches. A root file that is not matched
 * is simply absent from the app, and the feature it configures stops working in a way that
 * looks like a bug in the feature: `presence.config.json` missing means no Discord
 * application id, so rich presence silently never starts in the installed build while it
 * works fine in a checkout. `tools/preflight.js` fails the build over this.
 */

const REQUIRED_ROOT_FILES = ['main.js', 'preload.js', 'servers.json', 'social.config.json', 'presence.config.json'];

const REQUIRED_ROOT_DIRECTORIES = ['lib', 'renderer'];

/** Minimal glob matching for the patterns electron-builder accepts. */
function matchesPattern(filePath, pattern) {
    const escaped = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*');

    return new RegExp(`^${escaped}$`).test(filePath);
}

function isCovered(filePath, patterns) {
    return (Array.isArray(patterns) ? patterns : []).some((pattern) => matchesPattern(filePath, pattern));
}

/**
 * @returns {{ missingFiles: string[], missingDirectories: string[] }} what `build.files`
 *   would leave out of the package.
 */
function findUnpackagedFiles(patterns) {
    return {
        missingFiles: REQUIRED_ROOT_FILES.filter((file) => !isCovered(file, patterns)),
        missingDirectories: REQUIRED_ROOT_DIRECTORIES.filter(
            (directory) => !isCovered(`${directory}/index.js`, patterns) && !isCovered(`${directory}/**/*`, patterns)
        )
    };
}

module.exports = {
    REQUIRED_ROOT_DIRECTORIES,
    REQUIRED_ROOT_FILES,
    findUnpackagedFiles,
    isCovered,
    matchesPattern
};

#!/usr/bin/env node
'use strict';

/**
 * Checks that `build.files` in package.json still covers every file the launcher reads at
 * runtime.
 *
 * This is the failure that leaves no trace: a root config file that is not matched is not
 * packed, so the packaged app starts without it and the feature it configures simply does
 * nothing — rich presence with no application id, for instance. It works in a checkout and
 * not in the installed build, which is the hardest kind of report to act on.
 *
 * Usage: node tools/test-package-files.js
 */

const assert = require('assert');
const path = require('path');

const { REQUIRED_ROOT_FILES, findUnpackagedFiles, isCovered, matchesPattern } = require('../lib/packageFiles');

function main() {
    // Glob behaviour, so the check itself can be trusted.
    assert.strictEqual(matchesPattern('presence.config.json', '*.config.json'), true);
    assert.strictEqual(matchesPattern('lib/presence.js', 'lib/**/*'), true);
    assert.strictEqual(matchesPattern('lib/nested/deep.js', 'lib/**/*'), true);
    assert.strictEqual(matchesPattern('renderer/assets/logo.svg', 'renderer/**/*'), true);
    assert.strictEqual(matchesPattern('servers.json', 'lib/**/*'), false);
    assert.strictEqual(matchesPattern('README.md', 'servers.json'), false);
    assert.strictEqual(isCovered('preload.js', ['main.js', 'preload.js']), true);

    // The shipping configuration: every runtime file must be matched by it.
    const buildConfig = require(path.join(__dirname, '..', 'package.json')).build || {};
    const { missingFiles, missingDirectories } = findUnpackagedFiles(buildConfig.files);
    assert.deepStrictEqual(
        { missingFiles, missingDirectories },
        { missingFiles: [], missingDirectories: [] },
        `package.json build.files must ship ${REQUIRED_ROOT_FILES.join(', ')} and lib/ + renderer/`
    );

    console.log('[test-package-files] every runtime file is covered by build.files');
    console.log('[test-package-files] all assertions passed');
}

main();

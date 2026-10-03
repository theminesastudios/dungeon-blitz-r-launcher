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

    // Each Windows target names exactly one architecture, and both architectures are
    // present. This is the difference between two packages and three.
    //
    // A target listing `["x64", "ia32"]` also produces a *universal* installer carrying
    // both, which is what 1.0.12 shipped: `latest.yml` pointed at that ~135 MB build, so
    // every x64 player updating from 1.0.11 downloaded roughly twice what they needed.
    // Naming one architecture per target drops the universal package and leaves
    // `latest.yml` pointing at win-x64-setup.exe.
    //
    // Nothing else would catch a regression here: the build still succeeds, both
    // architectures still appear in the release, and the cost only shows up in an
    // existing player's update download.
    const winTargets = buildConfig.win.target;

    for (const entry of winTargets) {
        assert.strictEqual(
            Array.isArray(entry.arch) && entry.arch.length,
            1,
            `every build.win target must name exactly one architecture, got ${JSON.stringify(entry.arch)}`
        );
    }

    // Every architecture each target type is built for, so dropping one is caught here.
    for (const target of ['nsis', 'portable']) {
        const built = winTargets
            .filter((entry) => entry.target === target)
            .map((entry) => entry.arch[0])
            .sort();

        assert.deepStrictEqual(
            built,
            ['ia32', 'x64'],
            `${target} must be built for both x64 and ia32, one target each`
        );
    }

    console.log('[test-package-files] every runtime file is covered by build.files');
    console.log('[test-package-files] Windows targets are per-architecture, so no universal installer is built');
    console.log('[test-package-files] all assertions passed');
}

main();

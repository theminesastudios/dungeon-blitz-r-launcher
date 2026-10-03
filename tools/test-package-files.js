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
const fs = require('fs');
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

    // Each Windows target names exactly one architecture, and the 32-bit installers come
    // from a separate electron-builder run rather than from this config.
    //
    // electron-builder emits a universal installer whenever a single run packages more
    // than one architecture -- `NsisTarget.finishBuild()` always adds the combined build,
    // and per-architecture ones only on top of it. Splitting the target entries does not
    // stop that; it is the number of architectures in one *invocation* that matters.
    //
    // So build.win configures x64 only, and the workflow runs `--win --ia32` separately.
    // Both arches in this file would put them back in one run, which is what 1.0.12 did:
    // a ~135 MB universal installer that latest.yml pointed at, so every x64 player
    // updating from 1.0.11 downloaded roughly twice what they needed.
    const winTargets = buildConfig.win.target;

    for (const entry of winTargets) {
        assert.strictEqual(
            Array.isArray(entry.arch) && entry.arch.length,
            1,
            `every build.win target must name exactly one architecture, got ${JSON.stringify(entry.arch)}`
        );
        assert.strictEqual(
            entry.arch[0],
            'x64',
            `build.win must configure x64 only; ia32 is a separate run. Found ${entry.arch[0]}`
        );
    }

    // Both installer types still have to be produced for x64.
    assert.deepStrictEqual(
        winTargets.map((entry) => entry.target).sort(),
        ['nsis', 'portable'],
        'build.win must produce an nsis and a portable installer'
    );

    // And the ia32 run has to exist in the workflow, or 32-bit silently stops shipping.
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

    // Every Windows run must pin its architecture with the per-target `name:arch` suffix.
    // A bare `--win --ia32` does NOT override `build.win`: the flag says which arches are
    // *requested*, the config still says x64, and the run packages both -- which is what
    // 1.0.14 shipped, universal installer included.
    const windowsRuns = [...workflow.matchAll(/builder_args:\s*--win\s+([^\n]*)/g)].map((match) => match[1].trim());
    assert.strictEqual(windowsRuns.length, 2, 'release.yml must have exactly two Windows runs, x64 and ia32');

    for (const args of windowsRuns) {
        // Exactly one architecture, applied to both targets: mixing them would rebuild the
        // universal installer, and naming neither falls back to build.win.
        const named = [...args.matchAll(/\b(?:nsis|portable):(\w+)/g)].map((match) => match[1]);
        assert.strictEqual(named.length, 2, `a Windows run must name both targets explicitly, got "${args}"`);
        assert.strictEqual(
            new Set(named).size,
            1,
            `one run must build exactly one architecture, got "${args}"`
        );
        assert.ok(
            ['x64', 'ia32'].includes(named[0]),
            `unknown architecture in "${args}"`
        );
        assert.ok(
            !/--ia32\b|--x64\b/.test(args),
            `use the nsis:<arch> suffix, not --ia32/--x64: the flag does not override build.win. Got "${args}"`
        );
    }

    // And the two runs must be the two different architectures.
    assert.deepStrictEqual(
        windowsRuns.map((args) => args.match(/nsis:(\w+)/)[1]).sort(),
        ['ia32', 'x64'],
        'the two Windows runs must cover both architectures, one each'
    );

    // Both Windows jobs upload artifacts, and actions/upload-artifact rejects a duplicate
    // name within one workflow run -- so the two Windows entries must not share one.
    const artifactNames = [...workflow.matchAll(/name:\s*launcher-\$\{\{\s*matrix\.platform\s*\}\}([^\n]*)/g)]
        .map((match) => (match[1] || '').trim());
    for (const name of artifactNames) {
        assert.ok(
            name.includes('matrix.arch'),
            `the Windows artifact name must include matrix.arch, or both Windows jobs collide: "${name}"`
        );
    }

    console.log('[test-package-files] every runtime file is covered by build.files');
    console.log('[test-package-files] Windows arches are built one per run, so no universal installer is built');
    console.log('[test-package-files] all assertions passed');
}

main();

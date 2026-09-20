#!/usr/bin/env node
'use strict';

/**
 * Checks where the launcher decides it is running from, and what it offers to do about it.
 * A copy opened from a mounted .dmg or from Downloads is how a stale build ends up being
 * the one a player keeps opening.
 *
 * Usage: node tools/test-install-location.js
 */

const assert = require('assert');

const { bundlePathOf, inspectInstallLocation } = require('../lib/install');

function main() {
    // The `.app` root is what a move has to copy, wherever inside the bundle the path points.
    assert.strictEqual(
        bundlePathOf('/Applications/Dungeon Blitz R.app/Contents/Resources/app.asar'),
        '/Applications/Dungeon Blitz R.app'
    );
    assert.strictEqual(bundlePathOf('/Applications/Dungeon Blitz R.app'), '/Applications/Dungeon Blitz R.app');
    assert.strictEqual(bundlePathOf('/Users/player/project'), '/Users/player/project');

    // An installed copy is left alone.
    assert.deepStrictEqual(
        inspectInstallLocation({
            isPackaged: true,
            appPath: '/Applications/Dungeon Blitz R.app/Contents/Resources/app.asar',
            platform: 'darwin'
        }),
        {
            relocate: false,
            reason: '',
            bundlePath: '/Applications/Dungeon Blitz R.app',
            targetPath: '',
            message: ''
        }
    );

    // A development checkout is left alone even when it sits in Downloads: it is run in
    // place on purpose.
    const dev = inspectInstallLocation({
        isPackaged: false,
        appPath: '/Users/player/Downloads/dungeon-blitz-r-launcher/lib/../main.js',
        platform: 'darwin'
    });
    assert.strictEqual(dev.relocate, false);

    // A mounted disk image: the copy disappears when the image is ejected.
    const diskImage = inspectInstallLocation({
        isPackaged: true,
        appPath: '/Volumes/Dungeon Blitz R/Dungeon Blitz R.app/Contents/Resources/app.asar',
        platform: 'darwin'
    });
    assert.strictEqual(diskImage.relocate, true);
    assert.strictEqual(diskImage.reason, 'disk-image');
    assert.strictEqual(diskImage.bundlePath, '/Volumes/Dungeon Blitz R/Dungeon Blitz R.app');
    assert.strictEqual(diskImage.targetPath, '/Applications/Dungeon Blitz R.app');
    assert.ok(diskImage.message.includes('disk image'));

    // An unzipped copy in Downloads, which is where a player would drag it from.
    const downloads = inspectInstallLocation({
        isPackaged: true,
        appPath: '/Users/player/Downloads/Dungeon Blitz R.app/Contents/Resources/app.asar',
        platform: 'darwin',
        homeDir: '/Users/player'
    });
    assert.strictEqual(downloads.relocate, true);
    assert.strictEqual(downloads.reason, 'downloads');
    assert.strictEqual(downloads.targetPath, '/Applications/Dungeon Blitz R.app');
    assert.ok(downloads.message.includes('Downloads'));

    // Somewhere else entirely -- a USB stick, a second drive -- is not guessed at.
    const elsewhere = inspectInstallLocation({
        isPackaged: true,
        appPath: '/Users/player/Games/Dungeon Blitz R.app/Contents/Resources/app.asar',
        platform: 'darwin'
    });
    assert.strictEqual(elsewhere.relocate, false);

    // Windows and Linux have no .app bundle; the same Downloads rule applies to the folder
    // the app was unpacked into.
    const windows = inspectInstallLocation({
        isPackaged: true,
        appPath: 'C:\\Users\\player\\Downloads\\Dungeon Blitz R\\resources\\app.asar',
        platform: 'win32',
        applicationsDir: 'C:\\Users\\player\\Programs'
    });
    assert.strictEqual(windows.relocate, true);
    assert.strictEqual(windows.reason, 'downloads');
    assert.strictEqual(windows.targetPath, '', 'only a macOS .app is offered a move');
    assert.ok(windows.message.includes('unpacked'));

    console.log('[test-install-location] disk images and Downloads copies are flagged, installs and checkouts are not');
    console.log('[test-install-location] all assertions passed');
}

main();

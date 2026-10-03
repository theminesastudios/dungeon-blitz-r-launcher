#!/usr/bin/env node
'use strict';

/**
 * Checks which Windows the launcher supports and what it switches on for the ones it does.
 *
 * Every Windows version is described from its `os.release()` string, so the whole matrix
 * runs on any machine: no Windows, no Electron runtime, no network. That matters more than
 * usual here, because the versions being pinned down (7, 8, Vista) are exactly the ones a
 * CI runner cannot be.
 *
 * Usage: node tools/test-windows-support.js
 */

const assert = require('assert');

const {
    LEGACY_REQUIREMENTS,
    MINIMUM_WINDOWS,
    WINDOWS_7_SERVICE_PACK_1_BUILD,
    compatibilitySwitches,
    describeWindows,
    unsupportedWindowsMessage
} = require('../lib/windowsSupport');

const WIN32 = 'win32';
const SOFTWARE_SWITCHES = ['use-gl=swiftshader', 'disable-gpu-compositing'];

function switchList(options) {
    return compatibilitySwitches(options).map(({ name, value }) => (value ? `${name}=${value}` : name));
}

function main() {
    // Anything that is not Windows is left alone: there is nothing to classify and nothing
    // to switch on, and a build for macOS must not start reading Windows versions.
    for (const platform of ['darwin', 'linux']) {
        const status = describeWindows({ platform, release: '10.0.22631' });
        assert.strictEqual(status.supported, true);
        assert.strictEqual(status.legacy, false);
        assert.strictEqual(status.product, '');
        assert.strictEqual(status.softwareRendering, false);
        assert.strictEqual(status.reason, '');
        assert.deepStrictEqual(switchList({ platform, release: '10.0.22631' }), []);
    }

    // Windows 7 Service Pack 1 is the floor, and the reason this exists: Electron 11 is old
    // enough to still run on it.
    const windows7 = describeWindows({ platform: WIN32, release: '6.1.7601' });
    assert.strictEqual(windows7.supported, true);
    assert.strictEqual(windows7.product, 'Windows 7 SP1');
    assert.strictEqual(windows7.legacy, true);
    assert.strictEqual(windows7.softwareRendering, true, 'legacy Windows renders in software');
    assert.strictEqual(windows7.build, 7601);
    assert.strictEqual(windows7.reason, '', 'a supported Windows has nothing to complain about');
    assert.strictEqual(windows7.requirements, LEGACY_REQUIREMENTS);
    assert.deepStrictEqual(switchList({ platform: WIN32, release: '6.1.7601' }), SOFTWARE_SWITCHES);

    // Service Pack 1 is the build that carries the platform update and the C runtime, so
    // the RTM build is refused by name rather than left to fail on start.
    const windows7Rtm = describeWindows({ platform: WIN32, release: '6.1.7600' });
    assert.strictEqual(windows7Rtm.supported, false);
    assert.strictEqual(windows7Rtm.product, 'Windows 7 (no Service Pack 1)');
    assert.ok(windows7Rtm.reason.includes('Service Pack 1'), windows7Rtm.reason);
    assert.ok(windows7Rtm.requirements.includes(MINIMUM_WINDOWS));
    assert.strictEqual(windows7Rtm.softwareRendering, false, 'a refused Windows never gets as far as rendering');
    assert.deepStrictEqual(switchList({ platform: WIN32, release: '6.1.7600' }), []);

    // Windows 8 and 8.1 are supported: Electron dropped 7/8/8.1 only in version 23.
    const windows8 = describeWindows({ platform: WIN32, release: '6.2.9200' });
    assert.strictEqual(windows8.supported, true);
    assert.strictEqual(windows8.product, 'Windows 8');
    assert.deepStrictEqual(switchList({ platform: WIN32, release: '6.2.9200' }), SOFTWARE_SWITCHES);

    const windows81 = describeWindows({ platform: WIN32, release: '6.3.9600' });
    assert.strictEqual(windows81.supported, true);
    assert.strictEqual(windows81.product, 'Windows 8.1');
    assert.strictEqual(windows81.softwareRendering, true);

    // Vista is not, and neither is anything older than the table.
    const vista = describeWindows({ platform: WIN32, release: '6.0.6002' });
    assert.strictEqual(vista.supported, false);
    assert.strictEqual(vista.product, 'Windows Vista');
    assert.ok(vista.reason.includes(MINIMUM_WINDOWS), vista.reason);

    const xp = describeWindows({ platform: WIN32, release: '5.1.2600' });
    assert.strictEqual(xp.supported, false);
    assert.strictEqual(xp.product, 'Windows 5.1');
    assert.ok(xp.reason.includes(MINIMUM_WINDOWS), xp.reason);

    // Windows 10 and 11 both report a 10.0 kernel, and neither is legacy: the software
    // fallback would cost real frames there to solve a problem they do not have.
    for (const release of ['10.0.19045', '10.0.22631']) {
        const windows10 = describeWindows({ platform: WIN32, release });
        assert.strictEqual(windows10.supported, true);
        assert.strictEqual(windows10.product, 'Windows 10 or later');
        assert.strictEqual(windows10.legacy, false);
        assert.strictEqual(windows10.softwareRendering, false);
        assert.strictEqual(windows10.requirements, '');
        assert.deepStrictEqual(switchList({ platform: WIN32, release }), []);
    }

    // A version that cannot be read is refused rather than assumed modern: guessing here
    // is how a player ends up on a launcher that cannot start with no way to tell why.
    for (const release of ['', 'not-a-version', '10']) {
        const unknown = describeWindows({ platform: WIN32, release });
        assert.strictEqual(unknown.supported, false, `"${release}" must not read as supported`);
        assert.ok(unknown.reason.includes('could not be read'), unknown.reason);
        assert.deepStrictEqual(switchList({ platform: WIN32, release }), []);
    }

    // A player on a legacy machine that does have the platform update can keep the GPU,
    // which is the one of these two answers a player is allowed to pick wrongly.
    for (const gpu of ['hardware', 'HARDWARE', ' on ', '1']) {
        assert.deepStrictEqual(switchList({ platform: WIN32, release: '6.1.7601', gpu }), [], `gpu=${gpu}`);
    }
    // Anything else keeps the software fallback, including no preference at all.
    for (const gpu of ['', 'software', '0', 'off', 'garbage']) {
        assert.deepStrictEqual(switchList({ platform: WIN32, release: '6.1.7601', gpu }), SOFTWARE_SWITCHES, `gpu=${gpu}`);
    }

    // The refusal text names the floor, the machine it refused, and the two things that
    // are not optional: 64-bit, because the Flash plugin is x86_64 and in-process, and the
    // C runtime, without which there is no dialog to show at all.
    const message = unsupportedWindowsMessage(vista);
    assert.ok(message.includes(MINIMUM_WINDOWS), message);
    assert.ok(message.includes('Windows Vista'), message);
    assert.ok(message.includes('6.0.6002'), message);
    assert.ok(message.includes('64-bit'), message);
    assert.ok(message.includes('KB2999226'), message);

    // The same text works for a version that could not be read at all.
    const unknownMessage = unsupportedWindowsMessage(describeWindows({ platform: WIN32, release: '' }));
    assert.ok(unknownMessage.includes(MINIMUM_WINDOWS), unknownMessage);

    assert.strictEqual(WINDOWS_7_SERVICE_PACK_1_BUILD, 7601, 'the service pack build this pins');

    console.log('[test-windows-support] Windows 7, 8 and 8.1 are supported with software rendering');
    console.log('[test-windows-support] Vista, XP and unreadable versions are refused by name');
    console.log('[test-windows-support] all assertions passed');
}

main();
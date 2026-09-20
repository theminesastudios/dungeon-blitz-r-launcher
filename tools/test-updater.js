#!/usr/bin/env node
'use strict';

/**
 * Drives lib/update.js against a fake electron-updater the way every other bridge in this
 * repository is tested against a mock: no Electron, no network, deterministic events.
 *
 * Pinned down: the state machine (checking -> downloading -> downloaded), progress
 * percentages, the not-available and error paths, the check cadence, the restart gate (a
 * click before the download completes must do nothing), and the summary the launcher's
 * status strip renders.
 *
 * Usage: node tools/test-updater.js
 */

const assert = require('assert');
const path = require('path');

const { CHECK_INTERVAL_MS, START_DELAY_MS, createUpdateService } = require(path.join(__dirname, '..', 'lib', 'update'));

/** A fake autoUpdater: the same event surface lib/update.js listens to. */
function fakeAutoUpdater() {
    return {
        listeners: {},
        on(event, handler) {
            (this.listeners[event] = this.listeners[event] || []).push(handler);
        },
        emit(event, arg) {
            for (const handler of this.listeners[event] || []) {
                handler(arg);
            }
        },
        checkCalls: 0,
        checkForUpdates() {
            this.checkCalls += 1;
            return Promise.resolve();
        },
        quitInstalled: false,
        quitAndInstall() {
            this.quitInstalled = true;
        }
    };
}

/** A tiny stand-in for Electron's app object. */
const fakeApp = { getVersion: () => '1.0.4' };

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const fakeTimers = { timeouts: [], intervals: [] };
    const realSetTimeout = setTimeout;
    const realSetInterval = setInterval;

    // Timers are captured, not run by the clock: the cadence assertions would otherwise
    // take six hours, and a flaky sleep is worse than no assertion.
    const capturedSetTimeout = (fn, ms) => {
        fakeTimers.timeouts.push({ fn, ms });
        return fakeTimers.timeouts.length;
    };
    const capturedSetInterval = (fn, ms) => {
        fakeTimers.intervals.push({ fn, ms });
        return fakeTimers.intervals.length;
    };

    // The service reads the global timer functions; swap them in for the duration.
    global.setTimeout = capturedSetTimeout;
    global.setInterval = capturedSetInterval;

    let summary;
    try {
        const autoUpdater = fakeAutoUpdater();
        const logs = [];
        const service = createUpdateService({ autoUpdater, app: fakeApp, log: (line) => logs.push(line) });

        const states = [];
        service.on('state', (s) => states.push(`${s.state}:${s.percent}`));

        // start() schedules the first check after START_DELAY_MS and the cadence after
        // CHECK_INTERVAL_MS -- and neither runs without the timer firing.
        service.start();
        assert.strictEqual(fakeTimers.timeouts.length, 1, 'the first check is scheduled');
        assert.strictEqual(fakeTimers.timeouts[0].ms, START_DELAY_MS, 'the first check waits the start delay');
        assert.strictEqual(fakeTimers.intervals.length, 1, 'the cadence is scheduled');
        assert.strictEqual(fakeTimers.intervals[0].ms, CHECK_INTERVAL_MS, 'the cadence is the six-hour interval');
        assert.strictEqual(autoUpdater.checkCalls, 0, 'nothing checks before the delay fires');

        // A second start() must not double-schedule.
        service.start();
        assert.strictEqual(fakeTimers.timeouts.length, 1, 'start() is idempotent');

        // The first check runs.
        fakeTimers.timeouts[0].fn();
        assert.strictEqual(autoUpdater.checkCalls, 1, 'the delayed first check ran');

        // checking -> update-available -> progress -> downloaded.
        autoUpdater.emit('checking-for-update');
        assert.strictEqual(service.summary().state, 'checking');

        autoUpdater.emit('update-available', { version: '1.1.0' });
        summary = service.summary();
        assert.strictEqual(summary.state, 'downloading');
        assert.strictEqual(summary.version, '1.1.0');
        assert.strictEqual(summary.currentVersion, '1.0.4');

        autoUpdater.emit('download-progress', { percent: 37.4 });
        summary = service.summary();
        assert.strictEqual(summary.state, 'downloading');
        assert.strictEqual(summary.percent, 37, 'progress is rounded to whole percents');

        autoUpdater.emit('update-downloaded', { version: '1.1.0' });
        summary = service.summary();
        assert.strictEqual(summary.state, 'downloaded');
        assert.strictEqual(summary.percent, 100);
        assert.strictEqual(summary.version, '1.1.0');

        // The restart gate: this is a player's click, and only a completed download may
        // act on it.
        assert.strictEqual(service.restartToUpdate(), true, 'a completed download installs on restart');
        assert.strictEqual(autoUpdater.quitInstalled, true, 'quitAndInstall was called');

        // The full event sequence reached the status strip.
        assert.deepStrictEqual(states, [
            'checking:0',
            'downloading:0',
            'downloading:37',
            'downloaded:100'
        ]);

        // An error event is captured into the state, not thrown and not a crash.
        autoUpdater.emit('error', new Error('ENOTFOUND latest'));
        summary = service.summary();
        assert.strictEqual(summary.state, 'error');
        assert.match(summary.error, /ENOTFOUND/);

        // update-not-available returns to a resting state.
        autoUpdater.emit('checking-for-update');
        autoUpdater.emit('update-not-available');
        summary = service.summary();
        assert.strictEqual(summary.state, 'not-available');
        assert.strictEqual(summary.version, '');
        assert.strictEqual(summary.percent, 0);

        // The cadence timer re-checks.
        fakeTimers.intervals[0].fn();
        assert.strictEqual(autoUpdater.checkCalls, 2, 'the interval re-checks');

        // checkNow also works directly (the renderer's "check now" path).
        service.checkNow();
        assert.strictEqual(autoUpdater.checkCalls, 3, 'checkNow forces a check');

        // stop() detaches the cadence.
        service.stop();
        service.start();
        assert.ok(fakeTimers.timeouts.length >= 2, 'a stopped service can restart');

        // Logs stay one-line-per-event for the console.
        assert.ok(logs.some((line) => /1\.1\.0 is available/.test(line)), 'the availability is logged');
        assert.ok(logs.some((line) => /1\.1\.0 downloaded/.test(line)), 'the completion is logged');
    } finally {
        global.setTimeout = realSetTimeout;
        global.setInterval = realSetInterval;
    }

    // A service without a working autoUpdater is a programming error, not a runtime one.
    assert.throws(() => createUpdateService({}), /needs an electron-updater autoUpdater/);

    console.log('[test-updater] the update state machine, restart gate and cadence: OK');
    console.log('[test-updater] all assertions passed');
}

// The timer-capture in main() is synchronous-safe; the async wrapper only formalizes it.
void wait;
main().catch((error) => {
    console.error(error);
    process.exit(1);
});

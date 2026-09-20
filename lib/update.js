'use strict';

/**
 * Auto-update service around electron-updater.
 *
 * electron-updater itself is injected, not required: the module is tested against a fake
 * (tools/test-updater.js) the same way the rest of the launcher's bridges are tested
 * against mocks, without an Electron runtime.
 *
 * The behaviour a player sees: the launcher checks GitHub's releases for a newer version
 * a few seconds after start and then every six hours, downloads one in the background and
 * says so in the status strip -- never forcing a restart while the game might be running.
 * electron-updater's own autoInstallOnAppQuit stays on as the floor: if the player never
 * clicks "restart to update", the new version still lands on the next quit.
 *
 * Known limits, stated where they bite:
 *  - GitHub's provider cannot see draft releases; the update feed becomes visible only
 *    once the release is published (see the note in .github/workflows/release.yml).
 *  - macOS updates require the app to be code-signed. These builds are unsigned, so on
 *    macOS the check reports an error and is skipped -- Windows (NSIS) and Linux
 *    (AppImage) do work unsigned.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const START_DELAY_MS = 5000;

function createUpdateService({ autoUpdater, app, log = () => {} } = {}) {
    if (!autoUpdater || typeof autoUpdater.on !== 'function' || typeof autoUpdater.checkForUpdates !== 'function') {
        throw new Error('createUpdateService needs an electron-updater autoUpdater');
    }

    const service = {
        // One of: idle, checking, downloading, downloaded, not-available, error
        state: 'idle',
        percent: 0,
        version: '',
        error: '',
        lastCheckedAt: 0
    };

    const listeners = new Map();
    function emit(event) {
        const handlers = listeners.get(event) || [];
        for (const handler of handlers) {
            handler(summary());
        }
        if (event !== 'state') {
            emit('state');
        }
    }
    function on(event, handler) {
        if (!listeners.has(event)) {
            listeners.set(event, []);
        }
        listeners.get(event).push(handler);
        return () => {
            const handlers = listeners.get(event) || [];
            const index = handlers.indexOf(handler);
            if (index >= 0) {
                handlers.splice(index, 1);
            }
        };
    }

    function patch(fields) {
        Object.assign(service, fields);
    }

    function summary() {
        return {
            state: service.state,
            percent: service.percent,
            version: service.version,
            error: service.error,
            currentVersion: app && typeof app.getVersion === 'function' ? app.getVersion() : '',
            lastCheckedAt: service.lastCheckedAt
        };
    }

    autoUpdater.on('checking-for-update', () => {
        patch({ state: 'checking', error: '' });
        emit('checking');
    });
    autoUpdater.on('update-available', (info) => {
        patch({ state: 'downloading', version: String((info && info.version) || ''), percent: 0 });
        log(`[Update] ${service.version} is available; downloading in the background.`);
        emit('available');
    });
    autoUpdater.on('update-not-available', () => {
        patch({ state: 'not-available', version: '', percent: 0 });
        emit('not-available');
    });
    autoUpdater.on('download-progress', (progress) => {
        patch({ state: 'downloading', percent: Math.min(100, Math.round((progress && progress.percent) || 0)) });
        emit('progress');
    });
    autoUpdater.on('update-downloaded', (info) => {
        patch({ state: 'downloaded', version: String((info && info.version) || service.version), percent: 100 });
        log(`[Update] ${service.version} downloaded; restart to install.`);
        emit('downloaded');
    });
    autoUpdater.on('error', (error) => {
        // Not a player-facing problem: unsigned macOS builds always land here, and an
        // offline moment should never read as a launcher fault. Kept in the state so the
        // status strip can show it in the detail hover.
        patch({ state: 'error', error: String((error && error.message) || error) });
        log(`[Update] check failed: ${service.error}`);
        emit('error');
    });

    let started = false;
    let timer = null;

    function check() {
        // A game in progress does not pause the check: the download is background and the
        // install only happens on quit or on the player's click.
        service.lastCheckedAt = Date.now();
        const result = autoUpdater.checkForUpdates();
        return result && typeof result.catch === 'function' ? result.catch(() => {}) : result;
    }

    return {
        on,
        summary,
        start() {
            if (started) {
                return;
            }
            started = true;
            const startTimer = setTimeout(check, START_DELAY_MS);
            if (typeof startTimer.unref === 'function') {
                startTimer.unref();
            }
            timer = setInterval(check, CHECK_INTERVAL_MS);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            started = false;
        },
        checkNow: check,
        // Restart is the player's click, never a timer: the game window might be open.
        restartToUpdate() {
            if (service.state !== 'downloaded') {
                return false;
            }
            autoUpdater.quitAndInstall();
            return true;
        }
    };
}

module.exports = { CHECK_INTERVAL_MS, START_DELAY_MS, createUpdateService };

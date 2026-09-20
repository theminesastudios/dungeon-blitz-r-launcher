'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The device token that keeps a player signed in between launches.
 *
 * It is a bearer credential for a game account, so it does not go in `launcher-state.json`
 * beside the window bounds: its own file, written 0600, the same treatment the Social SDK's
 * token cache gets. Nothing else in the launcher reads it.
 *
 * Every read is defensive. A corrupt or hand-edited file means "no saved sign-in", which costs
 * the player one Discord login -- never a crash on startup.
 */
function createSessionCache(cachePath) {
    function read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            const token = String((parsed && parsed.token) || '').trim();
            if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
                return { token: '', email: '', savedAt: 0 };
            }
            return {
                token,
                email: String((parsed && parsed.email) || '').trim(),
                savedAt: Number.isFinite(parsed && parsed.savedAt) ? parsed.savedAt : 0
            };
        } catch {
            return { token: '', email: '', savedAt: 0 };
        }
    }

    function write(token, email) {
        const value = {
            token: String(token || '').trim(),
            email: String(email || '').trim(),
            savedAt: Date.now()
        };
        if (!value.token) {
            clear();
            return { token: '', email: '', savedAt: 0 };
        }

        try {
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            const tempPath = `${cachePath}.${process.pid}.tmp`;
            fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            fs.renameSync(tempPath, cachePath);
        } catch {
            // A token that cannot be saved is a sign-in that has to be repeated later, which
            // is the behaviour this whole file is replacing -- not a reason to fail now.
        }
        return value;
    }

    function clear() {
        try {
            fs.rmSync(cachePath, { force: true });
        } catch {
            // Already gone, or not ours to remove.
        }
    }

    return { path: cachePath, read, write, clear };
}

module.exports = { createSessionCache };

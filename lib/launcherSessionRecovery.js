'use strict';

/**
 * Takes the device token for a sign-in that happened inside the game.
 *
 * The routes that act *as* the player -- the Game Stats widget sync, the linked lobby -- ask
 * the server with a device token, and a device token is only ever written by the launcher's
 * own sign-in button (`lib/launcherSession.js`, filled by `captureLauncherSession` in main.js
 * when that button's flow completes). A player who signs in with Discord **inside the game**
 * never touches that button, so there was nothing to send: every one of those routes answered
 * 401 for those players and worked for the ones who used the button. That is the whole of
 * "some players can make widgets and some cannot" -- the widget was written for whoever had
 * signed in through the launcher, and never for anybody else, however often they played.
 *
 * The server issues a device token to whoever asks from an address that has just signed in
 * with Discord (`GET /api/auth/launcher/session`), and it *peeks* the pending sign-in rather
 * than spending it, so the game's own hand-off survives being asked for. What it will not do
 * is remember the proof forever: the pending and recent Discord logins both expire two minutes
 * after the callback. So this is driven from the game-session poll rather than from a button,
 * and it keeps asking (no more often than `intervalMs`) while the game window is open -- a
 * player who signs in a minute into the session is captured just as one who signed in first.
 *
 * Nothing here is fatal. A server without the route, a sign-in older than the server's memory,
 * or a player who never linked Discord all end as "no token", which is where the launcher
 * already was; the caller carries on and the row in the window reports what the sync itself
 * answered.
 */
function createLauncherSessionRecovery({
    gameUrl = '',
    readToken,
    issueSession,
    onCaptured,
    intervalMs = 30000,
    now = () => Date.now()
} = {}) {
    let lastAttemptAt = 0;

    /**
     * Ask for a device token, if this machine has none and this sign-in is still fresh enough
     * for the server to remember. Resolves to the token it ended up with ('' when there is
     * none), so a caller can report the outcome without reading the cache a second time.
     *
     * @param {{ email?: string }} [options] The account the game session is signed in as,
     *   used only as the label to store beside the token.
     */
    async function capture({ email = '' } = {}) {
        if (String(readToken() || '')) {
            return { captured: false, reason: 'already-have-token', token: '' };
        }
        const at = now();
        if (at - lastAttemptAt < intervalMs) {
            return { captured: false, reason: 'too-soon', token: '' };
        }
        lastAttemptAt = at;

        const issued = await issueSession();
        if (!issued || !issued.token) {
            return { captured: false, reason: 'no-pending-sign-in', token: '' };
        }

        const token = String(issued.token);
        // Written by the caller, so the file format and its permissions stay in one place.
        onCaptured(token, String(issued.email || email || ''));
        return { captured: true, reason: 'captured', token };
    }

    /** A new game session starts its own window: the first ask is not "too soon". */
    function reset() {
        lastAttemptAt = 0;
    }

    return { capture, reset };
}

module.exports = { createLauncherSessionRecovery };

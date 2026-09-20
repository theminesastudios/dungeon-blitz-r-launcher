'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * The game account login that the server already implements: `/auth/discord` starts the
 * OAuth hand-off, and `/api/auth/discord/pending` reports the result.
 *
 * The pending record is keyed by the requester's address rather than by a cookie, so the
 * launcher's own poll sees the login the player completed in the OAuth window, and the
 * game page's identical poll then picks it up and signs in.
 */

function getJson(url, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
        let parsed = null;
        try {
            parsed = new URL(url);
        } catch {
            resolve(null);
            return;
        }

        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(
            parsed,
            { headers: { 'Cache-Control': 'no-store', Accept: 'application/json' } },
            (response) => {
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    response.resume();
                    resolve(null);
                    return;
                }

                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > 64 * 1024) {
                        request.destroy();
                    }
                });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        resolve(null);
                    }
                });
            }
        );

        request.setTimeout(timeoutMs, () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

/**
 * A small JSON POST, with the status kept: 401 means the server answered and said no, which is
 * the only answer that should make the launcher throw a saved sign-in away. Anything else --
 * an older server without the route, a timeout, a 500 -- leaves it alone.
 *
 * @returns {Promise<{ status: number, body: any }>} status 0 when nothing was reached.
 */
function postJson(url, payload, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
        let parsed = null;
        try {
            parsed = new URL(url);
        } catch {
            resolve({ status: 0, body: null });
            return;
        }

        const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.request(
            parsed,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    'Cache-Control': 'no-store',
                    Accept: 'application/json'
                }
            },
            (response) => {
                const status = response.statusCode || 0;
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    text += chunk;
                    if (text.length > 64 * 1024) {
                        request.destroy();
                    }
                });
                response.on('end', () => {
                    try {
                        resolve({ status, body: JSON.parse(text) });
                    } catch {
                        resolve({ status, body: null });
                    }
                });
            }
        );

        request.setTimeout(timeoutMs, () => request.destroy());
        request.on('error', () => resolve({ status: 0, body: null }));
        request.end(body);
    });
}

function absolute(gameUrl, pathname) {
    try {
        return new URL(pathname, gameUrl).toString();
    } catch {
        return '';
    }
}

async function fetchConfig(gameUrl) {
    const payload = await getJson(absolute(gameUrl, '/api/auth/discord/config'));
    if (!payload) {
        return { reachable: false, configured: false, authUrl: '/auth/discord' };
    }

    return {
        reachable: true,
        configured: payload.configured === true,
        authUrl: String(payload.authUrl || '/auth/discord'),
        sponsorRequired: payload.sponsorRequired === true
    };
}

/**
 * Who the player is signed in as on this server. The server resolves it from the
 * connection asking, so this is only meaningful while the game is running -- which is
 * exactly when the launcher learns an account it did not itself sign in.
 */
async function fetchDiscordAccount(gameUrl) {
    const payload = await getJson(absolute(gameUrl, '/api/discord/account'));
    if (!payload) {
        return null;
    }

    return {
        linked: payload.linked === true,
        email: String(payload.email || ''),
        username: String(payload.username || ''),
        globalName: String(payload.globalName || ''),
        discordUserId: String(payload.discordUserId || '')
    };
}

async function fetchPending(gameUrl) {
    const payload = await getJson(absolute(gameUrl, '/api/auth/discord/pending'));
    if (!payload || payload.pending !== true) {
        return null;
    }

    return {
        email: String(payload.email || ''),
        userId: payload.userId ?? null,
        expiresAt: payload.expiresAt ?? null
    };
}

/**
 * Whether a Discord login has just succeeded for this machine.
 *
 * Not the same question as `fetchPending`. The callback has two outcomes: with a game client
 * already connected it signs that socket in and records no hand-off, and otherwise it records
 * one. Only the second is a pending login, so watching for that alone meant the launcher saw
 * nothing whenever the game window was already open -- which is the usual case, since the
 * launcher opens it on its own -- and never asked for its device token.
 */
async function fetchLoginState(gameUrl) {
    const payload = await getJson(absolute(gameUrl, '/api/auth/launcher/login-state'));
    if (!payload || payload.signedIn !== true) {
        return null;
    }
    return { email: String(payload.email || '') };
}

/**
 * Polls for a completed login until one lands or the window expires.
 *
 * Falls back to the hand-off poll on a server that does not serve the login-state route yet,
 * which is the behaviour this had before -- worse, but never worse than nothing.
 *
 * @returns {{ cancel: () => void, promise: Promise<{ email: string } | null> }}
 */
function watchForLogin(gameUrl, { intervalMs = 1000, timeoutMs = 3 * 60 * 1000 } = {}) {
    let cancelled = false;
    let timer = null;

    const promise = new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;

        const tick = async () => {
            if (cancelled) {
                resolve(null);
                return;
            }
            if (Date.now() > deadline) {
                resolve(null);
                return;
            }

            const signedIn = (await fetchLoginState(gameUrl)) || (await fetchPending(gameUrl));
            if (cancelled) {
                resolve(null);
                return;
            }
            if (signedIn) {
                resolve(signedIn);
                return;
            }

            timer = setTimeout(tick, intervalMs);
        };

        timer = setTimeout(tick, intervalMs);
    });

    return {
        cancel() {
            cancelled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
        promise
    };
}

/**
 * Ask the server for a device token, right after a real Discord sign-in.
 *
 * It is granted on the strength of the pending login the OAuth callback just recorded for this
 * address, so it only works in the moments after that sign-in -- which is exactly when it is
 * called.
 */
async function issueSession(gameUrl) {
    const payload = await getJson(absolute(gameUrl, '/api/auth/launcher/session'));
    if (!payload || payload.ok !== true || !payload.token) {
        return null;
    }
    return { token: String(payload.token), email: String(payload.email || '') };
}

/**
 * Trade a saved token for a fresh sign-in, and for the token that replaces it.
 *
 * `expired` is the one case the caller must act on: the server recognised the request and
 * refused the token, so the saved sign-in is gone and the player has to use Discord again.
 * Every other failure is reported as `unavailable`, which means "carry on as before".
 *
 * @returns {Promise<{ ok: true, email: string, token: string } | { ok: false, expired: boolean }>}
 */
async function resumeSession(gameUrl, token) {
    const { status, body } = await postJson(absolute(gameUrl, '/api/auth/launcher/resume'), { token });
    if (status === 200 && body && body.ok === true && body.token) {
        return { ok: true, email: String(body.email || ''), token: String(body.token) };
    }
    return { ok: false, expired: status === 401 };
}

/** Sign out on the server too, so a revoked device cannot be resumed from a stale copy. */
async function forgetSession(gameUrl, token) {
    if (!token) {
        return;
    }
    await postJson(absolute(gameUrl, '/api/auth/launcher/forget'), { token });
}

module.exports = {
    absolute,
    fetchConfig,
    fetchDiscordAccount,
    fetchLoginState,
    fetchPending,
    forgetSession,
    issueSession,
    resumeSession,
    watchForLogin
};

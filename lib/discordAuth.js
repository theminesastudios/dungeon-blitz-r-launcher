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
 * Polls for a completed login until one lands or the window expires.
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

            const pending = await fetchPending(gameUrl);
            if (cancelled) {
                resolve(null);
                return;
            }
            if (pending) {
                resolve(pending);
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

module.exports = {
    absolute,
    fetchConfig,
    fetchPending,
    watchForLogin
};

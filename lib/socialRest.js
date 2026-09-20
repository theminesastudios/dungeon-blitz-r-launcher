'use strict';

const http = require('http');
const https = require('https');

/**
 * The handful of Discord calls the launcher's JavaScript social bridge needs, spoken
 * directly over https. The native bridge gets these from the Discord Social SDK, but no
 * macOS build of that SDK exists, and `@minesa-org/mini-interaction` -- whose
 * `DiscordRestClient` documents this surface -- is an ESM package the Electron 11 main
 * process cannot require. So the endpoints live here, modelled on that client:
 *
 *   PUT    /lobbies                          create-or-join by secret (user token)
 *   GET    /lobbies/{id}                     read a lobby incl. linked_channel
 *   PATCH  /lobbies/{id}/channel-linking     bind a guild text channel (user token)
 *   POST   /lobbies/{id}/messages            send a lobby message (user token)
 *   GET    /lobbies/{id}/messages            list recent lobby messages (user token)
 *   GET    /users/@me                        resolve the authorized player
 *
 * Lobby calls that act on behalf of the player carry `Authorization: Bearer <token>`
 * with the `openid identify sdk.social_layer` scopes; the bot token is rejected there.
 *
 * Rate limits are failed fast, never retried in a loop: channel linking is capped at
 * 20 calls per 2 hours per application while the app is unapproved, so a retry would
 * burn the whole window silently.
 */

const API_BASE_URL = 'https://discord.com/api/v10';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class DiscordRestError extends Error {
    constructor(status, code, message) {
        super(message || `Discord answered ${status}.`);
        this.name = 'DiscordRestError';
        this.status = status;
        this.code = code;
    }
}

/** Endpoint override, so tests can point every call at a local mock server. */
function apiUrl(path, override) {
    return `${String(override || API_BASE_URL).replace(/\/$/, '')}${path}`;
}

/** The transport follows the scheme, so tests can mock the API over plain http. */
function transportFor(url) {
    return url.protocol === 'http:' ? http : https;
}

/**
 * One JSON request. Resolves with the parsed body, or rejects with
 * DiscordRestError carrying the HTTP status.
 */
function jsonRequest(url, { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let parsed = null;
        try {
            parsed = new URL(url);
        } catch {
            reject(new DiscordRestError(0, 0, `Not a valid URL: ${url}`));
            return;
        }

        const payload = body === undefined || body === null ? null : String(body);
        const request = transportFor(parsed).request(
            {
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: `${parsed.pathname}${parsed.search}`,
                method,
                headers: {
                    Accept: 'application/json',
                    ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
                    ...headers
                }
            },
            (response) => {
                response.setEncoding('utf8');
                let text = '';
                response.on('data', (chunk) => {
                    text += chunk;
                    if (text.length > MAX_BODY_BYTES) {
                        request.destroy(new DiscordRestError(0, 0, 'Discord response exceeded 2 MiB.'));
                    }
                });
                response.on('end', () => {
                    let parsedBody = null;
                    try {
                        parsedBody = text ? JSON.parse(text) : null;
                    } catch {
                        parsedBody = null;
                    }

                    const status = response.statusCode || 0;
                    if (status < 200 || status >= 300) {
                        const apiCode = parsedBody && parsedBody.code;
                        const apiMessage = parsedBody && (parsedBody.message || parsedBody.error_description || parsedBody.error);
                        reject(new DiscordRestError(status, apiCode, apiMessage));
                        return;
                    }

                    resolve(parsedBody);
                });
            }
        );

        request.setTimeout(timeoutMs, () => request.destroy(new DiscordRestError(0, 0, 'Discord did not answer in time.')));
        request.on('error', (error) => reject(error instanceof DiscordRestError ? error : new DiscordRestError(0, 0, String((error && error.message) || error))));
        if (payload !== null) {
            request.write(payload);
        }
        request.end();
    });
}

/** One application/x-www-form-urlencoded request, for the OAuth2 token endpoint. */
function formRequest(url, fields, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const body = new URLSearchParams(fields).toString();
    return new Promise((resolve, reject) => {
        let parsed = null;
        try {
            parsed = new URL(url);
        } catch {
            reject(new DiscordRestError(0, 0, `Not a valid URL: ${url}`));
            return;
        }

        const request = transportFor(parsed).request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
                path: `${parsed.pathname}${parsed.search}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                    Accept: 'application/json'
                }
            },
            (response) => {
                response.setEncoding('utf8');
                let text = '';
                response.on('data', (chunk) => {
                    text += chunk;
                    if (text.length > MAX_BODY_BYTES) {
                        request.destroy(new DiscordRestError(0, 0, 'Discord response exceeded 2 MiB.'));
                    }
                });
                response.on('end', () => {
                    let parsedBody = null;
                    try {
                        parsedBody = text ? JSON.parse(text) : null;
                    } catch {
                        parsedBody = null;
                    }

                    const status = response.statusCode || 0;
                    if (status < 200 || status >= 300) {
                        reject(
                            new DiscordRestError(
                                status,
                                parsedBody && parsedBody.error,
                                (parsedBody && (parsedBody.error_description || parsedBody.error)) || `Discord answered ${status}.`
                            )
                        );
                        return;
                    }

                    resolve(parsedBody);
                });
            }
        );

        request.setTimeout(timeoutMs, () => request.destroy(new DiscordRestError(0, 0, 'Discord did not answer in time.')));
        request.on('error', (error) => reject(error instanceof DiscordRestError ? error : new DiscordRestError(0, 0, String((error && error.message) || error))));
        request.write(body);
        request.end();
    });
}

/**
 * The browser authorize URL for the PKCE flow. `codeChallenge` is the base64url
 * SHA-256 of the verifier, per RFC 7636 S256.
 */
function buildAuthorizeUrl({ clientId, redirectUri, scopes, state, codeChallenge, authorizeUrl }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes || ''),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // A fresh consent guarantees a refresh token even when Discord remembers the player.
        prompt: 'consent'
    });
    return `${authorizeUrl || AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchanges the redirect's `code` for the player's tokens. */
function exchangeAuthorizationCode({ clientId, clientSecret, code, codeVerifier, redirectUri, tokenUrl }) {
    return formRequest(tokenUrl || TOKEN_URL, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
        ...(clientSecret ? { client_secret: clientSecret } : {})
    });
}

/** Refreshes an expired access token. */
function refreshAccessToken({ clientId, clientSecret, refreshToken, tokenUrl }) {
    return formRequest(tokenUrl || TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {})
    });
}

/** The authorized player: `{ id, username, global_name, ... }`. */
function getCurrentUser(userToken, { apiBaseUrl } = {}) {
    return jsonRequest(apiUrl('/users/@me', apiBaseUrl), {
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

/**
 * Creates a lobby for `secret`, or joins the caller to the existing one. The secret is
 * what makes every player with the same value land in the same lobby.
 */
function createOrJoinLobby(userToken, { secret, idleTimeoutSeconds = 604800, apiBaseUrl } = {}) {
    return jsonRequest(apiUrl('/lobbies', apiBaseUrl), {
        method: 'PUT',
        body: JSON.stringify({
            secret,
            ...(idleTimeoutSeconds !== undefined ? { idle_timeout_seconds: idleTimeoutSeconds } : {})
        }),
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

/** Reads a lobby, including `linked_channel` when one is bound. */
function getLobby(userToken, lobbyId, { apiBaseUrl } = {}) {
    return jsonRequest(apiUrl(`/lobbies/${lobbyId}`, apiBaseUrl), {
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

/** Binds a guild text channel to the lobby; every member can then read and post it. */
function linkChannelToLobby(userToken, lobbyId, channelId, { apiBaseUrl } = {}) {
    return jsonRequest(apiUrl(`/lobbies/${lobbyId}/channel-linking`, apiBaseUrl), {
        method: 'PATCH',
        body: JSON.stringify({ channel_id: channelId }),
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

/** Sends a lobby message; Discord forwards it to the linked channel when one exists. */
function sendLobbyMessage(userToken, lobbyId, content, { apiBaseUrl } = {}) {
    return jsonRequest(apiUrl(`/lobbies/${lobbyId}/messages`, apiBaseUrl), {
        method: 'POST',
        body: JSON.stringify({ content }),
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

/** Lists recent lobby messages (1-200, default 50), oldest first. */
function getLobbyMessages(userToken, lobbyId, { limit = 50, apiBaseUrl } = {}) {
    return jsonRequest(apiUrl(`/lobbies/${lobbyId}/messages?limit=${limit}`, apiBaseUrl), {
        headers: { Authorization: `Bearer ${userToken}` }
    });
}

module.exports = {
    API_BASE_URL,
    AUTHORIZE_URL,
    DiscordRestError,
    TOKEN_URL,
    buildAuthorizeUrl,
    createOrJoinLobby,
    exchangeAuthorizationCode,
    getCurrentUser,
    getLobby,
    getLobbyMessages,
    linkChannelToLobby,
    refreshAccessToken,
    sendLobbyMessage
};

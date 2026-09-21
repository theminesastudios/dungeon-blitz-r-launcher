'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { EventEmitter } = require('events');

const { LAUNCHER_ROOT, SERVER_ROOT, readJson } = require('./config');
const { DiscordIpcClient } = require('./discordIpc');

/**
 * Discord rich presence, served from the launcher itself.
 *
 * The game page the player is on pushes its own presence to a fixed local address
 * (`http://127.0.0.1:47631/presence`, hardcoded in the host page) and this is what
 * answers: it holds the player's character, party and level, and forwards them to the
 * Discord client over the same IPC socket the sign-in uses.
 *
 * It used to be the multiplayer server's own bridge (`src/server/tools/discordLocalBridge.ts`),
 * spawned as a child process. That cannot work from a packaged launcher: the server
 * checkout is not shipped inside the app at all, and the only Node runtime a packaged
 * Electron carries is v12 (Electron 11), which cannot load the server bridge's own
 * dependencies (express 5 and body-parser 2 need `node:`-prefixed builtins and Node 18).
 * The child died on startup, invisibly, because its output was discarded.
 *
 * Speaking the same HTTP contract means the page needs no changes, and presence works
 * wherever Discord's client runs -- including the Apple Silicon and Windows builds the
 * native Social SDK has no binary for.
 */

const PRESENCE_CONFIG_PATH = path.join(LAUNCHER_ROOT, 'presence.config.json');
const SERVER_PRESENCE_CONFIG_PATH = path.join(SERVER_ROOT, 'discord-bridge.config.json');

// Every area, dungeon and discipline the game can name, mapped onto the artwork uploaded
// to the Discord application. This used to be three hard-coded keys -- home, indungeon and
// newbieroad -- so every other area showed the default `dungeon_blitz` art instead of its
// own, which is the shape "the region image is wrong" takes. Keys are the exact asset
// names uploaded to the application's Rich Presence Art Assets; an unknown level still
// falls through to `resolveLargeImageKey`'s configured fallbacks rather than going blank.
const LEVEL_AREA_IMAGE_KEYS = {
    blackrosemire: 'blackrosemire',
    castlehocke: 'castlehocke',
    cemeteryhill: 'cemeteryhill',
    dungeon_blitz: 'dungeon_blitz',
    embedded_background: 'embedded_background',
    embedded_cover: 'embedded_cover',
    emeraldglades: 'emeraldglades',
    fellbridge: 'fellbridge',
    flameseer: 'flameseer',
    frostbringer: 'frostbringer',
    home: 'home',
    indungeon: 'indungeon',
    justicar: 'justicar',
    mage: 'mage',
    necromancer: 'necromancer',
    newbieroad: 'newbieroad',
    paladin: 'paladin',
    rogue: 'rogue',
    sentinel: 'sentinel',
    shadowbringer: 'shadowbringer',
    shazaridesert: 'shazaridesert',
    soulthieft: 'soulthieft',
    stormshardmountain: 'stormshardmountain',
    templar: 'templar',
    valhaven: 'valhaven',
    viperblade: 'viperblade'
};

const DEFAULT_PORT = 47631;
const PARTY_MAX_MEMBERS = 4;
const DEFAULT_PLAY_GAME_URL = 'https://theminesa.studio/dungeon-blitz-r';
const MAX_BODY_BYTES = 64 * 1024;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

const DEFAULTS = {
    appId: '',
    port: DEFAULT_PORT,
    presenceUrl: '',
    joinUrl: '',
    playGameUrl: DEFAULT_PLAY_GAME_URL,
    characterName: '',
    pollMs: 4000,
    largeImageText: 'Dungeon Blitz: R',
    smallImageKey: 'dungeon_blitz',
    smallImageText: 'Dungeon Blitz: R',
    largeImageHomeKey: 'home',
    largeImageDungeonKey: 'indungeon',
    largeImageNewbieRoadKey: 'newbieroad',
    logPayloads: false,
    // The game page pushes from the origin the player actually plays on, so the host of
    // the selected server is added to this at runtime.
    allowedPresenceOrigins: ['theminesa.studio', '*.theminesa.studio']
};

function normalizeHostname(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return '';
    }

    const candidate = text.includes('://') ? text : `http://${text}`;
    try {
        return new URL(candidate).hostname.replace(/^\[|\]$/g, '');
    } catch {
        return '';
    }
}

function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/** `*` and `*.suffix` wildcards, matching the server bridge's own rule. */
function isHostAllowedByList(host, allowed) {
    if (!host) {
        return false;
    }
    if (isLoopbackHostname(host)) {
        return true;
    }
    if (allowed.includes('*') || allowed.includes(host)) {
        return true;
    }

    return allowed.some((entry) => {
        if (!entry.startsWith('*.') || entry.length <= 2) {
            return false;
        }
        const suffix = entry.slice(2);
        return host.endsWith(`.${suffix}`) && host.length > suffix.length + 1;
    });
}

function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }
        if (parsed.username || parsed.password) {
            return '';
        }
        return parsed.toString();
    } catch {
        return '';
    }
}

/** A small POST helper: Electron 11's Node has no global fetch. */
function postJson(url, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const target = normalizeHttpUrl(url);
        if (!target) {
            resolve({ ok: false, status: 0, body: '' });
            return;
        }

        const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
        const client = target.startsWith('https:') ? require('https') : http;

        let request = null;
        try {
            request = client.request(
                target,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': payload.length
                    },
                    timeout: timeoutMs
                },
                (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () =>
                        resolve({
                            ok: response.statusCode >= 200 && response.statusCode < 300,
                            status: response.statusCode,
                            body: Buffer.concat(chunks).toString('utf8')
                        })
                    );
                }
            );
        } catch (error) {
            resolve({ ok: false, status: 0, body: String((error && error.message) || error) });
            return;
        }

        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', (error) => resolve({ ok: false, status: 0, body: String((error && error.message) || error) }));
        request.end(payload);
    });
}

function readConfig() {
    // The launcher's own file is the shipped default; a side-by-side server checkout wins
    // so a developer's existing bridge settings keep working unchanged.
    const base = { ...DEFAULTS, ...readJson(PRESENCE_CONFIG_PATH, {}) };
    const fromServer = readJson(SERVER_PRESENCE_CONFIG_PATH, null);
    if (!fromServer || typeof fromServer !== 'object') {
        return base;
    }

    const merged = { ...base };
    for (const key of Object.keys(DEFAULTS)) {
        if (fromServer[key] === undefined || fromServer[key] === null || fromServer[key] === '') {
            continue;
        }
        merged[key] = fromServer[key];
    }

    const origins = Array.isArray(merged.allowedPresenceOrigins) ? merged.allowedPresenceOrigins : [];
    merged.allowedPresenceOrigins = Array.from(
        new Set([
            ...origins.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean),
            ...DEFAULTS.allowedPresenceOrigins
        ])
    );

    return merged;
}

class PresenceBridge extends EventEmitter {
    /**
     * @param {{ launcherConfig?: object, config?: object }} options `config` replaces the
     *   file-derived settings outright, which is how the tests drive it without a checkout.
     */
    constructor({ launcherConfig = {}, config = null } = {}) {
        super();
        this.launcherConfig = launcherConfig;
        this.configOverride = config;
        this.client = null;
        this.server = null;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.started = false;
        this.lastActivityHash = '';
        this.currentPresence = null;
        this.state = {
            available: true,
            running: false,
            ready: false,
            port: 0,
            characterName: '',
            detail: '',
            activity: '',
            lastError: ''
        };
    }

    snapshot() {
        return { ...this.state };
    }

    patch(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('state', this.snapshot());
    }

    isRunning() {
        return Boolean(this.server);
    }

    /**
     * Starts the local endpoint and connects to the Discord client. Both halves stay up
     * for the life of the game session; a Discord client that is not running (or restarted
     * mid-session) is retried in the background rather than reported as a failure.
     */
    start({ serverUrl = '', gameWindowPid = 0 } = {}) {
        if (this.started) {
            return { started: true };
        }

        const config = this.configOverride ? { ...DEFAULTS, ...this.configOverride } : readConfig();
        if (!config.appId) {
            this.patch({ available: false, running: false, lastError: 'No Discord application id configured.' });
            return { started: false, reason: 'missing-app-id' };
        }

        const allowedOrigins = Array.from(
            new Set([...(config.allowedPresenceOrigins || []), normalizeHostname(serverUrl)].filter(Boolean))
        );
        const port = Number.isFinite(Number(config.port)) ? Math.round(Number(config.port)) : DEFAULT_PORT;

        this.started = true;
        this.config = config;
        this.serverUrl = normalizeHttpUrl(serverUrl).replace(/\/+$/, '');
        this.allowedOrigins = allowedOrigins;
        this.gameWindowPid = Number.isFinite(Number(gameWindowPid)) ? Number(gameWindowPid) : 0;

        this.startServer(port);
        this.connectToDiscord();

        return { started: true };
    }

    stop() {
        this.started = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.client) {
            const client = this.client;
            this.client = null;
            const close = () => client.close();

            // Clearing the activity is what takes "playing Dungeon Blitz: R" off the
            // profile when the game window closes -- the launcher itself keeps running, so
            // Discord cannot infer it from the process exiting.
            if (this.lastActivityHash) {
                client
                    .request('SET_ACTIVITY', { pid: this.gameWindowPid || process.pid, activity: null }, 2000)
                    .then(close, close);
            } else {
                close();
            }
        }

        if (this.server) {
            const server = this.server;
            this.server = null;
            try {
                server.close();
            } catch {
                // The socket is loopback-only; a failed close cannot leak anywhere.
            }
        }

        this.lastActivityHash = '';
        this.currentPresence = null;
        this.patch({ running: false, ready: false, activity: '', characterName: '' });
    }

    startServer(port) {
        const server = http.createServer((req, res) => this.handleRequest(req, res));
        server.on('error', (error) => {
            this.server = null;
            this.patch({
                running: false,
                port: 0,
                lastError: `Presence endpoint could not listen on 127.0.0.1:${port} (${(error && error.message) || error}).`
            });
        });
        server.listen(port, '127.0.0.1', () => {
            // Port 0 asks the operating system for a free port; the window shows whichever
            // one was actually bound.
            const bound = server.address();
            const actualPort = bound && typeof bound === 'object' ? bound.port : port;
            this.patch({ running: true, port: actualPort, lastError: '' });
            this.log(`Listening on http://127.0.0.1:${actualPort}`);
        });
        this.server = server;
    }

    connectToDiscord() {
        if (!this.started || this.client) {
            return;
        }

        const client = new DiscordIpcClient();
        this.client = client;

        client
            .connect({ clientId: this.config.appId })
            .then(() => {
                if (this.client !== client) {
                    client.close();
                    return;
                }

                this.reconnectAttempt = 0;
                this.patch({ ready: true, lastError: '' });
                this.log('Connected to the Discord client.');

                client.on('ACTIVITY_JOIN', (data) => void this.handleActivityJoin(data));
                void client.request('SUBSCRIBE', { evt: 'ACTIVITY_JOIN' }).catch(() => {
                    // Party joins are a bonus; presence itself does not depend on this.
                });
            })
            .catch((error) => {
                if (this.client !== client) {
                    return;
                }
                client.close();
                this.client = null;
                const message = String((error && error.message) || error);
                this.patch({ ready: false, lastError: message });
                // The retry loop keeps going on its own; naming the common case once makes
                // "waiting for Discord" a diagnosis instead of a shrug.
                if (/not running|ENOENT|EACCES/i.test(message)) {
                    this.log('The Discord desktop client is not running; rich presence starts once it is.');
                }
                this.scheduleReconnect();
            });

        // A client that closes (Discord quit or restarted) is picked up again on the next
        // attempt; the hash is reset so the same presence is re-sent once it is back.
        client.on('rpc-error', () => {
            this.lastActivityHash = '';
        });
    }

    scheduleReconnect() {
        if (!this.started || this.reconnectTimer) {
            return;
        }

        const attempt = Math.min(30, this.reconnectAttempt);
        const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * Math.pow(2, attempt));
        this.reconnectAttempt = attempt + 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectToDiscord();
        }, delayMs);
    }

    handleRequest(req, res) {
        const origin = String(req.headers.origin || '').trim();
        const originHost = normalizeHostname(origin);

        if (origin) {
            if (!isHostAllowedByList(originHost, this.allowedOrigins)) {
                this.respond(res, 403, { ok: false, reason: 'origin-not-allowed' });
                return;
            }
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
        }

        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

        if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }

        const route = String(req.url || '').split('?')[0];
        if (route === '/healthz') {
            this.respond(res, 200, { ok: true, ready: this.state.ready });
            return;
        }

        if (req.method !== 'POST') {
            this.respond(res, 405, { ok: false, reason: 'method-not-allowed' });
            return;
        }

        this.readBody(req)
            .then((body) => this.handlePost(route, body, res))
            .catch(() => this.respond(res, 400, { ok: false, reason: 'bad-request' }));
    }

    readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;

            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Error('body-too-large'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8').trim();
                if (!text) {
                    resolve({});
                    return;
                }
                try {
                    const parsed = JSON.parse(text);
                    resolve(parsed && typeof parsed === 'object' ? parsed : {});
                } catch {
                    reject(new Error('invalid-json'));
                }
            });
            req.on('error', reject);
        });
    }

    async handlePost(route, body, res) {
        if (route === '/configure') {
            const characterName = String(body.characterName || '').trim();
            if (characterName) {
                this.patch({ characterName });
            }
            this.respond(res, 200, {
                ok: true,
                presenceUrl: this.buildPresenceUrl(),
                joinUrl: this.buildJoinUrl()
            });
            return;
        }

        if (route === '/clear') {
            await this.applyActivity(null);
            this.respond(res, 200, { ok: true, cleared: true });
            return;
        }

        if (route === '/presence') {
            const payload = normalizePayload(body);
            if (!payload) {
                // The page pushes an empty payload from its sign-in screen, which means
                // "this player is not in a game": the activity goes away.
                await this.applyActivity(null);
                this.respond(res, 202, { ok: true, cleared: true });
                return;
            }

            const updated = await this.applyActivity(payload);
            this.respond(res, updated ? 200 : 202, { ok: true, updated });
            return;
        }

        this.respond(res, 404, { ok: false, reason: 'not-found' });
    }

    respond(res, status, body) {
        if (res.writableEnded) {
            return;
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    }

    buildPresenceUrl() {
        // The game page pushes its own endpoint to the bridge; this is what a launcher
        // asks for in return: the server it is playing on knows who is online there.
        // The selected server wins over the configured value, which is a loopback address
        // in a checkout that plays locally.
        const base =
            (this.serverUrl ? `${this.serverUrl}/api/presence/discord-target` : '') ||
            normalizeHttpUrl(this.launcherConfig.presenceUrl) ||
            normalizeHttpUrl(this.config.presenceUrl);
        if (!base) {
            return '';
        }

        const characterName = this.state.characterName || String(this.config.characterName || '').trim();
        if (!characterName) {
            return base;
        }
        return `${base}${base.includes('?') ? '&' : '?'}character=${encodeURIComponent(characterName)}`;
    }

    buildJoinUrl() {
        return (
            (this.serverUrl ? `${this.serverUrl}/api/presence/discord-join` : '') ||
            normalizeHttpUrl(this.launcherConfig.joinUrl) ||
            normalizeHttpUrl(this.config.joinUrl)
        );
    }

    /** Applies one presence payload, or clears the activity when given nothing. */
    async applyActivity(payload) {
        const client = this.client;
        if (!client || !this.state.ready) {
            return false;
        }

        const pid = this.gameWindowPid || process.pid;

        if (!payload) {
            if (!this.lastActivityHash) {
                this.currentPresence = null;
                return false;
            }

            try {
                await client.request('SET_ACTIVITY', { pid, activity: null });
            } catch (error) {
                this.log(`Failed to clear presence: ${(error && error.message) || error}`);
            } finally {
                this.lastActivityHash = '';
                this.currentPresence = null;
                this.patch({ activity: '', characterName: '' });
            }
            return true;
        }

        const activity = this.buildActivity(payload);
        const hash = JSON.stringify(activity);
        if (hash === this.lastActivityHash) {
            return false;
        }

        try {
            await client.request('SET_ACTIVITY', { pid, activity });
        } catch (error) {
            this.patch({ lastError: `Discord refused the presence update: ${(error && error.message) || error}` });
            return false;
        }

        this.lastActivityHash = hash;
        this.currentPresence = { ...payload };
        this.patch({
            characterName: payload.characterName,
            detail: payload.details,
            activity: [payload.details, payload.state].filter(Boolean).join(' - '),
            lastError: ''
        });
        this.log(
            `Presence updated: ${payload.characterName} | ${payload.details} | ${payload.state}` +
                (payload.partyId ? ` | party ${payload.partySize}/${payload.partyMax}` : '')
        );
        return true;
    }

    /**
     * The activity exactly as the RPC socket takes it.
     *
     * Not the shape the discord-rpc library took. That library accepted flat camelCase
     * (`largeImageKey`, `partySize`, `startTimestamp`) and translated it into the nested
     * snake_case the wire actually wants; speaking the socket directly means doing that
     * translation here. Sending the library's shape raw is silently half-ignored: Discord
     * takes the handful of fields whose names happen to coincide -- `details`, `state`,
     * `instance`, `buttons` -- and drops the rest on the floor without an error, which is a
     * presence with the right two lines of text, no artwork, no party and no join.
     */
    buildActivity(payload) {
        const activity = {
            instance: false,
            // Milliseconds since the epoch, as a number. A Date here serializes to an ISO
            // string, which is not a timestamp as far as the socket is concerned.
            timestamps: { start: Math.round(Number(payload.startedAtMs) || Date.now()) }
        };

        // An empty line is left off rather than sent: Discord refuses a details or state
        // shorter than two characters, and that refusal would drop the whole activity.
        if (payload.details) {
            activity.details = payload.details;
        }
        if (payload.state) {
            activity.state = payload.state;
        }

        if (payload.partyId > 0) {
            activity.party = {
                id: String(payload.partyId),
                // A pair, not two fields: [current, max].
                size: [
                    Math.max(1, Math.round(Number(payload.partySize) || 1)),
                    Math.max(1, Math.round(Number(payload.partyMax) || 1))
                ]
            };
        }

        // No join secret, deliberately. Discord treats an activity carrying `secrets` as a
        // joinable one and hides `buttons` behind Ask to Join -- the two are never shown
        // together. The secret used to go out under a name the socket ignored, so what players
        // actually had was the Play Game button; sending it for real took the button away.
        //
        // To trade the button back for Ask to Join, set `activity.secrets` from
        // payload.joinSecret here and drop the buttons below.

        const assets = {};
        if (payload.disciplineKey) {
            assets.small_image = payload.disciplineKey;
            // The class only: the character's name is kept off the presence entirely, hover
            // text included.
            if (payload.characterClass) {
                assets.small_text = payload.characterClass;
            }
        } else if (this.config.smallImageKey) {
            assets.small_image = this.config.smallImageKey;
            if (this.config.smallImageText) {
                assets.small_text = this.config.smallImageText;
            }
        }

        // The place, not the face. A published portrait used to win this slot, so the presence
        // showed a character on a plain background and lost the one thing the small icon does
        // not already say -- where the player is. The portrait stays as the last resort.
        //
        // First a key this build knows the application has art for: a name Discord cannot
        // resolve renders as *no* image at all, which is the shape "the region picture is
        // missing" took. The page's raw key comes next, so artwork uploaded after this build
        // shipped still works; run with DUNGEON_BLITZ_LOG_PRESENCE=1 to see the keys the page
        // actually sends.
        const largeImage =
            this.resolveLargeImageKey(payload) ||
            payload.areaKey ||
            normalizeHttpUrl(payload.portraitUrl) ||
            '';
        if (largeImage) {
            assets.large_image = largeImage;
            assets.large_text = payload.levelName || this.config.largeImageText;
        }

        if (Object.keys(assets).length > 0) {
            activity.assets = assets;
        }

        const playGameUrl = normalizeHttpUrl(this.config.playGameUrl) || DEFAULT_PLAY_GAME_URL;
        activity.buttons = [{ label: 'Play Game', url: playGameUrl }];

        return activity;
    }

    resolveLargeImageKey(payload) {
        const levelKey = String(payload.levelKey || '').trim();
        const areaKey = String(payload.areaKey || '').trim();
        const activityKind = String(payload.activityKind || '').trim().toLowerCase();

        // An explicit area key the Discord application actually has art for wins: the page
        // names the region it is in, and that is the picture to show.
        const areaImage = LEVEL_AREA_IMAGE_KEYS[areaKey.toLowerCase()];
        if (areaImage) {
            return areaImage;
        }

        // The level key names areas too, sometimes without a separate area key.
        const levelImage = LEVEL_AREA_IMAGE_KEYS[levelKey.toLowerCase()];
        if (levelImage) {
            return levelImage;
        }

        if (levelKey === 'CraftTown' || levelKey === 'CraftTownTutorial') {
            return this.config.largeImageHomeKey;
        }
        if (levelKey === 'NewbieRoad' || levelKey === 'NewbieRoadHard') {
            return this.config.largeImageNewbieRoadKey;
        }
        if (activityKind === 'dungeon') {
            return this.config.largeImageDungeonKey;
        }
        return '';
    }

    /**
     * Somebody clicked "Join" on the player's profile: the game server owns the party, so
     * the secret goes to its join endpoint and the server decides what happens next.
     */
    async handleActivityJoin(data) {
        const secret = String((data && (data.secret || data.joinSecret)) || '').trim();
        const joinUrl = this.buildJoinUrl();
        if (!secret || !joinUrl) {
            return;
        }

        const result = await postJson(joinUrl, { secret });
        this.log(
            result.ok
                ? 'Handed a Discord party join to the game server.'
                : `Discord party join failed (${result.status || 'no answer'}).`
        );
    }

    log(message) {
        // logPayloads in presence.config.json is the quiet default; the environment flag
        // answers "is my presence even being sent?" without editing a packaged install.
        if (this.config && (this.config.logPayloads || process.env.DUNGEON_BLITZ_LOG_PRESENCE === '1')) {
            console.log(`[Presence] ${message}`);
        }
    }
}

/** The page's own payload, normalized exactly as the server bridge did. */
function normalizePayload(body) {
    if (body && body.clear === true) {
        return null;
    }

    const characterName = String(body.characterName || '').trim();
    const details = String(body.details || '').trim();
    const state = String(body.state || '').trim();
    const startedAtMs = Number(body.startedAtMs || 0);
    // Either line may be empty: the server leaves both blank for a player roaming alone, and
    // Discord shows the application name, artwork and timer on their own. Only a payload with
    // no character is the sign-in screen's "not in a game", which clears the activity.
    if (!characterName || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
        return null;
    }

    const partySize = Number(body.partySize || 0);
    const partyId = Number(body.partyId || 0);
    const partyMax = Number(body.partyMax || PARTY_MAX_MEMBERS);
    const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);

    return {
        characterName,
        characterClass: String(body.characterClass || '').trim(),
        details,
        state,
        startedAtMs,
        partySize: Math.max(0, Math.round(number(partySize, 0))),
        partyId: partyId > 0 ? Math.round(partyId) : 0,
        partyMax: Math.max(1, Math.round(number(partyMax, PARTY_MAX_MEMBERS))),
        partyLocked: Boolean(body.partyLocked),
        joinSecret: String(body.joinSecret || '').trim(),
        levelKey: String(body.levelKey || '').trim(),
        levelName: String(body.levelName || '').trim(),
        areaKey: String(body.areaKey || '').trim(),
        portraitUrl: String(body.portraitUrl || '').trim(),
        disciplineKey: String(body.disciplineKey || '').trim(),
        activityKind: String(body.activityKind || '').trim(),
        playerStatus: String(body.playerStatus || '').trim()
    };
}

function presenceConfigExists() {
    return fs.existsSync(PRESENCE_CONFIG_PATH) || fs.existsSync(SERVER_PRESENCE_CONFIG_PATH);
}

module.exports = {
    DEFAULT_PLAY_GAME_URL,
    DEFAULTS,
    LEVEL_AREA_IMAGE_KEYS,
    PRESENCE_CONFIG_PATH,
    PresenceBridge,
    SERVER_PRESENCE_CONFIG_PATH,
    isHostAllowedByList,
    normalizePayload,
    presenceConfigExists,
    readConfig
};

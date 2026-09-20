'use strict';

const fs = require('fs');
const path = require('path');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');

// This repository holds only the launcher. A few optional features -- the Discord
// presence bridge and the server's own Social SDK settings -- live in the game repo, so
// point at a checkout of it when you have one side by side. Everything reads through
// readJson, so a missing path just turns those features off.
const SERVER_ROOT = path.resolve(
    process.env.DUNGEON_BLITZ_SERVER_ROOT || path.join(LAUNCHER_ROOT, '..', 'private-dungeon-blitz-r', 'src', 'server')
);
const SERVERS_PATH = path.join(LAUNCHER_ROOT, 'servers.json');
const LAUNCHER_CONFIG_PATH = path.join(SERVER_ROOT, 'launcher.config.json');

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Rejects anything that is not a plain http(s) URL, and anything carrying credentials
 * -- the value ends up in a BrowserWindow that has the Flash plugin enabled, so it has
 * to come from the server list or the player's own typing, never from a redirect.
 */
function normalizeHttpUrl(value, { loopbackOnly = false } = {}) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const parsed = new URL(raw);
        const protocolAllowed = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        const hasCredentials = Boolean(parsed.username || parsed.password);
        const hostname = parsed.hostname.toLowerCase();
        const isLoopback =
            hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

        if (!protocolAllowed || hasCredentials || (loopbackOnly && !isLoopback)) {
            return '';
        }

        return parsed.toString();
    } catch {
        return '';
    }
}

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

function loadServers() {
    const file = readJson(SERVERS_PATH, { servers: [], defaultServerId: '' });
    const launcherConfig = readJson(LAUNCHER_CONFIG_PATH, {});

    const servers = (Array.isArray(file.servers) ? file.servers : [])
        .map((entry) => ({
            id: String(entry && entry.id ? entry.id : '').trim(),
            name: String(entry && entry.name ? entry.name : '').trim(),
            note: String(entry && entry.note ? entry.note : '').trim(),
            url: normalizeHttpUrl(entry && entry.url)
        }))
        .filter((entry) => entry.id && entry.url);

    // The shared launcher.config.json is what the Discord bridge and the existing
    // `npm run launch:multiplayer-with-discord` path already agree on, so its clientUrl
    // belongs in the list even when servers.json has not been updated for it.
    const configuredUrl = normalizeHttpUrl(launcherConfig.clientUrl);
    if (configuredUrl && !servers.some((entry) => entry.url === configuredUrl)) {
        servers.unshift({
            id: 'launcher-config',
            name: 'launcher.config.json',
            note: 'src/server/launcher.config.json icindeki clientUrl',
            url: configuredUrl
        });
    }

    const defaultServerId = servers.some((entry) => entry.id === file.defaultServerId)
        ? file.defaultServerId
        : (servers[0] && servers[0].id) || '';

    return { servers, defaultServerId };
}

function loadLauncherConfig() {
    return readJson(LAUNCHER_CONFIG_PATH, {});
}

function createStateStore(stateDirectory) {
    const statePath = path.join(stateDirectory, 'launcher-state.json');

    function read() {
        const state = readJson(statePath, {});
        return {
            serverId: String(state.serverId || '').trim(),
            customServerUrl: normalizeHttpUrl(state.customServerUrl),
            flashPath: String(state.flashPath || '').trim(),
            startDiscordBridge: state.startDiscordBridge !== false,
            // The launcher connects to the official server on its own; a developer can
            // turn that off to pick a different one before the game window opens.
            autoConnect: state.autoConnect !== false,
            startSocialBridge: state.startSocialBridge !== false,
            chatName: String(state.chatName || '').trim(),
            // Set once the player has completed a Discord sign-in, so the launcher stops
            // asking. The game session itself lives in the game window's cookie jar.
            discordEmail: String(state.discordEmail || '').trim(),
            discordLinkedAt: Number.isFinite(state.discordLinkedAt) ? state.discordLinkedAt : 0,
            windowBounds:
                state.windowBounds && typeof state.windowBounds === 'object' ? state.windowBounds : null
        };
    }

    function write(patch) {
        const next = { ...read(), ...patch };
        writeJson(statePath, next);
        return next;
    }

    return { path: statePath, read, write };
}

module.exports = {
    LAUNCHER_ROOT,
    SERVER_ROOT,
    LAUNCHER_CONFIG_PATH,
    SERVERS_PATH,
    createStateStore,
    loadLauncherConfig,
    loadServers,
    normalizeHttpUrl,
    originOf,
    readJson,
    writeJson
};

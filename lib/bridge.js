'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { SERVER_ROOT, normalizeHttpUrl, readJson, writeJson } = require('./config');

const BRIDGE_CONFIG_PATH = path.join(SERVER_ROOT, 'discord-bridge.config.json');
const BRIDGE_ENTRY = path.join(SERVER_ROOT, 'dist', 'tools', 'discordLocalBridge.js');

let bridgeProcess = null;

function isAvailable() {
    return fs.existsSync(BRIDGE_ENTRY);
}

function hostOf(url) {
    try {
        return String(new URL(url).hostname || '').trim().toLowerCase();
    } catch {
        return '';
    }
}

// Mirrors the bridge's own `*` / `*.suffix` matching (see
// src/server/integrations/discordBridgeOrigins.ts) so a host a wildcard already covers is
// not appended again -- otherwise every launch would rewrite a tracked config file.
function isHostCovered(host, allowed) {
    if (!host) {
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

// The game page pushes presence to the local bridge from the origin the player actually
// plays on. The bridge refuses cross-origin pushes from hosts it does not know, so the
// server the launcher just opened has to join the allowlist the config ships with.
function collectAllowedOrigins(bridgeConfig, clientUrl) {
    const allowed = Array.isArray(bridgeConfig.allowedPresenceOrigins)
        ? bridgeConfig.allowedPresenceOrigins.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
        : [];

    const clientHost = hostOf(clientUrl);
    if (clientHost && clientHost !== 'localhost' && clientHost !== '127.0.0.1' && !isHostCovered(clientHost, allowed)) {
        allowed.push(clientHost);
    }

    return Array.from(new Set(allowed));
}

function updateConfig({ clientUrl, launcherConfig = {} }) {
    if (!fs.existsSync(BRIDGE_CONFIG_PATH)) {
        return false;
    }

    const bridgeConfig = readJson(BRIDGE_CONFIG_PATH, null);
    if (!bridgeConfig) {
        return false;
    }

    const presenceUrl = normalizeHttpUrl(launcherConfig.presenceUrl || bridgeConfig.presenceUrl, {
        loopbackOnly: true
    });
    const joinUrl = normalizeHttpUrl(launcherConfig.joinUrl || bridgeConfig.joinUrl, { loopbackOnly: true });
    const playGameUrl = normalizeHttpUrl(launcherConfig.playGameUrl || bridgeConfig.playGameUrl);

    if (presenceUrl) {
        bridgeConfig.presenceUrl = presenceUrl;
    }
    if (joinUrl) {
        bridgeConfig.joinUrl = joinUrl;
    }
    if (playGameUrl) {
        bridgeConfig.playGameUrl = playGameUrl;
    }

    bridgeConfig.characterName = String(launcherConfig.characterName || bridgeConfig.characterName || '').trim();
    bridgeConfig.allowedPresenceOrigins = collectAllowedOrigins(bridgeConfig, clientUrl);

    // discord-bridge.config.json is tracked, and writeJson normalizes line endings, so an
    // unconditional write would dirty the worktree on every launch. Only settings that
    // actually changed are worth a write.
    const current = readJson(BRIDGE_CONFIG_PATH, null);
    if (current && JSON.stringify(current) === JSON.stringify(bridgeConfig)) {
        return true;
    }

    writeJson(BRIDGE_CONFIG_PATH, bridgeConfig);
    return true;
}

function isRunning() {
    return Boolean(bridgeProcess && bridgeProcess.exitCode === null && !bridgeProcess.killed);
}

/**
 * Starts the Discord rich-presence bridge next to the game window. The bridge is
 * optional: a checkout that has not run `npm run build` simply plays without presence.
 *
 * @returns {{ started: boolean, reason?: string }}
 */
function start({ clientUrl, launcherConfig }) {
    if (!isAvailable()) {
        return { started: false, reason: 'not-built' };
    }
    if (isRunning()) {
        return { started: true };
    }

    updateConfig({ clientUrl, launcherConfig });

    try {
        bridgeProcess = spawn(process.execPath, [BRIDGE_ENTRY], {
            cwd: SERVER_ROOT,
            stdio: 'ignore',
            shell: false,
            // ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, so the
            // bridge does not need a separate Node install on a packaged launcher.
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        });
    } catch (error) {
        bridgeProcess = null;
        return { started: false, reason: String((error && error.message) || error) };
    }

    bridgeProcess.on('exit', () => {
        bridgeProcess = null;
    });

    return { started: true };
}

function stop() {
    if (!isRunning()) {
        bridgeProcess = null;
        return;
    }

    try {
        bridgeProcess.kill();
    } catch {
        // The bridge is a child process; a failed kill only leaves presence stale.
    }
    bridgeProcess = null;
}

module.exports = {
    BRIDGE_ENTRY,
    isAvailable,
    isRunning,
    start,
    stop,
    updateConfig
};

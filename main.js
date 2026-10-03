'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const { ChatRelay } = require('./lib/chatRelay');
const { GameStats } = require('./lib/gameStats');
const { createLauncherSessionRecovery } = require('./lib/launcherSessionRecovery');
const discordAuth = require('./lib/discordAuth');
const { exists, inspectInstallLocation, isWritableDirectory } = require('./lib/install');
const { findFlashPlugin, findVendoredPlugin } = require('./lib/flash');
const { compatibilitySwitches, describeWindows, unsupportedArchitectureMessage, unsupportedWindowsMessage } = require('./lib/windowsSupport');
const { PresenceBridge } = require('./lib/presence');
const { SocialBridge } = require('./lib/social');
const { createUpdateService } = require('./lib/update');
const { createSessionCache } = require('./lib/launcherSession');
const {
    LAUNCHER_ROOT,
    createStateStore,
    loadLauncherConfig,
    loadServers,
    normalizeHttpUrl,
    originOf
} = require('./lib/config');

const GAME_WINDOW_DEFAULTS = { width: 1200, height: 800, minWidth: 800, minHeight: 600 };
const BACKGROUND_COLOR = '#484955';

// Which Windows this is, read once at startup. Electron 11 is old enough to still run on
// Windows 7 and 8, but Chromium 87 cannot trust the GPU on those machines: it asks for
// D3D11, which only reaches Windows 7 through the platform update (KB4474419), and the
// machines that still need this launcher most often do not have it. The result is a black
// window rather than an error, so the switches below answer it before it is asked for.
// lib/windowsSupport.js holds the rules and is tested without an Electron runtime.
const windows = describeWindows();

// One 256px PNG arms the window icon on every platform and the dock icon on Linux and
// Windows; the packaged macOS app takes its icon from build/icon.icns via electron-builder,
// and the dock line below covers running from a checkout. A missing file is not fatal -- a
// window without an icon still works -- so this resolves lazily rather than failing start.
const WINDOW_ICON_PATH = path.join(LAUNCHER_ROOT, 'renderer', 'assets', 'icon.png');
const windowIcon = fs.existsSync(WINDOW_ICON_PATH) ? WINDOW_ICON_PATH : undefined;

function applyDockIcon() {
    if (process.platform === 'darwin' && app.dock && windowIcon) {
        // The dock is macOS-only, so the image is always readable here.
        app.dock.setIcon(windowIcon);
    }
}

// Electron derives the user data folder from package.json's name, so renaming the package
// would strand every player's saved sign-in in the old folder. Pinning it outright keeps
// that folder fixed whatever the package is called. setName alone is not enough: the
// default path is resolved before this script runs.
const APP_DIRECTORY_NAME = 'dungeon-blitz-r-launcher';
app.setName(APP_DIRECTORY_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_DIRECTORY_NAME));

const state = createStateStore(app.getPath('userData'));
const social = new SocialBridge({
    tokenCachePath: path.join(app.getPath('userData'), 'discord-social-token.json'),
    // Authorization happens in the player's own Discord client; a browser is only opened
    // when the configuration explicitly asks for that fallback.
    openUrl: openExternal
});
const sessionCache = createSessionCache(path.join(app.getPath('userData'), 'launcher-session.json'));

// Auto-update: GitHub releases are the feed (build.publish in package.json points
// electron-updater at them). Dev checkouts and dev AppImages never self-update, and the
// service itself is inert unless app.isPackaged.
let updateService = null;

// Rich presence is served by the launcher itself. The multiplayer server's own bridge
// cannot be used from a packaged build, and its absence used to be silent: presence just
// never appeared. See lib/presence.js.
const presence = new PresenceBridge({ launcherConfig: loadLauncherConfig() });

// Game chat and the player's Discord lobby are mirrored for the length of a game session.
// The game server does the reading and the printing; this side only carries the lines.
const chatRelay = new ChatRelay({ social });
chatRelay.on('state', () => pushState());

// The Discord Game Stats widget is written by the game server, which is the only side that
// can hold a bot token; the launcher asks for the write and shows what came back.
const gameStats = new GameStats();
gameStats.on('state', () => pushState());

let launcherWindow = null;
let gameWindow = null;
let loginWatcher = null;
let flashPlugin = null;
let flashArmed = false;
let currentGameOrigin = '';
let discordAccount = { linked: false, email: '', name: '' };
let remembered = false;
let serverReachable = null;
// Set once at startup: a copy running from a mounted disk image or from Downloads is a copy
// nobody will notice going stale.
let installLocation = { relocate: false, reason: '', bundlePath: '', targetPath: '', message: '' };

function locateFlash(preferredPath) {
    return findFlashPlugin({
        preferredPath,
        // A gitignored src/launcher/flash/ is a second drop point for anyone who would
        // rather not run tools/extract-flash.js.
        extraDirectories: [path.join(LAUNCHER_ROOT, 'flash')]
    });
}

// Chromium reads the plugin switches once, while it starts up -- after that the path is
// frozen for the life of the process. A player who points at a different plugin therefore
// gets a relaunch rather than a silently ignored setting.
function armFlash() {
    flashPlugin = locateFlash(state.read().flashPath);
    if (!flashPlugin) {
        flashArmed = false;
        console.log('[Flash] No Flash plugin found; the launcher will ask for one.');
        return;
    }

    app.commandLine.appendSwitch('ppapi-flash-path', flashPlugin.path);
    app.commandLine.appendSwitch('ppapi-flash-version', flashPlugin.version);
    flashArmed = true;

    // The same status the launcher window renders, on the console: the quickest way to
    // tell a missing plugin from a copy built before the plugin was vendored.
    console.log(`[Flash] Armed ${flashPlugin.source} plugin ${flashPlugin.version} at ${flashPlugin.path}`);
    if (flashPlugin.archMismatch) {
        console.log(
            `[Flash] WARNING: the plugin is ${flashPlugin.architectures.join('/')} and this launcher runs as ${process.arch}; Flash cannot load.`
        );
    }
}

/**
 * The switches a legacy Windows needs, applied before Chromium reads its command line.
 *
 * Scoped to Windows 7 and 8 deliberately: the same switches on Windows 10 would cost the
 * game real frames to work around a problem that machine does not have.
 * `DUNGEON_BLITZ_GPU=hardware` keeps the GPU on a legacy machine that has the platform
 * update, which is the one of those two answers a player can pick wrongly.
 */
function applyWindowsCompatibility() {
    const switches = compatibilitySwitches({ gpu: process.env.DUNGEON_BLITZ_GPU });

    if (process.platform === 'win32') {
        console.log(
            `[Windows] ${windows.product}${windows.softwareRendering ? ' - legacy Windows, rendering in software' : ''}`
        );
    }

    for (const { name, value } of switches) {
        if (value) {
            app.commandLine.appendSwitch(name, value);
        } else {
            app.commandLine.appendSwitch(name);
        }
        console.log(`[Windows] --${name}${value ? `=${value}` : ''}`);
    }
}

function resolveSelectedServer() {
    const { servers, defaultServerId } = loadServers();
    const saved = state.read();
    const selected =
        servers.find((entry) => entry.id === saved.serverId) ||
        servers.find((entry) => entry.id === defaultServerId) ||
        servers[0] ||
        null;

    return { servers, selected };
}

/**
 * A packaged launcher always carries its own Flash plugin. One that does not is an
 * incomplete build -- a stale install, or a package assembled without running
 * tools/extract-flash -- and it can never play unless the player happens to have their
 * own Flash install. Refusing to start says so outright instead of leaving players on a
 * sign-in screen that leads nowhere.
 *
 * A development checkout is exempt: there, a missing plugin is one `npm run extract-flash`
 * away and the window already explains it. DUNGEON_BLITZ_ALLOW_NO_FLASH=1 keeps a
 * deliberately Flash-less build startable.
 */
function buildIsPlayable() {
    if (!app.isPackaged || flashArmed) {
        return true;
    }
    return process.env.DUNGEON_BLITZ_ALLOW_NO_FLASH === '1';
}

function refuseToStart() {
    const vendored = findVendoredPlugin();
    const detail = [
        'This copy of the launcher has no Flash plugin, so the game could not start even after signing in.',
        '',
        `Running from: ${app.getAppPath()}`,
        'This is an incomplete or outdated build.',
        '',
        'Fix: install the current build again from the .dmg or .zip, or in a development',
        'checkout run `npm run extract-flash` and start it there.',
        '',
        'To start anyway (a deliberately Flash-less build), set DUNGEON_BLITZ_ALLOW_NO_FLASH=1.'
    ].join('\n');

    console.log('[Flash] Refusing to start: this build carries no Flash plugin.');
    if (vendored) {
        console.log(`[Flash] (a vendored plugin was found at ${vendored} but could not be armed)`);
    }
    dialog.showErrorBox('Dungeon Blitz: R cannot start', detail);
    app.exit(1);
}

/**
 * A Windows the pinned runtime cannot run on. The same shape as the Flash-less refusal
 * below: name what is missing and quit, rather than leaving a player on a window whose game
 * can never load. On Windows 7 without the C runtime update there is nothing to show even
 * this -- the README says so instead.
 */
function refuseUnsupportedWindows() {
    console.error(`[Windows] Refusing to start: ${windows.reason}`);

    // A 32-bit build is refused with its own text: the exact file to download is the whole
    // of the answer there, and burying it under the Windows 7 requirements would send the
    // player off to install service packs on a machine that was never the problem.
    //
    // The version names the installer exactly. A player who installed win-ia32 needs to
    // know which of the release's files replaces it, and the list is ordered against
    // them: GitHub sorts assets alphabetically and ia32 sorts before x64.
    const message = windows.architectureSupported
        ? unsupportedWindowsMessage(windows)
        : unsupportedArchitectureMessage(windows, { version: app.getVersion() });

    dialog.showErrorBox('Dungeon Blitz: R cannot start', message);
    app.exit(1);
}

/**
 * The lobby-chat state the launcher window shows, in one small object. The bridge is
 * deliberately quiet until the game starts, so "idle" is a normal state, not a fault.
 */
function socialSummary() {
    const snapshot = social.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_SOCIAL !== '0' && social.isAvailable(),
        running: Boolean(snapshot.running),
        lobbyReady: Boolean(snapshot.lobbyReady),
        authPending: Boolean(snapshot.auth),
        lobbyId: String(snapshot.lobbyId || ''),
        lastStatus: String(snapshot.lastStatus || '')
    };
}

function presenceSummary() {
    const snapshot = presence.snapshot();
    return {
        running: Boolean(snapshot.running),
        ready: Boolean(snapshot.ready),
        port: Number(snapshot.port) || 0,
        characterName: String(snapshot.characterName || ''),
        activity: String(snapshot.activity || ''),
        lastError: String(snapshot.lastError || '')
    };
}

function flashStatus() {
    if (!flashPlugin) {
        return {
            found: false,
            armed: false,
            path: '',
            version: '',
            source: '',
            killSwitch: false,
            architectures: [],
            archMismatch: false
        };
    }

    return {
        found: true,
        armed: flashArmed,
        path: flashPlugin.path,
        version: flashPlugin.version,
        source: flashPlugin.source,
        killSwitch: flashPlugin.killSwitch,
        architectures: flashPlugin.architectures,
        archMismatch: flashPlugin.archMismatch
    };
}

/**
 * What this Windows is costing, for the window's status strip: on Windows 7 and 8 the game
 * runs on a software rasteriser, which is playable and visibly slower, and that should not
 * read as a fault in the launcher.
 */
function windowsStatus() {
    return {
        supported: Boolean(windows.supported),
        product: String(windows.product || ''),
        legacy: Boolean(windows.legacy),
        softwareRendering: Boolean(windows.softwareRendering),
        // The 32-bit installers are refused on start, so the status strip is what a build
        // that somehow got past that would read from. Kept because it is the same fact
        // every other row is: what this machine is, and what it can do.
        architecture: String(windows.arch || ''),
        architectureSupported: Boolean(windows.architectureSupported),
        reason: String(windows.reason || ''),
        requirements: String(windows.requirements || '')
    };
}

/** What the widget-stats pipeline is doing, for the window's status strip. */
function gameStatsSummary() {
    const snapshot = gameStats.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_GAME_STATS !== '0',
        running: Boolean(snapshot.running),
        state: String(snapshot.state || 'idle'),
        written: Boolean(snapshot.written),
        username: String(snapshot.username || ''),
        updatedAt: Number(snapshot.updatedAt) || 0,
        lastError: String(snapshot.lastError || '')
    };
}

/** What the chat mirror is doing, for the window's status strip. */
function chatSummary() {
    const snapshot = chatRelay.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_CHAT_RELAY !== '0',
        running: Boolean(snapshot.running),
        supported: snapshot.supported,
        relayed: Number(snapshot.relayed) || 0,
        received: Number(snapshot.received) || 0,
        lastError: String(snapshot.lastError || '')
    };
}

function launcherState() {
    const { servers, selected } = resolveSelectedServer();

    return {
        appVersion: app.getVersion(),
        servers,
        selectedServerUrl: selected ? selected.url : '',
        serverReachable,
        gameRunning: Boolean(gameWindow && !gameWindow.isDestroyed()),
        windows: windowsStatus(),
        flash: flashStatus(),
        presence: presenceSummary(),
        social: socialSummary(),
        chat: chatSummary(),
        gameStats: gameStatsSummary(),
        install: {
            relocate: Boolean(installLocation.relocate),
            reason: String(installLocation.reason || ''),
            message: String(installLocation.message || ''),
            sourcePath: String(installLocation.bundlePath || ''),
            targetPath: String(installLocation.targetPath || ''),
            canMove: Boolean(installLocation.targetPath)
        },
        update: updateService
            ? updateService.summary()
            : { state: 'disabled', percent: 0, version: '', error: '', currentVersion: app.getVersion(), lastCheckedAt: 0 },
        discord: {
            ...discordAccount,
            remembered,
            loginPending: Boolean(loginWatcher)
        }
    };
}

function pushState() {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.webContents.send('launcher:state', launcherState());
    }
}

// The Social SDK runs headless: it puts the player in the Discord lobby, and Discord's
// own client is where lobby chat and the party roster are read. Nothing to render here.
let lastLoggedSocialStatus = '';
// Presence changes (Discord reached, character changed, Discord closed) belong in the
// status strip for the same reason: the window is where this is checked.
presence.on('state', () => pushState());

social.on('state', (snapshot) => {
    // Patches that carry no status (a lobby_ready's running flag, stop()) re-surface the
    // previous status; logging only changes keeps the console one-line-per-event.
    if (snapshot.lastStatus && snapshot.lastStatus !== lastLoggedSocialStatus) {
        lastLoggedSocialStatus = snapshot.lastStatus;
        console.log(`[Social] ${snapshot.lastStatus}`);
    }

    // The bridge knows the Discord account it authorized as; keeping that is what lets the
    // launcher greet the player by name without another sign-in.
    if (snapshot.username && snapshot.username !== discordAccount.name) {
        rememberDiscordLogin(discordAccount.email, snapshot.username);
    }
    // The window shows the bridge state, so every change has to reach it.
    pushState();
});

function createLauncherWindow() {
    launcherWindow = new BrowserWindow({
        width: 460,
        height: 580,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: '#1d1e26',
        title: 'Dungeon Blitz: R',
        show: false,
        icon: windowIcon,
        webPreferences: {
            preload: path.join(LAUNCHER_ROOT, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // The launcher shell has no business hosting plugins; only the game window does.
            plugins: false
        }
    });

    launcherWindow.setMenuBarVisibility(false);
    launcherWindow.loadFile(path.join(LAUNCHER_ROOT, 'renderer', 'index.html'));
    launcherWindow.once('ready-to-show', () => launcherWindow.show());
    launcherWindow.on('closed', () => {
        launcherWindow = null;
    });
}

function openExternal(url) {
    const safeUrl = normalizeHttpUrl(url);
    if (!safeUrl) {
        return;
    }
    void shell.openExternal(safeUrl);
}

// Flash content can ask to navigate, and a plugin-enabled window must not be walked onto
// an arbitrary origin by a page -- or by anything a page loads.
function guardNavigation(contents, allowedOrigin) {
    contents.on('will-navigate', (event, url) => {
        if (allowedOrigin && originOf(url) === allowedOrigin) {
            return;
        }
        event.preventDefault();
        openExternal(url);
    });

    contents.on('new-window', (event, url) => {
        event.preventDefault();
        openExternal(url);
        nudgeDiscordLoginPoll();
    });

    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
    });
}

// Discord's OAuth hand-off can finish outside the game page, which then never sees the
// localStorage event it normally waits on. Restarting its poll from here keeps the login
// flow working without modifying the page.
function nudgeDiscordLoginPoll() {
    if (!gameWindow || gameWindow.isDestroyed()) {
        return;
    }

    void gameWindow.webContents
        .executeJavaScript(
            'typeof startDiscordPendingLoginPoll === "function" ? (startDiscordPendingLoginPoll(), true) : false',
            true
        )
        .catch(() => false);
}

function createGameWindow(url) {
    const saved = state.read();
    const bounds = saved.windowBounds || {};

    gameWindow = new BrowserWindow({
        width: Number.isFinite(bounds.width) ? bounds.width : GAME_WINDOW_DEFAULTS.width,
        height: Number.isFinite(bounds.height) ? bounds.height : GAME_WINDOW_DEFAULTS.height,
        x: Number.isFinite(bounds.x) ? bounds.x : undefined,
        y: Number.isFinite(bounds.y) ? bounds.y : undefined,
        minWidth: GAME_WINDOW_DEFAULTS.minWidth,
        minHeight: GAME_WINDOW_DEFAULTS.minHeight,
        backgroundColor: BACKGROUND_COLOR,
        title: 'Dungeon Blitz',
        show: false,
        icon: windowIcon,
        webPreferences: {
            plugins: true,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: false,
            webSecurity: true
        }
    });

    gameWindow.setMenuBarVisibility(false);
    currentGameOrigin = originOf(url);
    guardNavigation(gameWindow.webContents, currentGameOrigin);

    gameWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return;
        }
        if (input.key === 'F11') {
            gameWindow.setFullScreen(!gameWindow.isFullScreen());
            event.preventDefault();
            return;
        }
        if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
            gameWindow.webContents.reload();
            event.preventDefault();
            return;
        }
        if (input.control && input.shift && input.key.toLowerCase() === 'i') {
            gameWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    gameWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
            return;
        }

        dialog.showMessageBox(gameWindow, {
            type: 'error',
            title: 'Connection error',
            message: 'The game page could not be opened.',
            detail: `${validatedUrl}\n\n${errorDescription} (${errorCode})`,
            buttons: ['OK']
        });
        gameWindow.close();
    });

    gameWindow.on('close', () => {
        if (gameWindow.isFullScreen()) {
            return;
        }
        state.write({ windowBounds: gameWindow.getNormalBounds() });
    });

    gameWindow.on('closed', () => {
        gameWindow = null;
        currentGameOrigin = '';
        // Presence and lobby chat belong to a game session, so closing the game ends
        // both; keeping them up would leave the player shown as playing nothing.
        presence.stop();
        chatRelay.stop();
        gameStats.stop();
        stopAccountPolling();
        if (launcherWindow && !launcherWindow.isDestroyed()) {
            launcherWindow.show();
        }
        pushState();
    });

    gameWindow.once('ready-to-show', () => gameWindow.show());
    gameWindow.loadURL(url);
    // Whoever the game ends up signing in as is remembered for the next launch.
    startAccountPolling();
}

async function play(serverId) {
    if (gameWindow && !gameWindow.isDestroyed()) {
        gameWindow.focus();
        return { ok: true };
    }

    const { servers, selected: fallback } = resolveSelectedServer();
    // An explicit pick from the advanced list wins; otherwise this is the saved choice,
    // and on a first run the configured default -- the official server.
    const selected = servers.find((entry) => entry.id === serverId) || fallback;

    if (!selected) {
        return { ok: false, message: 'No servers configured. Check servers.json.' };
    }
    if (!flashArmed) {
        return {
            ok: false,
            message: flashPlugin
                ? 'The Flash path changed. Restart the launcher to pick it up.'
                : 'The Flash plugin is missing. Run `npm run extract-flash` or choose it by hand.'
        };
    }

    // Arming only sets command-line switches; the plugin is loaded in-process when the
    // game page asks for it, and an architecture mismatch fails silently there. Refuse
    // with the actual mismatch so the fix is obvious instead of a dead plugin box.
    if (flashPlugin.archMismatch) {
        return {
            ok: false,
            message:
                `The Flash plugin is ${flashPlugin.architectures.join('/')} but this launcher runs as ` +
                `${process.arch}, and a PPAPI plugin must match. Reinstall the dependencies as x64: ` +
                '`npm_config_arch=x64 npm install`.'
        };
    }

    state.write({ serverId: selected.id });

    // Before the window, not after: the game page begins polling for a pending sign-in as
    // soon as it loads, and the point of the saved token is that there is already one
    // waiting. An expired token is the one case that stops the launch: continuing would
    // drop the player into the SWF's password path with a perfectly good account.
    const resumed = await resumeLauncherSession(selected.url);
    if (resumed.expired) {
        pushState();
        return {
            ok: false,
            message: 'Your saved sign-in is no longer valid. Sign in with Discord again.'
        };
    }

    const settings = state.read();
    if (settings.startDiscordBridge) {
        presence.start({ serverUrl: selected.url, gameWindowPid: process.pid });
    }

    // The game's own chat and the Discord lobby are mirrored in both directions for as
    // long as the game window is open.
    if (settings.startSocialBridge && process.env.DUNGEON_BLITZ_SOCIAL !== '0' && process.env.DUNGEON_BLITZ_CHAT_RELAY !== '0') {
        chatRelay.start({ serverUrl: selected.url });
    }

    // Lobby chat belongs to a game session. Starting the social bridge here rather than
    // at launch is what keeps the launcher from opening a browser for Discord
    // authorization before the player has asked for anything; once it starts, the
    // session is exactly what it always was. Repeated plays are no-ops -- the bridge
    // returns early while it is already running.
    if (settings.startSocialBridge && process.env.DUNGEON_BLITZ_SOCIAL !== '0') {
        social.start({
            serverUrl: selected.url,
            // Read at the moment of asking: the resume above rotates the token.
            getLauncherToken: () => sessionCache.read().token || ''
        });
    }

    // The widget profile is written for the player by the server, and a play session is when
    // the ask belongs: the launcher token that identifies them was just resumed above, and
    // the server reads the player's Discord account off it. One ask per session keeps the
    // profile current without the player having to do anything.
    if (process.env.DUNGEON_BLITZ_GAME_STATS !== '0') {
        gameStats.start({
            serverUrl: selected.url,
            getLauncherToken: () => sessionCache.read().token || ''
        });
        void gameStats.sync();
    }

    createGameWindow(selected.url);
    pushState();
    return { ok: true };
}

// Discord's consent screen is sent to the player's own browser, never rendered here:
// discord.com's web app needs a modern engine, and this launcher is pinned to Chromium 87
// for Flash. On 87 the page loads but its script fails to parse and the body stays empty.
//
// Nothing is lost by leaving: the server keys a pending login by requester address, so the
// launcher's poll sees the sign-in the player completed in their browser.
function openDiscordLogin() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        return { ok: false, message: 'No server selected.' };
    }
    if (loginWatcher) {
        return { ok: true };
    }

    const authUrl = discordAuth.absolute(selected.url, '/auth/discord');
    if (!normalizeHttpUrl(authUrl)) {
        return { ok: false, message: 'The sign-in address is not valid.' };
    }

    openExternal(authUrl);

    loginWatcher = discordAuth.watchForLogin(selected.url);
    void loginWatcher.promise.then(async (pending) => {
        loginWatcher = null;
        if (!pending) {
            pushState();
            return;
        }

        rememberDiscordLogin(pending.email);
        // While the hand-off this sign-in created is still live, which is what the server
        // grants the token against. It is also what play() below spends, so the token has to
        // be asked for first.
        await captureLauncherSession(selected.url, pending.email);
        nudgeDiscordLoginPoll();
        if (!gameWindow) {
            await play();
        }
        pushState();
    });

    pushState();
    return { ok: true };
}

// Signing in once is enough -- but "once" used to mean "once per launch".
//
// The server's Discord hand-off is a two-minute record keyed by the player's address, and
// the login packet spends it. What is kept now is a device token the server issues after a
// real Discord sign-in (lib/launcherSession.js); redeeming it on the next start recreates
// exactly the hand-off the OAuth callback would have, so the game page's own poll signs the
// player in as usual. The account *name* is kept on top of that, so the window can greet a
// returning player instead of offering the sign-in button again.
function rememberDiscordLogin(email, name) {
    const nextEmail = String(email || '').trim();
    const nextName = String(name || '').trim();
    const changed = nextEmail !== discordAccount.email || nextName !== discordAccount.name || !discordAccount.linked;

    discordAccount = { linked: true, email: nextEmail, name: nextName || discordAccount.name };
    remembered = true;

    // Written only on a change: this runs from a poll.
    if (changed) {
        state.write({
            discordEmail: discordAccount.email,
            discordName: discordAccount.name,
            discordLinkedAt: Date.now()
        });
    }
}

function restoreDiscordLogin() {
    const saved = state.read();
    const cached = sessionCache.read();
    if (!saved.discordLinkedAt && !cached.token) {
        return;
    }
    // The session cache is the authority on the email -- it is what the token was issued
    // against -- and the saved name is the display the window shows.
    discordAccount = {
        linked: true,
        email: cached.email || saved.discordEmail,
        name: saved.discordName || discordAccount.name
    };
    remembered = true;
}

function forgetDiscordLogin() {
    const { selected } = resolveSelectedServer();
    const cached = sessionCache.read();
    if (selected && cached.token) {
        // Best effort: the local copy goes either way, and a token the server still holds
        // expires on its own.
        void discordAuth.forgetSession(selected.url, cached.token);
    }
    sessionCache.clear();
    discordAccount = { linked: false, email: '', name: '' };
    remembered = false;
    state.write({ discordEmail: '', discordName: '', discordLinkedAt: 0 });
}

/**
 * Reads back the account the player is actually playing as.
 *
 * A player who signs in inside the game -- the SWF's own Discord flow, or simply a
 * session that outlived the launcher -- never touches the launcher's sign-in button, so
 * the launcher used to ask again on the next launch. The server can tell who is behind
 * the connection that is asking, and only while that connection is in the game, so this
 * runs while a game session is up and remembers what it finds.
 *
 * Knowing the name is not enough on its own: the routes that do something *as* the player --
 * the widget sync, the linked lobby -- take the device token, and the player who signed in
 * inside the game is exactly the one with no token here. So the same moment is used to take
 * the token too, before the sign-in that proves it goes stale (see below).
 */
async function refreshDiscordAccount() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        return;
    }

    const account = await discordAuth.fetchDiscordAccount(selected.url);
    if (!account || !account.linked) {
        return;
    }

    const name = account.globalName || account.username || discordAccount.name;
    if (!discordAccount.linked || name !== discordAccount.name || account.email !== discordAccount.email) {
        rememberDiscordLogin(account.email, name);
        pushState();
    }

    return captureLauncherSessionFromGameSession();
}

// The device token, for a player who signed in with Discord inside the game rather than through
// the launcher's own sign-in button. Without it the widget sync has nobody to ask about itself
// and answers 401 forever for those players, which is what made the widget appear for some and
// never for others. lib/launcherSessionRecovery.js holds the rules; this is only the wiring.
const sessionRecovery = createLauncherSessionRecovery({
    readToken: () => sessionCache.read().token,
    // Read at the moment of asking: the player can switch servers between plays.
    issueSession: () => {
        const { selected } = resolveSelectedServer();
        return selected ? discordAuth.issueSession(selected.url) : null;
    },
    onCaptured: (token, email) => sessionCache.write(token, email)
});

/**
 * Tries to take a device token from the sign-in this game session is running on.
 *
 * @returns {Promise<boolean>} Whether one was taken, so the caller can ask the server again
 *   for what the missing token just refused: a widget profile to write.
 */
async function captureLauncherSessionFromGameSession() {
    const result = await sessionRecovery.capture();
    if (!result.captured) {
        return false;
    }

    console.log('[LauncherSession] Took a device token from the game session\'s own Discord sign-in');
    return true;
}

// The game session appears a few seconds after the window opens, so the account is looked
// up again for a short while rather than once at the wrong moment -- and for a little longer
// than it takes to see the name, because a sign-in the player completes inside the game is
// what the device token is captured from, and the server keeps the proof of that sign-in for
// two minutes. A poll that stopped at the first name it read would miss it.
let accountPollTimer = null;
let accountPollAttempts = 0;
const ACCOUNT_POLL_ATTEMPTS = 24;

function startAccountPolling() {
    stopAccountPolling();
    accountPollAttempts = 0;
    sessionRecovery.reset();
    accountPollTimer = setInterval(() => {
        accountPollAttempts += 1;
        void refreshDiscordAccount().then((captured) => {
            // A token taken after the widget ask means the ask was refused for want of it, and
            // the answer is a profile Discord can now be written for.
            if (captured) {
                void gameStats.sync();
            }
        });
        if (accountPollAttempts >= ACCOUNT_POLL_ATTEMPTS) {
            stopAccountPolling();
        }
    }, 5000);
}

function stopAccountPolling() {
    if (accountPollTimer) {
        clearInterval(accountPollTimer);
        accountPollTimer = null;
    }
}

/** Take the device token the server offers while this sign-in is still fresh. */
async function captureLauncherSession(gameUrl, email) {
    const issued = await discordAuth.issueSession(gameUrl);
    if (!issued) {
        // An older server, or one that did not offer one. The player is signed in for this
        // session; the next start simply asks again, which is where we started.
        return;
    }
    sessionCache.write(issued.token, issued.email || email);
}

/**
 * Turn a saved token back into a sign-in, before the game window opens.
 *
 * Only an outright refusal (401) drops the saved sign-in -- a server that is old, down or slow
 * must not sign the player out. Anything else carries on exactly as the launcher did before.
 *
 * @returns {Promise<{ resumed: boolean, expired: boolean }>}
 */
async function resumeLauncherSession(gameUrl) {
    const cached = sessionCache.read();
    if (!cached.token) {
        return { resumed: false, expired: false };
    }

    const result = await discordAuth.resumeSession(gameUrl, cached.token);
    if (result.ok) {
        // The old token stopped working the moment the server answered, so the replacement is
        // saved before anything else can fail.
        sessionCache.write(result.token, result.email || cached.email);
        rememberDiscordLogin(result.email || cached.email);
        return { resumed: true, expired: false };
    }

    if (result.expired) {
        sessionCache.clear();
        discordAccount = { linked: false, email: '' };
        remembered = false;
        state.write({ discordEmail: '', discordLinkedAt: 0 });
        return { resumed: false, expired: true };
    }

    return { resumed: false, expired: false };
}

async function refreshServerStatus() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        serverReachable = null;
        pushState();
        return;
    }

    const config = await discordAuth.fetchConfig(selected.url);
    serverReachable = config.reachable;
    pushState();
}

/**
 * Puts this copy where it belongs and restarts from there.
 *
 * The copy is what updates stop reaching and what the player stops recognising; offering
 * the move is the difference between a warning nobody acts on and a one-click fix.
 */
function moveToApplications() {
    const target = String(installLocation.targetPath || '');
    const source = String(installLocation.bundlePath || '');
    if (!target || !source) {
        return { ok: false, message: 'This build cannot move itself. Install it again from the installer.' };
    }

    if (!isWritableDirectory(path.dirname(target))) {
        return { ok: false, message: `${path.dirname(target)} is not writable by this user.` };
    }

    try {
        if (exists(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        // ditto is the macOS way to copy a bundle: it preserves symlinks, permissions and
        // the app's signature, which a plain recursive copy does not.
        require('child_process').execFileSync('ditto', [source, target], { stdio: 'ignore' });
    } catch (error) {
        return { ok: false, message: `Could not copy the launcher: ${(error && error.message) || error}` };
    }

    console.log(`[Install] Moved to ${target}`);

    const executableInBundle = app.getPath('exe').replace(source, '');
    app.relaunch({ execPath: path.join(target, executableInBundle) });
    app.exit(0);
    return { ok: true };
}

/**
 * The standalone warning, for a player who launched from a disk image and never opens the
 * window's own banner.
 */
async function warnAboutInstallLocation() {
    if (!installLocation.relocate) {
        return;
    }

    const buttons = installLocation.targetPath ? ['Move to Applications', 'Not now'] : ['OK'];
    const options = {
        type: 'warning',
        title: 'This copy cannot update itself',
        message: installLocation.message,
        detail: [
            installLocation.targetPath ? `Move it to: ${installLocation.targetPath}` : '',
            'Running the current build is what keeps Flash arming and lobby chat working.'
        ]
            .filter(Boolean)
            .join('\n'),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1
    };
    const result =
        launcherWindow && !launcherWindow.isDestroyed()
            ? await dialog.showMessageBox(launcherWindow, options)
            : await dialog.showMessageBox(options);

    if (result.response === 0 && installLocation.targetPath) {
        const moved = moveToApplications();
        if (!moved.ok) {
            dialog.showErrorBox('Could not move the launcher', String(moved.message || ''));
        }
    }
}

function registerIpc() {
    ipcMain.handle('launcher:getState', () => launcherState());

    ipcMain.handle('launcher:discordLogin', () => openDiscordLogin());

    ipcMain.handle('launcher:forgetDiscordLogin', () => {
        forgetDiscordLogin();
        return launcherState();
    });

    ipcMain.handle('launcher:browseFlash', async () => {
        const filters =
            process.platform === 'win32'
                ? [{ name: 'Flash PPAPI plugin', extensions: ['dll'] }]
                : process.platform === 'darwin'
                  ? [{ name: 'Flash PPAPI plugin', extensions: ['plugin'] }]
                  : [{ name: 'Flash PPAPI plugin', extensions: ['so'] }];

        const result = await dialog.showOpenDialog(launcherWindow, {
            title: 'Choose the Flash plugin',
            properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
            filters
        });

        if (result.canceled || !result.filePaths.length) {
            return launcherState();
        }

        const chosen = result.filePaths[0];
        state.write({ flashPath: chosen });
        const rescanned = locateFlash(chosen);
        if ((rescanned && rescanned.path) !== (flashPlugin && flashPlugin.path)) {
            flashArmed = false;
        }
        flashPlugin = rescanned;
        return launcherState();
    });

    ipcMain.handle('launcher:relaunch', () => {
        app.relaunch();
        app.exit(0);
    });

    ipcMain.handle('launcher:moveToApplications', () => moveToApplications());

    ipcMain.handle('launcher:updateInstall', () => (updateService ? updateService.restartToUpdate() : false));

    // The manual retry, for the player who just linked their Discord account and wants the
    // widget filled without opening the game again.
    ipcMain.handle('launcher:gameStatsSync', async () => {
        // The player presses this right after signing in with Discord inside the game, which is
        // the moment the widget usually needs a nudge -- and by then the account poll has long
        // since stopped, so the device token for that sign-in is taken here instead. The ask
        // then follows it: a launcher with no token has nobody to be written for.
        sessionRecovery.reset();
        await refreshDiscordAccount();
        await gameStats.sync();
        return gameStatsSummary();
    });

    ipcMain.handle('launcher:play', () => play());
    ipcMain.handle('launcher:quit', () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const target = gameWindow || launcherWindow;
        if (target && !target.isDestroyed()) {
            if (target.isMinimized()) {
                target.restore();
            }
            target.show();
            target.focus();
        }
    });

    applyWindowsCompatibility();
    armFlash();
    restoreDiscordLogin();
    installLocation = inspectInstallLocation({ isPackaged: app.isPackaged, appPath: app.getAppPath() });
    if (installLocation.relocate) {
        console.warn(`[Install] ${installLocation.message} (running from ${installLocation.bundlePath})`);
    }
    // The updater only arms in a packaged build: a checkout updates by git pull, and a dev
    // AppImage is exactly the kind of install that must not write over itself.
    if (app.isPackaged) {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        // The floor: if the player ignores the restart prompt, the update still lands on
        // the next quit. The prompt itself is never a forced restart (game may be open).
        autoUpdater.autoInstallOnAppQuit = true;
        updateService = createUpdateService({
            autoUpdater,
            app,
            log: (message) => console.log(message)
        });
        updateService.on('state', () => pushState());
        updateService.start();
    }
    registerIpc();

    app.whenReady().then(() => {
        // Checked before the Flash guard because nothing below it can matter on a Windows
        // the pinned runtime cannot run on at all.
        if (!windows.supported) {
            refuseUnsupportedWindows();
            return;
        }

        if (!buildIsPlayable()) {
            refuseToStart();
            return;
        }

        createLauncherWindow();
        applyDockIcon();
        void refreshServerStatus();
        void warnAboutInstallLocation();
        // Covers a session that outlived the launcher: the account is there to be found
        // even before a game window is opened.
        void refreshDiscordAccount();

        // A player who has signed in before is not asked again: play() redeems the saved
        // device token on the way, so the game page finds a sign-in waiting for it. If the
        // token has been revoked or has expired, play() says so and the launcher window is
        // already up with the Discord button on it.
        if (remembered && flashArmed) {
            void play();
        }

        app.on('activate', () => {
            if (!BrowserWindow.getAllWindows().length) {
                createLauncherWindow();
                applyDockIcon();
            }
        });
    });

    app.on('window-all-closed', () => {
        presence.stop();
        chatRelay.stop();
        social.stop();
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('before-quit', () => {
        presence.stop();
        chatRelay.stop();
        gameStats.stop();
        social.stop();
        if (updateService) {
            updateService.stop();
        }
    });
}

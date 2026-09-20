'use strict';

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');

const bridge = require('./lib/bridge');
const discordAuth = require('./lib/discordAuth');
const { findFlashPlugin } = require('./lib/flash');
const { SocialBridge } = require('./lib/social');
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

// Electron derives the user data folder from package.json's name, so renaming the package
// would strand every player's saved sign-in in the old folder. Pinning it outright keeps
// that folder fixed whatever the package is called. setName alone is not enough: the
// default path is resolved before this script runs.
const APP_DIRECTORY_NAME = 'dungeon-blitz-r-launcher';
app.setName(APP_DIRECTORY_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_DIRECTORY_NAME));

const state = createStateStore(app.getPath('userData'));
const social = new SocialBridge({ tokenCachePath: path.join(app.getPath('userData'), 'discord-social-token.json') });
const sessionCache = createSessionCache(path.join(app.getPath('userData'), 'launcher-session.json'));

let launcherWindow = null;
let gameWindow = null;
let loginWatcher = null;
let flashPlugin = null;
let flashArmed = false;
let currentGameOrigin = '';
let discordAccount = { linked: false, email: '' };
let remembered = false;
let serverReachable = null;

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
        return;
    }

    app.commandLine.appendSwitch('ppapi-flash-path', flashPlugin.path);
    app.commandLine.appendSwitch('ppapi-flash-version', flashPlugin.version);
    flashArmed = true;
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

function flashStatus() {
    if (!flashPlugin) {
        return { found: false, armed: false, path: '', version: '', source: '', killSwitch: false };
    }

    return {
        found: true,
        armed: flashArmed,
        path: flashPlugin.path,
        version: flashPlugin.version,
        source: flashPlugin.source,
        killSwitch: flashPlugin.killSwitch
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
        flash: flashStatus(),
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
social.on('state', (snapshot) => {
    if (snapshot.lastStatus) {
        console.log(`[Social] ${snapshot.lastStatus}`);
    }
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
        bridge.stop();
        if (launcherWindow && !launcherWindow.isDestroyed()) {
            launcherWindow.show();
        }
        pushState();
    });

    gameWindow.once('ready-to-show', () => gameWindow.show());
    gameWindow.loadURL(url);
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

    state.write({ serverId: selected.id });

    // Before the window, not after: the game page begins polling for a pending sign-in as soon
    // as it loads, and the point of the saved token is that there is already one waiting.
    const resumed = await resumeLauncherSession(selected.url);
    if (resumed.expired) {
        pushState();
        return {
            ok: false,
            message: 'Your saved sign-in is no longer valid. Sign in with Discord again.'
        };
    }

    if (state.read().startDiscordBridge) {
        bridge.start({ clientUrl: selected.url, launcherConfig: loadLauncherConfig() });
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
// The server's Discord hand-off is a two-minute record keyed by the player's address, and the
// login packet spends it. Remembering the email here did not remember any of that, so the next
// start opened the game with nothing for it to find, the SWF fell through to the password path,
// and an account that was perfectly fine answered "wrong email or password".
//
// What is kept now is a device token the server issues after a real Discord sign-in
// (lib/launcherSession.js). Redeeming it on the next start recreates exactly the hand-off the
// OAuth callback would have, so the game page's own poll signs the player in as usual.
function rememberDiscordLogin(email) {
    discordAccount = { linked: true, email: String(email || '') };
    remembered = true;
    state.write({ discordEmail: discordAccount.email, discordLinkedAt: Date.now() });
}

function restoreDiscordLogin() {
    const saved = state.read();
    const cached = sessionCache.read();
    if (!saved.discordLinkedAt && !cached.token) {
        return;
    }
    discordAccount = { linked: true, email: cached.email || saved.discordEmail };
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
    discordAccount = { linked: false, email: '' };
    remembered = false;
    state.write({ discordEmail: '', discordLinkedAt: 0 });
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

    armFlash();
    restoreDiscordLogin();
    registerIpc();

    app.whenReady().then(() => {
        createLauncherWindow();
        void refreshServerStatus();

        social.start();

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
            }
        });
    });

    app.on('window-all-closed', () => {
        bridge.stop();
        social.stop();
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('before-quit', () => {
        bridge.stop();
        social.stop();
    });
}

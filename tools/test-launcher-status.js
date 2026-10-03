#!/usr/bin/env node
'use strict';

/**
 * Checks what the launcher window actually renders -- the status rows (Flash, Discord rich
 * presence, lobby chat, the in-game chat mirror, the widget profile) and the account row --
 * for every combination of state, without needing Electron: renderer.js runs against a
 * minimal DOM stub and the results are read back.
 *
 * Usage: node tools/test-launcher-status.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class StubElement {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.title = '';
        this.listeners = {};
    }

    addEventListener(type, handler) {
        this.listeners[type] = handler;
    }

    append(...nodes) {
        this.children.push(...nodes);
    }

    replaceChildren(...nodes) {
        this.children = nodes;
    }

    querySelector() {
        if (!this.querySelectorStub) {
            this.querySelectorStub = new StubElement('span');
        }
        return this.querySelectorStub;
    }
}

/** Runs renderer/renderer.js in a stub DOM and hands back the elements it filled in. */
function loadRenderer() {
    const registry = new Map();
    const document = {
        getElementById: (id) => {
            if (!registry.has(id)) {
                registry.set(id, new StubElement());
            }
            return registry.get(id);
        },
        createElement: (tag) => new StubElement(tag)
    };

    let render = null;
    const window = {
        launcher: {
            onState: (handler) => {
                render = handler;
            },
            // The test drives render() itself, so the initial fetch never settles.
            getState: () => new Promise(() => {}),
            play: async () => ({ ok: true }),
            discordLogin: async () => ({ ok: true }),
            forgetDiscordLogin: async () => null,
            browseFlash: async () => null,
            moveToApplications: async () => ({ ok: true }),
            relaunch: () => {},
            gameStatsSync: async () => null,
            quit: () => {}
        }
    };

    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    vm.runInNewContext(source, { document, window, console });

    assert.ok(render, 'renderer.js must register a state handler');
    return { render, registry };
}

function rowsFrom(registry) {
    const status = registry.get('engine-status');
    return status.children.map((row) => {
        const [label, value] = row.children;
        return { label: label.textContent, value: value.textContent, tone: value.className, detail: value.title };
    });
}

function row(rows, label) {
    const found = rows.find((entry) => entry.label === label);
    assert.ok(found, `expected a "${label}" row`);
    return found;
}

function baseState(flash, social, extra = {}) {
    return {
        appVersion: '1.0.0',
        servers: [{ id: 'official', name: 'Dungeon Blitz: R', url: 'http://example.test/' }],
        selectedServerUrl: 'http://example.test/',
        serverReachable: true,
        gameRunning: false,
        flash,
        social,
        presence: extra.presence || {
            running: false,
            ready: false,
            port: 0,
            characterName: '',
            activity: '',
            lastError: ''
        },
        chat: extra.chat || { enabled: true, running: false, supported: null, relayed: 0, received: 0, lastError: '' },
        gameStats: extra.gameStats || {
            enabled: true,
            running: false,
            state: 'idle',
            written: false,
            username: '',
            updatedAt: 0,
            lastError: ''
        },
        update: extra.update || { state: 'not-available', percent: 0, version: '', error: '', currentVersion: '1.0.0' },
        windows: extra.windows || {
            supported: true,
            product: 'Windows 10 or later',
            legacy: false,
            softwareRendering: false,
            reason: '',
            requirements: ''
        },
        install: extra.install || { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false },
        discord: extra.discord || { linked: false, email: '', name: '', remembered: false, loginPending: false }
    };
}

const ARMED_FLASH = {
    found: true,
    armed: true,
    path: '/Applications/Dungeon Blitz R.app/Contents/Resources/vendor/flash/darwin/PepperFlashPlayer.plugin',
    version: '32.0.0.303',
    source: 'vendor',
    killSwitch: false,
    architectures: ['x64'],
    archMismatch: false
};

const MISSING_FLASH = {
    found: false,
    armed: false,
    path: '',
    version: '',
    source: '',
    killSwitch: false,
    architectures: [],
    archMismatch: false
};

const IDLE_SOCIAL = {
    enabled: true,
    running: false,
    lobbyReady: false,
    authPending: false,
    lobbyId: '',
    lastStatus: ''
};

function main() {
    const { render, registry } = loadRenderer();

    // Armed plugin, Discord reached, lobby chat connected, chat mirror running.
    render(
        baseState(
            ARMED_FLASH,
            { ...IDLE_SOCIAL, running: true, lobbyReady: true, lobbyId: 'lobby-1', lastStatus: 'Lobby chat connected.' },
            {
                presence: {
                    running: true,
                    ready: true,
                    port: 47631,
                    characterName: 'BridgeProbe',
                    activity: 'Home - Idling in town',
                    lastError: ''
                },
                chat: { enabled: true, running: true, supported: true, relayed: 3, received: 1, lastError: '' }
            }
        )
    );
    let rows = rowsFrom(registry);
    assert.deepStrictEqual(
        rows.map((entry) => [entry.label, entry.value, entry.tone]),
        [
            ['Windows', 'Windows 10 or later', 'muted'],
            ['Flash', '32.0.0.303 - vendor', 'ok'],
            ['Discord status', 'Home - Idling in town', 'ok'],
            ['Lobby chat', 'connected', 'ok'],
            ['In-game chat', '3 sent - 1 received', 'ok'],
            ['Game stats', 'starts with the game', 'muted'],
            ['Update', 'up to date', 'muted']
        ]
    );
    assert.ok(row(rows, 'Flash').detail.includes('PepperFlashPlayer.plugin'), 'the Flash path is the tooltip');
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Lobby chat connected.');
    assert.ok(row(rows, 'Discord status').detail.includes('47631'), 'the local presence endpoint is the tooltip');

    // The machine row: Windows 7 runs the launcher on a software rasteriser, and a player
    // who did not know that would read the frame rate as a fault in the launcher.
    const WINDOWS_7 = {
        supported: true,
        product: 'Windows 7 SP1',
        legacy: true,
        softwareRendering: true,
        reason: '',
        requirements: 'Windows 7 Service Pack 1, Windows 8 or Windows 8.1, 64-bit.'
    };
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { windows: WINDOWS_7 }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Windows').value, 'Windows 7 SP1 - software rendering');
    assert.strictEqual(row(rows, 'Windows').tone, 'warn');
    assert.ok(row(rows, 'Windows').detail.includes('software'), row(rows, 'Windows').detail);

    // A Windows the pinned runtime cannot run on: said in the strip, not left to decode
    // from a launcher that would not have started.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            windows: {
                supported: false,
                product: 'Windows Vista',
                legacy: true,
                softwareRendering: false,
                reason: 'Windows Vista is older than Windows 7 Service Pack 1 (64-bit).',
                requirements: ''
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Windows').value, 'this Windows is too old');
    assert.strictEqual(row(rows, 'Windows').tone, 'bad');
    assert.ok(row(rows, 'Windows').detail.includes('Windows Vista'), row(rows, 'Windows').detail);

    // A macOS or Linux build has no Windows to talk about, and says so rather than
    // pretending to know.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { windows: { supported: true, product: '', legacy: false, softwareRendering: false, reason: '', requirements: '' } }));
    assert.strictEqual(row(rowsFrom(registry), 'Windows').value, 'not a Windows build');

    // A plugin whose architecture cannot load here.
    render(baseState({ ...ARMED_FLASH, archMismatch: true }, IDLE_SOCIAL));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Flash').value, 'x64-only - cannot load');
    assert.strictEqual(row(rows, 'Flash').tone, 'bad');

    // Everything idle is normal: presence and chat both start with the game.
    render(baseState(MISSING_FLASH, IDLE_SOCIAL));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Flash').value, 'missing');
    assert.strictEqual(row(rows, 'Flash').tone, 'bad');
    assert.strictEqual(row(rows, 'Discord status').value, 'starts with the game');
    assert.strictEqual(row(rows, 'Discord status').tone, 'muted');
    assert.strictEqual(row(rows, 'Lobby chat').value, 'starts with the game');
    assert.strictEqual(row(rows, 'In-game chat').value, 'starts with the game');

    // Discord closed while the game runs: presence cannot be published.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            presence: { running: true, ready: false, port: 47631, characterName: '', activity: '', lastError: 'Discord is not running.' }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Discord status').value, 'waiting for Discord');
    assert.strictEqual(row(rows, 'Discord status').tone, 'warn');
    assert.strictEqual(row(rows, 'Discord status').detail, 'Discord is not running.');

    // A server without the chat feed (the official one until it is redeployed).
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            chat: {
                enabled: true,
                running: true,
                supported: false,
                relayed: 0,
                received: 0,
                lastError: 'This server does not mirror game chat to Discord yet.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'In-game chat').value, 'server has no chat feed');
    assert.strictEqual(row(rows, 'In-game chat').tone, 'warn');
    assert.strictEqual(row(rows, 'In-game chat').detail, 'This server does not mirror game chat to Discord yet.');

    // The widget row: a written profile is the one state that means the widget has data to
    // show -- which is exactly what a player sees, or does not see, on their own profile and
    // on a friend's.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'written',
                written: true,
                username: 'BridgeProbe',
                updatedAt: 1700000000000,
                lastError: ''
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'profile written');
    assert.strictEqual(row(rows, 'Game stats').tone, 'ok');
    assert.ok(row(rows, 'Game stats').detail.includes('BridgeProbe'), 'the account written for is the tooltip');
    assert.strictEqual(registry.get('game-stats-sync').hidden, false, 'the manual sync is offered during a session');

    // No linked Discord account: the widget has nobody to be written for, and that is a
    // different fix from a server fault.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unlinked',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'Sign in with Discord in the game so the widget has an account to write.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'no Discord account linked');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');
    assert.ok(row(rows, 'Game stats').detail.includes('Sign in with Discord'));

    // A server that has not been redeployed with the route: said plainly, so an empty widget
    // is not mistaken for a broken account.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unsupported',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'This server cannot write Discord widget stats yet.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'server cannot write it');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');

    // On the sign-in screen there is no session to ask, so there is no button to press.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('game-stats-sync').hidden, true, 'no sync button without a session');

    // Chat mirroring turned off by configuration.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { chat: { enabled: false, running: false, supported: null, relayed: 0, received: 0, lastError: '' } }));
    assert.strictEqual(row(rowsFrom(registry), 'In-game chat').value, 'off');

    // Lobby chat turned off by configuration.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, enabled: false }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'off');

    // Waiting for the Discord consent dialog.
    render(
        baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, authPending: true, lastStatus: 'Asking Discord to authorize the launcher...' })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'waiting for Discord approval');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'warn');
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Asking Discord to authorize the launcher...');

    // Starting up, nothing settled yet.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, lastStatus: 'JavaScript social bridge starting...' }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'connecting...');

    // The Discord client being closed is the common "never connects" cause; the row must
    // name it instead of leaving an errno to decode.
    render(
        baseState(ARMED_FLASH, {
            ...IDLE_SOCIAL,
            running: true,
            lastStatus: 'The Discord desktop client is not running. Start Discord, then start the game again.'
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'Discord client not running');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'bad');

    // The Update row: quiet when up to date, loud when an install is waiting.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloading', percent: 42, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Update').value, 'downloading 1.1.0 - 42%');
    assert.strictEqual(row(rows, 'Update').tone, 'warn');
    assert.strictEqual(registry.get('update-install').hidden, true, 'no restart button mid-download');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloaded', percent: 100, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Update').value, '1.1.0 ready - restart to install');
    assert.strictEqual(row(rows, 'Update').tone, 'ok');
    assert.strictEqual(registry.get('update-install').hidden, false, 'the restart button appears when the update is complete');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'disabled', percent: 0, version: '', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Update').value, 'off in this build');
    assert.strictEqual(registry.get('update-install').hidden, true);

    // A remembered account replaces the sign-in button entirely.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: 'neodevils', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('discord-login').hidden, true, 'no sign-in button once the account is known');
    assert.strictEqual(registry.get('account').hidden, false);
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as neodevils');
    assert.strictEqual(registry.get('status').textContent, 'Ready to play.');

    // Neither a name nor an email is still an account: fall back to the email, then to none.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: '', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as player@example.test');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('discord-login').hidden, false, 'a fresh install still offers the button');
    assert.strictEqual(registry.get('account').hidden, true);

    // A copy running from a disk image or from Downloads says so, and offers the move.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            install: {
                relocate: true,
                reason: 'disk-image',
                message: 'The launcher is running from a mounted disk image.',
                sourcePath: '/Volumes/Dungeon Blitz R/Dungeon Blitz R.app',
                targetPath: '/Applications/Dungeon Blitz R.app',
                canMove: true
            }
        })
    );
    assert.strictEqual(registry.get('problem').hidden, false);
    assert.ok(registry.get('problem').textContent.includes('/Applications/Dungeon Blitz R.app'));
    assert.strictEqual(registry.get('move-app').hidden, false);

    // An installed copy shows neither.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { install: { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false } }));
    assert.strictEqual(registry.get('problem').hidden, true);
    assert.strictEqual(registry.get('move-app').hidden, true);

    console.log('[test-launcher-status] status rows and the account row render correctly in every state');
    console.log('[test-launcher-status] all assertions passed');
}

main();

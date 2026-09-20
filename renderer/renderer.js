'use strict';

const elements = {
    discordLogin: document.getElementById('discord-login'),
    play: document.getElementById('play'),
    status: document.getElementById('status'),
    problem: document.getElementById('problem'),
    repair: document.getElementById('repair'),
    browseFlash: document.getElementById('browse-flash'),
    relaunch: document.getElementById('relaunch'),
    moveApp: document.getElementById('move-app'),
    account: document.getElementById('account'),
    accountName: document.getElementById('account-name'),
    forget: document.getElementById('forget'),
    versions: document.getElementById('versions'),
    quit: document.getElementById('quit'),
    engineStatus: document.getElementById('engine-status')
};

/**
 * The rows under the problem banner: which Flash plugin is armed, whether Discord shows the
 * player as playing, and what the two chat directions are doing. The values stay short and
 * the detail (paths, last status, last error) moves into the tooltip, so the row is
 * readable at a glance without becoming a log.
 */
function engineRows(state) {
    const flash = state.flash || {};
    const social = state.social || {};
    const presence = state.presence || {};
    const chat = state.chat || {};

    let flashValue = 'missing';
    let flashTone = 'bad';
    let flashDetail = 'No Flash plugin was found. Run `npm run extract-flash` or choose one by hand.';
    if (flash.found) {
        flashDetail = flash.path || '';
        if (flash.archMismatch) {
            flashValue = `${(flash.architectures || []).join('/')}-only - cannot load`;
            flashTone = 'bad';
        } else {
            flashValue = [flash.version || 'unknown version', flash.source].filter(Boolean).join(' - ');
            flashTone = 'ok';
        }
    }

    // "Starts with the game" is the normal state on the sign-in screen: the bridge is
    // deliberately idle until a game session asks for it.
    let socialValue = 'starts with the game';
    let socialTone = 'muted';
    let socialDetail = social.lastStatus || '';
    if (!social.enabled) {
        socialValue = 'off';
    } else if (social.lobbyReady) {
        socialValue = 'connected';
        socialTone = 'ok';
    } else if (social.authPending) {
        socialValue = 'waiting for Discord approval';
        socialTone = 'warn';
    } else if (/Discord desktop client is not running/i.test(social.lastStatus || '')) {
        // The one "lobby never connects" cause a player can fix themselves; say it instead
        // of leaving a generic "connecting..." to decode.
        socialValue = 'Discord client not running';
        socialTone = 'bad';
    } else if (social.running) {
        socialValue = 'connecting...';
        socialTone = 'warn';
    }

    // Discord's own window is the only place rich presence can be seen, so this row is
    // what tells the difference between "Discord has it" and "nothing was ever sent".
    let presenceValue = 'starts with the game';
    let presenceTone = 'muted';
    let presenceDetail = 'Rich presence is served by the launcher while the game runs.';
    if (presence.ready) {
        presenceValue = presence.activity || (presence.characterName ? `playing ${presence.characterName}` : 'connected');
        presenceTone = 'ok';
        presenceDetail = ['Discord client reached', presence.port ? `local endpoint 127.0.0.1:${presence.port}` : '']
            .filter(Boolean)
            .join(' - ');
    } else if (presence.running) {
        presenceValue = 'waiting for Discord';
        presenceTone = 'warn';
        presenceDetail = presence.lastError || 'The Discord desktop client is not reachable.';
    } else if (presence.lastError) {
        presenceValue = 'unavailable';
        presenceTone = 'bad';
        presenceDetail = presence.lastError;
    }

    // In-game chat cannot be read from the launcher, so this reflects the server's feed:
    // without it there is nothing to mirror, and the row says so instead of staying silent.
    let chatValue = 'starts with the game';
    let chatTone = 'muted';
    let chatDetail = 'Game chat is mirrored to your Discord lobby while you play.';
    if (chat.running) {
        if (chat.supported === false) {
            chatValue = 'server has no chat feed';
            chatTone = 'warn';
            chatDetail = chat.lastError || 'This server does not expose a chat feed yet.';
        } else if (chat.lastError) {
            chatValue = `${chat.relayed} sent - ${chat.received} received`;
            chatTone = 'warn';
            chatDetail = chat.lastError;
        } else if (chat.supported === true) {
            chatValue = `${chat.relayed} sent - ${chat.received} received`;
            chatTone = 'ok';
            chatDetail = 'Your own game chat goes to your lobby; lobby chat prints in game.';
        }
    } else if (!chat.enabled) {
        chatValue = 'off';
        chatDetail = 'Disabled with DUNGEON_BLITZ_CHAT_RELAY=0.';
    }

    return [
        { label: 'Flash', value: flashValue, tone: flashTone, detail: flashDetail },
        { label: 'Discord status', value: presenceValue, tone: presenceTone, detail: presenceDetail },
        { label: 'Lobby chat', value: socialValue, tone: socialTone, detail: socialDetail },
        { label: 'In-game chat', value: chatValue, tone: chatTone, detail: chatDetail }
    ];
}

function renderEngineStatus(state) {
    const rows = engineRows(state).map((row) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'engine-row';

        const label = document.createElement('dt');
        label.textContent = row.label;

        const value = document.createElement('dd');
        value.className = row.tone;
        value.textContent = row.value;
        if (row.detail) {
            value.title = row.detail;
        }

        wrapper.append(label, value);
        return wrapper;
    });

    elements.engineStatus.replaceChildren(...rows);
}

let currentState = null;

function showProblem(message, severity) {
    elements.problem.hidden = !message;
    elements.problem.textContent = message || '';
    elements.problem.className = severity === 'bad' ? 'problem bad' : 'problem';
    elements.repair.hidden = !message;
}

/**
 * A copy running from a mounted disk image or from Downloads is a copy the next build will
 * not replace -- the quiet way players end up on a launcher that no longer works. The
 * banner stays until the app has been moved.
 */
function installWarning(state) {
    const install = state.install || {};
    if (!install.relocate) {
        return null;
    }

    return {
        message: install.canMove
            ? `${install.message} Move it to ${install.targetPath}.`
            : install.message,
        severity: 'warn'
    };
}

// One line, because the launcher is a sign-in screen: whatever is currently keeping the
// player out of the game, or how far the sign-in has got.
function statusLine(state) {
    if (state.gameRunning) {
        return 'The game is running.';
    }
    if (state.discord.loginPending) {
        return 'Finish signing in in your browser...';
    }
    if (state.discord.linked) {
        return state.discord.remembered ? 'Ready to play.' : `${accountLabel(state.discord)}.`;
    }
    if (state.serverReachable === false) {
        return 'The server is not responding.';
    }
    if (state.serverReachable === null) {
        return 'Checking the server...';
    }
    return 'Sign in with Discord to play.';
}

function accountLabel(discord) {
    const name = String((discord && discord.name) || '').trim();
    if (name) {
        return `Signed in as ${name}`;
    }
    const email = String((discord && discord.email) || '').trim();
    return email ? `Signed in as ${email}` : 'Signed in';
}

function render(state) {
    currentState = state;

    const flash = state.flash;
    const playable = flash.armed && !flash.archMismatch && state.servers.length > 0;

    elements.status.textContent = statusLine(state);
    // A known account replaces the button outright: asking a player who is already signed
    // in to sign in again is the thing this row exists to stop.
    elements.discordLogin.hidden = state.discord.remembered;
    elements.discordLogin.disabled = state.discord.loginPending || !state.serverReachable;
    elements.discordLogin.querySelector('.label').textContent = state.discord.loginPending
        ? 'Waiting for your browser...'
        : 'Sign in with Discord';
    elements.account.hidden = !state.discord.remembered;
    elements.accountName.textContent = accountLabel(state.discord);
    elements.play.disabled = !playable;
    elements.relaunch.hidden = !flash.found || flash.armed;
    elements.forget.hidden = !state.discord.remembered;

    if (!flash.found) {
        showProblem('The Flash plugin is missing. Point the launcher at it to continue.', 'bad');
    } else if (flash.archMismatch) {
        showProblem(
            `The Flash plugin is ${flash.architectures.join('/')} but this launcher runs as a ` +
                'different architecture, so Flash cannot load. Reinstall dependencies as x64: ' +
                'npm_config_arch=x64 npm install',
            'bad'
        );
    } else if (!flash.armed) {
        showProblem('The Flash path changed. Restart the launcher to pick it up.', 'warn');
    } else if (flash.killSwitch) {
        showProblem(
            `Flash ${flash.version} carries Adobe's 2021 kill switch and may refuse to run the game.`,
            'warn'
        );
    } else if (state.serverReachable === false) {
        showProblem(`Could not reach ${state.selectedServerUrl}`, 'bad');
    } else {
        const install = installWarning(state);
        if (install) {
            showProblem(install.message, install.severity);
        } else {
            showProblem('');
        }
    }

    elements.moveApp.hidden = !(state.install && state.install.relocate && state.install.canMove);

    renderEngineStatus(state);
    elements.versions.textContent = `v${state.appVersion}`;
}

elements.discordLogin.addEventListener('click', async () => {
    const result = await window.launcher.discordLogin();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not start the Discord sign-in.', 'bad');
    }
});

elements.play.addEventListener('click', async () => {
    elements.play.disabled = true;
    const result = await window.launcher.play();
    if (!result || !result.ok) {
        showProblem((result && result.message) || 'Could not start the game.', 'bad');
    }
    if (currentState) {
        elements.play.disabled = !currentState.flash.armed;
    }
});

elements.forget.addEventListener('click', async () => {
    render(await window.launcher.forgetDiscordLogin());
});

elements.browseFlash.addEventListener('click', async () => {
    render(await window.launcher.browseFlash());
});

elements.relaunch.addEventListener('click', () => {
    void window.launcher.relaunch();
});

elements.moveApp.addEventListener('click', async () => {
    const result = await window.launcher.moveToApplications();
    if (result && !result.ok) {
        showProblem(result.message || 'Could not move the launcher.', 'bad');
    }
});

elements.quit.addEventListener('click', () => {
    void window.launcher.quit();
});

window.launcher.onState(render);
window.launcher.getState().then(render);

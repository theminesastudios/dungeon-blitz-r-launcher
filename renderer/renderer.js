'use strict';

const elements = {
    discordLogin: document.getElementById('discord-login'),
    play: document.getElementById('play'),
    status: document.getElementById('status'),
    problem: document.getElementById('problem'),
    repair: document.getElementById('repair'),
    browseFlash: document.getElementById('browse-flash'),
    relaunch: document.getElementById('relaunch'),
    forget: document.getElementById('forget'),
    versions: document.getElementById('versions'),
    quit: document.getElementById('quit')
};

let currentState = null;

function showProblem(message, severity) {
    elements.problem.hidden = !message;
    elements.problem.textContent = message || '';
    elements.problem.className = severity === 'bad' ? 'problem bad' : 'problem';
    elements.repair.hidden = !message;
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
        return state.discord.email ? `Signed in as ${state.discord.email}` : 'Signed in.';
    }
    if (state.serverReachable === false) {
        return 'The server is not responding.';
    }
    if (state.serverReachable === null) {
        return 'Checking the server...';
    }
    return 'Sign in with Discord to play.';
}

function render(state) {
    currentState = state;

    const flash = state.flash;
    const playable = flash.armed && !flash.archMismatch && state.servers.length > 0;

    elements.status.textContent = statusLine(state);
    elements.discordLogin.disabled = state.discord.loginPending || !state.serverReachable;
    elements.discordLogin.querySelector('.label').textContent = state.discord.loginPending
        ? 'Waiting for your browser...'
        : 'Sign in with Discord';
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
        showProblem('');
    }

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

elements.quit.addEventListener('click', () => {
    void window.launcher.quit();
});

window.launcher.onState(render);
window.launcher.getState().then(render);

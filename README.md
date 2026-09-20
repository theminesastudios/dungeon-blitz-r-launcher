# Dungeon Blitz: R Launcher

A desktop launcher that plays Dungeon Blitz with Adobe Flash embedded, so players do not
need a browser that still has Flash. It ships for Windows, macOS and Linux.

The launcher is a sign-in screen, not a control panel. It asks for one thing — sign in
with Discord — and once that is done it opens the game window and connects to the server.
A player who has signed in before is not asked again.

In the background it also arms the Flash plugin, runs the Discord Social SDK bridge so
lobby chat and the party roster work inside Discord, and starts the rich-presence bridge
when a game-server checkout is available.

## Why Electron 11

Chromium removed the PPAPI Flash host in 88. Electron 11 (Chromium 87) is the last release
that still understands `--ppapi-flash-path`, so the launcher is pinned to it.
**Upgrading Electron silently removes Flash support.**

The same pin is why Discord's consent screen is opened in the player's own browser rather
than inside the app: discord.com's web client no longer parses on Chromium 87. The server
keys a pending sign-in by requester address, so the launcher's poll still sees the result.

## Binaries: `payload/` and `vendor/`

| Folder | What | In git |
| --- | --- | --- |
| `payload/` | The **source** of the binaries a package ships | Yes, via Git LFS |
| `vendor/` | Build output — what packaging reads | No, gitignored |

`tools/stage-vendor.js` copies `payload/` (and a freshly built native bridge, when there is
one) into `vendor/`. Locally, `tools/extract-flash.js` writes straight into `vendor/`. Both
produce the same layout.

```text
payload/flash/<platform>/     pepflashplayer64.dll | PepperFlashPlayer.plugin | libpepflashplayer.so
payload/social/<platform>/    discord_social_bridge[.exe] + the SDK runtime library
```

## Flash plugin

```bash
npm run extract-flash
```

This pulls the plugin out of a FlashBrowser installation, which ships **32.0.0.363** — the
last build before Adobe's 2021-01-12 kill switch, which lives inside the plugin and cannot
be disabled from the outside. `32.0.0.371` and later will refuse to run the game.

From somewhere else:

```bash
node tools/extract-flash.js --from "/path/to/FlashBrowser" --platform darwin
```

If nothing is vendored, the launcher scans the player's own Flash installations and, as a
last resort, asks for the path on the sign-in screen.

| Platform | File | Where it comes from |
| --- | --- | --- |
| Windows | `pepflashplayer64.dll` | FlashBrowser (Windows) |
| macOS | `PepperFlashPlayer.plugin` | FlashBrowser's macOS build |
| Linux | `libpepflashplayer.so` | Adobe's archived PPAPI Linux tarball, or Chrome's `PepperFlash` folder |

The plugin is each platform's own native binary; the Windows DLL is of no use on macOS or
Linux.

### macOS is x64 only

On purpose. The last Flash plugin is an x86_64 binary and a PPAPI plugin must match the
architecture of the process hosting it, so an arm64 build would start and then never find a
usable plugin. Apple Silicon runs this build under Rosetta, and CI uses the Intel runner.

## Discord Social SDK bridge

`native_bridge/` is a mirror of the game server's bridge sources. The launcher runs the
compiled bridge as a child process and speaks the same newline-delimited JSON protocol the
server uses:

```text
launcher -> bridge : initialize | outbound_chat | use_lobby | link_channel
bridge -> launcher : ready | auth | status | chat | lobby_ready |
                     channel_linked | channel_link_failed | send_result
```

Running it here rather than on the server is what makes lobby chat per-player: each player
authorizes their own Discord account and joins the lobby as themselves. The bridge runs
headless — lobby chat and the party roster are read in Discord's own client.

Building it needs the Discord Social SDK (headers plus the platform library) at
`native_bridge/discord_social_sdk/`, which is not redistributable and therefore not in this
repository:

```bash
npm run build:bridge
```

On Linux this also needs `libasound2-dev` and `libpulse-dev` — the SDK links against ALSA
and PulseAudio. Copy the result into `payload/social/<platform>/`.

**No macOS build of the Social SDK exists.** On darwin (and wherever the native binary is
absent) the launcher falls back to a built-in JavaScript driver — `lib/socialJs.js` over
`lib/socialRest.js`, modelled on `@minesa-org/mini-interaction`'s `DiscordRestClient` —
which speaks the same protocol events to Discord's HTTP lobby API: PKCE sign-in in the
player's browser, create-or-join by lobby secret, linked-channel relay and message
polling. It needs the application to allow the `openid identify sdk.social_layer` scopes
and to register the loopback redirect `http://127.0.0.1/callback`.

```bash
node tools/test-social-bridge.js   # drives the JS bridge against a local mock of Discord
```

**`deviceFlow` must stay off.** The device path requires the Discord application to allow
device authorization; without it the SDK does not return an error, it aborts the whole
process on a failed `CanAuthorizeDevice` check. The browser PKCE flow needs no such
capability.

## Running and packaging

```bash
npm install && npm run extract-flash && npm start
```

```bash
npm run dist:win
```

Output lands in `dist/`. What can be built where:

| Target | On Windows | On Linux (incl. WSL) | On macOS |
| --- | --- | --- | --- |
| `nsis` / `portable` | yes, needs Developer Mode | no | no |
| `AppImage` / `deb` | no (symlinks) | yes | yes |
| `zip` (mac, unsigned) | no (symlinks) | yes | yes |
| `dmg` | no | no | yes |

### Symlink privilege on Windows

electron-builder's `winCodeSign` package and the AppImage icon step both create symbolic
links, which an ordinary Windows account may not do. With Developer Mode off, `dist:win`
and `dist:linux` fail with a privilege error. Either turn on Settings → System → For
developers → Developer Mode, or build Windows unsigned:

```bash
npm run dist:win -- --dir --config.win.signAndEditExecutable=false
```

### GitHub Actions

Bumping `version` in `package.json` on `main` is what cuts a release.
`.github/workflows/release.yml` then builds on three native runners, stages the binaries,
checks that Flash is present, runs electron-builder and attaches the installers to a draft
GitHub release tagged `v<version>`:

| Platform | Files |
| --- | --- |
| Windows | `...-win-x64-setup.exe`, `...-win-x64-portable.exe` |
| macOS | `...-mac-x64.dmg`, `...-mac-x64.zip` |
| Linux | `...-linux-x86_64.AppImage`, `...-linux-amd64.deb` |

Editing `package.json` without changing the version builds nothing; the workflow compares
against the previous commit first. A manual run builds the current version, and only
publishes when `publish` is ticked.

Packages are **unsigned**. Signing needs `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows and
macOS, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization.

## Servers

Targets live in `servers.json`. There is no server picker in the UI; the launcher uses the
saved choice from `launcher-state.json` in the user data folder, or `defaultServerId`.

## Optional: the game repository

The rich-presence bridge and the server's own Social SDK settings come from a checkout of
the game repository. The launcher looks for it next to this one, and
`DUNGEON_BLITZ_SERVER_ROOT` overrides that. Without it those two features simply stay off.

## Game window shortcuts

| Key | Effect |
| --- | --- |
| `F11` | Toggle full screen |
| `F5` / `Ctrl+R` | Reload |
| `Ctrl+Shift+I` | Developer tools |

## Security notes

- The launcher shell runs with `contextIsolation: true`, `nodeIntegration: false` and
  plugins disabled; its only contact with the main process is the seven IPC calls in
  `preload.js`.
- Plugins are enabled only in the game window.
- The game window cannot leave its own origin: `will-navigate` and `new-window` are
  blocked and handed to the system browser, and `webview` tags are refused.
- URLs are limited to `http`/`https`, and any carrying credentials are rejected.

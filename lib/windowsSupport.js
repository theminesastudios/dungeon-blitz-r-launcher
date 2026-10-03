'use strict';

const os = require('os');

/**
 * Which Windows versions this launcher runs on, and what has to be switched on for the
 * ones that are still supported.
 *
 * Electron 11 (Chromium 87) is the reason Windows 7 works at all: Electron only stopped
 * supporting Windows 7, 8 and 8.1 in version 23, long after the PPAPI Flash host this
 * launcher is pinned to was removed. So the runtime itself starts on every Windows from
 * 7 Service Pack 1 up, and two things are left over for those machines:
 *
 *  - The Universal C Runtime. Electron's binaries link against `ucrtbase.dll`, which
 *    Windows 7 and 8 ship only through KB2533623 (or its successor KB2999226). Without it
 *    the process never starts -- there is no window and no message to read.
 *  - A GPU Chromium can drive. Chromium 87 asks for D3D11, which reaches Windows 7 through
 *    the platform update (KB4474419) and is simply absent on the machines that need this
 *    launcher most: a spare desktop, a netbook, a VM. What that costs is a black window
 *    or a GPU process that dies on start, neither of which says which driver is at fault.
 *
 * The answer to both is here rather than at the call site, so the rule is one function
 * that can be tested from any machine: `os.release()` is a parameter rather than a call.
 * tools/test-windows-support.js walks every Windows version through it without an Electron
 * runtime, a Windows box, or a network.
 */

/** What the launcher needs at the very least. Named in the refusal dialog and the README. */
const MINIMUM_WINDOWS = 'Windows 7 Service Pack 1 (64-bit)';

/**
 * The process architectures whose packaged plugin can actually load.
 *
 * PPAPI plugins are loaded in-process, so the plugin has to be a binary this process can
 * execute. The only Windows plugin this project vendors is an x86_64 one
 * (`payload/flash/win32/pepflashplayer64.dll`), which is why the Windows targets are x64
 * and why macOS is x64 only for the same reason.
 *
 * The 32-bit Windows installers exist because a player on a 32-bit Windows has nothing
 * else to download: they install and they open, and then they cannot play. That is a
 * deliberate, documented outcome rather than a defect -- see README "32-bit Windows", and
 * unsupportedArchitectureMessage() below, which says so on the first window instead of
 * letting the player discover it as a game that never loads.
 */
const SUPPORTED_ARCHITECTURES = ['x64'];

/**
 * The refusal text for a launcher running as an architecture no vendored plugin matches.
 *
 * @param {{arch: string, platform: string}} status
 * @returns {string}
 */
function unsupportedArchitectureMessage(status) {
    // "an ia32 process", "an arm64 process" -- the article has to agree with the
    // architecture, which is a word a player is already reading for the first time.
    const arch = String(status.arch || 'unknown');
    const article = /^[aeiou]/i.test(arch) ? 'an' : 'a';
    const detected = `${article} ${arch} process`;

    return [
        `This launcher is a 64-bit application and ${detected} cannot host the Flash plugin.`,
        '',
        `Running on: ${detected} (${status.platform})`,
        'The Flash plugin is an x86_64 binary and a PPAPI plugin is loaded into this very',
        'process, so there is nothing a 32-bit build can load. The game will not start.',
        '',
        'Install the 64-bit launcher (win-x64) instead of this one (win-ia32). A 64-bit',
        'Windows 7 or later is what this game needs; Windows 7 and 8 run it in software.',
        '',
        'See "32-bit Windows" in the launcher README.'
    ].join('\n');
}

/** Windows 7 Service Pack 1 is the 7601 build; 7600 is the release-to-manufacturer one. */
const WINDOWS_7_SERVICE_PACK_1_BUILD = 7601;

/**
 * The Windows kernels, as `os.release()` reports them: "10.0.19045", "6.1.7601", and so
 * on. The legacy entries are all machines Chromium 87 can run on; Vista and older are the
 * ones it cannot, and the runtime never gets far enough on those to complain itself.
 *
 * A major of 10 covers Windows 10 and Windows 11 alike -- both report a 10.0 kernel -- so
 * the product name says "or later" rather than guessing from the build.
 */
const WINDOWS_RELEASES = [
    { major: 10, product: 'Windows 10 or later', legacy: false },
    { major: 6, minor: 3, product: 'Windows 8.1', legacy: true },
    { major: 6, minor: 2, product: 'Windows 8', legacy: true },
    { major: 6, minor: 1, product: 'Windows 7 SP1', legacy: true, minimumBuild: WINDOWS_7_SERVICE_PACK_1_BUILD },
    { major: 6, minor: 0, product: 'Windows Vista', legacy: true, unsupported: true }
];

/** What a legacy machine has to have installed before the launcher can start at all. */
const LEGACY_REQUIREMENTS = [
    'Windows 7 Service Pack 1, Windows 8 or Windows 8.1, 64-bit.',
    'The Universal C Runtime update: KB2999226, or the earlier KB2533623.',
    'The Windows 7 platform update (KB4474419) brings hardware rendering; without it the launcher renders in software.'
].join('\n');

/**
 * Splits an `os.release()` string into its kernel numbers.
 *
 * @returns {{major: number, minor: number, build: number, version: string}|null} `null`
 *   when the string is not a Windows kernel version at all.
 */
function parseRelease(release) {
    const parts = String(release || '')
        .split('.')
        .map((part) => Number.parseInt(part, 10));

    if (parts.length < 2 || parts.some((part) => !Number.isInteger(part))) {
        return null;
    }

    return {
        major: parts[0],
        minor: parts[1],
        build: parts.length > 2 && Number.isInteger(parts[2]) ? parts[2] : 0,
        version: `${parts[0]}.${parts[1]}`
    };
}

function findRelease(major, minor) {
    return WINDOWS_RELEASES.find((entry) => entry.major === major && (entry.minor === undefined || entry.minor === minor));
}

/**
 * Reads the Windows this is and decides what the launcher can do about it.
 *
 * @param {{platform?: string, release?: string, arch?: string}} [options] All default to this
 *   process, so the common call is argument-free; the parameters are what make every
 *   Windows version and both architectures testable from any machine.
 * @returns {{
 *   platform: string, release: string, product: string, build: number, arch: string,
 *   legacy: boolean, supported: boolean, softwareRendering: boolean,
 *   architectureSupported: boolean, reason: string, requirements: string
 * }} `softwareRendering` is what the launcher is about to do, not a recommendation: the
 *   switches in compatibilitySwitches() are applied whenever it is true.
 */
function describeWindows(options = {}) {
    const platform = options.platform === undefined ? process.platform : String(options.platform);
    const release = options.release === undefined ? String(os.release() || '') : String(options.release);
    const arch = options.arch === undefined ? String(process.arch || '') : String(options.arch);

    const status = {
        platform,
        release,
        product: '',
        build: 0,
        arch,
        // The 32-bit Windows installers install and open; this is what tells them apart
        // from a 64-bit one that cannot play, and it is checked before the refusal text
        // is chosen so the player is told about the architecture rather than the version.
        architectureSupported: SUPPORTED_ARCHITECTURES.includes(arch),
        // Windows 7 and 8 are the machines where the GPU cannot be trusted, so they are
        // also the ones that get the software fallback.
        legacy: false,
        supported: true,
        softwareRendering: false,
        reason: '',
        requirements: ''
    };

    // macOS and Linux have none of this: nothing to classify and nothing to switch on. A
    // wrong-architecture macOS or Linux build is equally unplayable, but those targets are
    // x64-only by configuration, so there is no package for this to catch.
    if (platform !== 'win32') {
        return status;
    }

    // Checked before the version, because it is the more likely reason on the machine this
    // describes: a player who downloaded the 32-bit installer is here because they were
    // told to, and "this Windows is too old" would be a wrong and unhelpful answer. The
    // product name is resolved first only so the refusal can say which Windows it is on.
    if (!status.architectureSupported) {
        const parsedForName = parseRelease(release);
        const knownForName = parsedForName && findRelease(parsedForName.major, parsedForName.minor);

        status.supported = false;
        status.build = parsedForName ? parsedForName.build : 0;
        status.product = knownForName ? `${knownForName.product} (${arch})` : `Windows (${arch})`;
        status.legacy = Boolean(knownForName && knownForName.legacy);
        status.reason =
            `This launcher is a 64-bit application and is running as ${arch}. The Flash plugin is ` +
            'an x86_64 binary loaded into this process, so a 32-bit build cannot play.';
        status.requirements = 'Install the 64-bit launcher (win-x64) instead of the 32-bit one (win-ia32).';
        return status;
    }

    const parsed = parseRelease(release);
    if (!parsed) {
        status.supported = false;
        status.reason = `The Windows version could not be read from "${release}".`;
        status.requirements = `This launcher needs ${MINIMUM_WINDOWS}.`;
        return status;
    }

    status.build = parsed.build;

    const known = findRelease(parsed.major, parsed.minor);
    if (!known) {
        // Older than the table (Windows XP and Server 2003 report a 5.x kernel).
        status.product = `Windows ${parsed.version}`;
        status.legacy = parsed.major < 10;
        status.supported = false;
        status.reason = `Windows ${parsed.version} is older than ${MINIMUM_WINDOWS}.`;
        status.requirements = `This launcher needs ${MINIMUM_WINDOWS}.`;
        return status;
    }

    // Windows 7 without its service pack is the one supported-looking entry that is not:
    // say so in the name rather than in a footnote.
    status.product =
        known.product === 'Windows 7 SP1' && parsed.build < WINDOWS_7_SERVICE_PACK_1_BUILD
            ? 'Windows 7 (no Service Pack 1)'
            : known.product;
    status.legacy = Boolean(known.legacy);

    const missingServicePack = Boolean(known.minimumBuild) && parsed.build < known.minimumBuild;
    status.supported = !known.unsupported && !missingServicePack;

    if (!status.supported) {
        status.reason = missingServicePack
            ? `This launcher needs ${MINIMUM_WINDOWS}, and this machine is not on the Service Pack 1 build.`
            : `${status.product} is older than ${MINIMUM_WINDOWS}.`;
        status.requirements = `This launcher needs ${MINIMUM_WINDOWS}.`;
    }

    if (status.legacy) {
        // Only where the launcher will actually run: an unsupported Windows is refused
        // before anything is drawn, so it has no rendering path to fall back to and no use
        // for the advice about one. What it needs there is the floor, already said.
        status.softwareRendering = status.supported;
        if (status.supported) {
            status.requirements = LEGACY_REQUIREMENTS;
        }
    }

    return status;
}

/**
 * The Chromium switches a legacy Windows needs before the first window is created.
 *
 * SwiftShader answers WebGL in software and `--disable-gpu-compositing` keeps the window
 * compositor off D3D11, which is the call that actually fails on a machine without the
 * platform update. Both are scoped to legacy Windows on purpose: on Windows 10 the same
 * switches would cost the game real frames for nothing.
 *
 * @param {{platform?: string, release?: string, gpu?: string}} [options] `gpu` overrides
 *   the default, which is `process.env.DUNGEON_BLITZ_GPU` as read by the caller. `hardware`
 *   (or `1`) leaves the GPU alone for a legacy machine that has the platform update.
 * @returns {Array<{name: string, value: string}>} An empty list on anything that is not a
 *   legacy Windows, or when the player asked for hardware rendering.
 */
function compatibilitySwitches(options = {}) {
    const status = describeWindows(options);
    if (!status.legacy || !status.supported) {
        return [];
    }

    const gpu = String(options.gpu === undefined ? '' : options.gpu)
        .trim()
        .toLowerCase();
    if (gpu === 'hardware' || gpu === 'on' || gpu === '1') {
        return [];
    }

    return [
        { name: 'use-gl', value: 'swiftshader' },
        { name: 'disable-gpu-compositing', value: '' }
    ];
}

/**
 * The refusal text for a Windows the pinned runtime cannot run on.
 *
 * @param {ReturnType<typeof describeWindows>} status
 * @returns {string}
 */
function unsupportedWindowsMessage(status) {
    const detected = status.product || `Windows ${status.release || 'unknown'}`;

    return [
        `This launcher needs ${MINIMUM_WINDOWS}.`,
        '',
        `Running on: ${detected} (${status.release})`,
        status.reason,
        '',
        '64-bit is not optional: the Flash plugin is an x86_64 binary and is loaded into this process,',
        'so a 32-bit Windows has no plugin that can load.',
        '',
        'A Windows 7 machine also needs the Universal C Runtime update (KB2999226). Without it the',
        'launcher does not start at all -- there is nothing to show this message.',
        '',
        'See "Windows versions" in the launcher README.'
    ].join('\n');
}

module.exports = {
    LEGACY_REQUIREMENTS,
    MINIMUM_WINDOWS,
    SUPPORTED_ARCHITECTURES,
    WINDOWS_7_SERVICE_PACK_1_BUILD,
    compatibilitySwitches,
    describeWindows,
    unsupportedArchitectureMessage,
    unsupportedWindowsMessage
};
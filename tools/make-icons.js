#!/usr/bin/env node
'use strict';

/**
 * Derives every icon format the launcher ships from one source PNG:
 *
 *   build/icon.icns                macOS app, dock and dmg icon (electron-builder's default name)
 *   build/icon.ico                 Windows and Linux icon (electron-builder's default name)
 *   renderer/assets/icon.png       256px PNG the windows and the Linux dock load at runtime
 *   renderer/assets/favicon.ico    the sign-in page's favicon
 *
 * Only macOS can run this: scaling goes through the system `sips` and the icns through
 * `iconutil`. The ICO is assembled here rather than copied, because sips writes its BMP
 * rows top-down (negative biHeight) and an ICO entry wants them bottom-up; getting that
 * wrong ships an upside-down icon nobody notices until it is in a taskbar. Every output is
 * parsed back after assembly, so a broken icon fails this script instead of shipping.
 *
 * Usage: node tools/make-icons.js [source.png]   (default source: build/icon.png)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.join(LAUNCHER_ROOT, 'build', 'icon.png');

// Sizes small enough to embed as raw bitmaps; 256 is embedded as PNG, the encoding every
// Windows shell since Vista reads and the only sane way to carry that size.
const BMP_SIZES = [16, 24, 32, 48, 64, 128];

// The icns wants every Apple-named variant, including the @2x retina steps.
const ICONSET_VARIANTS = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
];

function run(command, args) {
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Scales the source to size x size in the requested format and returns the file's bytes. */
function scaledTo(source, size, format, scratch) {
    const target = path.join(scratch, `scale-${size}.${format}`);
    run('sips', ['-s', 'format', format, '-z', String(size), String(size), source, '--out', target]);
    return fs.readFileSync(target);
}

/** Parses sips' 32-bit BMP output into { width, height, pixels } with rows in image order (top first). */
function readBmpPixels(buffer) {
    if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') {
        throw new Error('sips did not produce a BMP');
    }
    const pixelOffset = buffer.readUInt32LE(10);
    const headerSize = buffer.readUInt32LE(14);
    if (headerSize < 40) {
        throw new Error(`unexpected BMP header size ${headerSize}`);
    }
    const width = buffer.readInt32LE(18);
    const signedHeight = buffer.readInt32LE(22);
    const bitCount = buffer.readUInt16LE(28);
    if (width <= 0 || signedHeight === 0 || bitCount !== 32) {
        throw new Error(`unexpected BMP geometry ${width}x${signedHeight}, ${bitCount} bpp`);
    }
    const topDown = signedHeight < 0; // sips writes negative heights
    const height = Math.abs(signedHeight);
    const rowBytes = width * 4;
    if (buffer.length < pixelOffset + rowBytes * height) {
        throw new Error('BMP pixel data is truncated');
    }
    const pixels = Buffer.alloc(rowBytes * height);
    for (let row = 0; row < height; row++) {
        const source = pixelOffset + row * rowBytes;
        // ICO bitmap rows run bottom-up; sips hands them over top-down.
        const target = (topDown ? height - 1 - row : row) * rowBytes;
        buffer.copy(pixels, target, source, source + rowBytes);
    }
    return { width, height, pixels };
}

/** Wraps top-ordered BGRA pixels into an ICO bitmap entry: header, pixels, empty AND mask. */
function icoBitmapEntry(width, height, pixels) {
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);        // biSize: BITMAPINFOHEADER
    header.writeInt32LE(width, 4);      // biWidth
    header.writeInt32LE(height * 2, 8); // biHeight counts the XOR data plus the AND mask
    header.writeUInt16LE(1, 12);        // biPlanes
    header.writeUInt16LE(32, 14);       // biBitCount
    // Everything else stays zero: BI_RGB compression and a null AND mask. With 32bpp the
    // alpha channel is authoritative, and every consumer treats a zero mask that way.
    const maskRow = Math.ceil(width / 32) * 4;
    const mask = Buffer.alloc(maskRow * height);
    return Buffer.concat([header, pixels, mask]);
}

function buildIco(images) {
    const directory = Buffer.alloc(6 + images.length * 16);
    directory.writeUInt16LE(0, 0);  // reserved
    directory.writeUInt16LE(1, 2);  // type: icon
    directory.writeUInt16LE(images.length, 4);
    let offset = directory.length;
    images.forEach((image, index) => {
        const entry = 6 + index * 16;
        const size = image.width >= 256 ? 0 : image.width; // 0 encodes 256 in one byte
        directory.writeUInt8(size, entry);         // bWidth
        directory.writeUInt8(size, entry + 1);     // bHeight
        directory.writeUInt16LE(1, entry + 4);     // planes
        directory.writeUInt16LE(32, entry + 6);    // bit count
        directory.writeUInt32LE(image.data.length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += image.data.length;
    });
    return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

/** Self-check: parse the directory back and confirm every entry points inside the file. */
function verifyIco(buffer) {
    const count = buffer.readUInt16LE(4);
    if (buffer.readUInt16LE(2) !== 1 || count === 0) {
        throw new Error('ICO directory is malformed');
    }
    for (let index = 0; index < count; index++) {
        const entry = 6 + index * 16;
        const bytes = buffer.readUInt32LE(entry + 8);
        const offset = buffer.readUInt32LE(entry + 12);
        if (bytes === 0 || offset + bytes > buffer.length) {
            throw new Error(`ICO entry ${index} points outside the file`);
        }
        if (buffer[offset] === 0x89) {
            // A PNG entry: its IHDR must say 256x256, the size the directory byte cannot.
            if (buffer.readUInt32BE(offset + 16) !== 256 || buffer.readUInt32BE(offset + 20) !== 256) {
                throw new Error('the embedded PNG entry is not 256x256');
            }
        }
    }
    return count;
}

function main() {
    const source = path.resolve(process.argv[2] || DEFAULT_SOURCE);
    if (!fs.existsSync(source)) {
        console.error(`[make-icons] no source image at ${source}`);
        process.exit(1);
    }
    if (process.platform !== 'darwin') {
        console.error('[make-icons] needs macOS sips and iconutil; run this on a Mac.');
        console.error('[make-icons] electron-builder still converts build/icon.png itself for Windows and Linux targets.');
        process.exit(1);
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-icons-'));
    try {
        // The runtime icon: windows and the Linux dock load this in a checkout, where no
        // installer exists to carry an icon.
        fs.writeFileSync(
            path.join(LAUNCHER_ROOT, 'renderer', 'assets', 'icon.png'),
            scaledTo(source, 256, 'png', scratch)
        );

        // The favicon: small sizes only, it lives in a browser tab.
        fs.writeFileSync(
            path.join(LAUNCHER_ROOT, 'renderer', 'assets', 'favicon.ico'),
            buildIco(
                [16, 32, 48].map((size) => ({
                    width: size,
                    data: icoBitmapEntry(size, size, readBmpPixels(scaledTo(source, size, 'bmp', scratch)).pixels)
                }))
            )
        );

        // The application icon: one entry per size, 256 as an embedded PNG.
        const appImages = BMP_SIZES.map((size) => {
            const { width, height, pixels } = readBmpPixels(scaledTo(source, size, 'bmp', scratch));
            return { width, data: icoBitmapEntry(width, height, pixels) };
        });
        appImages.push({ width: 256, data: scaledTo(source, 256, 'png', scratch) });
        const ico = buildIco(appImages);
        const entries = verifyIco(ico);
        fs.writeFileSync(path.join(LAUNCHER_ROOT, 'build', 'icon.ico'), ico);

        // The icns: an iconset directory in exactly the layout iconutil insists on.
        const iconset = path.join(scratch, 'icon.iconset');
        fs.mkdirSync(iconset);
        for (const [name, size] of ICONSET_VARIANTS) {
            fs.writeFileSync(path.join(iconset, name), scaledTo(source, size, 'png', scratch));
        }
        run('iconutil', ['-c', 'icns', iconset, '-o', path.join(LAUNCHER_ROOT, 'build', 'icon.icns')]);

        console.log(`[make-icons] from ${path.relative(LAUNCHER_ROOT, source)}:`);
        console.log(`[make-icons]   build/icon.ico (${entries} entries, ${ico.length} bytes)`);
        console.log('[make-icons]   build/icon.icns');
        console.log('[make-icons]   renderer/assets/icon.png (256px, windows and dock)');
        console.log('[make-icons]   renderer/assets/favicon.ico (16/32/48px)');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main();

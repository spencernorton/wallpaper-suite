// Out-of-process, fail-closed compositor worker.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

import {VALID_MODES, drawIntoRect} from './pixbufModes.js';
import {computeCanvasBounds, translateMonitor} from './runtimeCore.js';

let job = null;

function finish(ok, code, message = '', extra = {}, exitCode = ok ? 0 : 1) {
    if (!ok && job?.tempPath) {
        try { GLib.unlink(job.tempPath); } catch (_) {}
    }
    if (!ok && job?.sidecarTempPath) {
        try { GLib.unlink(job.sidecarTempPath); } catch (_) {}
    }
    if (!ok && job?.cacheSidecarTempPath) {
        try { GLib.unlink(job.cacheSidecarTempPath); } catch (_) {}
    }
    print(JSON.stringify({
        ok,
        code,
        message,
        generation: job?.generation || 0,
        ...extra,
    }));
    if (!ok && message)
        printerr(`wallpaper-suite-worker: ${message}`);
    System.exit(exitCode);
}

function sha256File(path) {
    const [, contents] = GLib.file_get_contents(path);
    return GLib.compute_checksum_for_bytes(
        GLib.ChecksumType.SHA256,
        GLib.Bytes.new(contents)
    );
}

function readVerifiedSidecar(sidecarPath, outputPath, width, height) {
    const [, contents] = GLib.file_get_contents(sidecarPath);
    const sidecar = JSON.parse(new TextDecoder().decode(contents));
    if (sidecar.schemaVersion !== 1 ||
        sidecar.signature !== job.signature ||
        sidecar.outputFile !== GLib.path_get_basename(outputPath) ||
        sidecar.width !== width || sidecar.height !== height ||
        typeof sidecar.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sidecar.sha256))
        throw new Error('cache sidecar does not match the requested composite');
    return sidecar;
}

function srgbToLinear(value) {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function computePanelLuminanceMap(pixbuf, monitors, bounds) {
    if (!pixbuf || !Array.isArray(monitors) || !bounds)
        return null;
    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();
    const stripHeight = 40;
    const xStep = Math.max(1, Math.round(w / 1920));
    const yStep = Math.max(1, Math.round(h / 1080));
    const map = {};

    for (const monitor of monitors) {
        const t = translateMonitor(monitor, bounds);
        const x0 = Math.max(0, Math.min(w - 1, Math.floor(t.drawX)));
        const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(t.drawX + monitor.width)));
        const y0 = Math.max(0, Math.min(h - 1, Math.floor(t.drawY)));
        const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(t.drawY + Math.min(stripHeight, monitor.height))));
        const lums = [];
        for (let y = y0; y < y1; y += yStep) {
            const rowOff = y * rowstride;
            for (let x = x0; x < x1; x += xStep) {
                const off = rowOff + x * channels;
                lums.push(
                    0.2126 * srgbToLinear(pixels[off]) +
                    0.7152 * srgbToLinear(pixels[off + 1]) +
                    0.0722 * srgbToLinear(pixels[off + 2])
                );
            }
        }
        if (lums.length) {
            const sorted = Float64Array.from(lums).sort();
            const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
            map[`${t.drawX},${t.drawY},${monitor.width}x${monitor.height}`] = sorted[idx];
        }
    }
    return map;
}

function writeSidecar(outputPath, sidecarPath, sidecarTempPath, width, height,
    verifiedSha256 = null, panelLuminanceP95 = null) {
    if (!sidecarPath || !sidecarTempPath)
        return false;
    try {
        const file = Gio.File.new_for_path(outputPath);
        const info = file.query_info(
            'standard::size,time::modified,time::modified-usec,id::file',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        const sha256 = verifiedSha256 || sha256File(outputPath);
        const sidecar = {
            schemaVersion: 1,
            signature: job.signature,
            outputFile: GLib.path_get_basename(outputPath),
            width,
            height,
            size: Number(info.get_size()),
            mtimeSec: Number(info.get_attribute_uint64('time::modified')),
            mtimeUsec: info.get_attribute_uint32('time::modified-usec'),
            fileId: info.get_attribute_string('id::file') || '',
            sha256,
            verifiedAtMs: Date.now(),
            ...(panelLuminanceP95 ? {panelLuminanceP95} : {}),
        };
        try { GLib.unlink(sidecarTempPath); } catch (_) {}
        GLib.file_set_contents(sidecarTempPath, JSON.stringify(sidecar));
        try { GLib.chmod(sidecarTempPath, 0o600); } catch (_) {}
        Gio.File.new_for_path(sidecarTempPath).move(
            Gio.File.new_for_path(sidecarPath),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null
        );
        return true;
    } catch (error) {
        try { GLib.unlink(sidecarTempPath); } catch (_) {}
        printerr(`wallpaper-suite-worker: failed to write cache sidecar: ${error}`);
        return false;
    }
}

if (typeof ARGV === 'undefined' || ARGV.length < 1)
    finish(false, 'bad-job', 'Missing job argument', {}, 2);

try {
    job = JSON.parse(ARGV[0]);
} catch (error) {
    finish(false, 'bad-job', `Invalid job JSON: ${error}`, {}, 2);
}

const {monitors, assignments, modes, quality, outPath, tempPath} = job;
if (!Array.isArray(monitors) || monitors.length === 0 || !outPath || !tempPath)
    finish(false, 'bad-job', 'Job is missing monitors, outPath, or tempPath', {}, 2);

const bounds = computeCanvasBounds(monitors);
if (!bounds)
    finish(false, 'invalid-geometry', 'Monitor layout has invalid or non-positive bounds', {}, 2);

// Never trust a cache entry by existence alone. Decode the complete JPEG and
// verify its virtual-desktop dimensions off the Shell main loop. A corrupt or
// stale-sized cache falls through to a full render at the UUID-scoped outPath.
if (job.cachePath) {
    try {
        const cached = GdkPixbuf.Pixbuf.new_from_file(job.cachePath);
        if (cached.get_width() !== Number(job.expectedWidth) ||
            cached.get_height() !== Number(job.expectedHeight))
            throw new Error(
                `unexpected dimensions ${cached.get_width()}x${cached.get_height()}`
            );
        const priorSidecar = readVerifiedSidecar(
            job.cacheSidecarPath,
            job.cachePath,
            cached.get_width(),
            cached.get_height()
        );
        const currentSha256 = sha256File(job.cachePath);
        if (currentSha256 !== priorSidecar.sha256)
            throw new Error('cached composite digest does not match its sidecar');
        const panelLuminanceP95 = priorSidecar.panelLuminanceP95 ||
            computePanelLuminanceMap(cached, monitors, bounds);
        const sidecarWritten = writeSidecar(
            job.cachePath,
            job.cacheSidecarPath,
            job.cacheSidecarTempPath,
            cached.get_width(),
            cached.get_height(),
            currentSha256,
            panelLuminanceP95
        );
        finish(true, 'cache-hit', '', {
            path: job.cachePath,
            width: cached.get_width(),
            height: cached.get_height(),
            cacheHit: true,
            sidecarWritten,
        });
    } catch (_) {
        // Render a repaired output below. The invalid cache path remains in
        // place until the repaired URI has been published successfully.
    }
}

// Decode every assignment before allocating or drawing the destination. A
// single missing/corrupt source fails the whole render and leaves outPath — the
// last known-good composite — untouched.
const decoded = [];
for (const monitor of monitors) {
    const path = assignments?.[monitor.connector];
    if (!path)
        finish(false, 'missing-assignment', `No wallpaper is assigned to ${monitor.connector}`, {}, 3);
    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        finish(false, 'source-unavailable', `Wallpaper for ${monitor.connector} is unavailable`, {}, 3);

    try {
        const source = GdkPixbuf.Pixbuf.new_from_file(path);
        if (source.get_width() <= 0 || source.get_height() <= 0)
            throw new Error('decoded image has non-positive dimensions');
        decoded.push({
            monitor,
            source,
            mode: VALID_MODES.has(modes?.[monitor.connector])
                ? modes[monitor.connector]
                : 'zoom',
        });
    } catch (error) {
        finish(
            false,
            'source-decode-failed',
            `Wallpaper for ${monitor.connector} cannot be decoded: ${error}`,
            {},
            3
        );
    }
}

let destination;
try {
    destination = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB,
        false,
        8,
        bounds.width,
        bounds.height
    );
    destination.fill(0x000000ff);
    for (const item of decoded) {
        const translated = translateMonitor(item.monitor, bounds);
        drawIntoRect(
            destination,
            item.source,
            translated.drawX,
            translated.drawY,
            item.monitor.width,
            item.monitor.height,
            item.mode
        );
    }
} catch (error) {
    finish(false, 'draw-failed', `Failed to draw complete composite: ${error}`);
}

try {
    try { GLib.unlink(tempPath); } catch (_) {}
    destination.savev(tempPath, 'jpeg', ['quality'], [String(quality ?? 92)]);
} catch (error) {
    finish(false, 'encode-failed', `Failed to encode JPEG: ${error}`);
}

try {
    Gio.File.new_for_path(tempPath).move(
        Gio.File.new_for_path(outPath),
        Gio.FileCopyFlags.OVERWRITE,
        null,
        null
    );
} catch (error) {
    finish(false, 'finalize-failed', `Failed to atomically finalize composite: ${error}`);
}

const panelLuminanceP95 = computePanelLuminanceMap(destination, monitors, bounds);
const sidecarWritten = writeSidecar(
    outPath,
    job.sidecarPath,
    job.sidecarTempPath,
    bounds.width,
    bounds.height,
    null,
    panelLuminanceP95
);

finish(true, 'rendered', '', {
    path: outPath,
    width: bounds.width,
    height: bounds.height,
    cacheHit: false,
    sidecarWritten,
});

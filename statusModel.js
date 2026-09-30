// Read-only health/status helpers shared by preferences and tests.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function assignmentHealth(assignments, monitorKeys, fileExists = null) {
    const exists = fileExists || (path =>
        GLib.file_test(path, GLib.FileTest.IS_REGULAR));
    let assigned = 0;
    let missing = 0;
    for (const key of monitorKeys) {
        const path = assignments[key] || '';
        if (!path)
            continue;
        assigned++;
        if (!exists(path))
            missing++;
    }
    return {
        assigned,
        unassigned: Math.max(0, monitorKeys.length - assigned),
        missing,
        healthy: missing === 0 && assigned === monitorKeys.length,
    };
}

export function formatHealth(imageCount, health) {
    const parts = [`${imageCount} image${imageCount === 1 ? '' : 's'}`];
    parts.push(`${health.assigned} of ${health.assigned + health.unassigned} monitors assigned`);
    if (health.missing > 0)
        parts.push(`${health.missing} missing source${health.missing === 1 ? '' : 's'}`);
    else if (health.unassigned === 0)
        parts.push('all source files present');
    return parts.join(' · ');
}

export function readBuildInfo(moduleDir) {
    const fallback = {version: 'development', commit: 'source checkout'};
    try {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([moduleDir, 'build-info.json']));
        const [, contents] = file.load_contents(null);
        const parsed = JSON.parse(new TextDecoder().decode(contents));
        return {
            version: `${parsed.version || fallback.version}`,
            commit: `${parsed.commit || fallback.commit}`,
        };
    } catch (_) {
        return fallback;
    }
}

export function readRuntimeStatus(cacheDir = null) {
    const dir = cacheDir || GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'wallpaper-suite']);
    try {
        const file = Gio.File.new_for_path(
            GLib.build_filenamev([dir, 'runtime-status.json']));
        const [, contents] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch (_) {
        return {};
    }
}

export function newestComposite(cacheDir = null) {
    const dirPath = cacheDir || GLib.build_filenamev([
        GLib.get_user_cache_dir(), 'wallpaper-suite']);
    let newest = null;
    try {
        const enumerator = Gio.File.new_for_path(dirPath).enumerate_children(
            'standard::name,standard::size,time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.startsWith('composite-') || !name.endsWith('.jpg'))
                continue;
            const modifiedUsec = Number(info.get_attribute_uint64('time::modified')) * 1e6 +
                info.get_attribute_uint32('time::modified-usec');
            if (!newest || modifiedUsec > newest.modifiedUsec) {
                newest = {
                    path: GLib.build_filenamev([dirPath, name]),
                    modifiedUsec,
                    size: Number(info.get_size()),
                };
            }
        }
        enumerator.close(null);
    } catch (_) {
        return null;
    }
    return newest;
}

export function formatTimestamp(epochMilliseconds) {
    if (!Number.isFinite(epochMilliseconds) || epochMilliseconds <= 0)
        return 'Not available';
    const dateTime = GLib.DateTime.new_from_unix_local(
        Math.floor(epochMilliseconds / 1000));
    return dateTime.format('%b %e, %Y at %l:%M %p').trim();
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0)
        return 'unknown size';
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

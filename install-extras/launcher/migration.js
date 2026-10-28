import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The original, unmodified launcher. Never retire a user's customized entry.
export const LEGACY_SHA256 = '61a3fc294bdcb04a02c037eeb3602fddbf34897b89c9e99bb1b2c25abecaf157';
const UUID = 'wallpaper-suite@spencercnorton.github.io';

function contents(file) {
    const [, bytes] = file.load_contents(null);
    return bytes;
}

function digest(bytes) {
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
}

export function migrateLauncher({
    dataHome = GLib.get_user_data_dir(),
    stateHome = GLib.get_user_state_dir(),
    packagedEntry = '/usr/share/applications/wallpaper-suite.desktop',
} = {}) {
    const source = Gio.File.new_for_path(GLib.build_filenamev([
        dataHome, 'applications', 'wallpaper-suite.desktop']));
    if (!source.query_exists(null))
        return {code: 'already-current', changed: false};
    const info = source.query_info('standard::type,standard::is-symlink',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_is_symlink() || info.get_file_type() !== Gio.FileType.REGULAR)
        return {code: 'custom-launcher', changed: false};
    if (digest(contents(source)) !== LEGACY_SHA256)
        return {code: 'custom-launcher', changed: false};

    let replacement;
    try {
        replacement = new TextDecoder().decode(contents(Gio.File.new_for_path(packagedEntry)));
    } catch (_) {
        return {code: 'replacement-unavailable', changed: false};
    }
    if (!replacement.split('\n').some(line =>
        line === 'Exec=wallpaper-suite' ||
        line === `Exec=gnome-extensions prefs ${UUID}`))
        return {code: 'replacement-unavailable', changed: false};

    const directory = GLib.build_filenamev([stateHome, 'wallpaper-suite', 'launcher-backups']);
    GLib.mkdir_with_parents(directory, 0o700);
    const backup = Gio.File.new_for_path(GLib.build_filenamev([
        directory, `wallpaper-suite-${GLib.uuid_string_random()}.desktop`]));
    // Rename preserves the original bytes and refuses to replace an existing
    // backup. Verify the moved inode too, so a racing editor is not discarded.
    source.move(backup, Gio.FileCopyFlags.NONE, null, null);
    if (digest(contents(backup)) !== LEGACY_SHA256) {
        try { backup.move(source, Gio.FileCopyFlags.NONE, null, null); } catch (_) {}
        return {code: 'concurrent-edit', changed: false, backup: backup.get_path()};
    }
    return {code: 'migrated', changed: true, backup: backup.get_path()};
}

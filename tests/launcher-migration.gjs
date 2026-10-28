import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {migrateLauncher, LEGACY_SHA256} from '../install-extras/launcher/migration.js';

function assert(value, message) { if (!value) throw new Error(message); }
const root = GLib.dir_make_tmp('wallpaper-launcher-test-XXXXXX');
const source = Gio.File.new_for_path(GLib.build_filenamev([root, 'applications', 'wallpaper-suite.desktop']));
const packaged = GLib.build_filenamev([root, 'system.desktop']);
GLib.mkdir_with_parents(GLib.path_get_dirname(source.get_path()), 0o700);
const [, legacy] = Gio.File.new_for_path(GLib.build_filenamev([
    ARGV[0], 'tests', 'fixtures', 'legacy-wallpaper-suite.desktop'])).load_contents(null);
assert(GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, legacy) === LEGACY_SHA256,
    'fixture must be the exact original launcher');
const options = {dataHome: root, stateHome: root, packagedEntry: packaged};
const writeSource = bytes => source.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null);
try {
    writeSource(legacy);
    assert(migrateLauncher(options).code === 'replacement-unavailable', 'do not hide app without replacement');
    GLib.file_set_contents(packaged, '[Desktop Entry]\nType=Application\nExec=wallpaper-suite\n');
    const result = migrateLauncher(options);
    assert(result.changed && result.code === 'migrated', 'known launcher must migrate');
    assert(!source.query_exists(null), 'system launcher must become visible');
    const [, backup] = Gio.File.new_for_path(result.backup).load_contents(null);
    assert(GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, backup) === LEGACY_SHA256,
        'backup retains exact original bytes');
    assert(migrateLauncher(options).code === 'already-current', 'migration is idempotent');
    writeSource(new TextEncoder().encode(new TextDecoder().decode(legacy).replace('Name=Wallpaper Suite', 'Name=My wallpapers')));
    assert(migrateLauncher(options).code === 'custom-launcher' && source.query_exists(null),
        'customized launcher is preserved');
    source.delete(null);
    source.make_symbolic_link(packaged, null);
    assert(migrateLauncher(options).code === 'custom-launcher', 'symlinks are preserved');
    print('launcher migration: original, missing replacement, repeat, customized and symlink cases passed');
} finally {
    const proc = Gio.Subprocess.new(['rm', '-rf', '--', root], Gio.SubprocessFlags.NONE);
    proc.wait_check(null);
}

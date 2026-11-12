// Header-only dimensions must match GdkPixbuf, and the persistent dimension
// cache must be reused for unchanged files and refreshed for changed ones.
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import System from 'system';

const root = ARGV[0];
const scratch = GLib.dir_make_tmp('wallpaper-header-XXXXXX');
const folder = `${scratch}/images`;
GLib.mkdir_with_parents(folder, 0o700);
const assert = (condition, message) => { if (!condition) { printerr(`FAIL: ${message}`); System.exit(1); } };
const sizes = [[321, 180, 'png'], [640, 427, 'jpeg'], [97, 1203, 'jpeg'], [1, 1, 'png']];
sizes.forEach(([width, height, type], index) => {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    pixbuf.fill(0x336699ff);
    pixbuf.savev(`${folder}/image-${index}.${type === 'png' ? 'png' : 'jpg'}`, type, [], []);
});
GLib.file_set_contents(`${folder}/broken.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]));
const cachePath = `${scratch}/dims.json`;
const scan = () => {
    const job = JSON.stringify({schemaVersion: 1, generation: 1, root: folder, dimensionCachePath: cachePath});
    const [, stdout, , status] = GLib.spawn_sync(null, ['gjs', '-m', `${root}/library-index-worker.js`, job],
        null, GLib.SpawnFlags.SEARCH_PATH, null);
    assert(status === 0, 'index worker exits successfully');
    return JSON.parse(new TextDecoder().decode(stdout));
};
const first = scan();
assert(first.ok && first.files.length === sizes.length + 1, 'all files indexed');
for (const record of first.files) {
    let expected = [null, null];
    try { const [, w, h] = GdkPixbuf.Pixbuf.get_file_info(record.path); if (w > 0 && h > 0) expected = [w, h]; } catch (_) {}
    assert(record.width === expected[0] && record.height === expected[1],
        `${record.name} header ${record.width}x${record.height} matches decoder ${expected.join('x')}`);
}
print('PASS: header dimensions match GdkPixbuf for PNG, JPEG and damaged files');
const [, bytes] = GLib.file_get_contents(cachePath);
const cache = JSON.parse(new TextDecoder().decode(bytes));
const marked = `${folder}/image-0.png`;
cache.entries[marked][3] = 7; cache.entries[marked][4] = 9;
GLib.file_set_contents(cachePath, JSON.stringify(cache));
const second = scan();
const reused = second.files.find(record => record.path === marked);
assert(reused.width === 7 && reused.height === 9, 'unchanged files reuse cached dimensions');
GLib.usleep(20000);
GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 50, 60).savev(marked, 'png', [], []);
const third = scan();
const refreshed = third.files.find(record => record.path === marked);
assert(refreshed.width === 50 && refreshed.height === 60, 'changed files are probed again');
print('PASS: persistent dimension cache is reused and refreshed by size and mtime');
GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(scratch)}`);

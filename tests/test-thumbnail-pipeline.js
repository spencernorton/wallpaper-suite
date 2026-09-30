import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    ThumbnailLoader,
    fileFingerprint,
    indexedFileFingerprint,
    pruneThumbnailCache,
    thumbnailCacheKey,
    thumbnailPath,
} from '../thumbnailCache.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const root = GLib.dir_make_tmp('wallpaper-suite-thumbnail-test-XXXXXX');
const source = GLib.build_filenamev([root, 'source.png']);
const output = GLib.build_filenamev([root, 'thumb.png']);
const corrupt = GLib.build_filenamev([root, 'corrupt.jpg']);
const worker = GLib.build_filenamev([GLib.get_current_dir(), 'thumbnail-worker.js']);

const sourcePixbuf = GdkPixbuf.Pixbuf.new(
    GdkPixbuf.Colorspace.RGB, false, 8, 400, 200);
sourcePixbuf.fill(0x3366ccff);
sourcePixbuf.savev(source, 'png', [], []);
GLib.file_set_contents(corrupt, 'not an image');

const render = Gio.Subprocess.new([
    GLib.find_program_in_path('gjs'), '-m', worker, source, output,
    `${output}.tmp-test`, '192', '108',
], Gio.SubprocessFlags.STDERR_PIPE);
const [, , renderError] = render.communicate_utf8(null, null);
assert(render.get_successful(), `Thumbnail worker succeeds: ${renderError || ''}`);
const thumb = GdkPixbuf.Pixbuf.new_from_file(output);
assert(thumb.get_width() === 192 && thumb.get_height() === 108,
    'Thumbnail worker emits requested dimensions');

const badOutput = GLib.build_filenamev([root, 'bad.png']);
const badRender = Gio.Subprocess.new([
    GLib.find_program_in_path('gjs'), '-m', worker, corrupt, badOutput,
    `${badOutput}.tmp-test`, '192', '108',
], Gio.SubprocessFlags.STDERR_PIPE);
badRender.communicate_utf8(null, null);
assert(!badRender.get_successful(), 'Corrupt source fails instead of creating a blank tile');
assert(!GLib.file_test(badOutput, GLib.FileTest.EXISTS), 'Failed decode publishes no cache file');

const fingerprint = fileFingerprint(source);
assert(indexedFileFingerprint({mtimeSec: 12, mtimeUsec: 34, size: 56}) ===
    '12.34:56:', 'Worker metadata produces a thumbnail fingerprint without source IO');
assert(indexedFileFingerprint({mtimeSec: -1, mtimeUsec: 0, size: 0}) === null,
    'Invalid worker metadata is rejected instead of weakening cache identity');
assert(thumbnailCacheKey(source, fingerprint, 192, 108).length === 64,
    'Cache key is a SHA-256 digest');
assert(thumbnailCacheKey(source, `${fingerprint}-changed`, 192, 108) !==
    thumbnailCacheKey(source, fingerprint, 192, 108),
    'Cache key changes with high-resolution file fingerprint');

const recoveryCache = GLib.build_filenamev([root, 'recovery-cache']);
GLib.mkdir_with_parents(recoveryCache, 0o700);
const corruptCachedThumbnail = thumbnailPath(
    source, fingerprint, 192, 108, recoveryCache);
GLib.file_set_contents(corruptCachedThumbnail, 'not a png');
let recoveryResult = null;
const recoveryLoader = new ThumbnailLoader(worker, {
    cacheDir: recoveryCache,
    concurrency: 1,
});
const recoveryLoop = new GLib.MainLoop(null, false);
recoveryLoader.enqueue(source, result => {
    recoveryResult = result;
    recoveryLoop.quit();
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    recoveryLoop.quit();
    return GLib.SOURCE_REMOVE;
});
recoveryLoop.run();
assert(recoveryResult && !recoveryResult.error && recoveryResult.cached === false,
    'Corrupt cached thumbnail is regenerated instead of becoming permanently unavailable');
const recoveredThumbnail = GdkPixbuf.Pixbuf.new_from_file(recoveryResult.outputPath);
assert(recoveredThumbnail.get_width() === 192 && recoveredThumbnail.get_height() === 108,
    'Regenerated thumbnail is fully decodable at the requested size');

const slowWorker = GLib.build_filenamev([
    GLib.get_current_dir(), 'tests', 'fixtures', 'slow-thumbnail-worker.js']);
let callbackRan = false;
const cancelCache = GLib.build_filenamev([root, 'cache']);
const loader = new ThumbnailLoader(slowWorker, {
    cacheDir: cancelCache,
    concurrency: 1,
});
loader.enqueue(source, () => {
    callbackRan = true;
});

function tempFiles(directory) {
    let names = [];
    try {
        const enumerator = Gio.File.new_for_path(directory).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_name().includes('.png.tmp-'))
                names.push(info.get_name());
        }
        enumerator.close(null);
    } catch (_) {}
    return names;
}

const tempLoop = new GLib.MainLoop(null, false);
let tempAppeared = false;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    tempAppeared = tempFiles(cancelCache).length > 0;
    if (tempAppeared)
        tempLoop.quit();
    return tempAppeared ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
});
const tempTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
    tempLoop.quit();
    return GLib.SOURCE_REMOVE;
});
tempLoop.run();
if (tempAppeared)
    GLib.Source.remove(tempTimeoutId);
assert(tempAppeared, 'Cancellation fixture creates the parent-known partial path');
loader.cancel();
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
assert(callbackRan === false, 'Cancellation suppresses stale thumbnail callbacks');
assert(tempFiles(cancelCache).length === 0,
    'Cancellation removes the exact parent-known partial thumbnail');

const staleTemp = `${thumbnailPath(source, fingerprint, 192, 108, cancelCache)}.tmp-${GLib.uuid_string_random()}`;
GLib.file_set_contents(staleTemp, 'abandoned thumbnail');
Gio.File.new_for_path(staleTemp).set_attribute_uint64(
    'time::modified', Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
    Gio.FileQueryInfoFlags.NONE, null);
pruneThumbnailCache(cancelCache);
assert(!GLib.file_test(staleTemp, GLib.FileTest.EXISTS),
    'bounded maintenance removes only aged managed thumbnail temporaries');

Gio.File.new_for_path(root).delete_async(GLib.PRIORITY_LOW, null, () => {});
print('thumbnail pipeline tests passed');

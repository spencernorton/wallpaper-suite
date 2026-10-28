import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {ThumbnailLoader, thumbnailCacheKey} from '../thumbnailCache.js';
import {drawIntoRect, previewDecodeSize} from '../pixbufModes.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const root = GLib.dir_make_tmp('wallpaper-previews-XXXXXX');
const path = GLib.build_filenamev([root, 'source.png']);
const source = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 720, 480);
source.fill(0x3366ccff);
source.new_subpixbuf(0, 0, 360, 480).fill(0xee6633ff);
source.savev(path, 'png', [], []);
const worker = GLib.build_filenamev([ARGV[0], 'thumbnail-worker.js']);
const modes = ['zoom', 'fit', 'stretch', 'center', 'tile'];
let ticks = 0;
const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => { ticks++; return GLib.SOURCE_CONTINUE; });
try {
    for (const mode of modes) {
        const preview = {mode, monitorWidth: 1920, monitorHeight: 1080};
        const loader = new ThumbnailLoader(worker, {cacheDir: root, width: 320, height: 180, preview});
        let result = null;
        const loop = new GLib.MainLoop(null, false);
        const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
        loader.enqueue(path, value => { result = value; loop.quit(); });
        loop.run();
        if (GLib.MainContext.default().find_source_by_id(timeout)) GLib.Source.remove(timeout);
        assert(result && !result.error, `${mode} preview worker succeeds`);
        const actual = GdkPixbuf.Pixbuf.new_from_file(result.outputPath);
        const decode = previewDecodeSize(720, 480, 1920, 1080, 320, 180, mode);
        const input = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, decode.width, decode.height, decode.preserveAspectRatio);
        const expected = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 320, 180);
        expected.fill(0x000000ff);
        drawIntoRect(expected, input, 0, 0, 320, 180, mode);
        assert(GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, actual.get_pixels()) ===
            GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, expected.get_pixels()),
        `${mode} worker matches the monitor-accurate reference pixels`);
        loader.cancel();
    }
    assert(ticks > 5, 'UI event loop remains responsive while previews decode');
    assert(thumbnailCacheKey(path, 'same', 320, 180, {mode: 'fit', monitorWidth: 1920, monitorHeight: 1080}) !==
        thumbnailCacheKey(path, 'same', 320, 180, {mode: 'center', monitorWidth: 1920, monitorHeight: 1080}),
    'mode is part of preview cache identity');
    const largePath = `${root}/large.png`;
    const large = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 6000, 4000);
    large.fill(0x448855ff); large.savev(largePath, 'png', [], []);
    const loader = new ThumbnailLoader(worker, {cacheDir: root, width: 320, height: 180,
        preview: {mode: 'center', monitorWidth: 320, monitorHeight: 180}});
    const beforeLarge = ticks;
    let largeResult = null;
    const largeLoop = new GLib.MainLoop(null, false);
    const largeTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10,
        () => { largeLoop.quit(); return GLib.SOURCE_REMOVE; });
    loader.enqueue(largePath, result => { largeResult = result; largeLoop.quit(); });
    largeLoop.run();
    if (GLib.MainContext.default().find_source_by_id(largeTimeout)) GLib.Source.remove(largeTimeout);
    assert(largeResult && !largeResult.error && largeResult.approximate,
        'oversized pixel-relative preview reports its bounded density approximation');
    assert(ticks - beforeLarge > 5, '24-megapixel image decoding leaves the UI event loop responsive');
    loader.cancel();
    print(`all five worker previews match reference pixels; ${ticks} event-loop heartbeats`);
} finally {
    GLib.Source.remove(heartbeat);
    Gio.Subprocess.new(['rm', '-rf', '--', root], Gio.SubprocessFlags.NONE).wait_check(null);
}

#!/usr/bin/gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const root = ARGV[0] || GLib.get_current_dir();
const worker = GLib.build_filenamev([root, 'compositor-worker.js']);
const tempDir = GLib.dir_make_tmp('wallpaper-suite-worker-test-XXXXXX');

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function image(name, fill) {
    const path = GLib.build_filenamev([tempDir, name]);
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 24, 24);
    pixbuf.fill(fill);
    pixbuf.savev(path, 'png', [], []);
    return path;
}

function run(job) {
    const process = Gio.Subprocess.new(
        ['gjs', '-m', worker, JSON.stringify(job)],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
    );
    const [, stdout, stderr] = process.communicate_utf8(null, null);
    let result = null;
    try { result = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)); } catch (_) {}
    return {successful: process.get_successful(), result, stderr};
}

const red = image('red.png', 0xff0000ff);
const blue = image('blue.png', 0x0000ffff);
const corrupt = GLib.build_filenamev([tempDir, 'corrupt.png']);
GLib.file_set_contents(corrupt, 'this is not an image');

const monitors = [
    {connector: 'left', x: -20, y: -5, width: 20, height: 10},
    {connector: 'right', x: 0, y: -5, width: 30, height: 10},
];
const outPath = GLib.build_filenamev([tempDir, 'negative.jpg']);
const successful = run({
    monitors,
    assignments: {left: red, right: blue},
    modes: {left: 'zoom', right: 'zoom'},
    quality: 95,
    outPath,
    tempPath: `${outPath}.tmp.test`,
    generation: 1,
});
assert(successful.successful, `negative-coordinate render failed: ${successful.stderr}`);
assert(successful.result?.ok === true, 'worker returns a structured success result');
assert(successful.result.width === 50 && successful.result.height === 10,
    'worker reports translated full virtual bounds');
const rendered = GdkPixbuf.Pixbuf.new_from_file(outPath);
assert(rendered.get_width() === 50 && rendered.get_height() === 10,
    'negative-origin canvas preserves both monitors');

const sentinelPath = GLib.build_filenamev([tempDir, 'sentinel.jpg']);
GLib.file_set_contents(sentinelPath, 'last-known-good');
const missing = run({
    monitors,
    assignments: {left: red},
    modes: {},
    quality: 92,
    outPath: sentinelPath,
    tempPath: `${sentinelPath}.tmp.missing`,
    generation: 2,
});
assert(!missing.successful && missing.result?.code === 'missing-assignment',
    'one missing assignment fails the complete render');
const [, sentinelAfterMissing] = GLib.file_get_contents(sentinelPath);
assert(new TextDecoder().decode(sentinelAfterMissing) === 'last-known-good',
    'missing assignment leaves the last-known-good output untouched');
assert(!GLib.file_test(`${sentinelPath}.tmp.missing`, GLib.FileTest.EXISTS),
    'failed render removes only its own temporary file');

const corruptResult = run({
    monitors,
    assignments: {left: red, right: corrupt},
    modes: {},
    quality: 92,
    outPath: sentinelPath,
    tempPath: `${sentinelPath}.tmp.corrupt`,
    generation: 3,
});
assert(!corruptResult.successful && corruptResult.result?.code === 'source-decode-failed',
    'a corrupt source fails preflight before drawing');
const [, sentinelAfterCorrupt] = GLib.file_get_contents(sentinelPath);
assert(new TextDecoder().decode(sentinelAfterCorrupt) === 'last-known-good',
    'corrupt source leaves the last-known-good output untouched');

print('worker-integration: all tests passed');

#!/usr/bin/gjs -m

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Compositor} from '../compositor.js';

const root = ARGV[0] || GLib.get_current_dir();
const tempDir = GLib.dir_make_tmp('wallpaper-suite-compositor-test-XXXXXX');
const cacheDir = GLib.build_filenamev([tempDir, 'cache']);
GLib.mkdir_with_parents(cacheDir, 0o700);

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function image(name, fill, size = 512) {
    const path = GLib.build_filenamev([tempDir, name]);
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, size, size);
    pixbuf.fill(fill);
    pixbuf.savev(path, 'png', [], []);
    return path;
}

const first = image('first.png', 0xff0000ff, 1024);
const second = image('second.png', 0x00ff00ff, 128);
const monitors = [{connector: 'one', x: -50, y: 0, width: 400, height: 240}];
const compositor = new Compositor(root, {cacheDir});
const results = [];
const loop = new GLib.MainLoop(null, false);
let timedOut = false;

compositor.compositeAsync(monitors, {one: first}, {one: 'zoom'}, 92, result => {
    results.push(result);
});
compositor.compositeAsync(monitors, {one: second}, {one: 'zoom'}, 92, result => {
    results.push(result);
    if (result.ok)
        loop.quit();
});

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
    timedOut = true;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

assert(!timedOut, 'latest compositor generation completed before timeout');
assert(results.some(result => result.code === 'superseded'),
    'first in-flight generation is explicitly superseded');
const latest = results.find(result => result.ok);
assert(latest?.generation === compositor.generation, 'only the latest generation succeeds');
assert(GLib.file_test(latest.path, GLib.FileTest.IS_REGULAR), 'latest output exists');

let fastHit = null;
compositor.compositeAsync(monitors, {one: second}, {one: 'zoom'}, 92, result => {
    fastHit = result;
});
assert(fastHit?.ok && fastHit.cacheHit && fastHit.path === latest.path,
    'atomic sidecar enables a synchronous trusted cache hit');
assert(fastHit.durationMs <= 10, 'trusted cache hit avoids worker spawn and full JPEG decode');

// A regular, decodable JPEG at the expected signature is not automatically
// trusted. Replace it with the wrong pixels, then ensure digest validation
// repairs to a distinct generation while leaving the old path untouched until
// publication cleanup.
const corruptCachePath = latest.path;
const wrongCache = GdkPixbuf.Pixbuf.new(
    GdkPixbuf.Colorspace.RGB, false, 8, 400, 240);
wrongCache.fill(0x0000ffff);
wrongCache.savev(corruptCachePath, 'jpeg', ['quality'], ['92']);
let repaired = null;
let repairTimedOut = false;
const repairLoop = new GLib.MainLoop(null, false);
compositor.compositeAsync(monitors, {one: second}, {one: 'zoom'}, 92, result => {
    repaired = result;
    repairLoop.quit();
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
    repairTimedOut = true;
    repairLoop.quit();
    return GLib.SOURCE_REMOVE;
});
repairLoop.run();
assert(!repairTimedOut && repaired?.ok, 'corrupt cache is repaired successfully');
assert(repaired.cacheHit === false && repaired.path !== corruptCachePath,
    'cache decode failure produces a distinct repair generation');
const repairedPixbuf = GdkPixbuf.Pixbuf.new_from_file(repaired.path);
assert(repairedPixbuf.get_width() === 400 && repairedPixbuf.get_height() === 240,
    'repaired cache has expected virtual-desktop dimensions');
assert(GLib.file_test(corruptCachePath, GLib.FileTest.EXISTS),
    'invalid old cache remains until the replacement URI can be published');
compositor.releaseObsolete([corruptCachePath], new Set([repaired.path]));
assert(!GLib.file_test(corruptCachePath, GLib.FileTest.EXISTS),
    'invalid cache is retired by exact path after replacement publication');

let preferredHit = null;
compositor.compositeAsync(
    monitors,
    {one: second},
    {one: 'zoom'},
    92,
    {preferredPaths: [repaired.path]},
    result => { preferredHit = result; }
);
assert(preferredHit?.ok && preferredHit.cacheHit && preferredHit.path === repaired.path,
    'the exact active repair generation remains a trusted fast cache');

const protectedPath = GLib.build_filenamev([cacheDir, `composite-${'a'.repeat(32)}.jpg`]);
const obsoletePath = GLib.build_filenamev([cacheDir, `composite-${'b'.repeat(32)}.jpg`]);
GLib.file_set_contents(protectedPath, 'protected');
GLib.file_set_contents(obsoletePath, 'obsolete');
compositor.releaseObsolete([protectedPath, obsoletePath], new Set([protectedPath, repaired.path]));
assert(GLib.file_test(protectedPath, GLib.FileTest.EXISTS),
    'every currently referenced output is protected');
assert(!GLib.file_test(obsoletePath, GLib.FileTest.EXISTS),
    'only an explicitly named unreferenced output is removed');
assert(GLib.file_test(repaired.path, GLib.FileTest.EXISTS),
    'cleanup cannot delete the newest generation');

const inFlightPath = GLib.build_filenamev([
    cacheDir,
    `composite-${'e'.repeat(32)}.jpg`,
]);
GLib.file_set_contents(inFlightPath, 'in-flight');
compositor._active = {request: {job: {outPath: inFlightPath}}};
compositor.pruneCache(new Set(), {
    nowUsec: GLib.get_real_time() + 1e6,
    outputMaxAgeSeconds: 0,
});
assert(GLib.file_test(inFlightPath, GLib.FileTest.EXISTS),
    'age pruning protects an in-flight compositor output');
compositor._active = null;
compositor.pruneCache(new Set(), {
    nowUsec: GLib.get_real_time() + 1e6,
    outputMaxAgeSeconds: 0,
});
assert(!GLib.file_test(inFlightPath, GLib.FileTest.EXISTS),
    'the exact unreferenced output becomes eligible after its job completes');

const entries = [];
const enumerator = GLib.Dir.open(cacheDir, 0);
let name;
while ((name = enumerator.read_name()) !== null)
    entries.push(name);
assert(!entries.some(entry => entry.includes('.tmp.')), 'no generation temp files remain');

compositor.dispose();

// Deterministically cancel after a force worker has finalized its unique file
// but before it reports completion. That exact abandoned generation must be
// reaped; shared/cache paths are never considered by this cleanup path.
const abandonedCache = GLib.build_filenamev([tempDir, 'abandoned-cache']);
GLib.mkdir_with_parents(abandonedCache, 0o700);
const slow = new Compositor(root, {
    cacheDir: abandonedCache,
    workerPath: GLib.build_filenamev([root, 'tests', 'slow-finalize-worker.gjs']),
});
let cancelled = null;
let observedFinalized = false;
const abandonedLoop = new GLib.MainLoop(null, false);
slow.compositeAsync(
    monitors,
    {one: second},
    {one: 'zoom'},
    92,
    {force: true},
    result => { cancelled = result; }
);
const pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
    const directory = GLib.Dir.open(abandonedCache, 0);
    let entry;
    while ((entry = directory.read_name()) !== null) {
        if (entry.includes('-refresh-') && entry.endsWith('.jpg')) {
            observedFinalized = true;
            slow.dispose();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                abandonedLoop.quit();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        }
    }
    return GLib.SOURCE_CONTINUE;
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    try { GLib.Source.remove(pollId); } catch (_) {}
    abandonedLoop.quit();
    return GLib.SOURCE_REMOVE;
});
abandonedLoop.run();
assert(observedFinalized, 'test observed the finalized-before-callback window');
assert(cancelled?.code === 'cancelled', 'disposed generation reports cancellation');
const abandonedEntries = [];
const abandonedDir = GLib.Dir.open(abandonedCache, 0);
while ((name = abandonedDir.read_name()) !== null)
    abandonedEntries.push(name);
assert(!abandonedEntries.some(entry => entry.includes('-refresh-')),
    'cancelled force generation leaves no UUID-scoped output orphan');

// A worker may be terminated by the kernel or a decoder crash. The main
// process must report the signal without calling get_exit_status(), which is
// valid only for normally exited subprocesses.
const signalCache = GLib.build_filenamev([tempDir, 'signal-cache']);
GLib.mkdir_with_parents(signalCache, 0o700);
const signalCompositor = new Compositor(root, {
    cacheDir: signalCache,
    workerPath: GLib.build_filenamev([root, 'tests', 'signal-worker.gjs']),
});
let signalResult = null;
const signalLoop = new GLib.MainLoop(null, false);
signalCompositor.compositeAsync(
    monitors,
    {one: second},
    {one: 'zoom'},
    92,
    result => {
        signalResult = result;
        signalLoop.quit();
    }
);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    signalLoop.quit();
    return GLib.SOURCE_REMOVE;
});
signalLoop.run();
assert(signalResult?.ok === false && signalResult.message.includes('signal 15'),
    'signalled worker returns a structured failure without an exit-status critical');
signalCompositor.dispose();

print('compositor-async: all tests passed');

#!/usr/bin/gjs -m

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LibraryIndexer} from '../libraryIndex.js';

const repoRoot = ARGV[0] || GLib.get_current_dir();
const tempRoot = GLib.dir_make_tmp('wallpaper-suite-library-index-test-XXXXXX');
const library = GLib.build_filenamev([tempRoot, 'library']);
const nested = GLib.build_filenamev([library, 'nested']);
const tooDeep = GLib.build_filenamev([nested, 'too-deep']);
GLib.mkdir_with_parents(tooDeep, 0o700);

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function image(folder, name, width, height, format = 'png') {
    const path = GLib.build_filenamev([folder, name]);
    const pixbuf = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    pixbuf.fill(0x3366ccff);
    pixbuf.savev(path, format, [], []);
    return path;
}

function waitFor(start, timeoutMs = 5000) {
    const loop = new GLib.MainLoop(null, false);
    let value = null;
    let timedOut = false;
    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
        timedOut = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    start(result => {
        value = result;
        loop.quit();
    });
    loop.run();
    if (!timedOut) {
        try { GLib.Source.remove(timeoutId); } catch (_) {}
    }
    assert(!timedOut, `operation completed within ${timeoutMs} ms`);
    return value;
}

function spin(milliseconds) {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    let info;
    try {
        info = file.query_info(
            'standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (_) {
        return;
    }
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        let enumerator = null;
        try {
            enumerator = file.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let child;
            while ((child = enumerator.next_file(null)) !== null)
                removeTree(GLib.build_filenamev([path, child.get_name()]));
        } finally {
            try { enumerator?.close(null); } catch (_) {}
        }
    }
    try { file.delete(null); } catch (_) {}
}

const alpha = image(library, 'alpha.png', 13, 7);
const zeta = image(library, 'zeta.jpg', 31, 17, 'jpeg');
const bravo = image(nested, 'bravo.png', 19, 11);
image(tooDeep, 'ignored.png', 5, 5);
image(library, '.hidden.png', 3, 3);
GLib.file_set_contents(GLib.build_filenamev([library, 'notes.txt']), 'not an image');

const indexer = new LibraryIndexer(repoRoot, {timeoutMs: 5000});
let callbackWasSynchronous = true;
const first = waitFor(done => {
    const generation = indexer.scanAsync(library, {probeDimensions: true}, result => {
        assert(!callbackWasSynchronous, 'worker completion is asynchronous');
        assert(result.generation === generation, 'result retains request generation');
        done(result);
    });
    callbackWasSynchronous = false;
});

assert(first.ok && ['indexed', 'indexed-with-errors'].includes(first.code),
    'real worker returns a usable structured index');
assert(first.schemaVersion === 1 && first.root === library,
    'result schema and canonical root are stable');
assert(JSON.stringify(first.files.map(file => file.path)) ===
    JSON.stringify([alpha, bravo, zeta]),
    'root and one child level are indexed in deterministic path order');
assert(!first.files.some(file => file.path.includes('ignored') || file.path.includes('hidden')),
    'deeper and hidden images are excluded');

const alphaRecord = first.files.find(file => file.path === alpha);
assert(alphaRecord.relativePath === 'alpha.png' && alphaRecord.size > 0,
    'records include relative path and byte size');
assert(alphaRecord.mtimeSec > 0 && alphaRecord.contentType.startsWith('image/'),
    'records include mtime and content type');
assert(alphaRecord.width === 13 && alphaRecord.height === 7,
    'cheap header probing returns image dimensions');
assert(first.directories.length === 2 && first.directories.includes(library) &&
    first.directories.includes(nested), 'worker reports exactly the scanned directories');
assert(!first.watcher.degraded && first.watcher.directories.length === 0 &&
    first.watcher.errors.length === 0,
    'disposable index workers do not duplicate the Shell live-watcher set');

const second = waitFor(done => indexer.scanAsync(
    library, {probeDimensions: true}, done));
assert(JSON.stringify(second.files) === JSON.stringify(first.files),
    'unchanged libraries produce byte-stable ordered records');

const limited = waitFor(done => indexer.scanAsync(
    library, {probeDimensions: false, maxFiles: 2}, done));
assert(limited.truncated && limited.files.length === 2 &&
    JSON.stringify(limited.files.map(file => file.path)) === JSON.stringify([alpha, bravo]),
    'file caps truncate only after deterministic ordering');
assert(limited.files.every(file => file.width === null && file.height === null),
    'dimension probing can be disabled for the cheapest metadata-only scan');
assert(limited.errors.some(error => error.code === 'file-limit-reached'),
    'truncation is visible as a structured recoverable error');

for (const name of ['dir-alpha', 'dir-beta', 'dir-charlie'])
    GLib.mkdir_with_parents(GLib.build_filenamev([library, name]), 0o700);
const directoryLimited = waitFor(done => indexer.scanAsync(
    library, {probeDimensions: false, maxDirectories: 2}, done));
assert(directoryLimited.ok && directoryLimited.truncated &&
    JSON.stringify(directoryLimited.directories) === JSON.stringify([
        library,
        GLib.build_filenamev([library, 'dir-alpha']),
        GLib.build_filenamev([library, 'dir-beta']),
    ]), 'subfolder scans are deterministically bounded independent of enumeration order');
assert(directoryLimited.errors.some(error => error.code === 'directory-limit-reached'),
    'subfolder truncation is explicit instead of growing memory and watch demand');

const missing = waitFor(done => indexer.scanAsync(
    GLib.build_filenamev([tempRoot, 'missing']), done));
assert(!missing.ok && missing.code === 'invalid-root' &&
    missing.errors.some(error => error.code === 'root-unavailable'),
    'unavailable roots return structured errors instead of throwing');

const denied = GLib.build_filenamev([tempRoot, 'denied']);
GLib.mkdir_with_parents(denied, 0o700);
image(denied, 'present.png', 4, 4);
GLib.chmod(denied, 0o000);
const deniedResult = waitFor(done => indexer.scanAsync(denied, done));
GLib.chmod(denied, 0o700);
if (deniedResult.code === 'scan-failed') {
    assert(!deniedResult.ok && deniedResult.errors.some(error =>
        error.path === denied && error.code === 'enumeration-failed'),
    'root enumeration failure is terminal and retains its structured error');
} else {
    // Root in some CI containers bypasses mode bits. That environment cannot
    // exercise EACCES, but must still return a valid complete index.
    assert(GLib.get_user_name() === 'root' && deniedResult.ok,
        'only a privileged test process may bypass the denied-root fixture');
}
indexer.dispose();

const slowWorker = GLib.build_filenamev([
    repoRoot, 'tests', 'fixtures', 'slow-library-index-worker.js']);
const latest = new LibraryIndexer(repoRoot, {
    workerPath: slowWorker,
    timeoutMs: 2000,
});
const generationResults = [];
let latestGeneration = 0;
let heartbeat = 0;
const heartbeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    heartbeat++;
    return GLib.SOURCE_CONTINUE;
});
const latestResult = waitFor(done => {
    latest.scanAsync(library, result => generationResults.push(result));
    latestGeneration = latest.scanAsync(library, result => {
        generationResults.push(result);
        done(result);
    });
});
GLib.Source.remove(heartbeatId);
assert(heartbeat >= 10,
    'the caller main loop remains responsive while a slow index worker runs');
assert(generationResults.filter(result => result.code === 'superseded').length === 1,
    'a newer scan explicitly supersedes the prior generation once');
assert(latestResult?.generation === latestGeneration && latestResult.ok &&
    latestResult.watcher.degraded,
    'latest generation succeeds and preserves degraded watcher status');
latest.dispose();

const reentrant = new LibraryIndexer(repoRoot, {
    workerPath: slowWorker,
    timeoutMs: 2000,
});
const reentrantResults = [];
let nestedGeneration = 0;
let outerGeneration = 0;
const reentrantResult = waitFor(done => {
    reentrant.scanAsync(library, firstResult => {
        reentrantResults.push(firstResult);
        if (firstResult.code === 'superseded') {
            nestedGeneration = reentrant.scanAsync(library, nestedResult => {
                reentrantResults.push(nestedResult);
                done(nestedResult);
            });
        }
    });
    outerGeneration = reentrant.scanAsync(
        library, outerResult => reentrantResults.push(outerResult));
});
assert(nestedGeneration > outerGeneration &&
    reentrantResult.generation === nestedGeneration && reentrantResult.ok,
    'a reentrant superseded callback owns the newest generation');
assert(reentrantResults.filter(result => result.code === 'superseded').length === 2 &&
    reentrantResults.filter(result => result.ok).length === 1,
    'reentrant last-wins completion is exactly once per generation');
assert(reentrant.generation === nestedGeneration && reentrant.active === false,
    'outer scan cannot overwrite or spawn after a reentrant replacement');
reentrant.dispose();

const timeoutIndexer = new LibraryIndexer(repoRoot, {
    workerPath: slowWorker,
    timeoutMs: 100,
});
let timeoutCallbacks = 0;
const timeoutResult = waitFor(done => timeoutIndexer.scanAsync(library, result => {
    timeoutCallbacks++;
    done(result);
}));
assert(timeoutResult.code === 'timeout' && !timeoutResult.ok,
    'overdue workers terminate with a structured timeout');
assert(timeoutIndexer.active === false, 'timed-out request releases active state');
spin(450);
assert(timeoutCallbacks === 1, 'late worker completion cannot duplicate the timeout callback');
timeoutIndexer.dispose();

const cancelIndexer = new LibraryIndexer(repoRoot, {
    workerPath: slowWorker,
    timeoutMs: 2000,
});
let cancelled = null;
const cancelledGeneration = cancelIndexer.scanAsync(library, result => {
    cancelled = result;
});
assert(cancelIndexer.cancel(cancelledGeneration + 1) === false,
    'cancellation cannot target an unrelated generation');
assert(cancelIndexer.cancel(cancelledGeneration) === true,
    'current generation can be cancelled explicitly');
assert(cancelled?.code === 'cancelled' && cancelIndexer.active === false,
    'explicit cancellation completes once and clears active state');
cancelIndexer.dispose();

const malformedWorker = GLib.build_filenamev([
    repoRoot, 'tests', 'fixtures', 'malformed-library-index-worker.js']);
const malformedIndexer = new LibraryIndexer(repoRoot, {
    workerPath: malformedWorker,
    timeoutMs: 2000,
});
const malformed = waitFor(done => malformedIndexer.scanAsync(library, done));
assert(!malformed.ok && malformed.code === 'worker-failed',
    'malformed worker output becomes a bounded protocol failure');
malformedIndexer.dispose();

const invalidWorker = GLib.build_filenamev([
    repoRoot, 'tests', 'fixtures', 'invalid-library-index-worker.js']);
const invalidIndexer = new LibraryIndexer(repoRoot, {
    workerPath: invalidWorker,
    timeoutMs: 2000,
});
const invalid = waitFor(done => invalidIndexer.scanAsync(library, done));
assert(!invalid.ok && invalid.code === 'worker-failed',
    'well-formed JSON with invalid nested records is rejected by the protocol');
invalidIndexer.dispose();

removeTree(tempRoot);
print('library-index async tests passed');

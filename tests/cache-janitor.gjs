#!/usr/bin/gjs -m

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    classifyManagedCacheName,
    pruneManagedCache,
} from '../cacheJanitor.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function write(path, contents = 'test') {
    GLib.file_set_contents(path, contents);
    return path;
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

const cacheDir = GLib.dir_make_tmp('wallpaper-suite-cache-janitor-XXXXXX');
const uuid = '11111111-1111-4111-8111-111111111111';
const output = hash => `composite-${hash}.jpg`;
const path = name => GLib.build_filenamev([cacheDir, name]);

assert(classifyManagedCacheName(output('a'.repeat(32)))?.kind === 'output',
    'current composite basename is recognized');
assert(classifyManagedCacheName(`composite-${'b'.repeat(8)}.jpg`)?.kind === 'output',
    'legacy eight-character composite basename is recognized');
assert(classifyManagedCacheName(
    `composite-${'c'.repeat(32)}-refresh-${uuid}-7.jpg.meta.json`)?.kind === 'sidecar',
    'refresh sidecar basename is recognized');
assert(classifyManagedCacheName(`${output('d'.repeat(32))}.backup`) === null,
    'similar user filename is not classified as managed');

const fresh = write(path(output('a'.repeat(32))));
const stale = write(path(output('b'.repeat(32))));
const staleSidecar = write(`${stale}.meta.json`);
const protectedOutput = write(path(output('c'.repeat(32))));
const protectedSidecar = write(`${protectedOutput}.meta.json`);
const refresh = write(path(
    `composite-${'d'.repeat(32)}-refresh-${uuid}-7.jpg`));
const outputTemp = write(path(`${output('e'.repeat(32))}.tmp.${uuid}.3`));
const sidecarTemp = write(path(
    `${output('f'.repeat(32))}.meta.json.tmp.${uuid}.9`));
const statusTemp = write(path(`runtime-status.json.tmp.${uuid}`));
const orphanSidecar = write(path(`${output('0'.repeat(32))}.meta.json`));
const unknown = write(path(`${output('1'.repeat(32))}.backup`));
const statusFile = write(path('runtime-status.json'));
const managedDirectory = path(output('2'.repeat(32)));
GLib.mkdir(managedDirectory, 0o700);
const managedSymlink = path(output('3'.repeat(32)));
Gio.File.new_for_path(managedSymlink).make_symbolic_link(unknown, null);

const young = pruneManagedCache(cacheDir, new Set(), {
    nowUsec: GLib.get_real_time(),
    tempMaxAgeSeconds: 60,
    outputMaxAgeSeconds: 60,
});
assert(young.removed.length === 0 && young.errors.length === 0,
    'fresh managed entries are retained');

const futureUsec = GLib.get_real_time() + 31 * 24 * 60 * 60 * 1e6;
const futureDated = write(path(output('4'.repeat(32))));
Gio.File.new_for_path(futureDated).set_attribute_uint64(
    'time::modified',
    Math.floor(futureUsec / 1e6) + 24 * 60 * 60,
    Gio.FileQueryInfoFlags.NONE,
    null
);
const pruned = pruneManagedCache(cacheDir, new Set([protectedOutput]), {
    nowUsec: futureUsec,
    tempMaxAgeSeconds: 24 * 60 * 60,
    outputMaxAgeSeconds: 30 * 24 * 60 * 60,
});
assert(pruned.errors.length === 0, 'age pruning completes without errors');
for (const removed of [fresh, stale, staleSidecar, refresh, outputTemp,
    sidecarTemp, statusTemp, orphanSidecar]) {
    assert(!exists(removed), `stale exact managed path is removed: ${removed}`);
}
assert(exists(protectedOutput) && exists(protectedSidecar),
    'an active output and its exact sidecar are protected together');
assert(exists(unknown), 'a similar but unmanaged filename is never deleted');
assert(exists(statusFile), 'the live runtime status contract is never deleted');
assert(exists(managedDirectory), 'a directory is never treated as a managed cache file');
assert(exists(managedSymlink), 'a managed-looking symbolic link is never followed or deleted');
assert(exists(futureDated), 'a future-dated managed output is retained');

const again = pruneManagedCache(cacheDir, new Set([protectedOutput]), {
    nowUsec: futureUsec,
    tempMaxAgeSeconds: 24 * 60 * 60,
    outputMaxAgeSeconds: 30 * 24 * 60 * 60,
});
assert(again.removed.length === 0 && again.errors.length === 0,
    'a repeated janitor pass is idempotent');

print('cache-janitor: all tests passed');

#!/usr/bin/gjs -m

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {Scheduler} from '../scheduler.js';

class FakeSettings {
    constructor(values) {
        this.values = values;
        this.rejectSequentialState = false;
    }
    get_boolean(key) { return Boolean(this.values[key]); }
    get_string(key) { return String(this.values[key] ?? ''); }
    get_int(key) { return Number(this.values[key] ?? 0); }
    get_int64(key) { return Number(this.values[key] ?? 0); }
    set_int64(key, value) { this.values[key] = Number(value); return true; }
    set_string(key, value) { this.values[key] = String(value); return true; }
    get_value(key) {
        const value = this.values[key];
        return {deep_unpack: () => value && typeof value === 'object'
            ? {...value}
            : value};
    }
    set_value(key, value) {
        if (key === 'rotation-sequential-state' && this.rejectSequentialState)
            return false;
        const unpacked = value.deep_unpack();
        this.values[key] = unpacked && typeof unpacked === 'object'
            ? {...unpacked}
            : unpacked;
        return true;
    }
}

class ControlledIndexer {
    constructor() {
        this.calls = [];
        this.generation = 0;
        this.disposed = false;
    }
    scanAsync(folder, _options, onDone) {
        const generation = ++this.generation;
        this.calls.push({folder, generation, onDone, done: false});
        return generation;
    }
    complete(files) {
        const call = this.calls.find(item => !item.done);
        if (!call)
            throw new Error('No controlled index call is pending');
        call.done = true;
        call.onDone({
            schemaVersion: 1,
            ok: true,
            code: 'indexed',
            message: '',
            generation: call.generation,
            root: call.folder,
            files: files.map(path => ({path})),
            directories: [],
            errors: [],
            watcher: {degraded: false, directories: [], errors: []},
            truncated: false,
            durationMs: 1,
        });
    }
    fail(code = 'scan-failed') {
        const call = this.calls.find(item => !item.done);
        if (!call)
            throw new Error('No controlled index call is pending');
        call.done = true;
        call.onDone({
            ok: false,
            code,
            message: 'synthetic index failure',
            generation: call.generation,
            durationMs: 1,
            watcher: {degraded: false, directories: [], errors: []},
        });
    }
    cancel() { return false; }
    dispose() { this.disposed = true; }
}

function assert(condition, message) {
    if (!condition)
        throw new Error(`assertion failed: ${message}`);
}

function image(folder, name, fill) {
    const path = GLib.build_filenamev([folder, name]);
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 8, 8);
    pixbuf.fill(fill);
    pixbuf.savev(path, 'png', [], []);
    return path;
}

function pickAsync(scheduler, monitors, currentAssignments, timeoutSeconds = 10) {
    let result = null;
    let timedOut = false;
    const loop = new GLib.MainLoop(null, false);
    scheduler.pickNextAsync(monitors, currentAssignments, value => {
        result = value;
        loop.quit();
    });
    const timeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        timeoutSeconds,
        () => {
            timedOut = true;
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
    );
    loop.run();
    if (!timedOut)
        GLib.Source.remove(timeoutId);
    assert(!timedOut && result, 'asynchronous selection completed before timeout');
    return result;
}

const folder = GLib.dir_make_tmp('wallpaper-suite-scheduler-test-XXXXXX');
const a = image(folder, 'a.png', 0xff0000ff);
const b = image(folder, 'b.png', 0x00ff00ff);
const settings = new FakeSettings({
    'wallpaper-folder': folder,
    'rotation-enabled': false,
    'rotation-interval-minutes': 1,
    'rotation-mode': 'random',
    'rotation-sync-monitors': false,
    'rotation-next-deadline': 0,
    'rotation-last-run': 0,
});
const scheduler = new Scheduler(settings, () => {}, {random: () => 0});
const monitors = [
    {connector: 'left'},
    {connector: 'right'},
];
const first = pickAsync(scheduler, monitors, {left: a, right: b});
assert(first.ok && first.assignments.left === b && first.assignments.right === a,
    'each monitor changes while avoiding a same-tick duplicate when possible');
assert(first.cursorCommitRequired === false,
    'random selections do not claim a durable sequential cursor');

GLib.unlink(b);
const c = image(folder, 'c.png', 0x0000ffff);
const refreshed = pickAsync(scheduler, [{connector: 'left'}], {left: a});
assert(refreshed.ok && refreshed.assignments.left === c,
    'every rotation awaits a fresh index and prunes a deleted cached path');

// A scheduled and manual action arriving during one scan share that scan;
// selection itself remains newest-request-wins.
const controlled = new ControlledIndexer();
const sharedSettings = new FakeSettings({...settings.values});
const shared = new Scheduler(sharedSettings, () => {}, {
    indexer: controlled,
    random: () => 0,
});
const sharedResults = [];
shared.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    sharedResults.push(result));
shared.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    sharedResults.push(result));
assert(controlled.calls.length === 1,
    'overlapping selection requests coalesce onto one index generation');
assert(sharedResults.length === 1 && sharedResults[0].code === 'superseded',
    'the older overlapping selection is completed as superseded');
controlled.complete([a, c]);
assert(sharedResults.length === 2 && sharedResults[1].ok &&
    sharedResults[1].assignments.only === c,
    'the newest coalesced selection receives the completed snapshot');
shared.shutdown();

const noAlternativeIndexer = new ControlledIndexer();
const noAlternative = new Scheduler(sharedSettings, () => {}, {
    indexer: noAlternativeIndexer,
    random: () => 0,
});
const noAlternativeResults = [];
noAlternative.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    noAlternativeResults.push(result));
noAlternativeIndexer.complete([a]);
assert(noAlternativeResults.length === 1 && noAlternativeResults[0].ok &&
    noAlternativeResults[0].code === 'no-alternative' &&
    noAlternativeResults[0].changed === false &&
    noAlternativeResults[0].assignments.only === a,
    'a current-only pool reports an accurate successful no-op');
assert(!noAlternative.commitSelection({only: a}, noAlternativeResults[0].generation),
    'a no-alternative result never creates a tentative sequential commit');
noAlternative.shutdown();

const noMonitorIndexer = new ControlledIndexer();
const noMonitorScheduler = new Scheduler(sharedSettings, () => {}, {
    indexer: noMonitorIndexer,
});
const noMonitorResults = [];
noMonitorScheduler.pickNextAsync([], {only: a}, result =>
    noMonitorResults.push(result));
noMonitorIndexer.complete([a]);
assert(noMonitorResults.length === 1 && !noMonitorResults[0].ok &&
    noMonitorResults[0].code === 'no-monitors',
    'an empty topology is an actionable failure, not a no-alternative success');
noMonitorScheduler.shutdown();

const backgroundIndexer = new ControlledIndexer();
const background = new Scheduler(sharedSettings, () => {}, {
    indexer: backgroundIndexer,
    random: () => 0,
});
background.start();
assert(backgroundIndexer.calls.length === 1,
    'scheduler startup begins one background index generation');
const backgroundResults = [];
background.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    backgroundResults.push(result));
backgroundIndexer.complete([a, c]);
assert(backgroundIndexer.calls.length === 2 && backgroundResults.length === 0,
    'an action joining a pre-existing background scan awaits an action-fresh snapshot');
backgroundIndexer.complete([a, c]);
assert(backgroundResults.length === 1 && backgroundResults[0].ok,
    'the action completes from the follow-up fresh generation');
background.shutdown();

const retryIndexer = new ControlledIndexer();
const retryScheduler = new Scheduler(sharedSettings, () => {}, {
    indexer: retryIndexer,
    random: () => 0,
});
const retryResults = [];
retryScheduler.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    retryResults.push(result));
retryScheduler._onPoolFileEvent();
retryIndexer.fail();
assert(retryIndexer.calls.length === 2 && retryResults.length === 0,
    'a dirty event during a failed scan schedules one immediate retry');
retryIndexer.complete([a, c]);
assert(retryResults.length === 1 && retryResults[0].ok,
    'the bounded retry can satisfy the waiting selection');
retryScheduler.shutdown();

const pauseIndexer = new ControlledIndexer();
const pauseScheduler = new Scheduler(sharedSettings, () => {}, {
    indexer: pauseIndexer,
    random: () => 0,
});
const pauseResults = [];
const scheduledGeneration = pauseScheduler.pickNextAsync(
    [{connector: 'only'}],
    {only: a},
    result => pauseResults.push(result)
);
assert(pauseScheduler.cancelSelection(
    scheduledGeneration,
    'cancelled',
    'Scheduled rotation was paused'
), 'pause can target the in-flight scheduled selection generation');
assert(pauseResults.length === 1 && pauseResults[0].code === 'cancelled',
    'paused scheduled selection completes without producing assignments');
pauseScheduler.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    pauseResults.push(result));
pauseIndexer.complete([a, c]);
assert(pauseResults.length === 2 && pauseResults[1].ok,
    'a later manual selection remains allowed while scheduling is paused');
pauseScheduler.shutdown();

// Shutdown must complete a pending selection exactly once and dispose its
// worker controller without waiting for the subprocess.
const shutdownIndexer = new ControlledIndexer();
const shutdownScheduler = new Scheduler(sharedSettings, () => {}, {
    indexer: shutdownIndexer,
});
const shutdownResults = [];
shutdownScheduler.pickNextAsync([{connector: 'only'}], {only: a}, result =>
    shutdownResults.push(result));
shutdownScheduler.shutdown();
assert(shutdownResults.length === 1 && shutdownResults[0].code === 'cancelled',
    'shutdown cancels a pending asynchronous selection exactly once');
assert(shutdownIndexer.disposed, 'shutdown disposes the library index controller');

// Monitor exhaustion is degraded-but-correct: rotation uses the fresh scan,
// while the five-minute reconciliation remains available as a fallback.
const degraded = new Scheduler(settings, () => {}, {
    random: () => 0,
    monitorDirectory: () => { throw new Error('watch allocation exhausted'); },
});
const degradedResult = pickAsync(degraded, [{connector: 'only'}], {only: a});
assert(degradedResult.ok, 'watch allocation failure does not block a fresh selection');
assert(degraded.poolStatus.watcherDegraded &&
    degraded.poolStatus.watcherErrors.some(error => error.includes('exhausted')),
    'watch allocation failure is exposed in scheduler diagnostics');
settings.values['wallpaper-folder'] = '';
degraded.invalidatePool();
assert(!degraded.poolStatus.watcherDegraded &&
    degraded.poolStatus.watcherErrors.length === 0 &&
    degraded.poolStatus.lastScanEpoch === 0 &&
    degraded.poolStatus.lastAttemptEpoch === 0,
    'unsetting the library clears stale watcher and scan diagnostics');
settings.values['wallpaper-folder'] = folder;
degraded.shutdown();

let liveMonitorCount = 0;
const fanoutScheduler = new Scheduler(settings, () => {}, {
    monitorDirectory: () => {
        liveMonitorCount++;
        return {
            connect() { return 1; },
            disconnect() {},
            cancel() {},
        };
    },
});
const fanoutErrors = fanoutScheduler._rebuildPoolMonitors(
    Array.from({length: 300}, (_value, index) => `/library/album-${index}`)
);
assert(liveMonitorCount === 128 && fanoutErrors.some(error =>
    error.includes('limited to 128 of 300')),
    'live directory watches are capped and disclose periodic reconciliation fallback');
fanoutScheduler.shutdown();

settings.values['rotation-enabled'] = true;
settings.values['rotation-next-deadline'] = Math.floor(Date.now() / 1000) - 120;
let rotations = 0;
// overdueCatchupSec: the real 30s settle delay keeps an overdue rotation out
// of the unlock transition; 1s here keeps this test fast without changing
// what it asserts (the catch-up still fires exactly once).
const catchup = new Scheduler(settings, () => { rotations++; },
    {random: () => 0, overdueCatchupSec: 1});
const loop = new GLib.MainLoop(null, false);
catchup.start();
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
    if (rotations > 0)
        loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
assert(rotations === 1, 'a missed persisted deadline catches up exactly once');
assert(catchup.nextDeadline > Math.floor(Date.now() / 1000),
    'catch-up advances the next deadline from now');
assert(catchup.lastRotationAttempt > 0 && catchup.lastRotationSuccess === 0,
    'dispatch records an attempt without claiming publication success');
catchup.markRotationSuccess(1234);
assert(catchup.lastRotationSuccess === 1234,
    'successful publication is recorded independently from its attempt');
catchup.shutdown();

const future = Math.floor(Date.now() / 1000) + 300;
settings.values['rotation-next-deadline'] = future;
const preserve = new Scheduler(settings, () => {});
preserve.start();
assert(preserve.nextDeadline === future, 'future persisted deadline survives extension restart');
preserve.shutdown();
scheduler.shutdown();

// Sequential progress is tentative until the compositor acknowledges that
// the exact selected assignment was published successfully.
const sequentialFolder = GLib.dir_make_tmp('wallpaper-suite-sequential-test-XXXXXX');
const seqA = image(sequentialFolder, 'a.png', 0xaa0000ff);
const seqB = image(sequentialFolder, 'b.png', 0x00aa00ff);
const seqC = image(sequentialFolder, 'c.png', 0x0000aaff);
const sequentialSettings = new FakeSettings({
    'wallpaper-folder': sequentialFolder,
    'rotation-enabled': false,
    'rotation-interval-minutes': 1,
    'rotation-mode': 'sequential',
    'rotation-sync-monitors': false,
    'rotation-next-deadline': 0,
    'rotation-last-run': 0,
    'rotation-sequential-state': {},
});
const firstLifecycle = new Scheduler(sequentialSettings, () => {});
const tentative = pickAsync(firstLifecycle, [{connector: 'only'}], {only: seqA});
assert(tentative.assignments.only === seqB,
    'first sequential selection follows lexical order');
assert(tentative.cursorCommitRequired === true,
    'sequential selections explicitly carry cursor-commit ownership');
assert(!sequentialSettings.values['rotation-sequential-state'].lastPath,
    'selection alone does not advance the durable cursor');
assert(firstLifecycle.discardSelection(tentative.assignments, tentative.generation),
    'a failed render discards its exact pending selection');
assert(!sequentialSettings.values['rotation-sequential-state'].lastPath,
    'failed publication leaves the durable cursor unchanged');

const unrelated = pickAsync(firstLifecycle, [{connector: 'only'}], {only: seqA});
assert(!firstLifecycle.commitSelection({only: seqC}, unrelated.generation),
    'a successful unrelated assignment cannot acknowledge a pending cursor');
assert(!sequentialSettings.values['rotation-sequential-state'].lastPath,
    'mismatched acknowledgement leaves the durable cursor unchanged');
firstLifecycle.discardSelection(unrelated.assignments, unrelated.generation);

const acknowledged = pickAsync(firstLifecycle, [{connector: 'only'}], {only: seqA});
assert(!firstLifecycle.discardSelection(
    acknowledged.assignments,
    acknowledged.generation + 1
), 'an older render cannot discard a newer same-assignment cursor token');
sequentialSettings.rejectSequentialState = true;
assert(!firstLifecycle.commitSelection(acknowledged.assignments, acknowledged.generation),
    'a rejected settings write does not acknowledge the pending cursor');
assert(!sequentialSettings.values['rotation-sequential-state'].lastPath,
    'a rejected atomic write leaves the durable cursor unchanged');
sequentialSettings.rejectSequentialState = false;
assert(firstLifecycle.commitSelection(acknowledged.assignments, acknowledged.generation),
    'successful publication acknowledges the pending cursor');
assert(sequentialSettings.values['rotation-sequential-state'].lastPath === seqB,
    'acknowledgement persists the last published path');
assert(sequentialSettings.values['rotation-sequential-state'].folder ===
    GLib.canonicalize_filename(sequentialFolder, null),
    'acknowledgement binds the cursor to its canonical folder');
firstLifecycle.shutdown();

const secondLifecycle = new Scheduler(sequentialSettings, () => {});
const resumed = pickAsync(secondLifecycle, [{connector: 'only'}], {only: seqB});
assert(resumed.assignments.only === seqC,
    'a new extension lifecycle resumes after the published path');
assert(sequentialSettings.values['rotation-sequential-state'].lastPath === seqB,
    'restart selection remains tentative before publication');
assert(secondLifecycle.commitSelection(resumed.assignments, resumed.generation),
    'resumed selection can be acknowledged');

GLib.unlink(seqC);
const afterDeletion = new Scheduler(sequentialSettings, () => {});
const deletionNext = pickAsync(afterDeletion, [{connector: 'only'}], {only: seqB});
assert(deletionNext.assignments.only === seqA,
    'a deleted final cursor wraps lexically without using a stale array index');
afterDeletion.discardSelection(deletionNext.assignments, deletionNext.generation);
afterDeletion.shutdown();

const otherFolder = GLib.dir_make_tmp('wallpaper-suite-sequential-other-XXXXXX');
const otherA = image(otherFolder, 'a.png', 0xaaaa00ff);
const otherB = image(otherFolder, 'b.png', 0x00aaaaff);
sequentialSettings.values['wallpaper-folder'] = otherFolder;
secondLifecycle.invalidatePool();
const switched = pickAsync(secondLifecycle, [{connector: 'only'}], {only: otherA});
assert(switched.assignments.only === otherB, 'a folder switch starts from the new pool');
assert(sequentialSettings.values['rotation-sequential-state'].lastPath === seqC,
    'folder switch does not overwrite committed state before publication');
assert(secondLifecycle.commitSelection(switched.assignments, switched.generation),
    'new-folder publication commits');
assert(sequentialSettings.values['rotation-sequential-state'].lastPath === otherB &&
    sequentialSettings.values['rotation-sequential-state'].folder ===
        GLib.canonicalize_filename(otherFolder, null),
    'new-folder acknowledgement replaces both cursor path and folder identity');
secondLifecycle.shutdown();

print('scheduler-integration: all tests passed');

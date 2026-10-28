// Regression cover for the two unlock-path defects fixed together:
//
//   1. _scheduleApply() was a LEADING debounce, so a multi-monitor DPMS wake
//      composited against a transient one-monitor layout and published it.
//      With picture-options=spanned that publishes a stretched wallpaper, and
//      any monitor the composite does not cover renders black.
//   2. _scheduleDeadline() floored an overdue delay at 1s, so a catch-up
//      rotation ran inside the unlock transition.
//
// Both are timing bugs with no observable return value, so we instrument the
// GLib timer stubs and assert on what got armed. Assertions deliberately test
// behaviour rather than the named constants, so this still fails meaningfully
// if someone reverts the logic and drops the constants with it.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.argv[2] || path.resolve(import.meta.dirname, '..');

/** Records every timeout_add/Source.remove so tests can assert on re-arming. */
function makeTimerSpy() {
    const spy = {armed: [], removed: [], nextId: 1, nowUs: 0};
    return {
        spy,
        GLib: {
            PRIORITY_DEFAULT: 0,
            PRIORITY_DEFAULT_IDLE: 0,
            SOURCE_REMOVE: false,
            get_monotonic_time() { return spy.nowUs; },
            Source: {remove(id) { spy.removed.push(id); }},
            timeout_add(_priority, ms, fn) {
                const id = spy.nextId++;
                spy.armed.push({id, ms, fn});
                return id;
            },
            timeout_add_seconds(_priority, sec, fn) {
                const id = spy.nextId++;
                spy.armed.push({id, sec, fn});
                return id;
            },
            idle_add() { return spy.nextId++; },
        },
    };
}

/** Load a module's real source with its GI imports replaced by stubs. */
function loadModule(file, exportName, extraContext = {}) {
    let source = readFileSync(path.join(root, file), 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    source = source.replace(/^export (default )?(?=(class|const|function|let|var) )/gm, '');
    source += `\nglobalThis.__loaded = ${exportName};\n`;

    class EmptyClass {}
    const context = vm.createContext({
        console,
        logError() {},
        GObject: {registerClass: value => value},
        Gio: {File: {new_for_path: p => ({get_uri: () => `file://${p}`})}},
        St: {Icon: EmptyClass},
        Extension: EmptyClass,
        Main: {notify() {}, panel: {addToStatusArea() {}}},
        PanelMenu: {Button: EmptyClass},
        PopupMenu: {PopupMenuItem: EmptyClass, PopupSeparatorMenuItem: EmptyClass},
        MonitorManager: EmptyClass,
        Compositor: EmptyClass,
        Scheduler: EmptyClass,
        LibraryIndexer: EmptyClass,
        DisplayIdentityClient: class {
            pending = false;
            attach(monitors) { return monitors; }
            refresh() {}
            dispose() {}
        },
        nextRotationDeadline: () => 0,
        selectAssignments: () => ({}),
        ControlService: EmptyClass,
        CONTROL_API_VERSION: 1,
        ...extraContext,
    });
    new vm.Script(source, {filename: path.join(root, file)}).runInContext(context);
    return context.__loaded;
}

// --- 1. a monitor-wake storm coalesces into a single trailing apply ---------
{
    const {spy, GLib} = makeTimerSpy();
    const Ext = loadModule('extension.js', 'WallpaperSuiteExtension', {GLib});

    const ext = Object.create(Ext.prototype);
    let applied = 0;
    ext.applyComposite = () => { applied += 1; };
    ext._applyTimeout = 0;

    // Five 'monitors-changed' events, as three 4K panels wake from DPMS.
    for (let i = 0; i < 5; i++)
        ext._scheduleApply({monitorChange: true});

    assert.equal(spy.armed.length, 5,
        'every event must re-arm the timer (leading debounce fires mid-storm)');
    assert.deepEqual(spy.removed, [1, 2, 3, 4],
        'each re-arm must cancel the previous source, in order');
    assert.equal(applied, 0, 'nothing composites while the storm is still arriving');

    const windowMs = spy.armed[0].ms;
    assert.ok(windowMs >= 1000,
        `debounce must outlast a multi-monitor DPMS wake, got ${windowMs}ms`);
    for (const armed of spy.armed)
        assert.equal(armed.ms, windowMs, 'every re-arm uses the full window');

    // Only the last timer survives; firing it applies exactly once.
    spy.armed.at(-1).fn();
    assert.equal(applied, 1, 'the settled layout composites exactly once');
}

// Next is immediate on a stable layout, but cannot shorten a wake's barrier.
{
    const {spy, GLib} = makeTimerSpy();
    const Ext = loadModule('extension.js', 'WallpaperSuiteExtension', {GLib});
    const ext = Object.create(Ext.prototype);
    let applied = 0;
    ext.applyComposite = () => { applied++; };
    ext._scheduleApply({immediate: true});
    assert.equal(spy.armed.at(-1).ms, 0, 'a stable explicit action does not wait for monitor settling');
    assert.equal(applied, 0, 'explicit rendering still yields before starting work');
    spy.armed.at(-1).fn();
    assert.equal(applied, 1);

    spy.nowUs = 100000;
    ext._scheduleApply({monitorChange: true});
    const settleMs = spy.armed.at(-1).ms;
    spy.nowUs += 100000;
    ext._scheduleApply({immediate: true});
    assert.equal(spy.armed.at(-1).ms, settleMs - 100,
        'Next keeps the remaining monitor-wake settle time');
    spy.nowUs += 200000;
    ext._scheduleApply({monitorChange: true});
    assert.equal(spy.armed.at(-1).ms, settleMs, 'a later wake event starts a fresh full window');
    spy.nowUs += (settleMs + 1) * 1000;
    ext._scheduleApply({immediate: true});
    assert.equal(spy.armed.at(-1).ms, 0, 'Next becomes immediate after the last monitor event settles');
}

// --- 1b. the monitor list is never served from a stale snapshot ------------
{
    // enable() runs on every unlock, i.e. while the panels are still waking.
    // Constructing during that window must not pin the layout for the session.
    let live = [{x: 0, y: 0, width: 2560, height: 1440}];
    const display = {
        get_n_monitors: () => live.length,
        get_monitor_geometry: i => live[i],
    };
    const MM = loadModule('monitorManager.js', 'MonitorManager',
        {global: {display}});

    const mgr = new MM();
    assert.equal(mgr.monitors.length, 1, 'starts with the mid-wake layout');

    // Panels finish waking and mutter applies monitors.xml. Crucially, NO
    // 'monitors-changed' callback is delivered here — that is the case the old
    // snapshot could not recover from.
    live = [
        {x: 0, y: 0, width: 3840, height: 2160},
        {x: 3840, y: 0, width: 3840, height: 2160},
        {x: 7680, y: 0, width: 3840, height: 2160},
    ];

    assert.equal(mgr.monitors.length, 3,
        'monitors must re-read, not serve the construction-time snapshot');
    // Array.from builds in this realm; the vm's arrays have a different
    // prototype and would fail deepStrictEqual for the wrong reason.
    assert.deepEqual(Array.from(mgr.monitors, m => m.connector),
        ['3840x2160+0+0', '3840x2160+3840+0', '3840x2160+7680+0'],
        'geometry keys reflect the settled layout');
}

// --- 2. an overdue deadline does not fire inside the unlock transition ------
{
    const {spy, GLib} = makeTimerSpy();
    const Sched = loadModule('scheduler.js', 'Scheduler', {GLib});

    // The delay is injectable so the GJS integration test can exercise the
    // catch-up path quickly; assert the SHIPPED default separately, since that
    // is the number that actually keeps a rotation out of the unlock
    // transition in production.
    const schedSrc = readFileSync(path.join(root, 'scheduler.js'), 'utf8');
    const shipped = Number(
        schedSrc.match(/OVERDUE_CATCHUP_DELAY_SEC\s*=\s*(\d+)/)?.[1]);
    assert.ok(shipped >= 15,
        `shipped overdue catch-up must let the session settle, got ${shipped}s`);

    const sched = Object.create(Sched.prototype);
    sched._settings = {get_boolean: () => false, get_int: () => 30};
    sched._setInt64 = () => {};
    sched._notifyStateChanged = () => {};
    sched._timerId = 0;
    sched._overdueCatchupSec = shipped;

    const nowSec = Math.floor(Date.now() / 1000);

    // Deadline missed while the screen was locked for an hour. enable() runs on
    // unlock, so this must not land on top of the unlock transition.
    sched._scheduleDeadline(nowSec - 3600);
    assert.equal(spy.armed.at(-1).sec, shipped,
        'an overdue rotation waits the settle delay, not ~0s');

    // A future deadline is still honoured exactly — the floor must not leak
    // into normal scheduling.
    sched._scheduleDeadline(nowSec + 900);
    assert.ok(Math.abs(spy.armed.at(-1).sec - 900) <= 1,
        'a future deadline keeps its own delay');
}

console.log('unlock-storm.test.mjs: ok');

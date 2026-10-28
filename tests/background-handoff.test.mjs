import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Signals {
    signals = new Map();
    next = 1;
    connect(name, callback) { const id = this.next++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { assert.ok(this.signals.delete(id), 'disconnect an owned live handler'); }
    emit(name) { for (const item of [...this.signals.values()]) if (item.name === name) item.callback(); }
}

function harness() {
    const timers = new Map(); const laters = new Map(); let id = 1;
    const file = path => ({path, equal: other => path === other.path});
    let image;
    class Image extends Signals {
        loaded = false; success = true;
        is_loaded() { return this.loaded; }
        get_success() { return this.success; }
        finish(success = true) { this.loaded = true; this.success = success; this.emit('loaded'); }
    }
    const actor = () => Object.assign(new Signals(), {
        content: {background: {_file: file('file:///old.jpg')}},
        duration: 1000,
        get_transition() { return {get_duration: () => this.duration, set_duration: ms => { this.duration = ms; }}; },
    });
    const oldActor = actor();
    const manager = Object.assign(new Signals(), {backgroundActor: oldActor});
    const context = vm.createContext({
        Gio: {File: {new_for_path: file, new_for_uri: file}},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, get_monotonic_time: () => 1000,
            timeout_add(_priority, ms, fn) { const n = id++; timers.set(n, {ms, fn}); return n; },
            Source: {remove(n) { assert.ok(timers.delete(n)); }}},
        Meta: {LaterType: {BEFORE_REDRAW: 0}},
    });
    const source = readFileSync(new URL('../backgroundHandoff.js', import.meta.url), 'utf8')
        .replace(/^import .*;\s*$/gm, '').replace('export class BackgroundHandoff', 'class BackgroundHandoff');
    new vm.Script(`${source}\nglobalThis.Handoff = BackgroundHandoff;`).runInContext(context);
    const handoff = new context.Handoff({getManagers: () => [manager],
        imageCache: {load() { image = new Image(); return image; }},
        laters: {add(_type, fn) { const n = id++; laters.set(n, fn); return n; }, remove(n) { assert.ok(laters.delete(n)); }}});
    return {handoff, timers, laters, manager, oldActor, actor, get image() { return image; },
        swap(path = 'file:///new.jpg') { manager.backgroundActor = actor(); manager.backgroundActor.content.background._file = file(path); manager.emit('changed'); },
        redraw() { for (const [n, fn] of [...laters]) { laters.delete(n); fn(); } },
        timeout() { const [n, t] = timers.entries().next().value; timers.delete(n); t.fn(); }};
}

{
    const h = harness(); const results = [];
    h.handoff.prepare('/new.jpg', result => results.push(result));
    assert.equal(results.length, 0, 'the URI cannot be published before native texture readiness');
    h.image.finish();
    assert.equal(results.length, 1); assert.equal(results[0].ok, true);
    assert.equal(h.timers.size, 0); assert.equal(h.image.signals.size, 0);
    h.handoff.watchPublication('file:///new.jpg');
    h.swap('file:///someone-else.jpg'); h.redraw();
    assert.equal(h.oldActor.duration, 1000, 'another wallpaper or extension retains its native animation');
    h.swap(); assert.equal(h.oldActor.duration, 1000, 'wait until Shell has installed its transition');
    h.redraw(); assert.equal(h.oldActor.duration, 160);
    assert.equal(h.manager.signals.size, 0); assert.equal(h.oldActor.signals.size, 0);
    assert.equal(h.timers.size, 0);
}

for (const failure of ['decode', 'timeout', 'disable']) {
    const h = harness(); const results = [];
    h.handoff.prepare('/new.jpg', result => results.push(result));
    if (failure === 'decode') h.image.finish(false);
    if (failure === 'timeout') h.timeout();
    if (failure === 'disable') h.handoff.dispose();
    h.image.finish();
    assert.equal(results.length, 1, `${failure} completes once even after a late loaded signal`);
    assert.equal(results[0].ok, false);
    assert.equal(h.image.signals.size, 0); assert.equal(h.timers.size, 0);
}

{
    const h = harness(); const first = []; const second = [];
    h.handoff.prepare('/a.jpg', result => first.push(result)); const oldImage = h.image;
    h.handoff.prepare('/b.jpg', result => second.push(result));
    oldImage.finish(); assert.equal(first[0].code, 'superseded'); assert.equal(second.length, 0);
    h.image.finish(); assert.equal(second[0].ok, true);
}

for (const change of ['new-wallpaper', 'disable', 'actor-destroyed', 'publication-failed']) {
    const h = harness(); const cancel = h.handoff.watchPublication('file:///new.jpg'); h.swap();
    if (change === 'new-wallpaper') h.swap('file:///a-newer.jpg');
    if (change === 'disable') h.handoff.dispose();
    if (change === 'actor-destroyed') h.oldActor.emit('destroy');
    if (change === 'publication-failed') cancel();
    h.redraw();
    assert.equal(h.oldActor.duration, 1000, `${change} cannot retime an obsolete actor`);
    h.handoff.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.laters.size, 0);
    assert.equal(h.manager.signals.size, 0);
}

console.log('native texture readiness, fade ownership and cancellation tests passed');

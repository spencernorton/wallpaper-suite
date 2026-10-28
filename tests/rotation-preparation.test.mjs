import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function harness() {
    const timers = new Map(); let next = 1; let snapshot = {context: 'A', monitors: [], assignments: {only: 'old'}, modes: {}, quality: 92};
    const calls = []; const cancelled = []; const released = []; let disposed = false;
    const context = vm.createContext({GLib: {PRIORITY_DEFAULT_IDLE: 200, SOURCE_REMOVE: false,
        timeout_add(_priority, _ms, fn) { const id = next++; timers.set(id, fn); return id; },
        Source: {remove(id) { assert.ok(timers.delete(id)); }}}});
    const source = readFileSync(new URL('../rotationPreparation.js', import.meta.url), 'utf8')
        .replace(/^import .*;\s*$/gm, '').replace('export class RotationPreparation', 'class RotationPreparation');
    new vm.Script(`${source}\nglobalThis.Preparation = RotationPreparation;`).runInContext(context);
    const preparation = new context.Preparation({snapshot: () => snapshot,
        protectedPaths: () => new Set(['active']),
        scheduler: {prepareNext() { return {assignments: {only: 'new'}}; }},
        compositor: {
            compositeAsync(...args) { calls.push(args); return calls.length; },
            cancel(id) { cancelled.push(id); },
            releaseObsolete(paths, protectedPaths) { released.push({paths: [...paths], protectedPaths: [...protectedPaths]}); },
            dispose() { disposed = true; },
        }});
    return {preparation, calls, cancelled, released, timers,
        setSnapshot(value) { snapshot = value; },
        fire() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
        complete(index = 0) { calls[index].at(-1)({ok: true, path: 'prepared'}); },
        get disposed() { return disposed; }};
}

{
    const h = harness(); h.preparation.schedule(); h.preparation.schedule();
    assert.equal(h.timers.size, 1, 'coalesce idle preparation'); h.fire();
    assert.equal(h.calls[0][4].force, true, 'speculative output has a unique filename');
    assert.equal(h.calls[0][4].background, true, 'foreground responsiveness has priority');
    h.complete(); h.preparation.schedule(); assert.equal(h.timers.size, 0, 'keep one ready slot');
    const ready = h.preparation.take(); assert.equal(ready.path, 'prepared');
    assert.equal(h.preparation.take(), null, 'consume a prepared image once');
    assert.equal(h.released.length, 0, 'keep the file while the foreground action owns it');
    h.preparation.release(ready); assert.deepEqual(h.released[0], {paths: ['prepared'], protectedPaths: ['active']});
}

for (const mutation of ['context', 'busy', 'disable', 'foreground-before-ready']) {
    const h = harness(); h.preparation.schedule(); h.fire();
    if (mutation === 'context') h.setSnapshot({context: 'B'});
    if (mutation === 'busy') h.setSnapshot(null);
    if (mutation === 'disable') h.preparation.dispose();
    if (mutation === 'foreground-before-ready') assert.equal(h.preparation.take(), null);
    h.complete();
    assert.equal(h.preparation.take(), null, `${mutation} cannot consume a stale background render`);
    assert.equal(h.released.at(-1).paths[0], 'prepared', 'reap only the abandoned output');
    h.preparation.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.disposed, true);
}

{
    const h = harness(); h.preparation.schedule(); h.setSnapshot(null); h.fire();
    assert.equal(h.calls.length, 0, 'do no work while the desktop has a foreground action');
    h.preparation.dispose();
}
console.log('bounded preparation, foreground priority and stale-output ownership tests passed');

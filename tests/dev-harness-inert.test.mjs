// A nested dev-harness Shell shares the live desktop's dconf and composite
// cache (GNOME Shell 50 resolves both from the passwd home dir), so enabling
// there published a virtual-monitor composite over the real wallpaper. Assert
// the extension stays inert under GNOME_SHELL_DEV_HARNESS=1 — and, just as
// importantly, that it still runs without it. A guard that is always on would
// pass the first half alone.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.argv[2] || path.resolve(import.meta.dirname, '..');

function loadExtensionClass(env) {
    let source = readFileSync(path.join(root, 'extension.js'), 'utf8');
    source = source.replace(/^import .*;\s*$/gm, '');
    source = source.replace(
        'export default class WallpaperSuiteExtension extends Extension',
        'class WallpaperSuiteExtension extends Extension'
    );
    source += '\nglobalThis.__WallpaperSuiteExtension = WallpaperSuiteExtension;\n';

    class EmptyClass {}
    const context = vm.createContext({
        console: {log() {}, warn() {}},
        logError() {},
        GObject: {registerClass: value => value},
        GLib: {
            PRIORITY_DEFAULT: 0,
            PRIORITY_DEFAULT_IDLE: 0,
            SOURCE_REMOVE: false,
            Source: {remove() {}},
            timeout_add() { return 1; },
            idle_add() { return 2; },
            getenv: name => Object.hasOwn(env, name) ? env[name] : null,
        },
        Gio: {File: {new_for_path: p => ({get_uri: () => `file://${p}`})}},
        St: {Icon: EmptyClass},
        Extension: EmptyClass,
        Main: {notify() {}, panel: {addToStatusArea() {}}},
        PanelMenu: {Button: EmptyClass},
        PopupMenu: {PopupMenuItem: EmptyClass, PopupSeparatorMenuItem: EmptyClass},
        MonitorManager: EmptyClass,
        Compositor: EmptyClass,
        Scheduler: EmptyClass,
    });
    new vm.Script(source, {filename: path.join(root, 'extension.js')})
        .runInContext(context);
    return context.__WallpaperSuiteExtension;
}

// Reaching getSettings() means the guard let execution through. It is the
// first thing enable() does after the guard, and the first shared-state touch.
const REACHED = new Error('reached getSettings');
function makeExtension(env) {
    const Klass = loadExtensionClass(env);
    const ext = new Klass();
    ext.getSettings = () => { throw REACHED; };
    return ext;
}

// --- inside the harness: nothing runs, nothing is published ---------------
for (const value of ['1']) {
    const ext = makeExtension({GNOME_SHELL_DEV_HARNESS: value});
    ext.enable();
    assert.equal(ext._settings, undefined,
        `enable() must not build settings under GNOME_SHELL_DEV_HARNESS=${value}`);
    assert.equal(ext._lifecycleGeneration, undefined,
        'enable() must return before touching any state in the harness');

    ext.disable();
    assert.equal(ext._shuttingDown, undefined,
        'disable() must not write runtime-status.json in the harness');
}

// --- outside the harness: the extension still works ----------------------
// Unset, empty and any other value are all "the real session".
for (const env of [{}, {GNOME_SHELL_DEV_HARNESS: ''}, {GNOME_SHELL_DEV_HARNESS: '0'}]) {
    const shown = JSON.stringify(env);
    const ext = makeExtension(env);
    assert.throws(() => ext.enable(), error => error === REACHED,
        `enable() must proceed to getSettings() with env ${shown}`);
    assert.equal(ext._lifecycleGeneration, 1,
        `enable() must advance the lifecycle with env ${shown}`);

    try { ext.disable(); } catch { /* later teardown needs a real enable() */ }
    assert.equal(ext._shuttingDown, true,
        `disable() must proceed past the guard with env ${shown}`);
}

console.log('dev-harness-inert: ok');

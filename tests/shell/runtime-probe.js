import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {exercise, disabled} from './exercise.js';

const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const expect = (condition, message) => {
    if (!condition)
        throw new Error(message);
};

export default class RuntimeProbe extends Extension {
    enable() {
        // Session-mode changes and extension-order reloads can call enable()
        // again while the first asynchronous observation is still running.
        if (this._started)
            return;
        this._started = true;
        const run = () => this.runChecks()
            .then(() => console.log('RUNTIME-ACCEPTANCE result: pass'))
            .catch(error => console.log(`RUNTIME-ACCEPTANCE result: fail: ${error}\n${error.stack}`))
            .finally(() => console.log('RUNTIME-ACCEPTANCE done'));
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', run, this);
        else
            run();
    }

    disable() {
        Main.layoutManager.disconnectObject(this);
    }

    async runChecks() {
        const uuid = GLib.getenv('RUNTIME_EXTENSION_UUID');
        const manager = Main.extensionManager;
        const extension = () => manager.lookup(uuid);
        const state = async expected => {
            for (let i = 0; i < 50; i++) {
                if (extension()?.state === expected)
                    return;
                // loadExtension uses ERROR provisionally while awaiting its
                // module import. A nonempty error is an actual load failure.
                if (extension()?.state === 3 && extension()?.error)
                    throw new Error(`Extension failed: ${extension().error}`);
                await wait(100);
            }
            throw new Error(`Extension state ${extension()?.state}, expected ${expected}: ${extension()?.error}`);
        };
        await state(1);
        Main.overview.hide();
        await exercise(extension().stateObj, {wait, expect, phase: 'initial'});
        manager.disableExtension(uuid);
        await state(2);
        await disabled({wait, expect});
        manager.enableExtension(uuid);
        await state(1);
        await exercise(extension().stateObj, {wait, expect, phase: 'reenabled'});
        console.log(`RUNTIME-ACCEPTANCE ${uuid}: loaded, exercised, disabled and exercised again`);
    }
}

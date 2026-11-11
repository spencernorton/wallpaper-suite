import GLib from 'gi://GLib';
import System from 'system';
import {WallpaperManager} from './service.js';

try {
    // GLibUnix is separately introspected on newer GLib releases. Keep the
    // service entry point usable with the older supported GNOME packages too.
    let signalAdd;
    try { signalAdd = imports.gi.GLibUnix.signal_add; }
    catch (_) { signalAdd = GLib.unix_signal_add; }
    const loop = new GLib.MainLoop(null, false);
    const manager = new WallpaperManager({onStopped: () => loop.quit()});
    for (const signal of [2, 15]) signalAdd(GLib.PRIORITY_DEFAULT, signal, () => {
        manager.stop(); loop.quit(); return GLib.SOURCE_REMOVE;
    });
    manager.start(); loop.run();
} catch (error) { printerr(`${error.message || error}`); System.exit(1); }

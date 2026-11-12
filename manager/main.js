import GLib from 'gi://GLib';
import System from 'system';
import {WallpaperManager} from './service.js';

try {
    // GLibUnix is separately introspected on newer GLib releases. Keep the
    // service entry point usable with the older supported GNOME packages too.
    let signalAdd;
    try {
        const unix = imports.gi.GLibUnix;
        signalAdd = typeof unix.signal_add === 'function' ? unix.signal_add : unix.signal_add_full;
    }
    catch (_) {}
    if (typeof signalAdd !== 'function') signalAdd = GLib.unix_signal_add;
    if (typeof signalAdd !== 'function') throw new Error('Unix signal callbacks are unavailable');
    const loop = new GLib.MainLoop(null, false);
    const manager = new WallpaperManager({onStopped: () => loop.quit()});
    for (const signal of [2, 15]) signalAdd(GLib.PRIORITY_DEFAULT, signal, () => {
        manager.stop(); loop.quit(); return GLib.SOURCE_REMOVE;
    });
    manager.start(); loop.run();
} catch (error) { printerr(`${error.message || error}`); System.exit(1); }

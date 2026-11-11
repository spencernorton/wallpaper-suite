#!/usr/bin/gjs -m
import GLib from 'gi://GLib';
import System from 'system';
import {WallpaperManager} from './service.js';

try {
    const loop = new GLib.MainLoop(null, false);
    const manager = new WallpaperManager({onStopped: () => loop.quit()});
    for (const signal of [2, 15]) GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
        manager.stop(); loop.quit(); return GLib.SOURCE_REMOVE;
    });
    manager.start(); loop.run();
} catch (error) { printerr(`${error.message || error}`); System.exit(1); }

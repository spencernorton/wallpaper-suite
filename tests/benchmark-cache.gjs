#!/usr/bin/gjs -m
// Manual benchmark. Reads current assignments but renders only into the
// caller-provided isolated cache directory; it never changes desktop settings.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Compositor} from '../compositor.js';

const root = ARGV[0] || GLib.get_current_dir();
const cacheDir = ARGV[1] || GLib.build_filenamev([GLib.get_tmp_dir(), 'wallpaper-suite-benchmark']);
const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.wallpaper-suite'});
const assignments = settings.get_value('monitor-assignments').deep_unpack();
const modes = settings.get_value('monitor-modes').deep_unpack();
const quality = settings.get_int('composite-quality');
const monitors = Object.keys(assignments).map(connector => {
    const match = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(connector);
    if (!match)
        throw new Error(`Cannot parse monitor geometry key: ${connector}`);
    return {
        connector,
        width: Number(match[1]),
        height: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4]),
    };
});

GLib.mkdir_with_parents(cacheDir, 0o700);
const compositor = new Compositor(root, {cacheDir});
const loop = new GLib.MainLoop(null, false);
let completed = false;
let waiting = false;
compositor.compositeAsync(monitors, assignments, modes, quality, result => {
    print(JSON.stringify(result));
    completed = true;
    if (waiting)
        loop.quit();
});
if (!completed) {
    waiting = true;
    loop.run();
}
compositor.dispose();

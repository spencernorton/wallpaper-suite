#!/usr/bin/gjs -m

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Linux-only integration fixture: terminate this worker with SIGTERM so the
// parent exercises Gio.Subprocess' signalled (not normally exited) state.
const pid = GLib.file_read_link('/proc/self');
const killer = Gio.Subprocess.new(
    ['/bin/kill', '-TERM', pid],
    Gio.SubprocessFlags.NONE);
killer.wait(null);
new GLib.MainLoop(null, false).run();

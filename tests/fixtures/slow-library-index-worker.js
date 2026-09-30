#!/usr/bin/gjs -m

import GLib from 'gi://GLib';

const job = JSON.parse(ARGV[0]);
GLib.usleep(350000);
print(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    code: 'indexed-with-errors',
    message: 'synthetic degraded watcher result',
    generation: job.generation,
    root: job.root,
    files: [],
    directories: [job.root],
    errors: [],
    watcher: {
        degraded: true,
        directories: [],
        errors: [{
            path: job.root,
            code: 'watch-unavailable',
            message: 'synthetic watch exhaustion',
        }],
    },
    truncated: false,
    durationMs: 350,
}));

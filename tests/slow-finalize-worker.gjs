#!/usr/bin/gjs -m
// Test double: finalizes an output, then deliberately delays process exit so
// cancellation can exercise the post-rename/pre-callback cleanup window.

import GLib from 'gi://GLib';
import System from 'system';

const job = JSON.parse(ARGV[0]);
GLib.file_set_contents(job.outPath, 'finalized-but-not-reported');
GLib.usleep(2_000_000);
print(JSON.stringify({
    ok: true,
    code: 'rendered',
    path: job.outPath,
    generation: job.generation,
}));
System.exit(0);

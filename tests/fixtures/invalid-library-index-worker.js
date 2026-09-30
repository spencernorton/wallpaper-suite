#!/usr/bin/gjs -m

const job = JSON.parse(ARGV[0]);
print(JSON.stringify({
    schemaVersion: 1,
    ok: true,
    code: 'indexed',
    message: '',
    generation: job.generation,
    root: job.root,
    files: [{
        path: `${job.root}/image.png`,
        name: 'mismatched-name.png',
        relativePath: 'image.png',
        size: -1,
        mtimeSec: 1,
        mtimeUsec: 0,
        contentType: 'image/png',
        width: 10,
        height: 10,
    }],
    directories: [job.root],
    errors: [],
    watcher: {
        degraded: false,
        directories: [job.root],
        errors: [],
    },
    truncated: false,
    durationMs: 1,
}));

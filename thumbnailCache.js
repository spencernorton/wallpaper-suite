// Bounded, cancellable thumbnail generation backed by an on-disk cache.
//
// Full-size image decoding happens in thumbnail-worker.js subprocesses, never
// in the preferences process. Only the small cached PNG is loaded by GTK.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

const CACHE_VERSION = 'v2';
const DEFAULT_CONCURRENCY = 2;
const MAX_CACHE_FILES = 512;
const THUMBNAIL_TEMP_MAX_AGE_USEC = 24 * 60 * 60 * 1e6;
const UUID_PATTERN = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const THUMBNAIL_TEMP_RE = new RegExp(
    `^[a-f0-9]{64}\\.png\\.tmp-${UUID_PATTERN}$`);

export function thumbnailCacheDir() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'wallpaper-suite',
        'thumbnails',
    ]);
}

export function fileFingerprint(path) {
    const info = Gio.File.new_for_path(path).query_info(
        'standard::size,time::modified,time::modified-usec,etag::value',
        Gio.FileQueryInfoFlags.NONE,
        null);
    return _infoFingerprint(info);
}

function _infoFingerprint(info) {
    const seconds = info.get_attribute_uint64('time::modified');
    const usec = info.get_attribute_uint32('time::modified-usec');
    const etag = info.get_attribute_string('etag::value') || '';
    return `${seconds}.${usec}:${info.get_size()}:${etag}`;
}

/** Build the same cache identity from the off-main-loop library index. */
export function indexedFileFingerprint(record) {
    const seconds = Number(record?.mtimeSec);
    const usec = Number(record?.mtimeUsec);
    const size = Number(record?.size);
    if (!Number.isSafeInteger(seconds) || seconds < 0 ||
        !Number.isSafeInteger(usec) || usec < 0 || usec > 999999 ||
        !Number.isSafeInteger(size) || size < 0)
        return null;
    // The worker does not request an etag: local size+mtime is sufficient and
    // avoids a synchronous source-file stat for every visible picker tile.
    return `${seconds}.${usec}:${size}:`;
}

export function thumbnailCacheKey(path, fingerprint, width, height, preview = null) {
    // Do not use NUL separators here: GLib's -1 length follows C-string
    // semantics and would hash only the version prefix before the first NUL.
    const fields = [CACHE_VERSION, path, fingerprint, `${width}x${height}`];
    if (preview)
        fields.push(JSON.stringify([preview.mode, preview.monitorWidth, preview.monitorHeight]));
    const input = fields.join('\x1f');
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, input, -1);
}

export function thumbnailPath(path, fingerprint, width, height, cacheDir = null, preview = null) {
    const dir = cacheDir || thumbnailCacheDir();
    return GLib.build_filenamev([
        dir,
        `${thumbnailCacheKey(path, fingerprint, width, height, preview)}.png`,
    ]);
}

export class ThumbnailLoader {
    constructor(workerPath, options = {}) {
        this._workerPath = workerPath;
        this._width = options.width || 192;
        this._height = options.height || 108;
        this._preview = options.preview || null;
        this._concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
        this._cacheDir = options.cacheDir || thumbnailCacheDir();
        this._gjs = options.gjs || GLib.find_program_in_path('gjs') || '/usr/bin/gjs';
        this._pending = [];
        this._active = new Map();
        this._cancelled = false;
        this._cancellable = new Gio.Cancellable();
        GLib.mkdir_with_parents(this._cacheDir, 0o700);
    }

    enqueue(path, onComplete, fingerprintHint = null) {
        if (this._cancelled)
            return;
        if (typeof fingerprintHint === 'string' && fingerprintHint) {
            this._enqueueKnown(path, onComplete, fingerprintHint);
            return;
        }
        // Source metadata can live on a slow mount. It belongs in asynchronous
        // I/O just like image decoding, including for per-monitor previews.
        Gio.File.new_for_path(path).query_info_async(
            'standard::size,time::modified,time::modified-usec,etag::value',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable,
            (file, result) => {
                if (this._cancelled)
                    return;
                try {
                    this._enqueueKnown(path, onComplete, _infoFingerprint(file.query_info_finish(result)));
                } catch (error) {
                    this._later(() => onComplete({path, error}));
                }
            });
    }

    _enqueueKnown(path, onComplete, fingerprint) {
        if (this._cancelled)
            return;
        let outputPath;
        try {
            outputPath = thumbnailPath(
                path, fingerprint, this._width, this._height, this._cacheDir, this._preview);
        } catch (error) {
            this._later(() => onComplete({path, error}));
            return;
        }

        if (GLib.file_test(outputPath, GLib.FileTest.IS_REGULAR)) {
            if (this._thumbnailValid(outputPath)) {
                this._later(() => onComplete({path, outputPath, cached: true}));
                return;
            }
            try { GLib.unlink(outputPath); } catch (_) {}
        }

        this._pending.push({path, outputPath, onComplete});
        this._drain();
    }

    cancel() {
        if (this._cancelled)
            return;
        this._cancelled = true;
        this._pending = [];
        this._cancellable.cancel();
        for (const [process, item] of this._active.entries()) {
            this._unlinkExact(item.tempPath);
            try {
                process.force_exit();
            } catch (_) {
                // It may have exited between iteration and force_exit().
            }
        }
        this._active.clear();
    }

    _later(callback) {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (!this._cancelled)
                callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _drain() {
        while (!this._cancelled &&
               this._active.size < this._concurrency &&
               this._pending.length > 0) {
            const item = this._pending.shift();
            this._start(item);
        }
    }

    _start(item) {
        let process;
        item.tempPath = `${item.outputPath}.tmp-${GLib.uuid_string_random()}`;
        try {
            const argv = [
                this._gjs,
                '-m',
                this._workerPath,
                item.path,
                item.outputPath,
                item.tempPath,
                `${this._width}`,
                `${this._height}`,
            ];
            if (this._preview)
                argv.push(JSON.stringify(this._preview));
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            this._unlinkExact(item.tempPath);
            this._later(() => item.onComplete({path: item.path, error}));
            return;
        }

        this._active.set(process, item);
        process.communicate_utf8_async(null, this._cancellable, (proc, result) => {
            this._active.delete(process);
            this._unlinkExact(item.tempPath);
            if (this._cancelled)
                return;

            let error = null;
            try {
                const [, , stderr] = proc.communicate_utf8_finish(result);
                if (!proc.get_successful() ||
                    !GLib.file_test(item.outputPath, GLib.FileTest.IS_REGULAR)) {
                    error = new Error((stderr || 'Thumbnail worker failed').trim());
                } else if (!this._thumbnailValid(item.outputPath)) {
                    error = new Error('Thumbnail worker produced an invalid image');
                    try { GLib.unlink(item.outputPath); } catch (_) {}
                }
            } catch (caught) {
                error = caught;
            }

            try {
                item.onComplete({
                    path: item.path,
                    outputPath: error ? null : item.outputPath,
                    cached: false,
                    error,
                });
            } catch (callbackError) {
                logError(callbackError, 'wallpaper-suite: thumbnail callback failed');
            } finally {
                this._drain();
            }
        });
    }

    _thumbnailValid(path) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
            return pixbuf.get_width() === this._width &&
                pixbuf.get_height() === this._height;
        } catch (_) {
            return false;
        }
    }

    _unlinkExact(path) {
        if (!path)
            return;
        try { GLib.unlink(path); } catch (_) {}
    }
}

export function pruneThumbnailCache(cacheDir = null, maxFiles = MAX_CACHE_FILES) {
    const dirPath = cacheDir || thumbnailCacheDir();
    const entries = [];
    const staleTemps = [];
    const nowUsec = GLib.get_real_time();
    try {
        const dir = Gio.File.new_for_path(dirPath);
        const enumerator = dir.enumerate_children(
            'standard::name,time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const modified = Number(info.get_attribute_uint64('time::modified')) * 1e6 +
                info.get_attribute_uint32('time::modified-usec');
            if (THUMBNAIL_TEMP_RE.test(name)) {
                if (nowUsec >= modified &&
                    nowUsec - modified >= THUMBNAIL_TEMP_MAX_AGE_USEC) {
                    staleTemps.push(GLib.build_filenamev([dirPath, name]));
                }
                continue;
            }
            if (!/^[a-f0-9]{64}\.png$/.test(name))
                continue;
            entries.push({
                path: GLib.build_filenamev([dirPath, name]),
                modified,
            });
        }
        enumerator.close(null);
    } catch (_) {
        return;
    }

    entries.sort((a, b) => b.modified - a.modified);
    for (const path of [
        ...staleTemps,
        ...entries.slice(Math.max(0, maxFiles)).map(entry => entry.path),
    ]) {
        try {
            GLib.unlink(path);
        } catch (_) {
            // Best-effort cache maintenance; stale files are harmless.
        }
    }
}

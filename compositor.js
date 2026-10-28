// Composites per-monitor images into one spanned JPEG. Heavy rendering is
// delegated to compositor-worker.js so GNOME Shell's main loop stays fluid.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

import {VALID_MODES, drawIntoRect} from './pixbufModes.js';
import {computeCanvasBounds, translateMonitor} from './runtimeCore.js';
import {pruneManagedCache} from './cacheJanitor.js';

const CACHE_SIDECAR_VERSION = 1;
const CACHE_FULL_VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function _result(overrides = {}) {
    return {
        ok: false,
        path: null,
        code: 'unknown',
        message: '',
        generation: 0,
        cacheHit: false,
        durationMs: 0,
        ...overrides,
    };
}

function _subprocessFailureMessage(process, stderr) {
    const detail = (stderr || '').trim();
    if (detail)
        return detail;
    if (process.get_if_signaled())
        return `Worker terminated by signal ${process.get_term_sig()}`;
    if (process.get_if_exited())
        return `Worker exited with status ${process.get_exit_status()}`;
    return 'Worker did not complete successfully';
}

export class Compositor {
    /**
     * @param {string} [extensionPath] absolute extension directory
     * @param {{cacheDir?: string, workerPath?: string, gjsPath?: string}} [options]
     */
    constructor(extensionPath = null, options = {}) {
        this._cacheDir = options.cacheDir ||
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'wallpaper-suite']);
        GLib.mkdir_with_parents(this._cacheDir, 0o700);
        try { GLib.chmod(this._cacheDir, 0o700); } catch (_) {}

        this._extensionPath = extensionPath;
        this._workerPath = options.workerPath || (extensionPath
            ? GLib.build_filenamev([extensionPath, 'compositor-worker.js'])
            : null);
        this._gjs = options.gjsPath || GLib.find_program_in_path('gjs') || '/usr/bin/gjs';
        this._nice = GLib.find_program_in_path('nice');
        this._sessionId = GLib.uuid_string_random();
        this._generation = 0;
        this._active = null;
        this._queued = null;
        this._disposed = false;
    }

    get cacheDir() {
        return this._cacheDir;
    }

    get generation() {
        return this._generation;
    }

    get busy() {
        return Boolean(this._active || this._queued);
    }

    /**
     * Render a complete monitor assignment off the Shell main loop.
     *
     * The callback always receives a structured result. Calls are last-wins:
     * an in-flight worker is cancelled and its exact temporary file removed
     * before the newest request is run.
     */
    compositeAsync(monitors, assignments, modes, jpegQuality, options, onDone) {
        if (typeof options === 'function') {
            onDone = options;
            options = {};
        }
        options ||= {};
        onDone ||= () => {};

        const generation = ++this._generation;
        const startedUs = GLib.get_monotonic_time();
        const request = {
            generation,
            startedUs,
            onDone,
            done: false,
            job: null,
            background: options.background === true,
        };

        if (this._disposed) {
            this._finish(request, _result({
                code: 'disposed',
                message: 'Compositor has been disposed',
                generation,
            }));
            return generation;
        }

        const validation = this._validateRequest(monitors, assignments);
        if (!validation.ok) {
            this._supersedePending('superseded');
            this._finish(request, _result({...validation, generation}));
            return generation;
        }

        const resolved = this._resolve(
            monitors,
            assignments,
            modes,
            jpegQuality,
            generation,
            options.force === true
        );
        if (!resolved) {
            this._supersedePending('superseded');
            this._finish(request, _result({
                code: 'invalid-geometry',
                message: 'Monitor layout has invalid or non-positive bounds',
                generation,
            }));
            return generation;
        }

        const trustedPath = options.force !== true
            ? this._findTrustedCache(resolved, options.preferredPaths)
            : null;
        if (trustedPath) {
            this._supersedePending('superseded');
            this._finish(request, _result({
                ok: true,
                path: trustedPath,
                code: 'cache-hit',
                generation,
                cacheHit: true,
            }));
            return generation;
        }

        // Cache hits are validated in the worker, not trusted merely because a
        // regular file exists. If decode/dimensions fail, the same worker
        // renders a UUID-scoped repair output while the old URI remains intact.
        const cachePath = resolved.exists && options.force !== true
            ? resolved.outPath
            : null;
        const outputPath = (cachePath || options.force === true)
            ? this._forcedOutputPath(resolved.signature, generation)
            : resolved.outPath;
        const tempPath = `${outputPath}.tmp.${this._sessionId}.${generation}`;
        const sidecarPath = this._sidecarPath(outputPath);
        request.job = {
            monitors,
            assignments,
            modes,
            quality: jpegQuality,
            outPath: outputPath,
            tempPath,
            generation,
            signature: resolved.signature,
            cachePath,
            cacheSidecarPath: cachePath ? this._sidecarPath(cachePath) : null,
            cacheSidecarTempPath: cachePath
                ? `${this._sidecarPath(cachePath)}.tmp.${this._sessionId}.${generation}`
                : null,
            sidecarPath,
            sidecarTempPath: `${sidecarPath}.tmp.${this._sessionId}.${generation}`,
            expectedWidth: resolved.bounds.width,
            expectedHeight: resolved.bounds.height,
        };

        if (this._queued)
            this._cancelRequest(this._queued, 'superseded', 'A newer render replaced this request');
        this._queued = request;

        if (this._active)
            this._cancelActive('superseded', 'A newer render replaced this request');
        else
            this._drainQueue();

        return generation;
    }

    _spawnWorker(request) {
        if (!this._workerPath) {
            this._queued = null;
            this._finish(request, _result({
                code: 'worker-unavailable',
                message: 'No compositor worker path is configured',
                generation: request.generation,
            }));
            this._drainQueue();
            return;
        }

        let proc;
        try {
            const command = [this._gjs, '-m', this._workerPath, JSON.stringify(request.job)];
            if (request.background && this._nice)
                command.unshift(this._nice, '-n', '10');
            proc = Gio.Subprocess.new(
                command,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._queued = null;
            this._finish(request, _result({
                code: 'spawn-failed',
                message: String(error),
                generation: request.generation,
            }));
            this._drainQueue();
            return;
        }

        this._queued = null;
        const cancellable = new Gio.Cancellable();
        this._active = {request, proc, cancellable};

        proc.communicate_utf8_async(null, cancellable, (process, asyncResult) => {
            const active = this._active;
            if (active?.request === request)
                this._active = null;

            let stdout = '';
            let stderr = '';
            let waitError = null;
            try {
                const [, out, err] = process.communicate_utf8_finish(asyncResult);
                stdout = out || '';
                stderr = err || '';
            } catch (error) {
                waitError = error;
            }

            this._unlinkExact(request.job?.tempPath);
            this._unlinkExact(request.job?.sidecarTempPath);
            this._unlinkExact(request.job?.cacheSidecarTempPath);

            if (!request.done) {
                if (request.generation !== this._generation || this._disposed) {
                    this._cancelRequest(request, 'stale', 'Render completed after it was superseded');
                } else if (waitError) {
                    this._finish(request, _result({
                        code: 'worker-wait-failed',
                        message: String(waitError),
                        generation: request.generation,
                    }));
                } else {
                    let workerResult = null;
                    try {
                        const line = stdout.trim().split('\n').filter(Boolean).at(-1);
                        workerResult = line ? JSON.parse(line) : null;
                    } catch (_) {}

                    const resultPath = workerResult?.path || null;
                    const allowedPaths = new Set([
                        request.job.outPath,
                        request.job.cachePath,
                    ].filter(Boolean));
                    if (process.get_successful() && workerResult?.ok === true &&
                        allowedPaths.has(resultPath) &&
                        GLib.file_test(resultPath, GLib.FileTest.IS_REGULAR)) {
                        this._finish(request, _result({
                            ...workerResult,
                            ok: true,
                            path: resultPath,
                            code: workerResult.code || 'rendered',
                            generation: request.generation,
                        }));
                    } else {
                        this._finish(request, _result({
                            code: workerResult?.code || 'worker-failed',
                            message: workerResult?.message ||
                                _subprocessFailureMessage(process, stderr),
                            generation: request.generation,
                        }));
                    }
                }
            } else {
                // A force/cache-repair worker may have completed its atomic
                // move immediately before cancellation reached the main loop.
                // Reap only this instance+generation's UUID-scoped output.
                this._cleanupAbandonedOutput(request);
            }
            this._drainQueue();
        });
    }

    _drainQueue() {
        if (this._disposed || this._active || !this._queued)
            return;
        const request = this._queued;
        if (request.done) {
            this._queued = null;
            this._drainQueue();
            return;
        }
        this._spawnWorker(request);
    }

    _finish(request, result) {
        if (request.done)
            return;
        request.done = true;
        result.durationMs = Math.max(0,
            Math.round((GLib.get_monotonic_time() - request.startedUs) / 1000));
        try {
            request.onDone(result);
        } catch (error) {
            logError(error, 'wallpaper-suite: render completion callback failed');
        }
    }

    _cancelRequest(request, code, message) {
        if (!request)
            return;
        this._unlinkExact(request.job?.tempPath);
        this._unlinkExact(request.job?.sidecarTempPath);
        this._unlinkExact(request.job?.cacheSidecarTempPath);
        this._cleanupAbandonedOutput(request);
        this._finish(request, _result({
            code,
            message,
            generation: request.generation,
        }));
    }

    _cancelActive(code, message) {
        const active = this._active;
        if (!active)
            return;
        this._cancelRequest(active.request, code, message);
        try { active.cancellable.cancel(); } catch (_) {}
        try { active.proc.force_exit(); } catch (_) {}
    }

    _supersedePending(code) {
        if (this._queued) {
            this._cancelRequest(this._queued, code, 'A newer render replaced this request');
            this._queued = null;
        }
        if (this._active)
            this._cancelActive(code, 'A newer render replaced this request');
    }

    /** Cancel one queued/active generation without disposing the compositor. */
    cancel(generation = null) {
        let cancelled = false;
        if (this._queued &&
            (generation === null || this._queued.generation === generation)) {
            this._cancelRequest(
                this._queued,
                'cancelled',
                'Render was cancelled before publication'
            );
            this._queued = null;
            cancelled = true;
        }
        if (this._active &&
            (generation === null || this._active.request.generation === generation)) {
            this._cancelActive('cancelled', 'Render was cancelled before publication');
            cancelled = true;
        }
        return cancelled;
    }

    /** Cancel all workers and guarantee that no later callback can publish. */
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._generation++;
        if (this._queued) {
            this._cancelRequest(this._queued, 'cancelled', 'Compositor was disposed');
            this._queued = null;
        }
        this._cancelActive('cancelled', 'Compositor was disposed');
    }

    _validateRequest(monitors, assignments) {
        const bounds = computeCanvasBounds(monitors);
        if (!bounds)
            return {ok: false, code: 'invalid-geometry', message: 'Invalid monitor geometry'};

        for (const monitor of monitors) {
            const path = assignments?.[monitor.connector];
            if (!path)
                return {
                    ok: false,
                    code: 'missing-assignment',
                    message: `No wallpaper is assigned to monitor ${monitor.connector}`,
                };
            try {
                const info = Gio.File.new_for_path(path).query_info(
                    'standard::type,standard::size',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                if (info.get_file_type() !== Gio.FileType.REGULAR || info.get_size() <= 0)
                    throw new Error('not a non-empty regular file');
            } catch (error) {
                return {
                    ok: false,
                    code: 'source-unavailable',
                    message: `Wallpaper for ${monitor.connector} is unavailable: ${error}`,
                };
            }
        }
        return {ok: true, bounds};
    }

    _resolve(monitors, assignments, modes, jpegQuality, generation, force) {
        const bounds = computeCanvasBounds(monitors);
        if (!bounds)
            return null;
        const signature = this._signature(monitors, assignments, modes, jpegQuality);
        const outPath = GLib.build_filenamev([
            this._cacheDir,
            `composite-${signature}.jpg`,
        ]);
        return {
            signature,
            bounds,
            outPath,
            exists: GLib.file_test(outPath, GLib.FileTest.IS_REGULAR),
        };
    }

    _forcedOutputPath(signature, generation) {
        return GLib.build_filenamev([
            this._cacheDir,
            `composite-${signature}-refresh-${this._sessionId}-${generation}.jpg`,
        ]);
    }

    /**
     * Synchronous compatibility path used by diagnostics/tests. It preflights
     * and decodes every monitor before drawing anything, and finalizes via an
     * atomic rename. Shell runtime should use compositeAsync().
     */
    composite(monitors, assignments, modes, jpegQuality = 92) {
        const validation = this._validateRequest(monitors, assignments);
        if (!validation.ok)
            return null;

        const resolved = this._resolve(monitors, assignments, modes, jpegQuality, 0, false);
        if (!resolved)
            return null;
        if (resolved.exists)
            return resolved.outPath;

        const decoded = [];
        try {
            for (const monitor of monitors) {
                decoded.push({
                    monitor,
                    source: GdkPixbuf.Pixbuf.new_from_file(assignments[monitor.connector]),
                    mode: VALID_MODES.has(modes?.[monitor.connector])
                        ? modes[monitor.connector]
                        : 'zoom',
                });
            }
        } catch (error) {
            logError(error, 'wallpaper-suite: source preflight failed');
            return null;
        }

        let destination;
        try {
            destination = GdkPixbuf.Pixbuf.new(
                GdkPixbuf.Colorspace.RGB,
                false,
                8,
                validation.bounds.width,
                validation.bounds.height
            );
            destination.fill(0x000000ff);
            for (const item of decoded) {
                const translated = translateMonitor(item.monitor, validation.bounds);
                drawIntoRect(
                    destination,
                    item.source,
                    translated.drawX,
                    translated.drawY,
                    item.monitor.width,
                    item.monitor.height,
                    item.mode
                );
            }
        } catch (error) {
            logError(error, 'wallpaper-suite: composite draw failed');
            return null;
        }

        const tempPath = `${resolved.outPath}.tmp.${this._sessionId}.sync`;
        try {
            destination.savev(tempPath, 'jpeg', ['quality'], [String(jpegQuality)]);
            Gio.File.new_for_path(tempPath).move(
                Gio.File.new_for_path(resolved.outPath),
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );
            return resolved.outPath;
        } catch (error) {
            this._unlinkExact(tempPath);
            logError(error, 'wallpaper-suite: failed to finalize composite');
            return null;
        }
    }

    /** Hash every input that affects output bytes, with sub-second metadata. */
    _signature(monitors, assignments, modes, jpegQuality) {
        const parts = [`format=2`, `q=${jpegQuality}`];
        const sorted = [...monitors].sort((a, b) => a.connector.localeCompare(b.connector));
        for (const monitor of sorted) {
            const path = assignments?.[monitor.connector] || '';
            const mode = VALID_MODES.has(modes?.[monitor.connector])
                ? modes[monitor.connector]
                : 'zoom';
            let metadata = 'missing';
            if (path) {
                try {
                    const info = Gio.File.new_for_path(path).query_info(
                        'standard::size,time::modified,time::modified-usec,id::file',
                        Gio.FileQueryInfoFlags.NONE,
                        null
                    );
                    metadata = [
                        info.get_size(),
                        info.get_attribute_uint64('time::modified'),
                        info.get_attribute_uint32('time::modified-usec'),
                        info.get_attribute_string('id::file') || '',
                    ].join(':');
                } catch (_) {}
            }
            parts.push(
                `${monitor.connector}|${monitor.x},${monitor.y},${monitor.width},${monitor.height}` +
                `|${mode}|${path}|${metadata}`
            );
        }
        return GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            parts.join('\n'),
            -1
        ).slice(0, 32);
    }

    /** Age-prune only exact managed files that are not active or in flight. */
    pruneCache(protectedPaths = new Set(), options = {}) {
        const protectedSet = protectedPaths instanceof Set
            ? new Set(protectedPaths)
            : new Set(protectedPaths || []);
        const protectJob = job => {
            for (const path of [
                job?.outPath,
                job?.tempPath,
                job?.sidecarPath,
                job?.sidecarTempPath,
                job?.cachePath,
                job?.cacheSidecarPath,
                job?.cacheSidecarTempPath,
            ]) {
                if (path)
                    protectedSet.add(path);
            }
        };
        protectJob(this._active?.request?.job);
        protectJob(this._queued?.job);
        return pruneManagedCache(this._cacheDir, protectedSet, options);
    }

    /**
     * Delete only explicitly named old composites after URI publication.
     * `protectedPaths` must contain every file still referenced by light,
     * dark, and lock-screen settings. No directory globbing occurs here.
     */
    releaseObsolete(candidatePaths, protectedPaths = new Set()) {
        const protectedSet = protectedPaths instanceof Set
            ? protectedPaths
            : new Set(protectedPaths || []);
        const inFlight = new Set([
            this._active?.request?.job?.outPath,
            this._queued?.job?.outPath,
        ].filter(Boolean));
        for (const path of new Set(candidatePaths || [])) {
            if (!path || protectedSet.has(path) || inFlight.has(path) || !this._isManagedOutput(path))
                continue;
            this._unlinkExact(path);
            this._unlinkExact(this._sidecarPath(path));
        }
    }

    _isManagedOutput(path) {
        if (GLib.path_get_dirname(path) !== this._cacheDir)
            return false;
        // Eight hex characters is the v1.1 legacy signature. It is accepted
        // only for an exact path that was actually referenced by a URI, so the
        // first successful v1.2 publication can safely retire that old output.
        return /^composite-(?:[a-f0-9]{8}|[a-f0-9]{32}(?:-refresh-[a-f0-9-]+-\d+)?)\.jpg$/.test(
            GLib.path_get_basename(path)
        );
    }

    _cleanupAbandonedOutput(request) {
        const path = request?.job?.outPath;
        if (!path)
            return;
        const expectedSuffix = `-refresh-${this._sessionId}-${request.generation}.jpg`;
        if (GLib.path_get_dirname(path) === this._cacheDir && path.endsWith(expectedSuffix)) {
            this._unlinkExact(path);
            this._unlinkExact(this._sidecarPath(path));
        }
    }

    /**
     * Fast trusted-cache path. The cache directory is user-private (0700); an
     * atomic sidecar binds signature, dimensions, digest, and exact file stat.
     * We avoid decoding 25 MP on each no-op signal, while forcing a full worker
     * verification at least weekly or whenever metadata changes.
     */
    _fastCacheValid(resolved) {
        try {
            const sidecarPath = this._sidecarPath(resolved.outPath);
            const [, contents] = GLib.file_get_contents(sidecarPath);
            const sidecar = JSON.parse(new TextDecoder().decode(contents));
            const info = Gio.File.new_for_path(resolved.outPath).query_info(
                'standard::size,time::modified,time::modified-usec,id::file',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            const ageMs = Date.now() - Number(sidecar.verifiedAtMs || 0);
            return sidecar.schemaVersion === CACHE_SIDECAR_VERSION &&
                sidecar.signature === resolved.signature &&
                sidecar.outputFile === GLib.path_get_basename(resolved.outPath) &&
                sidecar.width === resolved.bounds.width &&
                sidecar.height === resolved.bounds.height &&
                sidecar.size === Number(info.get_size()) &&
                sidecar.mtimeSec === Number(info.get_attribute_uint64('time::modified')) &&
                sidecar.mtimeUsec === info.get_attribute_uint32('time::modified-usec') &&
                sidecar.fileId === (info.get_attribute_string('id::file') || '') &&
                typeof sidecar.sha256 === 'string' && /^[a-f0-9]{64}$/.test(sidecar.sha256) &&
                ageMs >= 0 && ageMs <= CACHE_FULL_VERIFY_INTERVAL_MS;
        } catch (_) {
            return false;
        }
    }

    _findTrustedCache(resolved, preferredPaths = []) {
        if (resolved.exists && this._fastCacheValid(resolved))
            return resolved.outPath;

        // A forced refresh or corruption repair intentionally publishes a
        // UUID-scoped filename. The extension passes only its three active URI
        // paths here, allowing that exact last-good generation to remain the
        // fast cache without a directory scan or mutable global index.
        for (const path of new Set(preferredPaths || [])) {
            if (!path || path === resolved.outPath || !this._isManagedOutput(path) ||
                !GLib.file_test(path, GLib.FileTest.IS_REGULAR))
                continue;
            const candidate = {...resolved, outPath: path, exists: true};
            if (this._fastCacheValid(candidate))
                return path;
        }
        return null;
    }

    _sidecarPath(outputPath) {
        return `${outputPath}.meta.json`;
    }

    _unlinkExact(path) {
        if (!path)
            return;
        try { GLib.unlink(path); } catch (_) {}
    }
}

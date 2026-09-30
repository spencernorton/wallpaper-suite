// Async, generation-aware controller for library-index-worker.js.
//
// The public process never enumerates the wallpaper library. Every scan runs
// in a disposable GJS subprocess and returns a structured JSON snapshot.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const LIBRARY_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_INDEX_TIMEOUT_MS = 15000;

const DEFAULT_MAX_FILES = 25000;
const HARD_MAX_FILES = 100000;
const DEFAULT_MAX_DIRECTORIES = 1024;
const HARD_MAX_DIRECTORIES = 10000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;

function _boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function _baseResult(overrides = {}) {
    return {
        schemaVersion: LIBRARY_INDEX_SCHEMA_VERSION,
        ok: false,
        code: 'unknown',
        message: '',
        generation: 0,
        root: '',
        files: [],
        directories: [],
        errors: [],
        watcher: {
            degraded: false,
            directories: [],
            errors: [],
        },
        truncated: false,
        durationMs: 0,
        ...overrides,
    };
}

function _workerFailureMessage(process, stderr) {
    const detail = `${stderr || ''}`.trim();
    if (detail)
        return detail;
    if (process.get_if_signaled())
        return `Library index worker terminated by signal ${process.get_term_sig()}`;
    if (process.get_if_exited())
        return `Library index worker exited with status ${process.get_exit_status()}`;
    return 'Library index worker did not complete successfully';
}

function _moduleDirectory() {
    return Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
}

function _isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function _isCanonicalPathWithinRoot(path, root, allowRoot = true) {
    if (typeof path !== 'string' || !GLib.path_is_absolute(path) ||
        GLib.canonicalize_filename(path, null) !== path)
        return false;
    if (allowRoot && path === root)
        return true;
    const prefix = root === GLib.DIR_SEPARATOR_S
        ? root
        : `${root}${GLib.DIR_SEPARATOR_S}`;
    return path !== root && path.startsWith(prefix);
}

function _isStrictlySorted(items, key) {
    for (let index = 1; index < items.length; index++) {
        if (key(items[index - 1]) >= key(items[index]))
            return false;
    }
    return true;
}

function _validErrorRecord(error, root) {
    return error && typeof error === 'object' &&
        _isCanonicalPathWithinRoot(error.path, root) &&
        typeof error.code === 'string' && error.code.length > 0 &&
        typeof error.message === 'string';
}

function _validFileRecord(file, root) {
    if (!file || typeof file !== 'object' ||
        !_isCanonicalPathWithinRoot(file.path, root, false) ||
        typeof file.name !== 'string' || file.name.length === 0 ||
        typeof file.relativePath !== 'string' || file.relativePath.length === 0 ||
        file.name !== GLib.path_get_basename(file.path) ||
        file.relativePath !== file.path.slice(
            root === GLib.DIR_SEPARATOR_S ? 1 : root.length + 1) ||
        !_isNonNegativeInteger(file.size) ||
        !_isNonNegativeInteger(file.mtimeSec) ||
        !_isNonNegativeInteger(file.mtimeUsec) || file.mtimeUsec > 999999 ||
        typeof file.contentType !== 'string')
        return false;
    const validDimension = value => value === null ||
        (Number.isSafeInteger(value) && value > 0);
    return validDimension(file.width) && validDimension(file.height);
}

function _validWorkerResult(value, request) {
    if (!value || typeof value !== 'object' ||
        value.schemaVersion !== LIBRARY_INDEX_SCHEMA_VERSION ||
        Number(value.generation) !== request.generation ||
        typeof value.ok !== 'boolean' ||
        typeof value.code !== 'string' || value.code.length === 0 ||
        typeof value.message !== 'string' ||
        value.root !== request.root ||
        !Array.isArray(value.files) || value.files.length > request.maxFiles ||
        !Array.isArray(value.directories) ||
        value.directories.length > request.maxDirectories + 1 ||
        !Array.isArray(value.errors) ||
        typeof value.truncated !== 'boolean' ||
        !Number.isFinite(value.durationMs) || value.durationMs < 0 ||
        !value.watcher || typeof value.watcher !== 'object' ||
        typeof value.watcher.degraded !== 'boolean' ||
        !Array.isArray(value.watcher.directories) ||
        !Array.isArray(value.watcher.errors))
        return false;

    if (!value.files.every(file => _validFileRecord(file, value.root)) ||
        !_isStrictlySorted(value.files, file => file.path) ||
        !value.directories.every(path =>
            _isCanonicalPathWithinRoot(path, value.root)) ||
        !_isStrictlySorted(value.directories, path => path) ||
        !value.errors.every(error => _validErrorRecord(error, value.root)) ||
        !_isStrictlySorted(value.errors,
            error => `${error.path}\u001f${error.code}\u001f${error.message}`) ||
        !value.watcher.directories.every(path =>
            _isCanonicalPathWithinRoot(path, value.root)) ||
        !_isStrictlySorted(value.watcher.directories, path => path) ||
        !value.watcher.errors.every(error =>
            _validErrorRecord(error, value.root)) ||
        !_isStrictlySorted(value.watcher.errors,
            error => `${error.path}\u001f${error.code}\u001f${error.message}`) ||
        value.watcher.degraded !== (value.watcher.errors.length > 0))
        return false;

    if (value.ok && !value.directories.includes(value.root))
        return false;
    return true;
}

export class LibraryIndexer {
    /**
     * @param {string|null} extensionPath directory containing the worker
     * @param {{workerPath?: string, gjsPath?: string, timeoutMs?: number,
     *   maxFiles?: number, maxDirectories?: number,
     *   probeDimensions?: boolean}} options
     */
    constructor(extensionPath = null, options = {}) {
        const moduleDir = extensionPath || _moduleDirectory();
        this._workerPath = options.workerPath ||
            GLib.build_filenamev([moduleDir, 'library-index-worker.js']);
        this._gjs = options.gjsPath || GLib.find_program_in_path('gjs') || '/usr/bin/gjs';
        this._timeoutMs = _boundedInteger(
            options.timeoutMs,
            DEFAULT_INDEX_TIMEOUT_MS,
            MIN_TIMEOUT_MS,
            MAX_TIMEOUT_MS
        );
        this._maxFiles = _boundedInteger(
            options.maxFiles,
            DEFAULT_MAX_FILES,
            1,
            HARD_MAX_FILES
        );
        this._maxDirectories = _boundedInteger(
            options.maxDirectories,
            DEFAULT_MAX_DIRECTORIES,
            1,
            HARD_MAX_DIRECTORIES
        );
        this._probeDimensions = options.probeDimensions !== false;
        this._generation = 0;
        this._activeRequest = null;
        this._disposed = false;
    }

    get generation() {
        return this._generation;
    }

    get active() {
        return this._activeRequest !== null;
    }

    /**
     * Scan a local folder without blocking the caller's main loop.
     *
     * Calls are last-request-wins. A newer call completes the prior callback
     * once with `code: "superseded"`, then starts its own worker generation.
     *
     * @returns {number} request generation
     */
    scanAsync(folder, options, onDone) {
        if (typeof options === 'function') {
            onDone = options;
            options = {};
        }
        options ||= {};
        onDone ||= () => {};

        const previousRequest = this._activeRequest;
        const generation = ++this._generation;
        const request = {
            generation,
            root: typeof folder === 'string' ? folder : '',
            startedUs: GLib.get_monotonic_time(),
            onDone,
            done: false,
            process: null,
            cancellable: null,
            timeoutId: 0,
            idleId: 0,
        };
        // Publish the new generation before completing the old callback. A
        // superseded callback is allowed to call scanAsync() reentrantly; that
        // nested scan must be able to supersede this request instead of being
        // overwritten when the outer call resumes.
        this._activeRequest = request;
        if (previousRequest) {
            this._cancelRequest(
                previousRequest,
                'superseded',
                'A newer library scan replaced this request'
            );
        }
        if (request.done || this._activeRequest !== request ||
            this._generation !== generation)
            return generation;

        if (this._disposed) {
            this._finishLater(request, _baseResult({
                code: 'disposed',
                message: 'Library indexer has been disposed',
                generation,
                root: request.root,
            }));
            return generation;
        }

        if (!request.root || !GLib.path_is_absolute(request.root)) {
            this._finishLater(request, _baseResult({
                code: 'invalid-root',
                message: 'Library root must be an absolute local filesystem path',
                generation,
                root: request.root,
            }));
            return generation;
        }
        request.root = GLib.canonicalize_filename(request.root, null);

        const timeoutMs = _boundedInteger(
            options.timeoutMs,
            this._timeoutMs,
            MIN_TIMEOUT_MS,
            MAX_TIMEOUT_MS
        );
        const maxFiles = _boundedInteger(
            options.maxFiles,
            this._maxFiles,
            1,
            HARD_MAX_FILES
        );
        const maxDirectories = _boundedInteger(
            options.maxDirectories,
            this._maxDirectories,
            1,
            HARD_MAX_DIRECTORIES
        );
        request.maxFiles = maxFiles;
        request.maxDirectories = maxDirectories;
        const job = {
            schemaVersion: LIBRARY_INDEX_SCHEMA_VERSION,
            generation,
            root: request.root,
            maxFiles,
            maxDirectories,
            probeDimensions: options.probeDimensions ?? this._probeDimensions,
        };

        try {
            request.process = Gio.Subprocess.new(
                [this._gjs, '-m', this._workerPath, JSON.stringify(job)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (error) {
            this._finishLater(request, _baseResult({
                code: 'spawn-failed',
                message: `${error?.message || error}`,
                generation,
                root: request.root,
            }));
            return generation;
        }

        request.cancellable = new Gio.Cancellable();
        request.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            timeoutMs,
            () => {
                request.timeoutId = 0;
                if (!request.done) {
                    this._cancelRequest(
                        request,
                        'timeout',
                        `Library index worker exceeded ${timeoutMs} ms`
                    );
                }
                return GLib.SOURCE_REMOVE;
            }
        );

        try {
            request.process.communicate_utf8_async(
                null,
                request.cancellable,
                (process, asyncResult) => this._workerFinished(request, process, asyncResult)
            );
        } catch (error) {
            this._terminateWorker(request);
            this._clearSources(request);
            this._finishLater(request, _baseResult({
                code: 'worker-wait-failed',
                message: `${error?.message || error}`,
                generation,
                root: request.root,
            }));
        }
        return generation;
    }

    /** Cancel the current generation, or a specific generation if provided. */
    cancel(generation = null) {
        const request = this._activeRequest;
        if (!request || (generation !== null && generation !== request.generation))
            return false;
        this._cancelRequest(request, 'cancelled', 'Library scan was cancelled');
        return true;
    }

    /** Cancel all work and prevent future scans from spawning workers. */
    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        if (this._activeRequest)
            this._cancelRequest(this._activeRequest, 'cancelled', 'Library indexer was disposed');
    }

    _workerFinished(request, process, asyncResult) {
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

        if (request.done)
            return;
        if (request.generation !== this._generation || this._disposed) {
            this._cancelRequest(
                request,
                'stale',
                'Library scan completed after its generation expired'
            );
            return;
        }
        if (waitError) {
            this._finish(request, _baseResult({
                code: 'worker-wait-failed',
                message: `${waitError?.message || waitError}`,
                generation: request.generation,
                root: request.root,
            }));
            return;
        }

        let workerResult = null;
        try {
            workerResult = JSON.parse(stdout.trim());
        } catch (_) {}

        if (_validWorkerResult(workerResult, request)) {
            this._finish(request, workerResult);
            return;
        }

        this._finish(request, _baseResult({
            code: 'worker-failed',
            message: _workerFailureMessage(process, stderr),
            generation: request.generation,
            root: request.root,
        }));
    }

    _finishLater(request, result) {
        request.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            request.idleId = 0;
            if (!request.done)
                this._finish(request, result);
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(request, result) {
        if (request.done)
            return;
        request.done = true;
        this._clearSources(request);
        if (this._activeRequest === request)
            this._activeRequest = null;
        result.durationMs = Math.max(
            Number(result.durationMs) || 0,
            Math.round((GLib.get_monotonic_time() - request.startedUs) / 1000)
        );
        try {
            request.onDone(result);
        } catch (error) {
            logError(error, 'wallpaper-suite: library index callback failed');
        }
    }

    _cancelRequest(request, code, message) {
        if (!request || request.done)
            return;
        this._terminateWorker(request);
        this._finish(request, _baseResult({
            code,
            message,
            generation: request.generation,
            root: request.root,
        }));
    }

    _terminateWorker(request) {
        try { request.cancellable?.cancel(); } catch (_) {}
        try { request.process?.force_exit(); } catch (_) {}
    }

    _clearSources(request) {
        if (request.timeoutId) {
            GLib.Source.remove(request.timeoutId);
            request.timeoutId = 0;
        }
        if (request.idleId) {
            GLib.Source.remove(request.idleId);
            request.idleId = 0;
        }
    }
}

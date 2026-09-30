// Rotation scheduler and live wallpaper-library index.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {LibraryIndexer} from './libraryIndex.js';
import {nextRotationDeadline, selectAssignments} from './runtimeCore.js';

// Keep an overdue catch-up rotation clear of the unlock transition.
const OVERDUE_CATCHUP_DELAY_SEC = 30;

const POOL_RECONCILE_SECONDS = 300;
const POOL_EVENT_DEBOUNCE_MS = 300;
const POOL_MAX_LIVE_MONITORS = 128;

function _selectionResult(overrides = {}) {
    return {
        ok: false,
        code: 'unknown',
        message: '',
        generation: 0,
        indexGeneration: 0,
        assignments: null,
        changed: false,
        cursorCommitRequired: false,
        ...overrides,
    };
}

export class Scheduler {
    constructor(settings, onRotate, options = {}) {
        this._settings = settings;
        this._onRotate = onRotate;
        this._onPoolChanged = options.onPoolChanged || null;
        this._onStateChanged = options.onStateChanged || null;
        this._random = options.random || Math.random;
        // Injectable so tests can exercise the catch-up path without waiting
        // out the real settle delay.
        this._overdueCatchupSec =
            options.overdueCatchupSec ?? OVERDUE_CATCHUP_DELAY_SEC;
        this._indexer = options.indexer || new LibraryIndexer(
            options.extensionPath || null,
            {probeDimensions: false}
        );
        this._monitorDirectory = options.monitorDirectory || (path =>
            Gio.File.new_for_path(path).monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES,
                null
            ));

        this._timerId = 0;
        this._reconcileId = 0;
        this._poolDebounceId = 0;
        this._poolDir = null;
        this._poolCache = [];
        this._poolDirty = true;
        this._poolMonitors = [];
        this._poolIndexing = false;
        this._poolIndexGeneration = 0;
        this._poolDurationMs = 0;
        this._poolTruncated = false;
        this._watcherDegraded = false;
        this._watcherErrors = [];
        this._scanActive = null;
        this._selectionGeneration = 0;
        this._selectionRequest = null;
        this._shutdown = false;
        this._seqState = this._readSequentialState();
        this._pendingSeqState = null;
        this._lastPoolScanEpoch = 0;
        this._lastPoolAttemptEpoch = 0;
        this._lastPoolAttemptOk = false;
        this._poolError = '';
    }

    /**
     * Start (or reschedule) the one-shot deadline timer. A persisted deadline
     * in the past fires once almost immediately, then advances from "now" —
     * this is the lock/logout catch-up behavior and never loops missed ticks.
     */
    start({resetDeadline = false} = {}) {
        if (this._shutdown)
            return;
        this._ensurePoolLifecycle();
        this._stopRotationTimer();

        if (!this._settings.get_boolean('rotation-enabled')) {
            // This is an explicit user pause, not extension shutdown. Clearing
            // the deadline means resuming starts a fresh interval.
            this._setInt64('rotation-next-deadline', 0);
            this._notifyStateChanged();
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const interval = this._intervalSeconds();
        const stored = this._getInt64('rotation-next-deadline');
        const deadline = nextRotationDeadline(now, interval, stored, resetDeadline);
        this._setInt64('rotation-next-deadline', deadline);
        this._scheduleDeadline(deadline);
        this._notifyStateChanged();
    }

    /** Stop only the rotation source; persisted state and pool watches remain. */
    stop() {
        this._stopRotationTimer();
    }

    /** Full lifecycle teardown used by extension.disable(). */
    shutdown() {
        if (this._shutdown)
            return;
        this._shutdown = true;
        this._stopRotationTimer();
        if (this._reconcileId) {
            GLib.Source.remove(this._reconcileId);
            this._reconcileId = 0;
        }
        if (this._poolDebounceId) {
            GLib.Source.remove(this._poolDebounceId);
            this._poolDebounceId = 0;
        }
        const selection = this._selectionRequest;
        this._selectionRequest = null;
        if (selection) {
            this._finishSelection(selection, _selectionResult({
                code: 'cancelled',
                message: 'Scheduler was shut down',
                generation: selection.generation,
            }));
        }
        this._scanActive = null;
        try { this._indexer?.dispose(); } catch (_) {}
        this._poolIndexing = false;
        this._cancelPoolMonitors();
    }

    resetDeadline() {
        if (!this._settings.get_boolean('rotation-enabled'))
            return;
        this.start({resetDeadline: true});
    }

    /** Cancel only the current selection generation (used by Pause). */
    cancelSelection(generation = null, code = 'cancelled', message = 'Selection was cancelled') {
        const request = this._selectionRequest;
        if (!request || (generation !== null && request.generation !== generation))
            return false;
        this._selectionRequest = null;
        this._finishSelection(request, _selectionResult({
            code,
            message,
            generation: request.generation,
            indexGeneration: this._poolIndexGeneration,
        }));
        return true;
    }

    markRotationSuccess(epoch = Math.floor(Date.now() / 1000)) {
        this._setInt64('rotation-last-success', epoch);
        this._notifyStateChanged();
    }

    get nextDeadline() {
        return this._getInt64('rotation-next-deadline');
    }

    get remainingSeconds() {
        const deadline = this.nextDeadline;
        if (deadline <= 0)
            return 0;
        return Math.max(0, deadline - Math.floor(Date.now() / 1000));
    }

    get lastRotationAttempt() {
        return this._getInt64('rotation-last-run');
    }

    get lastRotationSuccess() {
        return this._getInt64('rotation-last-success');
    }

    get poolStatus() {
        return {
            folder: this._poolDir || this._folderIdentity(
                this._settings.get_string('wallpaper-folder')),
            count: this._poolCache.length,
            lastScanEpoch: this._lastPoolScanEpoch,
            lastAttemptEpoch: this._lastPoolAttemptEpoch,
            lastAttemptOk: this._lastPoolAttemptOk,
            error: this._poolError,
            indexing: this._poolIndexing,
            generation: this._poolIndexGeneration,
            durationMs: this._poolDurationMs,
            truncated: this._poolTruncated,
            watcherDegraded: this._watcherDegraded,
            watcherErrors: [...this._watcherErrors],
        };
    }

    invalidatePool() {
        const folder = this._folderIdentity(
            this._settings.get_string('wallpaper-folder'));
        this._poolDir = null;
        this._poolCache = [];
        this._poolDirty = true;
        this._poolError = '';
        this._poolTruncated = false;
        this._watcherDegraded = false;
        this._watcherErrors = [];
        this._lastPoolScanEpoch = 0;
        this._lastPoolAttemptEpoch = 0;
        this._lastPoolAttemptOk = false;
        this._seqState.index = -1;
        // A folder switch invalidates an unacknowledged selection. The
        // committed cursor remains available if the user switches back.
        this._pendingSeqState = null;
        this._cancelSelection('folder-changed', 'Wallpaper library folder changed');
        this._cancelPoolMonitors();
        if (!folder) {
            const active = this._scanActive;
            this._scanActive = null;
            try { this._indexer?.cancel(active?.generation); } catch (_) {}
            this._poolDir = '';
            this._poolDirty = false;
            this._poolIndexing = false;
            this._lastPoolScanEpoch = 0;
            this._lastPoolAttemptEpoch = 0;
            this._lastPoolAttemptOk = false;
            this._notifyPoolChanged();
            return;
        }
        this._refreshPool(true);
    }

    /**
     * Select against the last complete index. Runtime callers should use
     * pickNextAsync(), which requires a fresh worker generation first.
     */
    pickNext(monitors, currentAssignments) {
        const folder = this._folderIdentity(
            this._settings.get_string('wallpaper-folder'));
        if (!folder || this._poolDirty || this._poolIndexing || this._poolDir !== folder)
            return null;
        return this._selectNext(monitors, currentAssignments, folder, 0);
    }

    /**
     * Fresh, last-request-wins selection. Concurrent manual/scheduled actions
     * share the same in-flight scan; only the newest action receives a choice.
     */
    pickNextAsync(monitors, currentAssignments, onDone) {
        onDone ||= () => {};
        const generation = ++this._selectionGeneration;
        const request = {
            generation,
            folder: this._folderIdentity(
                this._settings.get_string('wallpaper-folder')),
            monitors: [...(monitors || [])],
            currentAssignments: {...(currentAssignments || {})},
            onDone,
            done: false,
            idleId: 0,
            startedUs: GLib.get_monotonic_time(),
        };

        const previous = this._selectionRequest;
        this._selectionRequest = request;
        if (previous) {
            this._finishSelection(previous, _selectionResult({
                code: 'superseded',
                message: 'A newer wallpaper selection replaced this request',
                generation: previous.generation,
            }));
        }
        // A superseded callback is allowed to start a still-newer request.
        if (this._selectionRequest !== request)
            return generation;

        if (this._shutdown) {
            this._finishSelectionLater(request, _selectionResult({
                code: 'cancelled',
                message: 'Scheduler is shut down',
                generation,
            }));
            return generation;
        }
        if (!request.folder) {
            this._finishSelectionLater(request, _selectionResult({
                code: 'library-unset',
                message: 'Wallpaper library folder is not set',
                generation,
            }));
            return generation;
        }

        // A fresh scan is mandatory for each rotation action. If an equally
        // fresh scan is already running, the request joins it rather than
        // spawning/cancelling duplicate workers.
        this._refreshPool(true);
        return generation;
    }

    /** Commit a tentative sequential cursor after successful URI publication. */
    commitSelection(assignments, selectionToken = null) {
        const pending = this._pendingSeqState;
        if (!pending)
            return false;
        if (pending.fingerprint !== _assignmentFingerprint(assignments) ||
            (selectionToken !== null && pending.selectionToken !== selectionToken))
            return false;

        // Folder and path are one structured GSettings value so a failed
        // backend write cannot durably split the cursor. Keep the pending
        // token intact until the write is accepted and read back verbatim.
        if (!this._persistSequentialState(pending.state))
            return false;
        this._seqState = {...pending.state};
        this._pendingSeqState = null;
        return true;
    }

    /** Drop only the pending selection that corresponds to a failed render. */
    discardSelection(assignments, selectionToken = null) {
        const pending = this._pendingSeqState;
        if (!pending || pending.fingerprint !== _assignmentFingerprint(assignments) ||
            (selectionToken !== null && pending.selectionToken !== selectionToken))
            return false;
        this._pendingSeqState = null;
        return true;
    }

    _selectNext(monitors, currentAssignments, folder, selectionToken = 0) {
        if (this._poolCache.length === 0)
            return null;
        const mode = this._settings.get_string('rotation-mode');
        const sync = this._settings.get_boolean('rotation-sync-monitors');
        const sequentialState = mode === 'sequential' &&
            this._seqState.folder === folder
            ? {...this._seqState}
            : {index: -1, lastPath: '', folder};
        const next = selectAssignments(monitors, this._poolCache, currentAssignments, {
            sync,
            mode,
            // Selection is tentative until the resulting composite is
            // published. A decode/publication failure must not advance the
            // durable cursor.
            state: sequentialState,
            random: this._random,
        });

        this._pendingSeqState = null;
        if (mode === 'sequential' && sequentialState.lastPath) {
            this._pendingSeqState = {
                fingerprint: _assignmentFingerprint(next),
                selectionToken,
                state: {...sequentialState, folder},
            };
        }
        return next;
    }

    _completeSelection(request) {
        if (!request || request.done || this._selectionRequest !== request ||
            this._scanActive || this._poolDirty)
            return;
        const currentFolder = this._folderIdentity(
            this._settings.get_string('wallpaper-folder'));
        if (request.folder !== currentFolder || this._poolDir !== currentFolder) {
            this._finishSelection(request, _selectionResult({
                code: 'folder-changed',
                message: 'Wallpaper library changed while it was being indexed',
                generation: request.generation,
                indexGeneration: this._poolIndexGeneration,
            }));
            return;
        }
        if (request.monitors.length === 0) {
            this._finishSelection(request, _selectionResult({
                code: 'no-monitors',
                message: 'No active monitors were detected',
                generation: request.generation,
                indexGeneration: this._poolIndexGeneration,
            }));
            return;
        }

        const assignments = this._selectNext(
            request.monitors,
            request.currentAssignments,
            currentFolder,
            request.generation
        );
        if (!assignments) {
            this._finishSelection(request, _selectionResult({
                code: 'library-empty',
                message: 'No supported images were found in the wallpaper library',
                generation: request.generation,
                indexGeneration: this._poolIndexGeneration,
            }));
            return;
        }
        const changed = _assignmentFingerprint(assignments) !==
            _assignmentFingerprint(request.currentAssignments);
        if (!changed) {
            // A one-item/current-only pool is an accurate, successful no-op.
            // Do not manufacture a render/publication or advance sequential
            // state merely to claim that a manual action changed something.
            this._pendingSeqState = null;
            this._finishSelection(request, _selectionResult({
                ok: true,
                code: 'no-alternative',
                message: 'No different wallpaper is available',
                generation: request.generation,
                indexGeneration: this._poolIndexGeneration,
                assignments,
                changed: false,
            }));
            return;
        }
        this._finishSelection(request, _selectionResult({
            ok: true,
            code: 'selected',
            generation: request.generation,
            indexGeneration: this._poolIndexGeneration,
            assignments,
            changed: true,
            cursorCommitRequired: this._pendingSeqState?.selectionToken ===
                request.generation,
        }));
    }

    _finishSelectionLater(request, result) {
        request.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            request.idleId = 0;
            this._finishSelection(request, result);
            return GLib.SOURCE_REMOVE;
        });
    }

    _finishSelection(request, result) {
        if (!request || request.done)
            return;
        request.done = true;
        if (request.idleId) {
            GLib.Source.remove(request.idleId);
            request.idleId = 0;
        }
        if (this._selectionRequest === request)
            this._selectionRequest = null;
        result.durationMs = Math.max(0,
            Math.round((GLib.get_monotonic_time() - request.startedUs) / 1000));
        try { request.onDone(result); } catch (error) {
            logError(error, 'wallpaper-suite: selection callback failed');
        }
    }

    _cancelSelection(code, message) {
        const request = this._selectionRequest;
        if (!request)
            return;
        this._selectionRequest = null;
        this._finishSelection(request, _selectionResult({
            code,
            message,
            generation: request.generation,
            indexGeneration: this._poolIndexGeneration,
        }));
    }

    _intervalSeconds() {
        return Math.max(60, this._settings.get_int('rotation-interval-minutes') * 60);
    }

    _scheduleDeadline(deadline) {
        const now = Math.floor(Date.now() / 1000);
        // An overdue deadline (screen locked past the interval) used to fire 1s
        // after enable() — and enable() runs on unlock, so the catch-up
        // rotation landed inside the unlock transition. Let the session settle:
        // the rotation is minutes late already, seconds more is free.
        const remaining = deadline - now;
        const delay = remaining > 0 ? remaining : this._overdueCatchupSec;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timerId = 0;
            if (!this._settings.get_boolean('rotation-enabled')) {
                this._setInt64('rotation-next-deadline', 0);
                this._notifyStateChanged();
                return GLib.SOURCE_REMOVE;
            }

            const currentDeadline = this._getInt64('rotation-next-deadline');
            const tickNow = Math.floor(Date.now() / 1000);
            if (currentDeadline > tickNow) {
                // A setting/manual action advanced the persisted deadline while
                // this source was queued.
                this._scheduleDeadline(currentDeadline);
                return GLib.SOURCE_REMOVE;
            }

            try {
                this._onRotate();
            } catch (error) {
                logError(error, 'wallpaper-suite: rotation tick failed');
            }
            this._setInt64('rotation-last-run', tickNow);
            const next = tickNow + this._intervalSeconds();
            this._setInt64('rotation-next-deadline', next);
            this._scheduleDeadline(next);
            this._notifyStateChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopRotationTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    _ensurePoolLifecycle() {
        this._refreshPool(this._poolDirty);
        if (!this._reconcileId) {
            this._reconcileId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                POOL_RECONCILE_SECONDS,
                () => {
                    this._refreshPool(true, {rescanIfActive: true});
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }
    }

    _refreshPool(force = false, {rescanIfActive = false} = {}) {
        if (this._shutdown)
            return;
        const folder = this._folderIdentity(
            this._settings.get_string('wallpaper-folder'));
        if (!folder) {
            const changed = this._poolCache.length > 0 || this._poolDir !== '';
            this._poolDir = '';
            this._poolCache = [];
            this._poolDirty = false;
            this._poolIndexing = false;
            this._poolError = '';
            this._poolTruncated = false;
            this._watcherDegraded = false;
            this._watcherErrors = [];
            this._lastPoolScanEpoch = 0;
            this._lastPoolAttemptEpoch = 0;
            this._lastPoolAttemptOk = false;
            this._cancelPoolMonitors();
            if (changed)
                this._notifyPoolChanged();
            return;
        }

        if (this._scanActive) {
            if (this._scanActive.folder === folder) {
                if (rescanIfActive)
                    this._scanActive.refreshAgain = true;
                // A background reconciliation may already have enumerated
                // before the action arrived. Finish it, then take one action-
                // scoped snapshot so rotation never consumes an older point
                // in time merely because startup indexing happened to overlap.
                if (this._selectionRequest && !this._scanActive.servesSelection)
                    this._scanActive.refreshAgain = true;
                return;
            }
        }

        const folderChanged = this._poolDir !== null && this._poolDir !== folder;
        if (!force && !folderChanged && !this._poolDirty)
            return;
        if (folderChanged) {
            this._poolCache = [];
            this._cancelPoolMonitors();
        }

        const context = {
            folder,
            generation: 0,
            refreshAgain: false,
            servesSelection: Boolean(this._selectionRequest),
        };
        this._scanActive = context;
        this._poolIndexing = true;
        this._poolDirty = true;
        this._notifyPoolChanged();

        try {
            context.generation = this._indexer.scanAsync(
                folder,
                {probeDimensions: false},
                result => this._onIndexDone(context, result)
            );
        } catch (error) {
            if (this._scanActive === context)
                this._scanActive = null;
            this._onIndexFailure(context, {
                code: 'spawn-failed',
                message: `${error?.message || error}`,
                generation: 0,
                durationMs: 0,
                watcher: {degraded: false, errors: []},
            });
        }
    }

    _onIndexDone(context, result) {
        if (this._shutdown || this._scanActive !== context)
            return;
        this._scanActive = null;

        const currentFolder = this._folderIdentity(
            this._settings.get_string('wallpaper-folder'));
        if (context.folder !== currentFolder) {
            this._refreshPool(true);
            return;
        }
        if (!result.ok) {
            this._onIndexFailure(context, result);
            return;
        }

        this._poolDir = context.folder;
        this._poolCache = result.files.map(record => record.path);
        this._poolIndexGeneration = Number(result.generation) || context.generation;
        this._poolDurationMs = Number(result.durationMs) || 0;
        this._poolTruncated = result.truncated === true;
        this._lastPoolScanEpoch = Math.floor(Date.now() / 1000);
        this._lastPoolAttemptEpoch = this._lastPoolScanEpoch;
        this._lastPoolAttemptOk = true;

        const monitorErrors = this._rebuildPoolMonitors(result.directories);
        const workerWatcherErrors = (result.watcher?.errors || []).map(_errorText);
        this._watcherErrors = [...new Set([...workerWatcherErrors, ...monitorErrors])];
        this._watcherDegraded = result.watcher?.degraded === true ||
            this._watcherErrors.length > 0;
        const scanErrors = (result.errors || []).map(_errorText);
        this._poolError = [...new Set([...scanErrors, ...this._watcherErrors])].join('; ');

        if (context.refreshAgain) {
            // A file event or periodic reconciliation landed during this scan.
            // Do not satisfy a rotation from a snapshot known to be stale.
            if (this._poolDebounceId) {
                GLib.Source.remove(this._poolDebounceId);
                this._poolDebounceId = 0;
            }
            this._poolDirty = true;
            this._poolIndexing = true;
            this._notifyPoolChanged();
            this._refreshPool(true);
            return;
        }

        this._poolDirty = false;
        this._poolIndexing = false;
        // Status changes (duration/degradation/errors) matter even when the
        // file list itself is identical, so publish every completed snapshot.
        this._notifyPoolChanged();
        this._completeSelection(this._selectionRequest);
    }

    _onIndexFailure(context, result) {
        if (this._shutdown)
            return;
        this._poolIndexing = false;
        this._poolDirty = true;
        this._poolIndexGeneration = Number(result.generation) || context.generation || 0;
        this._poolDurationMs = Number(result.durationMs) || 0;
        this._lastPoolAttemptEpoch = Math.floor(Date.now() / 1000);
        this._lastPoolAttemptOk = false;
        this._watcherDegraded = result.watcher?.degraded === true;
        this._watcherErrors = (result.watcher?.errors || []).map(_errorText);
        this._poolError = result.message || result.code || 'Library index failed';
        this._notifyPoolChanged();

        if (context.refreshAgain) {
            // One file event/reconciliation request earns one immediate retry.
            // The replacement context starts clean, so a persistent failure
            // cannot spin without another external event or the 5-minute poll.
            if (this._poolDebounceId) {
                GLib.Source.remove(this._poolDebounceId);
                this._poolDebounceId = 0;
            }
            this._poolIndexing = true;
            this._notifyPoolChanged();
            this._refreshPool(true);
            return;
        }

        const selection = this._selectionRequest;
        if (selection?.folder === context.folder) {
            this._finishSelection(selection, _selectionResult({
                code: result.code || 'index-failed',
                message: result.message || 'Wallpaper library index failed',
                generation: selection.generation,
                indexGeneration: this._poolIndexGeneration,
            }));
        }
    }

    _notifyPoolChanged() {
        if (!this._onPoolChanged)
            return;
        try { this._onPoolChanged(this.poolStatus); } catch (error) {
            logError(error, 'wallpaper-suite: pool-change callback failed');
        }
    }

    _notifyStateChanged() {
        if (!this._onStateChanged)
            return;
        try {
            this._onStateChanged({
                nextDeadline: this.nextDeadline,
                remainingSeconds: this.remainingSeconds,
            });
        } catch (error) {
            logError(error, 'wallpaper-suite: scheduler-state callback failed');
        }
    }

    _rebuildPoolMonitors(directories) {
        const available = [...new Set(directories || [])].sort();
        const wanted = available.slice(0, POOL_MAX_LIVE_MONITORS);
        const current = this._poolMonitors.map(entry => entry.path).sort();
        const errors = [];
        if (available.length > wanted.length) {
            errors.push(
                `Live folder watches limited to ${wanted.length} of ${available.length}; periodic reconciliation remains active`
            );
        }
        if (_arraysEqual(wanted, current))
            return errors;

        this._cancelPoolMonitors();
        for (const path of wanted) {
            try {
                const monitor = this._monitorDirectory(path);
                const signalId = monitor.connect('changed', () => this._onPoolFileEvent());
                this._poolMonitors.push({path, monitor, signalId});
            } catch (error) {
                errors.push(`Cannot monitor ${path}: ${error?.message || error}`);
            }
        }
        return errors;
    }

    _onPoolFileEvent() {
        this._poolDirty = true;
        if (this._scanActive)
            this._scanActive.refreshAgain = true;
        if (this._poolDebounceId)
            return;
        this._poolDebounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            POOL_EVENT_DEBOUNCE_MS,
            () => {
                this._poolDebounceId = 0;
                this._refreshPool(true, {rescanIfActive: true});
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelPoolMonitors() {
        for (const entry of this._poolMonitors) {
            try { entry.monitor.disconnect(entry.signalId); } catch (_) {}
            try { entry.monitor.cancel(); } catch (_) {}
        }
        this._poolMonitors = [];
    }

    _getInt64(key) {
        try { return Number(this._settings.get_int64(key)); } catch (_) { return 0; }
    }

    _setInt64(key, value) {
        try { this._settings.set_int64(key, Math.floor(value)); } catch (_) {}
    }

    _readSequentialState() {
        try {
            const value = this._settings
                .get_value('rotation-sequential-state')
                .deep_unpack();
            return {
                index: -1,
                lastPath: typeof value?.lastPath === 'string' ? value.lastPath : '',
                folder: typeof value?.folder === 'string' ? value.folder : '',
            };
        } catch (_) {
            return {index: -1, lastPath: '', folder: ''};
        }
    }

    _persistSequentialState(state) {
        const value = {
            lastPath: `${state?.lastPath || ''}`,
            folder: `${state?.folder || ''}`,
        };
        try {
            const accepted = this._settings.set_value(
                'rotation-sequential-state',
                new GLib.Variant('a{ss}', value)
            );
            if (accepted === false)
                return false;
            const saved = this._settings
                .get_value('rotation-sequential-state')
                .deep_unpack();
            return saved?.lastPath === value.lastPath &&
                saved?.folder === value.folder;
        } catch (_) {
            return false;
        }
    }

    _folderIdentity(folder) {
        if (!folder)
            return '';
        try { return GLib.canonicalize_filename(folder, null); } catch (_) { return folder; }
    }
}

function _arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function _assignmentFingerprint(assignments) {
    return JSON.stringify(Object.entries(assignments || {}).sort(([left], [right]) =>
        left.localeCompare(right)));
}

function _errorText(error) {
    if (typeof error === 'string')
        return error;
    if (!error || typeof error !== 'object')
        return `${error || 'Unknown library error'}`;
    const prefix = error.path ? `${error.path}: ` : '';
    return `${prefix}${error.message || error.code || 'Unknown library error'}`;
}

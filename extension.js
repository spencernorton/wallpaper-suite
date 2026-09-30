// Wallpaper Suite — main entry.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {MonitorManager} from './monitorManager.js';
import {Compositor} from './compositor.js';
import {Scheduler} from './scheduler.js';
import {ControlService, CONTROL_API_VERSION} from './controlService.js';

// Long enough to outlast a multi-monitor DPMS wake, short enough that a real
// hotplug still feels immediate.
const APPLY_DEBOUNCE_MS = 1500;

// A nested GNOME Shell started for development runs on its own D-Bus session
// and Wayland display, but GNOME Shell 50 resolves the user extension
// directory AND dconf from the passwd home dir, ignoring HOME and
// XDG_*_HOME. So a nested Shell loads THIS extension and its writes land in
// the LIVE desktop's settings. Started with a single
// `--virtual-monitor 2560x1440`, it composited for that one monitor and
// published the result as picture-uri; picture-options=spanned then
// stretched one 2560x1440 image across a real 11520x2160 desktop until the
// next apply corrected it.
//
// No layout heuristic can catch this — inside the nested session that render
// is correct for the monitor it can see. The only thing that distinguishes
// the two shells is which one owns the real session. A development harness
// that starts a nested Shell exports GNOME_SHELL_DEV_HARNESS=1; stay inert.
function inDevHarness() {
    return GLib.getenv('GNOME_SHELL_DEV_HARNESS') === '1';
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Wallpaper Suite');
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            style_class: 'system-status-icon',
        }));

        // --- Status (rotation countdown / disabled state) ---
        this._statusItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('dim-label');
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Actions ---
        const next = new PopupMenu.PopupMenuItem('Next background');
        next.connect('activate', () => ext.shuffleNow({source: 'indicator'}));
        this.menu.addMenuItem(next);

        const reapply = new PopupMenu.PopupMenuItem('Reapply current');
        reapply.connect('activate', () => ext.applyComposite(true));
        this.menu.addMenuItem(reapply);

        this._pauseItem = new PopupMenu.PopupMenuItem('Pause rotation');
        this._pauseItem.connect('activate', () => {
            const cur = ext._settings.get_boolean('rotation-enabled');
            ext._settings.set_boolean('rotation-enabled', !cur);
        });
        this.menu.addMenuItem(this._pauseItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefs = new PopupMenu.PopupMenuItem('Settings…');
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);

        // Refresh status text every time the menu opens.
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._refresh();
        });
        this._refresh();
    }

    _refresh() {
        const ext = this._ext;
        if (!ext || !ext._settings) return;
        const enabled = ext._settings.get_boolean('rotation-enabled');

        const render = ext._lastRenderResult;
        if (render && !render.ok &&
            !['cancelled', 'stale', 'superseded'].includes(render.code)) {
            this._statusItem.label.text = 'Render failed — previous wallpaper kept';
            this._pauseItem.label.text = enabled ? 'Pause rotation' : 'Resume rotation';
            return;
        }

        if (!enabled) {
            this._statusItem.label.text = 'Rotation paused';
            this._pauseItem.label.text = 'Resume rotation';
            return;
        }

        const remainingSec = ext._scheduler?.remainingSeconds || 0;
        this._statusItem.label.text = `Next rotation in ${_formatDuration(remainingSec)}`;
        this._pauseItem.label.text = 'Pause rotation';
    }
});

function _formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const mr = m % 60;
    return mr === 0 ? `${h} h` : `${h} h ${mr} min`;
}

function _assignmentFingerprint(assignments) {
    return JSON.stringify(Object.entries(assignments || {}).sort(([left], [right]) =>
        left.localeCompare(right)));
}

function _monitorFingerprint(monitors) {
    return JSON.stringify([...(monitors || [])]
        .map(monitor => ({
            connector: `${monitor.connector || ''}`,
            x: Number(monitor.x),
            y: Number(monitor.y),
            width: Number(monitor.width),
            height: Number(monitor.height),
        }))
        .sort((left, right) => left.connector.localeCompare(right.connector)));
}

export default class WallpaperSuiteExtension extends Extension {
    enable() {
        // Stay completely inert in a nested test Shell — see inDevHarness().
        // Must be first: everything below writes state (dconf, the composite
        // cache, runtime-status.json) that is shared with the live session.
        if (inDevHarness()) {
            console.log('wallpaper-suite: inert, GNOME_SHELL_DEV_HARNESS=1 ' +
                '(a nested Shell shares the live desktop\'s dconf and cache)');
            return;
        }
        // The object can be disabled/re-enabled while a subprocess is still
        // exiting. Every completion callback captures this lifecycle value.
        this._lifecycleGeneration = (this._lifecycleGeneration || 0) + 1;
        this._settings = this.getSettings();
        this._bgSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._ssSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'});
        this._lastRenderResult = null;
        this._lastNotifiedRenderCode = null;
        this._lastNotifiedSelectionCode = null;
        this._shuffleRequests = new Set();
        this._pendingShuffleApply = null;
        this._manualShuffleQueue = [];
        this._manualDrainId = 0;
        this._shuttingDown = false;
        this._statusPath = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            'wallpaper-suite',
            'runtime-status.json',
        ]);
        this._runtimeStatus = this._readRuntimeStatus();

        this._monitorMgr = new MonitorManager();
        this._compositor = new Compositor(this.path);
        this._cacheCleanup = this._compositor.pruneCache(this._activeWallpaperPaths());
        for (const error of this._cacheCleanup.errors)
            console.warn(`wallpaper-suite: cache janitor: ${error}`);
        this._scheduler = new Scheduler(this._settings, () => {
            return this.shuffleNow({resetTimer: false, source: 'scheduled'});
        }, {
            onPoolChanged: () => {
                this._indicator?._refresh();
                this._writeRuntimeStatus();
            },
            onStateChanged: () => this._writeRuntimeStatus(),
            extensionPath: this.path,
        });
        this._controlService = new ControlService({
            onNext: (options, onDone) => this.shuffleNow({
                resetTimer: options.resetTimer,
                source: options.source,
                onDone,
            }),
            getStatus: () => ({
                active: Boolean(this._settings && this._scheduler),
                rotationEnabled: this._settings?.get_boolean('rotation-enabled') === true,
            }),
            onAvailabilityChanged: available => this._writeRuntimeStatus({
                controlApiAvailable: available,
                controlApiVersion: CONTROL_API_VERSION,
            }),
            statePath: GLib.build_filenamev([
                GLib.get_user_state_dir(),
                'wallpaper-suite',
                'control-operations-v1.json',
            ]),
        });
        // Never carry a prior lifecycle's ready bit through an export/name
        // failure. Name acquisition will promote this to true asynchronously.
        this._writeRuntimeStatus({
            controlApiAvailable: false,
            controlApiVersion: CONTROL_API_VERSION,
        });
        this._controlService.start();

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._applyIndicatorVisibility();

        this._settingsHandlers = [
            this._settings.connect('changed::rotation-enabled', () =>
                this._onRotationEnabledChanged()),
            this._settings.connect('changed::rotation-interval-minutes', () =>
                this._restartScheduler({resetDeadline: true})),
            this._settings.connect('changed::wallpaper-folder', () =>
                this._onWallpaperFolderChanged()),
            this._settings.connect('changed::monitor-assignments', () => this._scheduleApply()),
            this._settings.connect('changed::monitor-modes', () => this._scheduleApply()),
            this._settings.connect('changed::composite-quality', () => this._scheduleApply()),
            this._settings.connect('changed::show-indicator', () => this._applyIndicatorVisibility()),
        ];

        this._monitorMgr.connectChange(() => this._scheduleApply());

        this._scheduleApply();
        this._restartScheduler();
        this._writeRuntimeStatus({
            extensionActive: true,
            cachePrunedCount: this._cacheCleanup.removed.length,
            cacheCleanupErrors: [...this._cacheCleanup.errors],
        });
    }

    _applyIndicatorVisibility() {
        if (!this._indicator) return;
        this._indicator.visible = this._settings.get_boolean('show-indicator');
    }

    _restartScheduler({resetDeadline = false} = {}) {
        this._scheduler?.start({resetDeadline});
        this._indicator?._refresh();
    }

    _onRotationEnabledChanged() {
        if (!this._settings.get_boolean('rotation-enabled'))
            this._cancelScheduledShuffleRequests();
        this._restartScheduler();
    }

    _onWallpaperFolderChanged() {
        this._cancelMatchingShuffleRequests(
            () => true,
            'Wallpaper library folder changed',
            {restoreAssignments: true}
        );
        this._cancelQueuedManualRequests('Wallpaper library folder changed');
        this._scheduler?.invalidatePool();
    }

    disable() {
        // enable() built nothing, and _writeRuntimeStatus below would still
        // publish to the shared cache. Bail before it.
        if (inDevHarness())
            return;
        this._lifecycleGeneration = (this._lifecycleGeneration || 0) + 1;
        this._shuttingDown = true;
        if (this._applyTimeout) {
            GLib.Source.remove(this._applyTimeout);
            this._applyTimeout = 0;
        }
        this._cancelShuffleRequests();
        if (this._manualDrainId) {
            GLib.Source.remove(this._manualDrainId);
            this._manualDrainId = 0;
        }
        this._cancelQueuedManualRequests('Wallpaper Suite was disabled');
        // Restoring an unpublished assignment emits a settings change. Do not
        // leave its coalesced apply source alive after this lifecycle ends.
        if (this._applyTimeout) {
            GLib.Source.remove(this._applyTimeout);
            this._applyTimeout = 0;
        }
        this._controlService?.stop();
        this._controlService = null;
        this._scheduler?.shutdown();
        this._writeRuntimeStatus({
            extensionActive: false,
            poolIndexing: false,
            controlApiAvailable: false,
            controlApiVersion: CONTROL_API_VERSION,
        });
        this._scheduler = null;

        this._monitorMgr?.disconnect();
        this._monitorMgr = null;

        for (const id of this._settingsHandlers || [])
            this._settings.disconnect(id);
        this._settingsHandlers = [];

        this._indicator?.destroy();
        this._indicator = null;

        // Dispose before dropping settings references. This cancels workers and
        // makes any completion already queued on the main loop stale.
        this._compositor?.dispose();
        this._compositor = null;
        this._settings = null;
        this._bgSettings = null;
        this._ssSettings = null;
    }

    // Coalesce rapid setting changes, and monitor hotplug storms. Waking
    // several 4K panels from DPMS (i.e. every unlock) makes mutter emit
    // 'monitors-changed' repeatedly for ~1s. Must be a TRAILING debounce: the
    // old leading form fired 120ms after the FIRST event, so we composited and
    // published for a transient one-monitor layout — which picture-options=
    // spanned then stretches across the whole desktop, leaving any monitor it
    // does not cover black until the next apply corrects it.
    _scheduleApply() {
        if (this._applyTimeout)
            GLib.Source.remove(this._applyTimeout);
        // A fixed window, not an adaptive settle detector. Raise it if a
        // slower display chain still slips a transient layout through.
        this._applyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, APPLY_DEBOUNCE_MS, () => {
            this._applyTimeout = 0;
            this.applyComposite();
            return GLib.SOURCE_REMOVE;
        });
    }

    shuffleNow({resetTimer = true, onDone = null, source = 'manual'} = {}) {
        // Guard against a scheduler tick firing after disable().
        if (!this._scheduler || !this._monitorMgr || !this._settings) {
            try { onDone?.({ok: false, code: 'inactive'}); } catch (_) {}
            return false;
        }
        const activeRequests = [...this._shuffleRequests]
            .filter(request => !request.done);
        const manualActive = activeRequests.some(request =>
            request.source !== 'scheduled');
        if (source === 'scheduled' &&
            (manualActive || this._manualShuffleQueue.length > 0)) {
            // A deadline tick never displaces an explicit user action.
            return false;
        }
        if (source !== 'scheduled' &&
            (activeRequests.length > 0 || this._manualShuffleQueue.length > 0)) {
            if (this._manualShuffleQueue.length >= 15) {
                try {
                    onDone?.({
                        ok: false,
                        code: 'busy',
                        message: 'Too many wallpaper actions are already queued',
                    });
                } catch (_) {}
                return true;
            }
            this._manualShuffleQueue.push({resetTimer, onDone, source});
            return true;
        }
        return this._startShuffleNow({resetTimer, onDone, source});
    }

    _startShuffleNow({resetTimer = true, onDone = null, source = 'manual'} = {}) {
        if (!this._scheduler || !this._monitorMgr || !this._settings) {
            try { onDone?.({ok: false, code: 'inactive'}); } catch (_) {}
            return false;
        }
        const monitors = this._monitorMgr.monitors.map(monitor => ({...monitor}));
        const current = this._readDict('monitor-assignments');
        const lifecycleGeneration = this._lifecycleGeneration;
        const request = {
            done: false,
            phase: 'index',
            resetTimer,
            source,
            onDone,
            previousAssignments: {...current},
            contextFingerprint: _assignmentFingerprint(current),
            monitorFingerprint: _monitorFingerprint(monitors),
            assignments: null,
            fingerprint: '',
            selectionGeneration: 0,
            cursorCommitRequired: false,
        };
        this._shuffleRequests.add(request);
        request.selectionGeneration = this._scheduler.pickNextAsync(
            monitors,
            current,
            result => {
                if (request.done)
                    return;
                if (lifecycleGeneration !== this._lifecycleGeneration ||
                    !this._scheduler || !this._settings) {
                    this._finishShuffleRequest(request, {
                        ok: false,
                        code: 'cancelled',
                        message: 'Extension lifecycle changed',
                    });
                    return;
                }
                if (!result.ok) {
                    const benign = ['cancelled', 'disposed', 'stale', 'superseded',
                        'folder-changed'].includes(result.code);
                    if (!benign) {
                        this._notifySelectionFailure(result);
                        this._writeRuntimeStatus({
                            lastSelectionError: result.message || result.code,
                            lastSelectionAttemptAt: Date.now(),
                        });
                    }
                    this._finishShuffleRequest(request, result);
                    return;
                }

                const assignmentsChanged = request.contextFingerprint !==
                    _assignmentFingerprint(this._readDict('monitor-assignments'));
                const monitorsChanged = request.monitorFingerprint !==
                    _monitorFingerprint(this._monitorMgr.monitors);
                if (assignmentsChanged || monitorsChanged) {
                    this._scheduler.discardSelection(
                        result.assignments,
                        result.generation
                    );
                    this._finishShuffleRequest(request, {
                        ok: false,
                        code: 'stale-context',
                        message: assignmentsChanged
                            ? 'Monitor assignments changed while the library was indexed'
                            : 'Monitor layout changed while the library was indexed',
                    });
                    return;
                }
                if (result.changed === false) {
                    const timerReset = request.resetTimer === true &&
                        this._settings.get_boolean('rotation-enabled');
                    if (timerReset)
                        this._scheduler.resetDeadline();
                    if (['desktop-menu', 'indicator', 'shortcut'].includes(request.source)) {
                        Main.notify(
                            'Wallpaper Suite',
                            result.message || 'No different background is available.'
                        );
                    }
                    this._finishShuffleRequest(request, {
                        ...result,
                        ok: true,
                        code: 'no-alternative',
                        changed: false,
                        published: false,
                        timerReset,
                    });
                    return;
                }

                this._lastNotifiedSelectionCode = null;
                request.phase = 'apply';
                request.selectionGeneration = result.generation;
                request.cursorCommitRequired = result.cursorCommitRequired === true;
                request.assignments = result.assignments;
                request.fingerprint = _assignmentFingerprint(result.assignments);

                const pending = this._pendingShuffleApply;
                if (pending && pending !== request && !pending.done) {
                    // A newer Next replaces the uncommitted image choice, but
                    // its rollback point is still the oldest known published
                    // assignment—not the superseded value in GSettings.
                    request.previousAssignments = {...pending.previousAssignments};
                    pending.cancelReason =
                        'A newer wallpaper selection replaced this request';
                    this._scheduler.discardSelection(
                        pending.assignments,
                        pending.selectionGeneration
                    );
                    this._finishShuffleRequest(pending, {
                        ok: false,
                        code: 'superseded',
                        message: pending.cancelReason,
                    });
                    if (pending.renderGeneration)
                        this._compositor?.cancel(pending.renderGeneration);
                }
                this._pendingShuffleApply = request;
                // Keep the tentative assignment in memory until its exact
                // composite is published. A Shell crash/logout can therefore
                // never make an uncommitted selection durable.
                this._scheduleApply();
            }
        );
        return true;
    }

    _scheduleManualDrain() {
        if (this._shuttingDown || this._manualDrainId ||
            (this._manualShuffleQueue?.length || 0) === 0)
            return;
        this._manualDrainId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._manualDrainId = 0;
            this._drainManualQueue();
            return GLib.SOURCE_REMOVE;
        });
    }

    _drainManualQueue() {
        this._manualDrainId = 0;
        if (this._shuttingDown || !this._scheduler)
            return;
        const manualActive = [...this._shuffleRequests].some(request =>
            !request.done && request.source !== 'scheduled');
        if (manualActive)
            return;
        const next = this._manualShuffleQueue.shift();
        if (!next)
            return;
        if (!this._startShuffleNow(next)) {
            try {
                next.onDone?.({
                    ok: false,
                    code: 'inactive',
                    message: 'Wallpaper Suite is not ready',
                });
            } catch (_) {}
            this._scheduleManualDrain();
        }
    }

    _cancelQueuedManualRequests(message) {
        for (const queued of this._manualShuffleQueue || []) {
            try {
                queued.onDone?.({
                    ok: false,
                    code: 'cancelled',
                    message,
                });
            } catch (_) {}
        }
        this._manualShuffleQueue = [];
    }

    applyComposite(force = false) {
        // Same guard — coalesced timeouts can outlive disable.
        if (!this._monitorMgr || !this._compositor || !this._settings || !this._bgSettings)
            return;

        const monitors = this._monitorMgr.monitors;
        const storedAssignments = this._readDict('monitor-assignments');
        const pendingShuffle = this._pendingShuffleApply;
        const assignments = pendingShuffle?.assignments
            ? {...pendingShuffle.assignments}
            : storedAssignments;
        const shuffleRequest = this._claimShuffleRequest(
            assignments,
            storedAssignments
        );
        if (monitors.length === 0) {
            this._failShuffleRender(shuffleRequest, assignments,
                'no-monitors', 'No active monitors were detected');
            return;
        }
        const modes = this._readDict('monitor-modes');
        const quality = this._settings.get_int('composite-quality');
        const assignmentFingerprint = _assignmentFingerprint(assignments);
        const monitorFingerprint = _monitorFingerprint(monitors);
        const modeFingerprint = _assignmentFingerprint(modes);

        const anyAssigned = monitors.some(m => assignments[m.connector]);
        if (!anyAssigned && !force) {
            this._failShuffleRender(shuffleRequest, assignments,
                'missing-assignment', 'No monitor wallpaper is assigned');
            return;
        }

        // Render OFF the main loop. The heavy decode/scale/encode runs in a
        // subprocess. A forced reapply gets a distinct filename so the current
        // URI is never unlinked or overwritten before the new file is ready.
        const lifecycleGeneration = this._lifecycleGeneration;
        const preferredPaths = [...this._activeWallpaperPaths()];
        const renderGeneration = this._compositor.compositeAsync(
            monitors,
            assignments,
            modes,
            quality,
            {force, preferredPaths},
            result => {
            // Reject callbacks from an older enable() lifecycle or generation.
            if (lifecycleGeneration !== this._lifecycleGeneration ||
                !this._compositor || !this._bgSettings || !this._ssSettings) {
                this._finishShuffleRequest(shuffleRequest, {
                    ok: false,
                    code: 'cancelled',
                    message: 'Extension lifecycle changed during rendering',
                });
                return;
            }
            // A newer selection can retire this logical request before its
            // compositor completion reaches the main loop. Never let a
            // terminal request publish merely because its worker won a race.
            if (shuffleRequest?.done)
                return;
            if (result.generation !== this._compositor.generation) {
                if (shuffleRequest && !shuffleRequest.done &&
                    this._pendingShuffleApply === shuffleRequest &&
                    shuffleRequest.fingerprint === _assignmentFingerprint(assignments)) {
                    // A mode/quality/layout/forced reapply took ownership of
                    // the same selected assignment. Its newest render will
                    // commit or discard the cursor; this stale callback must
                    // not consume the token.
                    return;
                }
                if (shuffleRequest) {
                    this._scheduler?.discardSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    );
                }
                this._finishShuffleRequest(shuffleRequest, result);
                return;
            }

            if (result.code === 'cancelled' && shuffleRequest?.cancelReason) {
                this._finishShuffleRequest(shuffleRequest, result);
                return;
            }

            this._lastRenderResult = result;
            this._indicator?._refresh();
            if (!result.ok) {
                if (shuffleRequest) {
                    this._scheduler?.discardSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    );
                    this._restoreShuffleAssignments(shuffleRequest);
                }
                this._writeRuntimeStatus({
                    durationMs: result.durationMs,
                    lastError: result.message || result.code,
                    lastAttemptAt: Date.now(),
                    generation: result.generation,
                });
                if (!['cancelled', 'stale', 'superseded'].includes(result.code) &&
                    result.code !== this._lastNotifiedRenderCode) {
                    this._lastNotifiedRenderCode = result.code;
                    Main.notify(
                        'Wallpaper Suite',
                        `Previous wallpaper kept: ${result.message || result.code}`
                    );
                }
                this._finishShuffleRequest(shuffleRequest, result);
                return;
            }

            const previousPaths = this._activeWallpaperPaths();
            const liveAssignmentFingerprint =
                _assignmentFingerprint(this._readDict('monitor-assignments'));
            const assignmentsChanged = shuffleRequest
                ? shuffleRequest.contextFingerprint !== liveAssignmentFingerprint
                : assignmentFingerprint !== liveAssignmentFingerprint;
            const monitorsChanged = monitorFingerprint !==
                _monitorFingerprint(this._monitorMgr.monitors);
            const modesChanged = modeFingerprint !==
                _assignmentFingerprint(this._readDict('monitor-modes'));
            const qualityChanged = quality !==
                this._settings.get_int('composite-quality');
            if (assignmentsChanged || monitorsChanged || modesChanged || qualityChanged) {
                this._compositor.releaseObsolete(
                    [result.path],
                    this._activeWallpaperPaths()
                );
                if (shuffleRequest && (assignmentsChanged || monitorsChanged)) {
                    this._scheduler?.discardSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    );
                    this._restoreShuffleAssignments(shuffleRequest);
                    this._finishShuffleRequest(shuffleRequest, {
                        ok: false,
                        code: 'stale-context',
                        message: assignmentsChanged
                            ? 'Monitor assignments changed before publication'
                            : 'Monitor layout changed before publication',
                    });
                } else {
                    // Mode/quality changes do not invalidate the chosen image.
                    // Keep its logical ownership and render once more from the
                    // current settings; no stale bytes reach URI publication.
                    this._scheduleApply();
                }
                return;
            }
            const uri = Gio.File.new_for_path(result.path).get_uri();
            if (!this._publishUri(uri)) {
                if (shuffleRequest) {
                    this._scheduler?.discardSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    );
                    this._restoreShuffleAssignments(shuffleRequest);
                }
                this._lastRenderResult = {
                    ...result,
                    ok: false,
                    code: 'publication-failed',
                    message: 'Desktop settings rejected the new wallpaper URI',
                };
                this._indicator?._refresh();
                this._writeRuntimeStatus({
                    durationMs: result.durationMs,
                    lastError: 'Desktop settings rejected the new wallpaper URI',
                    lastAttemptAt: Date.now(),
                    generation: result.generation,
                });
                // The newly rendered file is not referenced; remove that exact
                // file only. All prior light/dark/lock files remain protected.
                const activeAfterFailure = this._activeWallpaperPaths();
                this._compositor.releaseObsolete([result.path], activeAfterFailure);
                this._finishShuffleRequest(shuffleRequest, this._lastRenderResult);
                return;
            }

            this._lastNotifiedRenderCode = null;
            const assignmentsSaved = shuffleRequest
                ? this._writeDictVerified('monitor-assignments', assignments)
                : true;
            let cursorError = '';
            if (shuffleRequest) {
                const committed = assignmentsSaved
                    ? this._scheduler?.commitSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    )
                    : false;
                if (!assignmentsSaved) {
                    this._scheduler?.discardSelection(
                        assignments,
                        shuffleRequest.selectionGeneration
                    );
                    console.warn('wallpaper-suite: published assignment state was not saved');
                    Main.notify(
                        'Wallpaper Suite',
                        'Wallpaper changed, but monitor assignment state could not be saved.'
                    );
                } else if (shuffleRequest.cursorCommitRequired && committed !== true) {
                    cursorError =
                        'Wallpaper published, but the sequential cursor could not be saved';
                    console.warn(`wallpaper-suite: ${cursorError}`);
                    Main.notify(
                        'Wallpaper Suite',
                        'Wallpaper changed, but sequential progress could not be saved. The next change may repeat it.'
                    );
                }
            }
            const timerReset = shuffleRequest?.resetTimer === true &&
                this._settings.get_boolean('rotation-enabled');
            if (timerReset)
                this._scheduler.resetDeadline();
            if (shuffleRequest?.source === 'scheduled')
                this._scheduler.markRotationSuccess();
            const stateError = [
                assignmentsSaved ? '' :
                    'Wallpaper published, but monitor assignments could not be saved',
                cursorError,
            ].filter(Boolean).join('; ');
            this._writeRuntimeStatus({
                lastRenderAt: Date.now(),
                lastAttemptAt: Date.now(),
                lastSelectionError: stateError,
                durationMs: result.durationMs,
                lastError: '',
                generation: result.generation,
                cacheHit: result.cacheHit,
                outputPath: result.path,
            });
            const activePaths = this._activeWallpaperPaths();
            // Publication is phase one; exact old-file release is phase two.
            // Every URI still referenced by light, dark, or lock screen is
            // protected, and no cache-directory glob is used.
            this._compositor.releaseObsolete(previousPaths, activePaths);
            this._finishShuffleRequest(shuffleRequest, stateError ? {
                ...result,
                ok: false,
                code: 'partial',
                message: stateError,
                changed: true,
                published: true,
                stateSaved: false,
                timerReset,
            } : {
                ...result,
                ok: true,
                code: 'published',
                message: '',
                changed: true,
                published: true,
                stateSaved: true,
                timerReset,
            });
        });
        if (shuffleRequest && !shuffleRequest.done)
            shuffleRequest.renderGeneration = renderGeneration;
    }

    _claimShuffleRequest(assignments, storedAssignments = assignments) {
        const request = this._pendingShuffleApply;
        if (!request)
            return null;
        if (request.fingerprint !== _assignmentFingerprint(assignments) ||
            request.contextFingerprint !== _assignmentFingerprint(storedAssignments)) {
            request.cancelReason =
                'Assignments changed before the wallpaper could be rendered';
            this._pendingShuffleApply = null;
            this._scheduler?.discardSelection(
                request.assignments,
                request.selectionGeneration
            );
            this._finishShuffleRequest(request, {
                ok: false,
                code: 'superseded',
                message: request.cancelReason,
            });
            if (request.renderGeneration)
                this._compositor?.cancel(request.renderGeneration);
            return null;
        }
        request.phase = 'render';
        return request;
    }

    _failShuffleRender(request, assignments, code, message) {
        if (!request)
            return;
        request.cancelReason = message;
        this._scheduler?.discardSelection(assignments, request.selectionGeneration);
        this._restoreShuffleAssignments(request);
        this._finishShuffleRequest(request, {ok: false, code, message});
        if (request.renderGeneration)
            this._compositor?.cancel(request.renderGeneration);
    }

    _finishShuffleRequest(request, result) {
        if (!request || request.done)
            return;
        request.done = true;
        if (this._pendingShuffleApply === request)
            this._pendingShuffleApply = null;
        this._shuffleRequests?.delete(request);
        try { request.onDone?.(result); } catch (error) {
            logError(error, 'wallpaper-suite: shuffle completion callback failed');
        }
        this._scheduleManualDrain();
    }

    _restoreShuffleAssignments(request) {
        if (!request?.assignments || !this._settings)
            return false;
        const currentFingerprint =
            _assignmentFingerprint(this._readDict('monitor-assignments'));
        const previousFingerprint =
            _assignmentFingerprint(request.previousAssignments);
        if (currentFingerprint === previousFingerprint)
            return true;
        if (currentFingerprint !== request.fingerprint)
            return false;
        if (!this._writeDictVerified(
            'monitor-assignments',
            request.previousAssignments
        ))
            return false;
        this._scheduleApply();
        return true;
    }

    _cancelShuffleRequests() {
        this._cancelMatchingShuffleRequests(
            () => true,
            'Wallpaper Suite was disabled',
            {restoreAssignments: true}
        );
        this._pendingShuffleApply = null;
    }

    _cancelScheduledShuffleRequests() {
        this._cancelMatchingShuffleRequests(
            request => request.source === 'scheduled',
            'Scheduled rotation was paused',
            {restoreAssignments: true}
        );
    }

    _cancelMatchingShuffleRequests(predicate, message, {restoreAssignments = false} = {}) {
        for (const request of [...(this._shuffleRequests || [])]) {
            if (request.done || !predicate(request))
                continue;
            request.cancelReason = message;

            if (request.phase === 'index') {
                this._scheduler?.cancelSelection(
                    request.selectionGeneration,
                    'cancelled',
                    message
                );
            }
            if (request.done)
                continue;

            if (request.assignments) {
                this._scheduler?.discardSelection(
                    request.assignments,
                    request.selectionGeneration
                );
            }
            if (request.renderGeneration)
                this._compositor?.cancel(request.renderGeneration);

            if (!request.done) {
                this._finishShuffleRequest(request, {
                    ok: false,
                    code: 'cancelled',
                    message,
                });
            }

            // New selections remain in memory until publication. The restore
            // helper is still defensive for upgrades or external writers, and
            // uses compare-and-swap verification before touching durable state.
            if (restoreAssignments)
                this._restoreShuffleAssignments(request);
        }
    }

    _notifySelectionFailure(result) {
        if (['cancelled', 'disposed', 'stale', 'superseded', 'folder-changed']
            .includes(result.code) || result.code === this._lastNotifiedSelectionCode)
            return;
        this._lastNotifiedSelectionCode = result.code;
        const message = result.code === 'library-unset'
            ? 'Choose a wallpaper library folder in Settings first.'
            : result.code === 'library-empty'
                ? 'No supported images were found in the wallpaper library.'
                : `Library scan failed: ${result.message || result.code}`;
        Main.notify('Wallpaper Suite', message);
    }

    /**
     * Publish light, dark, and lock URI keys as one logical operation. Delayed
     * Gio.Settings writes are reverted before apply if any key rejects the
     * value; a post-apply verification rollback restores the complete snapshot
     * on backend failure.
     */
    _publishUri(uri) {
        const snapshot = {
            light: this._bgSettings.get_string('picture-uri'),
            dark: this._bgSettings.get_string('picture-uri-dark'),
            backgroundOptions: this._bgSettings.get_string('picture-options'),
            lock: this._ssSettings.get_string('picture-uri'),
            lockOptions: this._ssSettings.get_string('picture-options'),
        };

        try {
            this._bgSettings.delay();
            this._ssSettings.delay();
            const accepted = [
                this._bgSettings.set_string('picture-uri', uri),
                this._bgSettings.set_string('picture-uri-dark', uri),
                this._bgSettings.set_string('picture-options', 'spanned'),
                this._ssSettings.set_string('picture-uri', uri),
                this._ssSettings.set_string('picture-options', 'spanned'),
            ].every(Boolean);
            if (!accepted) {
                this._bgSettings.revert();
                this._ssSettings.revert();
                return false;
            }
            this._bgSettings.apply();
            this._ssSettings.apply();

            const verified =
                this._bgSettings.get_string('picture-uri') === uri &&
                this._bgSettings.get_string('picture-uri-dark') === uri &&
                this._ssSettings.get_string('picture-uri') === uri;
            if (verified)
                return true;
        } catch (error) {
            logError(error, 'wallpaper-suite: wallpaper URI publication failed');
            try { this._bgSettings.revert(); } catch (_) {}
            try { this._ssSettings.revert(); } catch (_) {}
        }

        this._restoreWallpaperSettings(snapshot);
        return false;
    }

    _restoreWallpaperSettings(snapshot) {
        try {
            this._bgSettings.set_string('picture-uri', snapshot.light);
            this._bgSettings.set_string('picture-uri-dark', snapshot.dark);
            this._bgSettings.set_string('picture-options', snapshot.backgroundOptions);
            this._bgSettings.apply();
        } catch (error) {
            logError(error, 'wallpaper-suite: failed to restore desktop wallpaper settings');
        }
        try {
            this._ssSettings.set_string('picture-uri', snapshot.lock);
            this._ssSettings.set_string('picture-options', snapshot.lockOptions);
            this._ssSettings.apply();
        } catch (error) {
            logError(error, 'wallpaper-suite: failed to restore lock wallpaper settings');
        }
    }

    _activeWallpaperPaths() {
        const paths = new Set();
        const uris = [
            this._bgSettings?.get_string('picture-uri'),
            this._bgSettings?.get_string('picture-uri-dark'),
            this._ssSettings?.get_string('picture-uri'),
        ];
        for (const uri of uris) {
            if (!uri?.startsWith('file:'))
                continue;
            try {
                const path = Gio.File.new_for_uri(uri).get_path();
                if (path)
                    paths.add(path);
            } catch (_) {}
        }
        return paths;
    }

    _readRuntimeStatus() {
        try {
            const [, contents] = GLib.file_get_contents(this._statusPath);
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    /** Atomically publish the prefs health/status contract. */
    _writeRuntimeStatus(updates = {}) {
        if (!this._statusPath)
            return;
        const pool = this._scheduler?.poolStatus || {};
        const monitorKeys = this._monitorMgr?.monitors?.map(monitor => monitor.connector) ||
            this._runtimeStatus?.monitorKeys || [];
        this._runtimeStatus = {
            ...(this._runtimeStatus || {}),
            ...updates,
            schemaVersion: 2,
            nextRotationAt: (this._scheduler?.nextDeadline || 0) * 1000,
            lastRotationAttemptAt: (this._scheduler?.lastRotationAttempt || 0) * 1000,
            lastRotationSuccessAt: (this._scheduler?.lastRotationSuccess || 0) * 1000,
            poolCount: pool.count ?? this._runtimeStatus?.poolCount ?? 0,
            poolFolder: this._scheduler
                ? pool.folder || ''
                : this._runtimeStatus?.poolFolder || '',
            poolLastScanAt: this._scheduler
                ? (pool.lastScanEpoch || 0) * 1000
                : this._runtimeStatus?.poolLastScanAt || 0,
            poolLastAttemptAt: this._scheduler
                ? (pool.lastAttemptEpoch || 0) * 1000
                : this._runtimeStatus?.poolLastAttemptAt || 0,
            poolLastAttemptOk: this._scheduler
                ? pool.lastAttemptOk === true
                : this._runtimeStatus?.poolLastAttemptOk ?? false,
            poolError: pool.error || '',
            poolIndexing: pool.indexing ?? false,
            poolIndexGeneration: pool.generation ??
                (this._runtimeStatus?.poolIndexGeneration || 0),
            poolIndexDurationMs: pool.durationMs ??
                (this._runtimeStatus?.poolIndexDurationMs || 0),
            poolTruncated: pool.truncated ?? false,
            poolWatcherDegraded: pool.watcherDegraded ?? false,
            poolWatcherErrors: pool.watcherErrors || [],
            monitorCount: monitorKeys.length,
            monitorKeys,
            updatedAt: Date.now(),
        };

        const directory = GLib.path_get_dirname(this._statusPath);
        const tempPath = `${this._statusPath}.tmp.${GLib.uuid_string_random()}`;
        try {
            GLib.mkdir_with_parents(directory, 0o700);
            GLib.file_set_contents(tempPath, JSON.stringify(this._runtimeStatus, null, 2));
            try { GLib.chmod(tempPath, 0o600); } catch (_) {}
            Gio.File.new_for_path(tempPath).move(
                Gio.File.new_for_path(this._statusPath),
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );
        } catch (error) {
            try { GLib.unlink(tempPath); } catch (_) {}
            logError(error, 'wallpaper-suite: failed to write runtime status');
        }
    }

    _readDict(key) {
        const v = this._settings.get_value(key);
        return v.deep_unpack();
    }

    _writeDict(key, obj) {
        return this._settings.set_value(key, new GLib.Variant('a{ss}', obj));
    }

    _writeDictVerified(key, obj) {
        try {
            const accepted = this._writeDict(key, obj);
            return accepted !== false &&
                _assignmentFingerprint(this._readDict(key)) ===
                    _assignmentFingerprint(obj);
        } catch (error) {
            logError(error, `wallpaper-suite: failed to persist ${key}`);
            return false;
        }
    }
}

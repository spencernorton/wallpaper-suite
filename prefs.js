// Adwaita preferences window for Wallpaper Suite.
//
// Page 1: General — wallpaper folder, rotation schedule, quality.
// Page 2: Monitors — one expander per detected monitor with image picker,
//                    display mode combo, and a live thumbnail.

import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ThumbnailLoader} from './thumbnailCache.js';
import {DisplayIdentityClient} from './displayIdentityClient.js';
import {resolveAssignments, topologyKey} from './displayIdentity.js';
import {LibraryIndexer} from './libraryIndex.js';
import {openLibraryPicker} from './libraryPicker.js';
import {
    assignmentHealth,
    formatBytes,
    formatHealth,
    formatTimestamp,
    newestComposite,
    readBuildInfo,
    readRuntimeStatus,
} from './statusModel.js';

const EXTENSION_UUID = 'wallpaper-suite@spencercnorton.github.io';
const CONTROL_BUS_NAME = 'dev.norvi.WallpaperSuite1';
const CONTROL_OBJECT_PATH = '/dev/norvi/WallpaperSuite1';
const CONTROL_INTERFACE = 'dev.norvi.WallpaperSuite1';
const CONTROL_ACTION_TIMEOUT_MS = 30_000;
const INDETERMINATE_RESULT_CODES = new Set([
    'durability-failed',
    'internal-error',
    'interrupted',
]);

// Compute a preview-canvas size that matches the monitor's aspect ratio.
function previewSize(monitorW, monitorH) {
    const aspect = monitorW / monitorH;
    let pw = 320, ph = Math.round(pw / aspect);
    if (ph > 200) { ph = 200; pw = Math.round(ph * aspect); }
    return [Math.max(1, pw), Math.max(1, ph)];
}

const MODES = [
    {id: 'zoom',    label: 'Zoom (cover, crops to fill)'},
    {id: 'fit',     label: 'Fit (contain, letterboxed)'},
    {id: 'stretch', label: 'Stretch (distorts to fill)'},
    {id: 'center',  label: 'Center (1:1, centered)'},
    {id: 'tile',    label: 'Tile (repeated)'},
];
const ROT_MODES = [
    {id: 'random',     label: 'Random'},
    {id: 'sequential', label: 'Sequential (alphabetical)'},
];

export function parsePendingAction(text) {
    if (typeof text !== 'string' || text.length > 32768)
        throw new Error('Saved action exceeds the recovery limit');
    const value = JSON.parse(text);
    const fields = ['monitor', 'image', 'mode', 'expected-image', 'expected-mode', 'topology'];
    if (!value || value.method !== 'Apply' || !value.options ||
        Object.keys(value).some(key => !['method', 'options', 'undo'].includes(key)) ||
        (value.undo !== undefined && typeof value.undo !== 'boolean') ||
        Object.keys(value.options).length !== fields.length ||
        !fields.every(key => typeof value.options[key] === 'string' &&
            value.options[key].length <= (key === 'topology' ? 8192 : 4096) &&
            !value.options[key].includes('\0')))
        throw new Error('Invalid saved apply action');
    return value;
}

export default class WallpaperSuitePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(860, 760);
        window.set_search_enabled(true);

        const settings = this.getSettings();
        this._settings = settings;
        this._window = window;

        // Keep refs so we can rewire on monitor-changes / setting-changes.
        this._monitorRows = new Map();
        this._undoStack = [];
        this._libraryIndexer = new LibraryIndexer(this.path, {
            probeDimensions: false,
        });
        this._controlCancellable = new Gio.Cancellable();
        this._controlPollId = 0;
        this._controlActionActive = false;
        this._controlActionGeneration = 0;
        const rawPending = settings.get_value(
            'control-pending-operation').deepUnpack();
        const persistedRequestId = typeof rawPending?.['request-id'] === 'string'
            ? rawPending['request-id'].trim()
            : '';
        const persistedOperationId = typeof rawPending?.['operation-id'] === 'string'
            ? rawPending['operation-id'].trim()
            : '';
        const pendingValid = persistedRequestId.length > 0 &&
            persistedRequestId.length <= 128 &&
            persistedOperationId.length <= 128 &&
            Object.keys(rawPending || {}).every(key =>
                ['request-id', 'operation-id', 'action'].includes(key));
        this._controlPendingAction = null;
        this._controlPendingActionFault = false;
        if (rawPending.action) {
            try { this._controlPendingAction = parsePendingAction(rawPending.action); }
            catch (_) { this._controlPendingActionFault = true; }
        }
        this._controlPendingRequestId = pendingValid ? persistedRequestId : null;
        this._controlPendingOperationId = pendingValid
            ? persistedOperationId || null
            : null;
        this._controlPendingNeedsResolution = Boolean(
            this._controlPendingRequestId);
        if (Object.keys(rawPending || {}).length > 0 && !pendingValid) {
            settings.set_value(
                'control-pending-operation',
                new GLib.Variant('a{ss}', {})
            );
        }
        this._statusCancellable = null;
        this._statusRefreshGeneration = 0;
        this._monitorSignals = [];
        this._monitorRefreshId = 0;
        this._identityClient = new DisplayIdentityClient(() => this._refreshIdentities());

        window.connect('close-request', () => {
            this._libraryIndexer?.dispose();
            this._libraryIndexer = null;
            this._controlCancellable?.cancel();
            this._controlCancellable = null;
            this._controlActionActive = false;
            this._controlActionGeneration++;
            // Keep the GSettings identity intact. A later Preferences window
            // must query the same operation before it can create a new one.
            this._controlPendingRequestId = null;
            this._controlPendingOperationId = null;
            this._controlPendingNeedsResolution = false;
            this._statusCancellable?.cancel();
            this._statusCancellable = null;
            if (this._controlPollId) {
                GLib.Source.remove(this._controlPollId);
                this._controlPollId = 0;
            }
            this._window = null;
            for (const row of this._monitorRows.values())
                row.previewLoader?.cancel();
            for (const [object, id] of this._monitorSignals)
                object.disconnect(id);
            this._monitorSignals = [];
            if (this._monitorRefreshId)
                GLib.Source.remove(this._monitorRefreshId);
            this._monitorRefreshId = 0;
            this._identityClient.dispose();
        });

        window.add(this._buildMonitorsPage(window, settings));
        window.add(this._buildGeneralPage(window, settings));
    }

    _toast(msg, priority = Adw.ToastPriority.NORMAL) {
        if (!this._window) {
            log(`wallpaper-suite: ${msg}`);
            return;
        }
        // Adw.PreferencesWindow has an internal toast overlay since libadwaita 1.4.
        const toast = new Adw.Toast({title: msg, timeout: 4, priority});
        this._window.add_toast(toast);
    }

    _setControlPendingOperation(requestId, operationId = '',
        needsResolution = false, action = this._controlPendingAction) {
        const normalizedRequestId = `${requestId || ''}`.trim();
        const normalizedOperationId = `${operationId || ''}`.trim();
        if (normalizedRequestId.length > 128 ||
            normalizedOperationId.length > 128 ||
            (normalizedOperationId && !normalizedRequestId))
            return false;
        const value = {};
        if (normalizedRequestId) {
            value['request-id'] = normalizedRequestId;
            if (normalizedOperationId)
                value['operation-id'] = normalizedOperationId;
            if (action)
                value.action = JSON.stringify(action);
        }
        if (!this._settings?.set_value(
            'control-pending-operation',
            new GLib.Variant('a{ss}', value)
        ))
            return false;
        this._controlPendingRequestId = normalizedRequestId || null;
        this._controlPendingOperationId = normalizedOperationId || null;
        this._controlPendingNeedsResolution = Boolean(
            normalizedRequestId && needsResolution);
        this._controlPendingAction = normalizedRequestId ? action : null;
        this._controlPendingActionFault = false;
        return true;
    }

    _toastAction(msg, actionLabel, onAction,
        priority = Adw.ToastPriority.HIGH) {
        if (!this._window) {
            log(`wallpaper-suite: ${msg}`);
            return;
        }
        const toast = new Adw.Toast({
            title: msg,
            timeout: 0,
            priority,
            button_label: actionLabel,
        });
        toast.connect('button-clicked', onAction);
        this._window.add_toast(toast);
    }

    // ---------- General page ----------

    _buildGeneralPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Rotation and Library',
            icon_name: 'preferences-system-symbolic',
        });

        // --- Source folder ---
        const sourceGroup = new Adw.PreferencesGroup({
            title: 'Wallpaper Library',
            description: 'A folder of images used as the rotation pool and for the "Random from pool" picker.',
        });

        const folderRow = new Adw.ActionRow({
            title: 'Library folder',
            subtitle: settings.get_string('wallpaper-folder') || 'Not set',
        });
        const folderBtn = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        folderBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose wallpaper library folder'});
            const current = settings.get_string('wallpaper-folder');
            if (current && GLib.file_test(current, GLib.FileTest.IS_DIR))
                dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (src, res) => {
                try {
                    const file = dialog.select_folder_finish(res);
                    settings.set_string('wallpaper-folder', file.get_path());
                } catch (e) {
                    if (!`${e}`.includes('Dismissed'))
                        logError(e);
                }
            });
        });
        folderRow.add_suffix(folderBtn);
        folderRow.activatable_widget = folderBtn;

        const folderSub = settings.connect('changed::wallpaper-folder', () => {
            // Preference actions are scoped to the folder that started them.
            // Cancelling here restores their button immediately and prevents
            // an old-folder result from writing assignments.
            this._libraryIndexer?.cancel();
            folderRow.subtitle = settings.get_string('wallpaper-folder') || 'Not set';
        });
        window.connect('close-request', () => settings.disconnect(folderSub));

        sourceGroup.add(folderRow);

        // --- Quick actions ---
        const actionGroup = new Adw.PreferencesGroup();
        const shuffleRow = new Adw.ActionRow({
            title: 'Next background now',
            subtitle: 'Advance unpinned displays using Random or Sequential selection.',
        });
        const shuffleBtn = new Gtk.Button({
            label: this._controlPendingRequestId ? 'Recheck' : 'Next',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        shuffleBtn.connect('clicked', () => this._triggerNext(shuffleBtn));
        shuffleBtn._operationIdleLabel = 'Next';
        shuffleRow.add_suffix(shuffleBtn);
        shuffleRow.activatable_widget = shuffleBtn;
        actionGroup.add(shuffleRow);

        // --- Rotation ---
        const rotGroup = new Adw.PreferencesGroup({
            title: 'Scheduled Rotation',
            description: 'Periodically swap wallpapers from the library.',
        });

        const rotEnabled = new Adw.SwitchRow({
            title: 'Enable rotation',
        });
        settings.bind('rotation-enabled', rotEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        rotGroup.add(rotEnabled);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval (minutes)',
            subtitle: 'Minimum 1 minute. 60 = hourly, 1440 = daily.',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10080, step_increment: 1, page_increment: 15,
                value: settings.get_int('rotation-interval-minutes'),
            }),
        });
        settings.bind('rotation-interval-minutes', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        rotGroup.add(intervalRow);

        const rotModeRow = new Adw.ComboRow({
            title: 'Selection',
            model: this._stringList(ROT_MODES.map(m => m.label)),
        });
        rotModeRow.selected = Math.max(0, ROT_MODES.findIndex(m => m.id === settings.get_string('rotation-mode')));
        rotModeRow.connect('notify::selected', () => {
            settings.set_string('rotation-mode', ROT_MODES[rotModeRow.selected].id);
        });
        rotGroup.add(rotModeRow);

        const syncRow = new Adw.SwitchRow({
            title: 'Synchronize monitors',
            subtitle: 'All monitors rotate to the same image. Off = each monitor picks independently.',
        });
        settings.bind('rotation-sync-monitors', syncRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        rotGroup.add(syncRow);
        const resetRow = new Adw.SwitchRow({title: 'Restart timer after Next',
            subtitle: 'Start a fresh interval after a manual Next action.'});
        settings.bind('manual-next-reset-timer', resetRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        rotGroup.add(resetRow);

        // --- Appearance ---
        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
        });
        const indicatorRow = new Adw.SwitchRow({
            title: 'Show top-bar indicator',
            subtitle: 'Wallpaper icon in the panel with shuffle/pause/settings menu.',
        });
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appearanceGroup.add(indicatorRow);

        // --- Advanced ---
        const qualityGroup = new Adw.PreferencesGroup({
            title: 'Advanced',
        });
        const qualityRow = new Adw.SpinRow({
            title: 'Composite JPEG quality',
            subtitle: '92 is visually lossless. Lower to shrink the cache file.',
            adjustment: new Gtk.Adjustment({
                lower: 60, upper: 100, step_increment: 1, page_increment: 5,
                value: settings.get_int('composite-quality'),
            }),
        });
        settings.bind('composite-quality', qualityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        qualityGroup.add(qualityRow);

        page.add(sourceGroup);
        page.add(actionGroup);
        page.add(rotGroup);
        page.add(appearanceGroup);
        page.add(qualityGroup);
        page.add(this._buildStatusGroup(settings));
        return page;
    }

    _buildStatusGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Status and Health',
            description: 'Installed build, runtime state, source availability, and render health.',
        });
        const buildRow = new Adw.ActionRow({title: 'Installed build'});
        const extensionRow = new Adw.ActionRow({title: 'Shell extension'});
        const controlRow = new Adw.ActionRow({title: 'Control API'});
        const libraryRow = new Adw.ActionRow({title: 'Library health'});
        const renderRow = new Adw.ActionRow({title: 'Last successful render'});
        const cacheRow = new Adw.ActionRow({title: 'Composite cache'});
        const rotationRow = new Adw.ActionRow({title: 'Rotation schedule'});
        const errorRow = new Adw.ActionRow({title: 'Last action warning', visible: false});
        const refreshButton = new Gtk.Button({
            label: 'Refresh status',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Re-read extension, library, and render status',
        });
        const refreshRow = new Adw.ActionRow({
            title: 'Refresh diagnostics',
            subtitle: 'Status is read-only and does not interrupt the current wallpaper.',
        });
        refreshRow.add_suffix(refreshButton);
        refreshRow.activatable_widget = refreshButton;

        for (const row of [buildRow, extensionRow, controlRow, libraryRow, renderRow, cacheRow,
            rotationRow, errorRow, refreshRow])
            group.add(row);

        const refresh = () => {
            const generation = ++this._statusRefreshGeneration;
            this._statusCancellable?.cancel();
            const cancellable = new Gio.Cancellable();
            this._statusCancellable = cancellable;
            refreshButton.sensitive = false;
            refreshButton.label = 'Checking…';

            const build = readBuildInfo(_moduleDirectory());
            buildRow.subtitle = `v${build.version} · ${build.commit}`;

            const runtime = readRuntimeStatus();
            let shellSettingsAvailable = false;
            let shellConfigured = false;
            let userExtensionsEnabled = true;
            try {
                const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
                shellConfigured = shell.get_strv('enabled-extensions').includes(EXTENSION_UUID);
                userExtensionsEnabled = shell.get_boolean('disable-user-extensions') === false;
                shellSettingsAvailable = true;
                if (!userExtensionsEnabled)
                    extensionRow.subtitle = 'Configured, but user extensions are globally disabled';
                else if (!shellConfigured)
                    extensionRow.subtitle = 'Disabled in GNOME Shell';
                else
                    extensionRow.subtitle = 'Checking live Shell state…';
            } catch (_) {
                extensionRow.subtitle = 'State unavailable outside a GNOME Shell session';
            }

            controlRow.subtitle = 'Checking live control service…';

            let pendingLiveQueries = 2;
            const isCurrent = () => this._window &&
                this._statusRefreshGeneration === generation &&
                this._statusCancellable === cancellable &&
                !cancellable.is_cancelled();
            const queryFinished = () => {
                if (!isCurrent())
                    return;
                pendingLiveQueries--;
                if (pendingLiveQueries > 0)
                    return;
                refreshButton.sensitive = true;
                refreshButton.label = 'Refresh status';
                this._statusCancellable = null;
            };

            _extensionRuntimeStateAsync(cancellable, runtimeState => {
                if (!isCurrent())
                    return;
                if (!shellSettingsAvailable) {
                    extensionRow.subtitle = 'State unavailable outside a GNOME Shell session';
                } else if (!userExtensionsEnabled) {
                    extensionRow.subtitle = 'Configured, but user extensions are globally disabled';
                } else if (!shellConfigured) {
                    extensionRow.subtitle = 'Disabled in GNOME Shell';
                } else if (runtimeState.state === 1) {
                    extensionRow.subtitle = 'Active in the current GNOME Shell session';
                } else if (runtimeState.state === 3) {
                    extensionRow.subtitle = runtimeState.error
                        ? `Extension error · ${runtimeState.error}`
                        : 'Extension error reported by GNOME Shell';
                } else if (runtimeState.state === 4) {
                    extensionRow.subtitle = 'Enabled, but incompatible with this GNOME Shell version';
                } else if (runtimeState.state !== null) {
                    extensionRow.subtitle = 'Enabled, but not active in the current GNOME Shell session';
                } else if (runtime.extensionActive === true) {
                    extensionRow.subtitle = `Live state unavailable · last active report ${formatTimestamp(Number(runtime.updatedAt))}`;
                } else {
                    extensionRow.subtitle = 'Enabled; live Shell state is unavailable';
                }
                queryFinished();
            });

            _controlRuntimeStateAsync(cancellable, control => {
                if (!isCurrent())
                    return;
                if (control.active && control.apiVersion >= 1) {
                    controlRow.subtitle = `Ready · D-Bus API v${control.apiVersion} · ` +
                        `${control.busy ? 'action in progress' : 'idle'}`;
                } else if (runtime.controlApiAvailable === true) {
                    controlRow.subtitle = `Live service unavailable · last ready report ${formatTimestamp(Number(runtime.updatedAt))}`;
                } else {
                    controlRow.subtitle = 'Unavailable until the Shell extension is active';
                }
                queryFinished();
            });

            const assignments = this._readDict(settings, 'monitor-assignments');
            // General is constructed before the Monitors page, so derive the
            // live inventory directly instead of relying on row construction.
            const currentMonitorKeys = this._currentMonitorKeys();
            const monitorKeys = currentMonitorKeys.length > 0
                ? currentMonitorKeys
                : Array.isArray(runtime.monitorKeys) ? runtime.monitorKeys : [];
            const selectedFolder = settings.get_string('wallpaper-folder');
            let canonicalSelectedFolder = selectedFolder;
            try {
                canonicalSelectedFolder = selectedFolder
                    ? GLib.canonicalize_filename(selectedFolder, null) : '';
            } catch (_) {}
            const indexedFolder = `${runtime.poolFolder || ''}`;
            const hasSelectedFolder = Boolean(canonicalSelectedFolder);
            const indexMatchesFolder = indexedFolder === canonicalSelectedFolder;
            const poolCount = indexMatchesFolder
                ? Math.max(0, Number(runtime.poolCount) || 0)
                : 0;
            const libraryDetails = hasSelectedFolder
                ? [formatHealth(poolCount, assignmentHealth(assignments, monitorKeys))]
                : ['No library folder selected'];
            if (hasSelectedFolder && !indexMatchesFolder) {
                libraryDetails.push(indexedFolder
                    ? 'library changed; awaiting a fresh runtime index'
                    : 'runtime index identity unavailable; awaiting a fresh index');
            }
            const lastIndexSuccess = indexMatchesFolder
                ? _timestampValue(runtime.poolLastScanAt) : 0;
            const lastIndexAttempt = indexMatchesFolder
                ? _timestampValue(runtime.poolLastAttemptAt) : 0;
            if (hasSelectedFolder && indexMatchesFolder && runtime.poolIndexing === true)
                libraryDetails.push('indexing in background');
            else if (lastIndexSuccess > 0)
                libraryDetails.push(
                    `indexed ${formatTimestamp(lastIndexSuccess)}`);
            if (runtime.poolLastAttemptOk === false && lastIndexAttempt > 0)
                libraryDetails.push(`failed attempt ${formatTimestamp(lastIndexAttempt)}`);
            if (indexMatchesFolder && runtime.poolTruncated === true)
                libraryDetails.push('configured index limit reached');
            const indexDuration = Number(runtime.poolIndexDurationMs);
            if (Number.isFinite(indexDuration) && indexDuration >= 0 &&
                lastIndexAttempt > 0)
                libraryDetails.push(`${indexDuration.toFixed(0)} ms`);
            if (indexMatchesFolder && runtime.poolWatcherDegraded === true)
                libraryDetails.push('live watch degraded; periodic reconciliation active');
            const poolError = indexMatchesFolder
                ? `${runtime.poolError || ''}`.trim() : '';
            if (poolError)
                libraryDetails.push(poolError);
            libraryRow.subtitle = libraryDetails.join(' · ');

            const composite = newestComposite();
            const lastRender = _timestampValue(runtime.lastRenderAt) ||
                (composite ? composite.modifiedUsec / 1000 : 0);
            const duration = Number(runtime.durationMs);
            const renderDetails = [];
            if (lastRender > 0)
                renderDetails.push(formatTimestamp(lastRender));
            if (Number.isFinite(duration) && duration >= 0)
                renderDetails.push(`${duration.toFixed(0)} ms`);
            if (composite)
                renderDetails.push(formatBytes(composite.size));
            renderRow.subtitle = renderDetails.length > 0
                ? renderDetails.join(' · ')
                : 'No completed composite found';

            const prunedCount = Math.max(0, Number(runtime.cachePrunedCount) || 0);
            const cleanupErrors = Array.isArray(runtime.cacheCleanupErrors)
                ? runtime.cacheCleanupErrors : [];
            cacheRow.subtitle = cleanupErrors.length > 0
                ? `${cleanupErrors.length} cleanup warning${cleanupErrors.length === 1 ? '' : 's'} · no active file was removed`
                : `${prunedCount} stale artifact${prunedCount === 1 ? '' : 's'} removed at startup · active files protected`;

            const enabled = settings.get_boolean('rotation-enabled');
            const minutes = settings.get_int('rotation-interval-minutes');
            const nextRotation = _timestampValue(runtime.nextRotationAt);
            const rotationDetails = [enabled
                ? nextRotation > 0
                    ? `Next rotation ${formatTimestamp(nextRotation)} · every ${minutes} min`
                    : `Enabled · every ${minutes} minute${minutes === 1 ? '' : 's'}`
                : 'Paused'];
            const lastRotationSuccess = _timestampValue(runtime.lastRotationSuccessAt);
            const lastRotationAttempt = _timestampValue(runtime.lastRotationAttemptAt);
            if (lastRotationSuccess > 0)
                rotationDetails.push(`last published ${formatTimestamp(lastRotationSuccess)}`);
            if (lastRotationAttempt > lastRotationSuccess)
                rotationDetails.push(`last attempt ${formatTimestamp(lastRotationAttempt)}`);
            rotationRow.subtitle = rotationDetails.join(' · ');

            const lastError = `${runtime.lastError || runtime.lastSelectionError || ''}`.trim();
            errorRow.visible = Boolean(lastError);
            errorRow.subtitle = lastError || '';
        };
        refreshButton.connect('clicked', refresh);
        refresh();
        return group;
    }

    _currentMonitorKeys() {
        const display = Gdk.Display.get_default();
        if (!display)
            return [];
        const monitors = display.get_monitors();
        const keys = [];
        for (let index = 0; index < monitors.get_n_items(); index++) {
            const geometry = monitors.get_item(index).geometry;
            keys.push(`${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`);
        }
        return keys;
    }

    // ---------- Monitors page ----------

    _buildMonitorsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Wallpapers',
            icon_name: 'video-display-symbolic',
        });

        const overview = new Adw.PreferencesGroup({title: 'Your displays',
            description: 'Select a display below, browse the library, and preview a choice before applying it.'});
        this._overview = new Gtk.DrawingArea({content_height: 150, hexpand: true,
            tooltip_text: 'Current display arrangement. Click a display to open its controls.'});
        this._overview.set_draw_func((area, cr, width, height) => this._drawOverview(cr, width, height));
        const gesture = new Gtk.GestureClick();
        gesture.connect('released', (_gesture, _count, x, y) => {
            const hit = this._overviewRects?.find(rect => x >= rect.x && y >= rect.y &&
                x < rect.x + rect.width && y < rect.y + rect.height);
            if (!hit)
                return;
            for (const [key, row] of this._monitorRows)
                row.expander.expanded = key === hit.key;
            this._selectedMonitor = hit.key;
            this._overview.queue_draw();
        });
        this._overview.add_controller(gesture);
        overview.add(this._overview);
        page.add(overview);
        const rotation = new Adw.PreferencesGroup({title: 'Rotation'});
        const enabled = new Adw.SwitchRow({title: 'Automatic rotation',
            subtitle: 'Pinned displays keep their image. Manual choices remain available.'});
        settings.bind('rotation-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        rotation.add(enabled);
        const scheduleRow = new Adw.ActionRow({title: 'Next change'});
        const nextButton = new Gtk.Button({label: this._controlPendingRequestId ? 'Recheck' : 'Next',
            valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        nextButton._operationIdleLabel = 'Next';
        nextButton.connect('clicked', () => this._triggerNext(nextButton));
        this._nextButton = nextButton;
        scheduleRow.add_suffix(nextButton);
        rotation.add(scheduleRow);
        page.add(rotation);
        const updateSchedule = () => {
            const deadline = Number(settings.get_int64('rotation-next-deadline'));
            const seconds = Math.max(0, deadline - Math.floor(Date.now() / 1000));
            const pins = settings.get_strv('pinned-monitors');
            const count = [...this._monitorRows.values()].filter(row =>
                pins.includes(row.identity || row.connector) || pins.includes(row.connector)).length;
            scheduleRow.subtitle = !settings.get_boolean('rotation-enabled') ? 'Paused · Next is available for unpinned displays'
                : `${deadline > 0 ? `In ${Math.floor(seconds / 60)}m ${seconds % 60}s` : 'Waiting for the active extension'} · ${count} pinned`;
            return GLib.SOURCE_CONTINUE;
        };
        const scheduleTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, updateSchedule);
        window.connect('close-request', () => GLib.Source.remove(scheduleTimer));
        updateSchedule();

        const group = new Adw.PreferencesGroup({
            title: 'Per-Monitor Wallpaper',
            description: 'Assign an image and display mode for each connected monitor.',
        });

        const undoRow = new Adw.ActionRow({
            title: 'Undo monitor change',
            subtitle: 'No monitor changes to undo.',
        });
        const undoButton = new Gtk.Button({
            label: 'Undo',
            valign: Gtk.Align.CENTER,
            sensitive: false,
            tooltip_text: 'Restore the previous monitor assignment or display mode',
        });
        undoButton._operationIdleLabel = 'Undo';
        undoButton.connect('clicked', () => this._undoLast(settings));
        undoRow.add_suffix(undoButton);
        undoRow.activatable_widget = undoButton;
        group.add(undoRow);
        this._undoRow = undoRow;
        this._undoButton = undoButton;

        const display = Gdk.Display.get_default();
        const monitors = display.get_monitors();
        let emptyRow = null;
        const rebuild = () => {
            this._monitorRefreshId = 0;
            for (const row of this._monitorRows.values()) {
                row.previewLoader?.cancel();
                group.remove(row.expander);
            }
            this._monitorRows.clear();
            if (emptyRow) {
                group.remove(emptyRow);
                emptyRow = null;
            }
            for (const [object, id] of this._monitorSignals.splice(1))
                object.disconnect(id);
            const n = monitors.get_n_items();
            if (!n) {
                emptyRow = new Adw.ActionRow({title: 'No monitors detected',
                    subtitle: 'Connect a display. This page updates automatically.'});
                group.add(emptyRow);
            }
            for (let i = 0; i < n; i++) {
                const mon = monitors.get_item(i);
                const row = this._buildMonitorRow(window, settings, mon, i);
                group.add(row.expander);
                this._monitorRows.set(row.connector, row);
                this._monitorSignals.push([mon, mon.connect('notify::geometry', schedule)]);
                this._monitorSignals.push([mon, mon.connect('notify::scale-factor', schedule)]);
            }
            this._refreshIdentities();
            this._overview?.queue_draw();
            return GLib.SOURCE_REMOVE;
        };
        const schedule = () => {
            if (this._window && !this._monitorRefreshId) {
                this._identityClient.refresh();
                this._monitorRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, rebuild);
            }
        };
        this._monitorSignals.push([monitors, monitors.connect('items-changed', schedule)]);
        rebuild();

        page.add(group);

        // Live refresh: whenever assignments or modes change externally, update labels + previews.
        const subA = settings.connect('changed::monitor-assignments', () => this._refreshAllMonitorRows(settings));
        const subM = settings.connect('changed::monitor-modes', () => this._refreshAllMonitorRows(settings));
        const subI = settings.connect('changed::display-bindings', () => this._refreshIdentities());
        const subL = settings.connect('changed::display-labels', () => this._refreshIdentities());
        const subP = settings.connect('changed::pinned-monitors', () => this._refreshIdentities());
        window.connect('close-request', () => {
            settings.disconnect(subA);
            settings.disconnect(subM);
            settings.disconnect(subI); settings.disconnect(subL); settings.disconnect(subP);
        });

        return page;
    }

    _buildMonitorRow(window, settings, monitor, index) {
        const geom = monitor.geometry;
        // Geometry-based key — must match what monitorManager.js produces shell-side.
        const connector = `${geom.width}x${geom.height}+${geom.x}+${geom.y}`;
        const gdkConnector = monitor.connector || `monitor-${index}`;
        const model = monitor.model || gdkConnector;
        const manufacturer = monitor.manufacturer || '';
        const title = `Display ${index + 1} · ${manufacturer ? `${manufacturer} ${model}` : model}`;

        const expander = new Adw.ExpanderRow({
            title: `${title}  ·  ${gdkConnector}`,
            subtitle: `${geom.width}×${geom.height} at (${geom.x}, ${geom.y})`,
            expanded: index === 0,
        });

        // --- Image row ---
        const imageRow = new Adw.ActionRow({title: 'Image'});

        const assignments = this._readDict(settings, 'monitor-assignments');
        const currentPath = assignments[connector] || '';

        const pathLabel = new Gtk.Label({
            label: currentPath ? GLib.path_get_basename(currentPath) : 'Not set',
            css_classes: currentPath ? [] : ['dim-label'],
            ellipsize: 3,
            max_width_chars: 28,
            tooltip_text: currentPath || '',
        });

        const chooseBtn = new Gtk.Button({
            label: 'Choose file…',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Pick any image from disk',
        });
        chooseBtn.connect('clicked', () => this._pickImage(window, settings, connector));

        const browseBtn = new Gtk.Button({
            label: 'Browse library',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Pick from a thumbnail grid of the library folder',
        });
        browseBtn.connect('clicked', () => {
            const lib = settings.get_string('wallpaper-folder');
            const cur = this._readDict(settings, 'monitor-assignments')[connector] || '';
            openLibraryPicker(window, lib, cur, (path) => {
                this._stageMonitor(rowState, path, rowState.draftMode);
            });
        });

        const poolBtn = new Gtk.Button({
            label: 'Random',
            valign: Gtk.Align.CENTER,
            tooltip_text: `Choose a different random library image for ${title}`,
        });
        poolBtn.connect('clicked', () => this._pickFromPool(settings, connector, poolBtn));

        imageRow.add_suffix(pathLabel);
        const actionFlow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: false,
            min_children_per_line: 1,
            max_children_per_line: 3,
            column_spacing: 6,
            row_spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        actionFlow.append(chooseBtn);
        actionFlow.append(browseBtn);
        actionFlow.append(poolBtn);
        imageRow.add_suffix(actionFlow);

        // --- Mode row ---
        const modeRow = new Adw.ComboRow({
            title: 'Display mode',
            subtitle: 'Preview below reflects this mode at the monitor’s real aspect ratio.',
            model: this._stringList(MODES.map(m => m.label)),
        });
        const modes = this._readDict(settings, 'monitor-modes');
        const currentMode = modes[connector] || 'zoom';
        modeRow.selected = Math.max(0, MODES.findIndex(m => m.id === currentMode));
        modeRow.connect('notify::selected', () => {
            if (rowState?._updatingMode)
                return;
            this._stageMonitor(rowState, rowState.draftPath, MODES[modeRow.selected].id);
        });

        // --- Preview row ---
        const [previewW, previewH] = previewSize(geom.width, geom.height);
        const previewRow = new Adw.ActionRow({title: 'Preview'});
        const previewFrame = new Gtk.Frame({
            valign: Gtk.Align.CENTER,
            css_classes: ['view'],
        });
        const previewPic = new Gtk.Picture({
            width_request: previewW,
            height_request: previewH,
        });
        previewFrame.set_child(previewPic);
        previewRow.add_suffix(previewFrame);

        const rowState = {
            connector,
            geom: {x: geom.x, y: geom.y, width: geom.width, height: geom.height},
            previewW,
            previewH,
            expander,
            pathLabel,
            previewPic,
            modeRow,
            _lastPreviewPath: currentPath,
            _lastPreviewMode: currentMode,
            _updatingMode: false,
            basePath: currentPath, baseMode: currentMode,
            draftPath: currentPath, draftMode: currentMode,
        };

        const pinRow = new Adw.SwitchRow({title: 'Pin this display',
            subtitle: 'Keep its wallpaper during automatic rotation and global Next.'});
        pinRow.active = settings.get_strv('pinned-monitors').includes(connector);
        pinRow.connect('notify::active', () => {
            if (rowState._updatingPin) return;
            const pins = new Set(settings.get_strv('pinned-monitors'));
            const key = rowState.identity || connector;
            pins.delete(connector);
            if (pinRow.active) pins.add(key); else pins.delete(key);
            settings.set_strv('pinned-monitors', [...pins]);
        });
        rowState.pinRow = pinRow;
        const applyRow = new Adw.ActionRow({title: 'Selection', subtitle: 'Current wallpaper'});
        const cancel = new Gtk.Button({label: 'Discard', valign: Gtk.Align.CENTER, sensitive: false});
        const apply = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER,
            sensitive: false, css_classes: ['suggested-action']});
        apply._operationIdleLabel = 'Apply';
        cancel.connect('clicked', () => this._stageMonitor(rowState, rowState.basePath, rowState.baseMode));
        apply.connect('clicked', () => this._applyPreview(rowState));
        applyRow.add_suffix(cancel);
        applyRow.add_suffix(apply);
        Object.assign(rowState, {applyButton: apply, discardButton: cancel, applyRow});

        this._renderPreview(rowState, currentPath, currentMode);

        expander.add_row(imageRow);
        expander.add_row(modeRow);
        expander.add_row(previewRow);
        expander.add_row(applyRow);
        expander.add_row(pinRow);
        const identityRow = new Adw.ActionRow({title: 'Remember display', subtitle: 'Checking display identity…'});
        const savedDisplay = new Gtk.DropDown({model: this._stringList(['This layout only']), valign: Gtk.Align.CENTER});
        const nameDisplay = new Gtk.Button({label: 'Name…', valign: Gtk.Align.CENTER, sensitive: false});
        nameDisplay.connect('clicked', () => this._nameDisplay(rowState));
        savedDisplay.connect('notify::selected', () => {
            if (rowState._updatingIdentity || !rowState.bindingKey || rowState.autoIdentity) return;
            const bindings = this._readDict(settings, 'display-bindings');
            const selected = rowState.savedDisplayKeys[savedDisplay.selected - 1];
            if (selected) bindings[rowState.bindingKey] = selected; else delete bindings[rowState.bindingKey];
            this._writeDict(settings, 'display-bindings', bindings);
        });
        identityRow.add_suffix(savedDisplay); identityRow.add_suffix(nameDisplay);
        Object.assign(rowState, {identityRow, savedDisplay, nameDisplay, savedDisplayKeys: []});
        expander.add_row(identityRow);

        return rowState;
    }

    _refreshAllMonitorRows(settings) {
        const monitors = [...this._monitorRows.values()].map(row => ({connector: row.connector, identity: row.identity}));
        const assignments = resolveAssignments(this._readDict(settings, 'monitor-assignments'), monitors);
        const modes = resolveAssignments(this._readDict(settings, 'monitor-modes'), monitors);
        for (const [connector, row] of this._monitorRows) {
            row.basePath = assignments[connector] || '';
            row.baseMode = modes[connector] || 'zoom';
            if (!row.dirty) {
                row.draftPath = row.basePath;
                row.draftMode = row.baseMode;
            }
            const path = row.draftPath;
            const mode = row.draftMode;

            // Label
            const newLabel = path ? GLib.path_get_basename(path) : 'Not set';
            if (row.pathLabel.label !== newLabel) {
                row.pathLabel.label = newLabel;
                row.pathLabel.tooltip_text = path;
                row.pathLabel.css_classes = path ? [] : ['dim-label'];
            }

            // Mode combo
            const idx = MODES.findIndex(m => m.id === mode);
            if (idx >= 0 && row.modeRow.selected !== idx) {
                row._updatingMode = true;
                row.modeRow.selected = idx;
                row._updatingMode = false;
            }

            // Preview — only re-render if path OR mode changed for THIS row.
            if (row._lastPreviewPath !== path || row._lastPreviewMode !== mode) {
                row._lastPreviewPath = path;
                row._lastPreviewMode = mode;
                this._renderPreview(row, path, mode);
            }
        }
    }

    _stageMonitor(row, path, mode) {
        if (!row || !this._window || this._monitorRows.get(row.connector) !== row)
            return;
        row.draftPath = path;
        row.draftMode = mode;
        row.dirty = path !== row.basePath || mode !== row.baseMode;
        row.pathLabel.label = path ? GLib.path_get_basename(path) : 'Not set';
        row.pathLabel.tooltip_text = path || '';
        row._updatingMode = true;
        row.modeRow.selected = Math.max(0, MODES.findIndex(item => item.id === mode));
        row._updatingMode = false;
        row.applyRow.subtitle = row.dirty ? 'Preview only · apply to change this display' : 'Current wallpaper';
        row.discardButton.sensitive = row.dirty;
        this._renderPreview(row, path, mode);
    }

    _applyPreview(row) {
        if (this._monitorRows.get(row.connector) !== row)
            return;
        this._triggerNext(row.applyButton, {method: 'Apply', options: {
            monitor: row.connector, image: row.draftPath, mode: row.draftMode,
            'expected-image': row.basePath, 'expected-mode': row.baseMode,
            topology: topologyKey([...this._monitorRows.values()]),
        }});
    }

    _refreshIdentities() {
        if (!this._window) return;
        const settings = this._settings;
        const bindings = this._readDict(settings, 'display-bindings');
        const labels = this._readDict(settings, 'display-labels');
        const pins = settings.get_strv('pinned-monitors');
        const monitors = this._identityClient.attach([...this._monitorRows.values()].map(row =>
            ({...row.geom, connector: row.connector})), bindings);
        for (const monitor of monitors) {
            const row = this._monitorRows.get(monitor.connector);
            const changed = row.identity !== monitor.identity;
            row.identity = monitor.identity;
            row.bindingKey = monitor.bindingKey || '';
            row.autoIdentity = Boolean(monitor.identity && !monitor.identity.startsWith('user:') &&
                !bindings[monitor.bindingKey]);
            if (changed) row.dirty = false;
            row.identityRow.subtitle = monitor.identity
                ? `${labels[monitor.identity] || 'Remembered display'} · assignment follows this display`
                : `${monitor.identityReason || 'No unique identifier'} Choose a saved display to restore its assignment.`;
            row.nameDisplay.sensitive = Boolean(row.bindingKey);
            row.savedDisplayKeys = Object.keys(labels).sort((a, b) => labels[a].localeCompare(labels[b]));
            row._updatingIdentity = true;
            row.savedDisplay.model = this._stringList(['This layout only', ...row.savedDisplayKeys.map(key => labels[key])]);
            row.savedDisplay.selected = Math.max(0, row.savedDisplayKeys.indexOf(row.identity) + 1);
            row.savedDisplay.sensitive = !row.autoIdentity && Boolean(row.bindingKey);
            row._updatingIdentity = false;
            row._updatingPin = true;
            row.pinRow.active = pins.includes(row.identity || row.connector) || pins.includes(row.connector);
            row._updatingPin = false;
        }
        this._refreshAllMonitorRows(settings);
        this._updateDraftButtons();
    }

    _nameDisplay(row) {
        if (!row.bindingKey || this._monitorRows.get(row.connector) !== row) return;
        const entry = new Gtk.Entry({text: '', placeholder_text: 'For example, Left display', max_length: 80});
        const dialog = new Adw.MessageDialog({transient_for: this._window,
            heading: 'Name this display', body: 'Keep its assignment when its position or scale changes.', extra_child: entry});
        dialog.add_response('cancel', 'Cancel'); dialog.add_response('save', 'Save');
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'save' || !entry.text.trim() || this._monitorRows.get(row.connector) !== row) return;
            const identity = row.identity || `user:${GLib.uuid_string_random()}`;
            const labels = this._readDict(this._settings, 'display-labels');
            labels[identity] = entry.text.trim();
            this._writeDict(this._settings, 'display-labels', labels);
            if (!row.autoIdentity) {
                const bindings = this._readDict(this._settings, 'display-bindings');
                bindings[row.bindingKey] = identity;
                this._writeDict(this._settings, 'display-bindings', bindings);
            }
        });
        dialog.present();
    }

    _drawOverview(cr, width, height) {
        const rows = [...this._monitorRows.values()];
        this._overviewRects = [];
        if (!rows.length)
            return;
        const minX = Math.min(...rows.map(row => row.geom.x));
        const minY = Math.min(...rows.map(row => row.geom.y));
        const spanX = Math.max(...rows.map(row => row.geom.x + row.geom.width)) - minX;
        const spanY = Math.max(...rows.map(row => row.geom.y + row.geom.height)) - minY;
        const scale = Math.min((width - 24) / spanX, (height - 24) / spanY);
        rows.forEach((row, index) => {
            const x = (width - spanX * scale) / 2 + (row.geom.x - minX) * scale + 3;
            const y = (height - spanY * scale) / 2 + (row.geom.y - minY) * scale + 3;
            const w = row.geom.width * scale - 6, h = row.geom.height * scale - 6;
            cr.setSourceRGB(...(this._selectedMonitor === row.connector ? [0.18, 0.44, 0.8] : [0.22, 0.25, 0.29]));
            cr.rectangle(x, y, w, h); cr.fill();
            if (row.previewPixbuf) {
                cr.save(); cr.rectangle(x, y, w, h); cr.clip();
                cr.translate(x, y); cr.scale(w / row.previewPixbuf.width, h / row.previewPixbuf.height);
                Gdk.cairo_set_source_pixbuf(cr, row.previewPixbuf, 0, 0); cr.paint(); cr.restore();
            }
            cr.setSourceRGBA(0, 0, 0, 0.65); cr.rectangle(x, y + h - 28, w, 28); cr.fill();
            cr.setSourceRGB(1, 1, 1); cr.setFontSize(Math.min(18, h / 3));
            cr.moveTo(x + 10, y + h - 8); cr.showText(`${index + 1}${row.dirty ? ' · Preview' : ''}`);
            this._overviewRects.push({x, y, width: w, height: h, key: row.connector});
        });
    }

    // ---------- Actions ----------

    _pickImage(window, settings, connector) {
        const row = this._monitorRows.get(connector);
        const dialog = new Gtk.FileDialog({title: `Choose wallpaper for ${connector}`});
        const filter = new Gtk.FileFilter({name: 'Images'});
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/jpeg');
        filter.add_mime_type('image/webp');
        filter.add_mime_type('image/avif');
        filter.add_mime_type('image/heic');
        filter.add_mime_type('image/heif');
        filter.add_mime_type('image/tiff');
        filter.add_mime_type('image/bmp');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        dialog.filters = filters;

        const folder = settings.get_string('wallpaper-folder');
        if (folder && GLib.file_test(folder, GLib.FileTest.IS_DIR))
            dialog.set_initial_folder(Gio.File.new_for_path(folder));

        dialog.open(window, null, (src, res) => {
            try {
                const file = dialog.open_finish(res);
                this._stageMonitor(row, file.get_path(), row.draftMode);
            } catch (e) {
                if (!`${e}`.includes('Dismissed'))
                    logError(e);
            }
        });
    }

    _pickFromPool(settings, connector, button = null) {
        const row = this._monitorRows.get(connector);
        this._withIndexedPool(settings, button, pool => {
            const assignments = this._readDict(settings, 'monitor-assignments');
            const current = assignments[connector];
            // Candidate-set selection guarantees a change whenever an alternative
            // exists; bounded retries still had a small chance of repeating.
            const candidates = pool.filter(path => path !== current);
            const source = candidates.length > 0 ? candidates : pool;
            const pick = source[Math.floor(Math.random() * source.length)];
            this._stageMonitor(row, pick, row.draftMode);
        });
    }

    _triggerNext(button = null, action = null) {
        const cancellable = this._controlCancellable;
        if (!cancellable || cancellable.is_cancelled()) {
            this._toast('Wallpaper control is unavailable because this window is closing.',
                Adw.ToastPriority.HIGH);
            return;
        }
        if (this._controlActionActive) {
            this._toast('A background change is already in progress.');
            return;
        }
        if (this._controlPendingActionFault && !this._controlPendingOperationId) {
            this._toastAction('The saved request details are invalid. No new action was sent.',
                'Allow new request', () => this._setControlPendingOperation(null));
            return;
        }

        const selectedAction = this._controlPendingRequestId ? this._controlPendingAction : action;
        const resolveExisting = Boolean(this._controlPendingRequestId &&
            this._controlPendingNeedsResolution);
        const requestId = this._controlPendingRequestId || GLib.uuid_string_random();
        let pendingOperationId = this._controlPendingOperationId || '';
        if (!this._controlPendingRequestId &&
            !this._setControlPendingOperation(requestId, '', false, selectedAction)) {
            this._toast('Could not save the request identity, so no background change was sent.',
                Adw.ToastPriority.HIGH);
            return;
        }
        const generation = ++this._controlActionGeneration;
        const originalLabel = button?._operationIdleLabel || 'Next';
        const deadlineUs = GLib.get_monotonic_time() + CONTROL_ACTION_TIMEOUT_MS * 1000;
        this._controlActionActive = true;
        this._updateDraftButtons();
        if (button) {
            button.sensitive = false;
            button.label = 'Changing…';
        }

        const isCurrent = () => this._window &&
            this._controlActionGeneration === generation &&
            this._controlCancellable === cancellable &&
            !cancellable.is_cancelled();
        const finish = () => {
            if (!isCurrent())
                return;
            if (this._controlPollId) {
                GLib.Source.remove(this._controlPollId);
                this._controlPollId = 0;
            }
            this._controlActionActive = false;
            this._updateDraftButtons();
            if (button) {
                button.sensitive = true;
                button.label = originalLabel;
            }
        };
        const offerExplicitNewRequest = (message, {canReplay = true} = {}) => {
            if (!isCurrent())
                return;
            if (!this._setControlPendingOperation(
                requestId, pendingOperationId, true)) {
                finish();
                if (button) {
                    button.sensitive = false;
                    button.label = 'Blocked';
                }
                this._toast('The request outcome is uncertain and its recovery identity could not be saved. Restart Wallpaper Suite before trying again.',
                    Adw.ToastPriority.HIGH);
                return;
            }
            finish();
            if (button) {
                button.sensitive = canReplay;
                button.label = canReplay ? 'Recheck' : 'Blocked';
            }
            this._toastAction(
                `${message} No new background will be requested automatically.`,
                'Allow new request',
                () => {
                    if (!this._window || this._controlPendingRequestId !== requestId)
                        return;
                    if (!this._setControlPendingOperation(null)) {
                        this._toast('Could not clear the previous request identity.',
                            Adw.ToastPriority.HIGH);
                        return;
                    }
                    if (button) {
                        button.sensitive = true;
                        button.label = originalLabel;
                    }
                    this._toast('A new background request is enabled.');
                }
            );
        };
        const fail = (message, options = {}) => {
            offerExplicitNewRequest(message, options);
        };
        const showTerminalResult = operation => {
            const indeterminate = !operation.published &&
                INDETERMINATE_RESULT_CODES.has(operation.code);
            if (indeterminate) {
                offerExplicitNewRequest(
                    `The previous background outcome is uncertain: ${
                        operation.message || operation.code}. Request ID: ${requestId}`
                );
                return;
            }
            if (!this._setControlPendingOperation(null)) {
                offerExplicitNewRequest(
                    'The result is known, but its saved recovery identity could not be cleared.'
                );
                return;
            }
            finish();
            const detail = `${operation.message || operation.code || ''}`.trim();
            if (operation.ok && operation.published) {
                if (selectedAction)
                    this._rememberAppliedAction(selectedAction);
                this._toast('Background changed.');
            } else if (operation.ok && operation.code === 'no-alternative') {
                this._toast(detail || 'The current background is the only available choice.');
            } else if (operation.ok) {
                this._toast(detail || 'Next background completed without changing the desktop.');
            } else if (operation.published) {
                this._toast(`Background changed with a warning${detail ? `: ${detail}` : '.'}`,
                    Adw.ToastPriority.HIGH);
            } else {
                this._toast(`Could not change the background${detail ? `: ${detail}` : '.'}`,
                    Adw.ToastPriority.HIGH);
            }
        };

        const poll = operationId => {
            if (!isCurrent())
                return;
            const remainingMs = Math.ceil(
                (deadlineUs - GLib.get_monotonic_time()) / 1000);
            if (remainingMs <= 0) {
                fail(`The background request is still running. Request ID: ${requestId}`);
                return;
            }
            Gio.DBus.session.call(
                CONTROL_BUS_NAME,
                CONTROL_OBJECT_PATH,
                CONTROL_INTERFACE,
                'GetOperation',
                new GLib.Variant('(s)', [operationId]),
                new GLib.VariantType('(bsbbbssxx)'),
                Gio.DBusCallFlags.NONE,
                Math.max(1, Math.min(3000, remainingMs)),
                cancellable,
                (connection, result) => {
                    if (!isCurrent())
                        return;
                    try {
                        const [found, state, ok, changed, published, code, message,
                            startedAtMs, finishedAtMs] = connection.call_finish(result).deepUnpack();
                        if (!found) {
                            fail(`The control service lost operation ${operationId}. ` +
                                `Request ID: ${requestId}`, {canReplay: false});
                            return;
                        }
                        if (state !== 'running') {
                            showTerminalResult({
                                state, ok, changed, published, code, message,
                                startedAtMs, finishedAtMs,
                            });
                            return;
                        }
                        const delayMs = Math.max(1, Math.min(150,
                            Math.ceil((deadlineUs - GLib.get_monotonic_time()) / 1000)));
                        this._controlPollId = GLib.timeout_add(
                            GLib.PRIORITY_DEFAULT,
                            delayMs,
                            () => {
                                this._controlPollId = 0;
                                poll(operationId);
                                return GLib.SOURCE_REMOVE;
                            });
                    } catch (error) {
                        if (!cancellable.is_cancelled())
                            fail(`Could not read the background result: ${error.message || error}. ` +
                                `Request ID: ${requestId}`);
                    }
                }
            );
        };

        if (resolveExisting && pendingOperationId) {
            poll(pendingOperationId);
            return;
        }

        const callOptions = {
            source: new GLib.Variant('s', 'preferences'),
            'request-id': new GLib.Variant('s', requestId),
            'reset-timer': new GLib.Variant('b', selectedAction ? false :
                this._settings.get_boolean('manual-next-reset-timer')),
        };
        if (selectedAction) {
            for (const [key, value] of Object.entries(selectedAction.options))
                callOptions[key] = new GLib.Variant('s', value);
        }
        Gio.DBus.session.call(
            CONTROL_BUS_NAME,
            CONTROL_OBJECT_PATH,
            CONTROL_INTERFACE,
            selectedAction?.method || 'Next',
            new GLib.Variant('(a{sv})', [callOptions]),
            new GLib.VariantType('(s)'),
            Gio.DBusCallFlags.NONE,
            3000,
            cancellable,
            (connection, result) => {
                if (!isCurrent())
                    return;
                try {
                    const [operationId] = connection.call_finish(result).deepUnpack();
                    if (!operationId) {
                        fail(`The control service returned no operation ID. Request ID: ${requestId}`);
                        return;
                    }
                    pendingOperationId = operationId;
                    if (!this._setControlPendingOperation(
                        requestId, operationId, false)) {
                        fail(`The operation was accepted, but its recovery identity could not be saved. Request ID: ${requestId}`);
                        return;
                    }
                    poll(operationId);
                } catch (error) {
                    let remote = '';
                    try { remote = Gio.DBusError.get_remote_error(error) || ''; } catch (_) {}
                    if (selectedAction && remote === 'org.freedesktop.DBus.Error.UnknownMethod') {
                        this._setControlPendingOperation(null);
                        finish();
                        this._toast('Sign out and back in to load the updated Wallpaper Suite controls.', Adw.ToastPriority.HIGH);
                    } else if (!cancellable.is_cancelled())
                        fail(`Could not request the next background: ${error.message || error}. ` +
                            `Request ID: ${requestId}`);
                }
            }
        );
    }

    /** Run one bounded worker scan for preference actions; newest action wins. */
    _withIndexedPool(settings, button, onReady) {
        const folder = settings.get_string('wallpaper-folder');
        if (!folder) {
            this._toast('Choose a folder under Rotation and Library → Wallpaper Library.');
            return;
        }
        if (!this._libraryIndexer) {
            this._toast('Library index is unavailable because this window is closing.');
            return;
        }
        const indexedFolder = _canonicalPath(folder);

        const oldLabel = button?.label || '';
        if (button) {
            button.sensitive = false;
            button.label = 'Scanning…';
        }
        this._libraryIndexer.scanAsync(folder, {probeDimensions: false}, result => {
            if (button) {
                button.sensitive = true;
                button.label = oldLabel;
            }
            if (['cancelled', 'disposed', 'stale', 'superseded'].includes(result.code))
                return;
            if (_canonicalPath(settings.get_string('wallpaper-folder')) !== indexedFolder)
                return;
            if (!result.ok) {
                this._toast(`Library scan failed: ${result.message || result.code}`,
                    Adw.ToastPriority.HIGH);
                return;
            }
            const pool = result.files.map(record => record.path);
            if (pool.length === 0) {
                this._toast('Library folder contains no supported images.');
                return;
            }
            const warnings = [];
            if (result.truncated)
                warnings.push(`index limit reached; using ${pool.length} images`);
            const recoverableErrors = (result.errors || []).filter(
                error => !['file-limit-reached', 'directory-limit-reached']
                    .includes(error?.code));
            if (recoverableErrors.length > 0) {
                warnings.push(
                    `${recoverableErrors.length} location${recoverableErrors.length === 1 ? '' : 's'} could not be read`
                );
            }
            if (warnings.length > 0)
                this._toast(`Library scan warning: ${warnings.join(' · ')}`);
            onReady(pool);
        });
    }

    _rememberAppliedAction(action) {
        const options = action.options;
        if (action.undo)
            this._undoStack.pop();
        else if (options['expected-image']) {
            this._undoStack.push({method: 'Apply', undo: true, options: {
                monitor: options.monitor, image: options['expected-image'], mode: options['expected-mode'],
                'expected-image': options.image, 'expected-mode': options.mode, topology: options.topology,
            }});
            if (this._undoStack.length > 20)
                this._undoStack.shift();
        }
        const row = this._monitorRows.get(options.monitor);
        if (row) {
            row.basePath = options.image;
            row.baseMode = options.mode;
            this._stageMonitor(row, options.image, options.mode);
        }
        this._undoButton.sensitive = this._undoStack.length > 0;
        this._undoRow.subtitle = this._undoStack.length ? 'Restore the previous successful selection' : 'No monitor changes to undo.';
    }

    _undoLast(_settings) {
        const action = this._undoStack[this._undoStack.length - 1];
        if (action)
            this._triggerNext(this._undoButton, action);
    }

    _updateDraftButtons() {
        for (const row of this._monitorRows.values()) {
            row.applyButton.sensitive = Boolean(row.dirty && row.previewReady && !this._controlActionActive && !this._identityClient.pending);
        }
    }

    _renderPreview(row, path, mode) {
        const {previewPic, previewW, previewH} = row;
        row.previewLoader?.cancel();
        row.previewLoader = null;
        const generation = (row.previewGeneration || 0) + 1;
        row.previewGeneration = generation;
        row.previewReady = false;
        row.previewPixbuf = null;
        this._updateDraftButtons();
        if (!path) {
            previewPic.set_paintable(null);
            previewPic.tooltip_text = 'No image assigned';
            return;
        }
        previewPic.tooltip_text = 'Loading preview…';
        const loader = new ThumbnailLoader(GLib.build_filenamev([this.path, 'thumbnail-worker.js']), {
            width: previewW, height: previewH, concurrency: 1,
            preview: {mode, monitorWidth: row.geom.width, monitorHeight: row.geom.height},
        });
        row.previewLoader = loader;
        loader.enqueue(path, result => {
            if (!this._window || row.previewGeneration !== generation || row.previewLoader !== loader)
                return;
            if (result.error) {
                previewPic.set_paintable(null);
                previewPic.tooltip_text = `Preview unavailable: ${result.error.message}`;
                return;
            }
            try {
                row.previewPixbuf = GdkPixbuf.Pixbuf.new_from_file(result.outputPath);
                previewPic.set_paintable(Gdk.Texture.new_for_pixbuf(row.previewPixbuf));
                previewPic.tooltip_text = `${mode} preview at display aspect ratio and pixel density`;
                row.previewReady = true;
                this._updateDraftButtons();
                this._overview?.queue_draw();
            } catch (error) {
                previewPic.set_paintable(null);
                previewPic.tooltip_text = `Preview unavailable: ${error.message}`;
            }
        });
    }


    // ---------- gsettings dict helpers ----------

    _readDict(settings, key) {
        return settings.get_value(key).deep_unpack();
    }

    _writeDict(settings, key, obj) {
        settings.set_value(key, new GLib.Variant('a{ss}', obj));
    }

    _stringList(items) {
        const list = new Gtk.StringList();
        for (const item of items) list.append(item);
        return list;
    }
}

function _moduleDirectory() {
    return Gio.File.new_for_uri(import.meta.url).get_parent().get_path();
}

function _canonicalPath(path) {
    if (!path)
        return '';
    try { return GLib.canonicalize_filename(path, null); } catch (_) { return path; }
}

function _timestampValue(value) {
    if (typeof value === 'number')
        return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function _extensionRuntimeStateAsync(cancellable, callback) {
    const unavailable = () => callback({state: null, error: ''});
    try {
        Gio.DBus.session.call(
            'org.gnome.Shell.Extensions',
            '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions',
            'GetExtensionInfo',
            new GLib.Variant('(s)', [EXTENSION_UUID]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE,
            750,
            cancellable,
            (connection, result) => {
                try {
                    const [info] = connection.call_finish(result).deepUnpack();
                    const rawState = info?.state;
                    const rawError = info?.error;
                    const state = Number(rawState?.deepUnpack?.() ??
                        rawState?.deep_unpack?.() ?? rawState);
                    callback({
                        state: Number.isFinite(state) ? state : null,
                        error: `${rawError?.deepUnpack?.() ??
                            rawError?.deep_unpack?.() ?? rawError ?? ''}`.trim(),
                    });
                } catch (_) {
                    unavailable();
                }
            });
    } catch (_) {
        unavailable();
    }
}

function _controlRuntimeStateAsync(cancellable, callback) {
    const unavailable = () => callback({
        apiVersion: 0,
        active: false,
        busy: false,
        rotationEnabled: false,
        currentOperationId: '',
    });
    try {
        Gio.DBus.session.call(
            CONTROL_BUS_NAME,
            CONTROL_OBJECT_PATH,
            CONTROL_INTERFACE,
            'GetStatus',
            null,
            new GLib.VariantType('(ubbbs)'),
            Gio.DBusCallFlags.NONE,
            500,
            cancellable,
            (connection, result) => {
                try {
                    const [apiVersion, active, busy, rotationEnabled, currentOperationId] =
                        connection.call_finish(result).deepUnpack();
                    callback({apiVersion, active, busy, rotationEnabled, currentOperationId});
                } catch (_) {
                    unavailable();
                }
            }
        );
    } catch (_) {
        unavailable();
    }
}

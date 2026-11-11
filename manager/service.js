// Native Settings user service. No Shell/GTK imports or image decoding here.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {LibraryIndexer} from '../libraryIndex.js';
import {ThumbnailLoader} from '../thumbnailCache.js';
import {topologyFromState, topologyKey, resolveAssignments} from '../displayIdentity.js';
import {prepareLibraryRecords} from '../libraryModel.js';
import {readBuildInfo} from '../statusModel.js';
import {Ledger} from './ledger.js';

export const BUS = 'tech.norvi.WallpaperManager1';
export const ROOT = '/tech/norvi/WallpaperManager1';
const RUNTIME = 'dev.norvi.WallpaperSuite1';
const RUNTIME_PATH = '/dev/norvi/WallpaperSuite1';
const MUTTER = 'org.gnome.Mutter.DisplayConfig';
const MUTTER_PATH = '/org/gnome/Mutter/DisplayConfig';
const OPS = 'tech.norvi.SettingsOperations1';
const OP = 'tech.norvi.SettingsOperation1';
const RESOURCE = 'tech.norvi.SettingsResource1';
const ASSET = 'tech.norvi.SettingsAsset1';
const CONFIG = 'tech.norvi.WallpaperConfiguration1';
const DISPLAY = 'tech.norvi.WallpaperDisplay1';
const LIBRARY = 'tech.norvi.WallpaperLibrary1';
const HEALTH = 'tech.norvi.WallpaperHealth1';
const MODES = new Set(['zoom', 'fit', 'stretch', 'center', 'tile']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const PURPOSES = new Set(['RefreshDisplays', 'RefreshLibrary', 'PreparePreview', 'PrepareThumbnails',
    'Apply', 'Next', 'Undo', 'SetLibraryFolder', 'SetRotation', 'SetRendering', 'SetPinned', 'UnpinAll', 'SetDisplayBinding', 'NameDisplay']);
const CAPABILITIES = ['service.snapshot.v1', 'operations.v1', 'assets.fd.v1', 'wallpaper.displays.v1',
    'wallpaper.configuration.v1', 'wallpaper.library.v1', 'wallpaper.preview.v1',
    'wallpaper.thumbnails.v1', 'wallpaper.apply.v1', 'wallpaper.next.v1', 'wallpaper.rotation.v1', 'wallpaper.pin.v1',
    'wallpaper.undo.v1', 'wallpaper.identity.v1', 'wallpaper.health.v1', 'wallpaper.rendering.v1'];
const pathUri = path => path ? Gio.File.new_for_path(path).get_uri() : '';
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const moduleRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const later = fn => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { fn(); return GLib.SOURCE_REMOVE; });

function localPath(uri, empty = false) {
    if (empty && uri === '') return '';
    if (typeof uri !== 'string' || uri.length > 4096 || !uri.startsWith('file://'))
        fail('InvalidArgument', 'A local file URI is required');
    const path = Gio.File.new_for_uri(uri).get_path();
    if (!path || !GLib.path_is_absolute(path)) fail('InvalidArgument', 'A local absolute path is required');
    return GLib.canonicalize_filename(path, null);
}

export class WallpaperManager {
    constructor(options = {}) {
        this.settings = options.settings || this._settings(options.schemaDir);
        this.statePath = options.statePath || GLib.build_filenamev([GLib.get_user_state_dir(), 'wallpaper-suite', 'settings-manager.json']);
        this.cacheDir = options.cacheDir || GLib.build_filenamev([GLib.get_user_cache_dir(), 'wallpaper-suite', 'manager']);
        this.runtimeCacheDir = options.runtimeCacheDir || GLib.build_filenamev([GLib.get_user_cache_dir(), 'wallpaper-suite']);
        this.topologyProvider = options.topologyProvider || null;
        this.instance = GLib.uuid_string_random();
        this.build = readBuildInfo(moduleRoot);
        this.objects = new Map(); this.resources = new Map(); this.operations = new Map();
        this.runtimeOwner = ''; this.monitors = []; this.topology = ''; this.active = false;
        this.closed = false; this.refreshing = false; this.epoch = 0;
        this.onStopped = options.onStopped || null;
        this.fault = ''; this.runtimeStatus = [0, false, false, false, ''];
        this.indexer = new LibraryIndexer(moduleRoot);
        this.interfaces = new Map(); this.exportMetadata = new Map();
        for (const name of ['tech.norvi.WallpaperManager1', 'tech.norvi.SettingsOperations1']) {
            const [, bytes] = Gio.File.new_for_path(`${moduleRoot}/manager/interfaces/${name}.xml`).load_contents(null);
            const text = new TextDecoder().decode(bytes);
            for (const match of text.matchAll(/<interface name="([^"]+)">[\s\S]*?<\/interface>/g))
                this.interfaces.set(match[1], `<node>${match[0]}</node>`);
        }
    }

    _settings(schemaDir) {
        const parent = Gio.SettingsSchemaSource.get_default();
        const directory = schemaDir || `${moduleRoot}/schemas`;
        let source = parent;
        if (GLib.file_test(`${directory}/gschemas.compiled`, GLib.FileTest.IS_REGULAR))
            source = Gio.SettingsSchemaSource.new_from_directory(directory, parent, false);
        const schema = source.lookup('org.gnome.shell.extensions.wallpaper-suite', true);
        if (!schema) throw new Error('Wallpaper Suite settings schema is not installed');
        return new Gio.Settings({settings_schema: schema});
    }

    start() {
        this.ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS, Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
            connection => { this.connection = connection; this._prepare(); },
            () => this._acquired(), () => this.stop());
    }

    _prepare() {
        if (this.closed) return;
        // Export before requesting the name: D-Bus delivers the activation
        // client's first call as soon as ownership is granted. Loading here
        // is read-only; a duplicate process must not advance shared receipts.
        this.ledger = new Ledger(this.statePath);
        this.fault ||= this.ledger.fault;
        this._export(ROOT, BUS, {}, this._rootMethods());
        this._export(ROOT, OPS, {}, {
            CreateRequest: ([purpose]) => {
                if (!PURPOSES.has(purpose)) fail('NotSupported', 'Unknown operation');
                try { const result = this.ledger.create(purpose); this._syncOperations(); return result; }
                catch (error) { if (this.ledger.fault) this.stop(); throw error; }
            },
            LookupRequest: ([id]) => { const r = Object.hasOwn(this.ledger.data.requests, id) ? this.ledger.data.requests[id] : null; return [Boolean(r), r?.operation?.path || '/']; },
            ListOperations: ([cursor, limit]) => {
                if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !/^\d*$/.test(cursor)) fail('InvalidArgument', 'Invalid page');
                const list = [...this.operations.keys()]; const offset = Number(cursor || 0);
                return [list.slice(offset, offset + limit), offset + limit < list.length ? `${offset + limit}` : ''];
            },
        });
        for (const request of Object.values(this.ledger.data.requests))
            if (request.operation) this._exportOperation(request.operation);
        this._exportConfiguration();
    }

    _acquired() {
        if (this.closed) return;
        try { this.ledger.bump(); } catch (error) { this.fault = error.message; }
        this.recoveryDeadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this.recoveryDeadline = 0;
            for (const op of this.operations.values()) if (op.recoveryPending && !op.recovering)
                this._complete(op, 'interrupted', 'outcome-unknown', 'The previous runtime outcome could not be checked; this action was not repeated.');
            return GLib.SOURCE_REMOVE;
        });
        this._exportConfiguration();
        this.runtimeWatch = Gio.bus_watch_name_on_connection(this.connection, RUNTIME, Gio.BusNameWatcherFlags.NONE,
            () => this.refreshRuntime(true), () => this._runtimeUnavailable());
        if (!this.topologyProvider) this.displayWatch = Gio.bus_watch_name_on_connection(this.connection, MUTTER, Gio.BusNameWatcherFlags.NONE,
            () => this.refreshRuntime(true), () => this._runtimeUnavailable());
        this.settingsSignal = this.settings.connect('changed', () => {
            if (this.closed || this.fault) return;
            this._bump(); this._exportConfiguration(); this._exportDisplays();
            this._signal(BUS, 'ConfigurationChanged', '(t)', [this.revision]);
        });
        this.pollSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            for (const [path, value] of this.resources) if (value.expires < Date.now()) this._release(path);
            this.refreshRuntime(); return this.closed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
        });
        this.refreshRuntime();
    }

    get revision() { return this.ledger?.data.revision || 0; }
    get fault() { return this._fault || this.ledger?.fault || ''; }
    set fault(value) { this._fault = value; }
    _save() {
        try { this.ledger.save(); this._syncOperations(); }
        catch (error) { this.fault = error.message; this.stop(); throw error; }
    }
    _syncOperations() {
        const retained = new Set(Object.values(this.ledger.data.requests).map(r => r.operation?.path).filter(Boolean));
        for (const path of this.operations.keys()) if (!retained.has(path)) { this.operations.delete(path); this._release(path); }
    }
    _bump() {
        try { this.ledger.bump(); }
        catch (error) { this.fault = error.message; if (this.objects.size) this.stop(); }
        this._signal(BUS, 'SnapshotChanged', '(t)', [this.revision]);
    }
    _signal(iface, signal, signature, values, path = ROOT) {
        if (!this.closed) this.connection.emit_signal(null, path, iface, signal, new GLib.Variant(signature, values));
    }
    _export(path, iface, props, methods = {}) {
        if (this.closed) return null;
        const key = `${path}:${iface}`;
        const previous = this.objects.get(key);
        if (previous) { previous.props = props; return previous; }
        const xml = this.interfaces.get(iface);
        // Shared metadata outlives every individual lease and pending dispatch.
        let metadata = this.exportMetadata.get(iface);
        if (!metadata) {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(xml);
            metadata = {nodeInfo, info: nodeInfo.interfaces[0]};
            this.exportMetadata.set(iface, metadata);
        }
        const {nodeInfo, info} = metadata;
        const object = {path, iface, props, exported: null, nodeInfo, interfaceInfo: info, propertySignatures: new Map()};
        const implementation = {};
        // Introspection child structs are borrowed from their parent. Keep
        // that parent alive and copy scalar metadata into retained closures.
        for (const property of info.properties || []) {
            const name = property.name;
            object.propertySignatures.set(name, property.signature);
            Object.defineProperty(implementation, name, {get: () => object.props[name]});
        }
        for (const method of info.methods || []) {
            const name = method.name;
            const signature = `(${(method.out_args || []).map(a => a.signature).join('')})`;
            implementation[`${name}Async`] = (args, invocation) => {
                Promise.resolve().then(() => {
                    if (this.closed) fail('Unavailable', 'Manager is stopping');
                    if (!methods[name]) fail('NotSupported', 'This workflow is not implemented');
                    return methods[name](args, invocation);
                }).then(result => {
                    if (result === undefined) return;
                    invocation.return_value(new GLib.Variant(signature, result));
                }).catch(error => {
                    const code = /^[A-Za-z_][A-Za-z0-9_]*$/.test(`${error.code || ''}`) ? error.code : 'Failed';
                    invocation.return_dbus_error(`tech.norvi.Settings.Error.${code}`, `${error.message || error}`.slice(0, 4096));
                });
            };
        }
        object.implementation = implementation;
        object.exported = Gio.DBusExportedObject.wrapJSObject(info, implementation);
        object.exported.export(this.connection, path);
        this.objects.set(key, object);
        return object;
    }

    _properties(path, iface, changed) {
        if (this.closed) return;
        const object = this.objects.get(`${path}:${iface}`);
        if (!object) return;
        Object.assign(object.props, changed);
        for (const [name, value] of Object.entries(changed))
            object.exported.emit_property_changed(name, new GLib.Variant(object.propertySignatures.get(name), value));
    }

    _rootMethods() {
        return {
            GetCapabilities: () => [1, 0, CAPABILITIES, {page: 100, displays: 64, thumbnails: 32, previewEdge: 2048, activeOperations: 8}],
            GetSnapshot: () => [this.instance, this.revision, !this.fault && this.active,
                this.fault ? 'state-corrupt' : this.active ? 'ready' : 'runtime-unavailable',
                this.fault || (this.active ? 'Wallpaper service is ready.' : 'The active Wallpaper Suite runtime and display session are required.'),
                this.build.version, this.build.version, false],
            GetConfiguration: () => {
                this._exportConfiguration();
                return [this._view(CONFIG, this.objects.get(`${ROOT}/configuration:${CONFIG}`).props, 'c')];
            },
            GetDisplays: () => {
                this._viewCapacity(this.monitors.length);
                this._exportDisplays();
                return [this.topology, this.monitors.map(m => this._view(DISPLAY,
                    this.objects.get(`${ROOT}/displays/${m.id}:${DISPLAY}`).props, 'd'))];
            },
            GetRememberedDisplays: () => [this._remembered()],
            GetHealth: () => this._health(),
            RefreshDisplays: ([id]) => this._submit(id, 'RefreshDisplays', [], async () => { await this.refreshRuntime(true); return ['/']; }),
            RefreshLibrary: ([id]) => this._submit(id, 'RefreshLibrary', [], op => this._scan(op)),
            PreparePreview: args => this._submit(args[0], 'PreparePreview', args.slice(1), op => this._preview(op, ...args.slice(1))),
            PrepareThumbnails: args => this._submit(args[0], 'PrepareThumbnails', args.slice(1), op => this._thumbnails(op, ...args.slice(1))),
            ChooseRandom: ([library, exclude]) => {
                const records = this.resources.get(library)?.records?.filter(r => r.id !== exclude);
                if (!records?.length) fail('NotFound', 'There is no alternative image in this snapshot');
                const record = records[GLib.random_int_range(0, records.length)]; return [record.id, pathUri(record.path)];
            },
            Apply: args => this._submit(args[0], 'Apply', args.slice(1), op => this._apply(op, ...args.slice(1))),
            Undo: ([id, original, topology]) => this._submit(id, 'Undo', [original, topology], op => this._undo(op, original, topology)),
            Next: ([id, reset]) => this._submit(id, 'Next', [reset], op => this._delegate(op, 'Next', {'reset-timer': new GLib.Variant('b', reset)})),
            SetLibraryFolder: ([id, uri, rev]) => this._submit(id, 'SetLibraryFolder', [uri, rev], op => this._configure(op, rev, {'wallpaper-folder': ['s', localPath(uri)]})),
            SetRotation: ([id, enabled, minutes, selection, sync, reset, rev]) => this._submit(id, 'SetRotation', [enabled, minutes, selection, sync, reset, rev], op => {
                if (minutes < 1 || minutes > 10080 || !['random', 'sequential'].includes(selection)) fail('InvalidArgument', 'Invalid rotation settings');
                return this._configure(op, rev, {'rotation-enabled': ['b', enabled], 'rotation-interval-minutes': ['i', minutes],
                    'rotation-mode': ['s', selection], 'rotation-sync-monitors': ['b', sync], 'manual-next-reset-timer': ['b', reset]});
            }),
            SetRendering: ([id, indicator, quality, rev]) => this._submit(id, 'SetRendering', [indicator, quality, rev], op => {
                if (quality < 60 || quality > 100) fail('InvalidArgument', 'Invalid JPEG quality');
                return this._configure(op, rev, {'show-indicator': ['b', indicator], 'composite-quality': ['i', quality]});
            }),
            SetPinned: ([id, display, pinned, topology, rev]) => this._submit(id, 'SetPinned', [display, pinned, topology, rev], op => {
                const monitor = this._display(display, topology); const pins = new Set(this.settings.get_strv('pinned-monitors'));
                if (pinned) pins.add(monitor.identity || monitor.connector);
                else { pins.delete(monitor.identity); pins.delete(monitor.connector); }
                return this._configure(op, rev, {'pinned-monitors': ['as', [...pins]]});
            }),
            UnpinAll: ([id, rev]) => this._submit(id, 'UnpinAll', [rev], op => this._configure(op, rev, {'pinned-monitors': ['as', []]})),
            SetDisplayBinding: ([id, display, remembered, topology, rev]) => this._submit(id, 'SetDisplayBinding', [display, remembered, topology, rev], op => {
                const monitor = this._display(display, topology);
                if (!monitor.bindingKey || monitor.autoIdentity) fail('NotSupported', 'This display has an automatic hardware identity');
                if (remembered && !this._remembered().some(([key]) => key === remembered)) fail('NotFound', 'Saved display identity was not found');
                if (remembered && this.monitors.some(m => m.id !== display && m.identity === remembered)) fail('Conflict', 'That saved display is already connected');
                const bindings = this._dict('display-bindings');
                if (remembered) bindings[monitor.bindingKey] = remembered; else delete bindings[monitor.bindingKey];
                return this._configure(op, rev, {'display-bindings': ['a{ss}', bindings]});
            }),
            NameDisplay: ([id, display, name, topology, rev]) => this._submit(id, 'NameDisplay', [display, name, topology, rev], op => {
                const monitor = this._display(display, topology);
                const label = name.trim();
                if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) fail('InvalidArgument', 'A display name must contain 1–80 printable characters');
                if (!monitor.bindingKey) fail('NotSupported', 'Display identity is unavailable');
                const identity = monitor.identity || `user:${GLib.uuid_string_random()}`;
                const labels = this._dict('display-labels'); labels[identity] = label;
                const values = {'display-labels': ['a{ss}', labels]};
                if (!monitor.autoIdentity) {
                    const bindings = this._dict('display-bindings'); bindings[monitor.bindingKey] = identity;
                    values['display-bindings'] = ['a{ss}', bindings];
                }
                return this._configure(op, rev, values);
            }),
        };
    }

    _dict(key) { return this.settings.get_value(key).deepUnpack(); }
    _viewCapacity(count) {
        for (const [path, resource] of this.resources) if (resource.expires < Date.now()) this._release(path);
        if (this.resources.size + count > 128) fail('Busy', 'Release unused result views before requesting more.');
    }
    _view(iface, props, prefix) {
        this._viewCapacity(1);
        const path = `${ROOT}/views/${prefix}${GLib.uuid_string_random().replaceAll('-', '')}`;
        this._export(path, iface, {...props});
        this.resources.set(path, {}); this._lease(path); return path;
    }
    _runtimeUnavailable() {
        if (this.closed) return;
        const changed = this.active || Boolean(this.runtimeOwner) || this.monitors.length > 0;
        this.epoch++; this.active = false; this.runtimeOwner = ''; this.topology = ''; this.monitors = [];
        this.runtimeStatus = [0, false, false, false, ''];
        if (this.displaySubscription) this.connection.signal_unsubscribe(this.displaySubscription);
        this.displaySubscription = 0; this.displaySignalOwner = '';
        if (changed) { this._bump(); this._exportConfiguration(); this._exportDisplays(); this._signal(BUS, 'DisplaysChanged', '(s)', ['']); }
    }
    async _health() {
        if (!this.healthPromise) this.healthPromise = this._readHealth().finally(() => { this.healthPromise = null; });
        const facts = await this.healthPromise;
        if (this.closed) fail('Unavailable', 'Manager is stopping');
        const path = `${ROOT}/health/h${GLib.uuid_string_random().replaceAll('-', '')}`;
        // Share expensive inspection work, never a caller's releasable handle.
        // Each reply gets an independent immutable snapshot and resource lease.
        this._export(path, HEALTH, {...facts});
        this.resources.set(path, {}); this._lease(path); return [path];
    }
    async _readHealth() {
        const revision = this.revision;
        const owner = this.runtimeOwner;
        const runtimeInstance = this.runtimeSession?.[0] || '';
        const assignments = resolveAssignments(this._dict('monitor-assignments'), this.monitors);
        const job = {cacheRoot: this.runtimeCacheDir, displays: this.monitors.map(m =>
            ({id: m.id, identity: m.identity, image: assignments[m.connector] || ''}))};
        const worker = Gio.Subprocess.new([GLib.find_program_in_path('gjs'), '-m', `${moduleRoot}/manager/health-worker.js`],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this.healthWorker = worker;
        let timeout;
        const result = await new Promise((resolve, reject) => {
            timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                timeout = 0; worker.force_exit(); reject(Object.assign(new Error('Health inspection timed out'), {code: 'Timeout'})); return GLib.SOURCE_REMOVE;
            });
            worker.communicate_utf8_async(`${JSON.stringify(job)}\n`, null, (process, outcome) => {
                if (timeout) GLib.source_remove(timeout); timeout = 0;
                try {
                    const [, output, error] = process.communicate_utf8_finish(outcome);
                    if (!process.get_successful() || output.length > 1024 * 1024) throw new Error(error || 'Invalid diagnostic worker result');
                    resolve(JSON.parse(output));
                } catch (error) { reject(error); }
            });
        });
        if (this.closed || revision !== this.revision || owner !== this.runtimeOwner) fail('Conflict', 'Runtime changed during health inspection; refresh diagnostics');
        const f = result.facts;
        this.healthWorker = null;
        let available = false;
        try { available = this.active && owner && await this._owner(RUNTIME) === owner &&
            (this.topologyProvider || await this._owner(MUTTER) === owner); } catch (_) {}
        const hasCurrentRender = Boolean(available && runtimeInstance && runtimeInstance === f.runtimeInstance);
        let extensionState = available ? 'active' : 'unavailable';
        try {
            const shellOwner = await this._owner('org.gnome.Shell.Extensions');
            const mutterOwner = await this._owner(MUTTER);
            if (shellOwner === mutterOwner && (!owner || owner === shellOwner)) {
                const [info] = await this._call(shellOwner, '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions', 'GetExtensionInfo',
                    new GLib.Variant('(s)', ['wallpaper-suite@spencercnorton.github.io']), '(a{sv})');
                const value = info.state?.deepUnpack ? info.state.deepUnpack() : info.state;
                extensionState = ({1: 'active', 2: 'disabled', 3: 'error', 4: 'incompatible', 5: 'uninstalled', 6: 'starting'})[Number(value)] || extensionState;
            }
        } catch (_) {}
        if (this.closed || revision !== this.revision || owner !== this.runtimeOwner) fail('Conflict', 'Runtime changed during health inspection; refresh diagnostics');
        const folder = this.settings.get_string('wallpaper-folder');
        const libraryState = !folder ? 'unconfigured' : f.poolFolder !== GLib.canonicalize_filename(folder, null) ? 'awaiting-index' :
            f.poolIndexing ? 'indexing' : f.poolLastAttemptOk ? f.poolWatcherDegraded ? 'degraded' : 'ready' : 'error';
        return {ObservedAtMs: Date.now(), RuntimeAvailable: Boolean(available), RuntimeApiVersion: available ? this.runtimeStatus[0] : 0,
            ExtensionState: extensionState, BuildVersion: this.build.version, SourceRevision: this.build.commit, LibraryState: libraryState,
            AssignmentIssues: result.issues, LastRenderAtMs: f.lastRenderAt, LastRenderSession: f.sessionId || f.runtimeInstance,
            LastRenderIsCurrentSession: hasCurrentRender, LastCompositeSize: result.dimensions, CacheBytes: result.cacheBytes,
            NextRotationAtMs: Number(this.settings.get_int64('rotation-next-deadline')) * 1000,
            LastRotationAtMs: Number(this.settings.get_int64('rotation-last-run')) * 1000,
            LastRotationSuccessAtMs: Number(this.settings.get_int64('rotation-last-success')) * 1000,
            LastWarningCode: result.truncated ? 'cache-count-truncated' : f.lastError || f.lastSelectionError || f.poolError ? 'runtime-warning' : '',
            LastWarningMessage: result.truncated ? 'Only the first 10000 cache entries were inspected.' : f.lastError || f.lastSelectionError || f.poolError};
    }
    _remembered() {
        const labels = this._dict('display-labels');
        const keys = new Set([...Object.keys(labels), ...Object.keys(this._dict('monitor-assignments')).filter(k => /^(display:|user:)/.test(k)),
            ...this.monitors.map(m => m.identity).filter(Boolean)]);
        return [...keys].sort().slice(0, 256).map(key => [key, labels[key] || 'Remembered display']);
    }
    _exportConfiguration() {
        const props = {Revision: this.revision, FolderUri: pathUri(this.settings.get_string('wallpaper-folder')),
            RotationEnabled: this.settings.get_boolean('rotation-enabled'), IntervalMinutes: this.settings.get_int('rotation-interval-minutes'),
            Selection: this.settings.get_string('rotation-mode'), Synchronize: this.settings.get_boolean('rotation-sync-monitors'),
            ResetAfterNext: this.settings.get_boolean('manual-next-reset-timer'), ShowIndicator: this.settings.get_boolean('show-indicator'),
            JpegQuality: this.settings.get_int('composite-quality')};
        this._export(`${ROOT}/configuration`, CONFIG, props);
    }

    async _call(owner, path, iface, method, args = null, signature = null) {
        return new Promise((resolve, reject) => this.connection.call(owner, path, iface, method, args,
            signature ? new GLib.VariantType(signature) : null, Gio.DBusCallFlags.NO_AUTO_START, 3000, null,
            (bus, result) => { try { resolve(bus.call_finish(result).deepUnpack()); } catch (error) { reject(error); } }));
    }
    async _owner(name) { return (await this._call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [name]), '(s)'))[0]; }
    async refreshRuntime(force = false) {
        if (this.closed || this.refreshing || this.fault) return;
        this.refreshing = true; const epoch = ++this.epoch;
        const previous = this.runtimeFingerprint || '';
        try {
            const owner = await this._owner(RUNTIME);
            const status = await this._call(owner, RUNTIME_PATH, RUNTIME, 'GetStatus', null, '(ubbbs)');
            const displayOwner = this.topologyProvider ? owner : await this._owner(MUTTER);
            if (displayOwner !== owner || status[0] < 2 || !status[1]) throw new Error('Runtime and display session are not the same active owner');
            let topology;
            if (this.topologyProvider) topology = await this.topologyProvider();
            else {
                const state = await this._call(owner, MUTTER_PATH, MUTTER, 'GetCurrentState');
                topology = topologyFromState(state).map(m => ({...m, scale: state[2].find(l => l[0] === m.x && l[1] === m.y)?.[2] || 1}));
            }
            if (!Array.isArray(topology) || !topology.length || topology.length > 64) throw new Error('Display topology is unavailable');
            if (this.closed || epoch !== this.epoch) return;
            const bindings = this._dict('display-bindings');
            this.monitors = topology.map(m => ({...m, autoIdentity: Boolean(m.identity), identity: m.identity || bindings[m.bindingKey] || null,
                id: `d${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `${m.connector}|${m.bindingKey || m.identity || ''}`, -1).slice(0, 24)}`}));
            this.topology = topologyKey(this.monitors); this.runtimeOwner = owner; this.runtimeStatus = status; this.active = true;
            for (const op of this.operations.values()) if (op.recoveryPending && !op.recovering)
                this._recoverOperation(op).catch(error => this._complete(op, 'interrupted', 'outcome-unknown', error.message));
            if (!this.topologyProvider && this.displaySignalOwner !== owner) {
                if (this.displaySubscription) this.connection.signal_unsubscribe(this.displaySubscription);
                this.displaySignalOwner = owner;
                this.displaySubscription = this.connection.signal_subscribe(owner, MUTTER, 'MonitorsChanged', MUTTER_PATH, null,
                    Gio.DBusSignalFlags.NONE, () => this.refreshRuntime(true));
            }
            try { this.runtimeSession = await this._call(owner, RUNTIME_PATH, RUNTIME, 'GetSessionInfo', null, '(ss)'); }
            catch (_) { this.runtimeSession = ['', '']; }
        } catch (_) { this.runtimeOwner = ''; this.monitors = []; this.topology = ''; this.active = false; }
        finally {
            this.refreshing = false;
            this.runtimeFingerprint = JSON.stringify([this.runtimeOwner, this.monitors.map(({path, ...m}) => m), this.runtimeStatus]);
            if (!this.closed && (force || previous !== this.runtimeFingerprint)) {
                this._bump(); this._exportConfiguration(); this._exportDisplays(); this._signal(BUS, 'DisplaysChanged', '(s)', [this.topology]);
            }
        }
    }

    _exportDisplays() {
        const assignments = resolveAssignments(this._dict('monitor-assignments'), this.monitors);
        const modes = resolveAssignments(this._dict('monitor-modes'), this.monitors);
        const pins = this.settings.get_strv('pinned-monitors'); const labels = this._dict('display-labels');
        const livePaths = new Set(this.monitors.map(m => `${ROOT}/displays/${m.id}`));
        for (const [key, object] of this.objects) if (object.iface === DISPLAY &&
            object.path.startsWith(`${ROOT}/displays/`) && !livePaths.has(object.path)) {
            object.exported.unexport(); this.objects.delete(key);
        }
        for (const m of this.monitors) {
            m.path = `${ROOT}/displays/${m.id}`;
            this._export(m.path, DISPLAY, {Id: m.id, Name: labels[m.identity] || m.label || m.hardwareConnector || 'Display',
                Connector: m.hardwareConnector || m.connector, Geometry: [m.x, m.y, m.width, m.height], Scale: [Math.round((m.scale || 1) * 1000), 1000],
                ImageUri: pathUri(assignments[m.connector] || ''), Mode: modes[m.connector] || 'zoom',
                Pinned: pins.includes(m.identity) || pins.includes(m.connector),
                IdentityState: m.autoIdentity ? 'automatic' : m.identity ? 'bound' : 'ambiguous',
                RememberedId: m.identity || '', CanBind: Boolean(m.bindingKey) && !m.autoIdentity, CanName: Boolean(m.bindingKey)});
        }
    }
    _display(id, topology) {
        if (!this.active || topology !== this.topology) fail('Conflict', 'The display session or topology changed');
        const monitor = this.monitors.find(m => m.id === id);
        if (!monitor) fail('Conflict', 'The selected display is no longer connected');
        return monitor;
    }

    _exportOperation(op) {
        this.operations.set(op.path, op);
        this._export(op.path, OP, op.props, {Cancel: () => {
            if (!op.props.CanCancel || TERMINAL.has(op.props.State)) return [false];
            op.cancel?.(); this._complete(op, 'cancelled', 'cancelled', 'Operation cancelled'); return [true];
        }});
    }
    _update(op, values) {
        if (this.closed || TERMINAL.has(op.props.State)) return;
        Object.assign(op.props, values); this._save(); this._properties(op.path, OP, values);
    }
    _complete(op, state, code, message, result = '/', resultInterface = '') {
        if (this.closed || TERMINAL.has(op.props.State)) return;
        op.recoveryPending = false;
        code = typeof code === 'string' ? code.slice(0, 128) : 'failed';
        this._update(op, {State: state, Phase: 'complete', CanCancel: false, Progress: state === 'succeeded' ? 10000 : op.props.Progress,
            ResultCode: code, Message: `${message || ''}`.slice(0, 4096), Result: result, ResultInterface: resultInterface, FinishedAtMs: Date.now()});
        this._signal(OP, 'Finished', '(ss)', [state, code], op.path);
    }
    _submit(id, kind, args, execute) {
        if (this.fault) fail('StateCorrupt', 'Manager metadata needs recovery');
        const request = Object.hasOwn(this.ledger.data.requests, id) ? this.ledger.data.requests[id] : null;
        const fingerprint = JSON.stringify([kind, args]);
        if (fingerprint.length > 65536) fail('TooLarge', 'Operation arguments exceed the limit');
        if (!request || request.purpose !== kind) fail('RequestMismatch', 'Use a request token issued for this operation');
        if (request.operation) {
            if (request.fingerprint !== fingerprint) fail('RequestMismatch', 'The request was already used with different inputs');
            return [request.operation.path];
        }
        if (request.expires < Date.now()) fail('RequestExpired', 'Request token expired');
        if ([...this.operations.values()].filter(op => !TERMINAL.has(op.props.State)).length >= 8) fail('Busy', 'Too many active operations');
        const op = {path: `${ROOT}/operations/r${id.replaceAll('-', '')}`, props: {
            Id: id, RequestId: id, Kind: kind, State: 'queued', Phase: 'queued', Progress: 0, CompletedUnits: 0,
            TotalUnits: 0, CanCancel: true, Partial: false, ResultCode: '', Message: '', Result: '/', ResultInterface: '',
            StartedAtMs: Date.now(), FinishedAtMs: 0}};
        request.fingerprint = fingerprint; request.operation = op; this._save(); this._exportOperation(op);
        later(async () => {
            if (this.closed || TERMINAL.has(op.props.State)) return;
            try {
                this._update(op, {State: 'running', Phase: 'validate'});
                const result = await execute(op);
                if (result) this._complete(op, 'succeeded', 'complete', '', result[0], result[1] || '');
            } catch (error) { this._complete(op, 'failed', error.code || 'failed', error.message); }
        });
        return [op.path];
    }

    async _configure(op, revision, changes) {
        if (revision !== this.revision) fail('Conflict', 'Configuration changed; refresh before applying');
        for (const key of Object.keys(changes)) if (!this.settings.is_writable(key)) fail('NotWritable', 'A setting is locked by policy');
        this._update(op, {CanCancel: false, Phase: 'commit'});
        this.settings.delay();
        for (const [key, [type, value]] of Object.entries(changes)) this.settings.set_value(key, new GLib.Variant(type, value));
        this.settings.apply(); await this.refreshRuntime(true); return ['/'];
    }
    _scan(op) {
        const folder = this.settings.get_string('wallpaper-folder');
        if (!folder) fail('InvalidArgument', 'Choose a wallpaper library folder first');
        this._update(op, {Phase: 'scan'});
        return new Promise((resolve, reject) => {
            const indexer = new LibraryIndexer(moduleRoot); op.cancel = () => indexer.dispose();
            indexer.scanAsync(folder, {probeDimensions: true}, result => {
                indexer.dispose();
                if (!result.ok) return reject(Object.assign(new Error(result.message), {code: result.code}));
                if (this.settings.get_string('wallpaper-folder') !== folder) return reject(Object.assign(new Error('Library folder changed'), {code: 'Conflict'}));
                const path = `${ROOT}/libraries/l${GLib.uuid_string_random().replaceAll('-', '')}`;
                const records = result.files.map(record => ({...record, id: GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, record.path, -1),
                    modifiedUsec: record.mtimeSec * 1000000 + record.mtimeUsec}));
                this._update(op, {CompletedUnits: records.length, TotalUnits: records.length});
                const fingerprint = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, JSON.stringify(records), -1);
                if (fingerprint !== this.libraryFingerprint) {
                    this.libraryFingerprint = fingerprint; this._bump(); this._exportConfiguration();
                    this._signal(BUS, 'LibraryChanged', '(t)', [this.revision]);
                }
                this._export(path, LIBRARY, {Revision: this.revision, FolderUri: pathUri(folder), Total: records.length,
                    Truncated: result.truncated, Warnings: result.errors.slice(0, 100).map(e => [e.code, e.message.slice(0, 512)])}, {
                    GetPage: ([query, sort, kind, cursor, limit]) => {
                        if (query.length > 512 || !['name-asc', 'name-desc', 'newest'].includes(sort) ||
                            !['all', 'png', 'jpeg', 'other'].includes(kind) || !/^\d*$/.test(cursor) || limit < 1 || limit > 100)
                            fail('InvalidArgument', 'Invalid library page');
                        const filtered = prepareLibraryRecords(records, {query, sort, kind}); const offset = Number(cursor || 0);
                        return [filtered.slice(offset, offset + limit).map(r => [r.id, pathUri(r.path), r.name, r.width || 0, r.height || 0, r.size, Math.floor(r.modifiedUsec / 1000)]),
                            offset + limit < filtered.length ? `${offset + limit}` : '', filtered.length];
                    },
                    LocateImage: ([uri, query, sort, kind, size]) => {
                        if (query.length > 512 || !['name-asc', 'name-desc', 'newest'].includes(sort) ||
                            !['all', 'png', 'jpeg', 'other'].includes(kind) || size < 1 || size > 100)
                            fail('InvalidArgument', 'Invalid library location query');
                        const filtered = prepareLibraryRecords(records, {query, sort, kind});
                        const index = filtered.findIndex(r => pathUri(r.path) === uri);
                        return [index >= 0, index >= 0 ? `${Math.floor(index / size) * size}` : '', index >= 0 ? index % size : 0];
                    },
                });
                this.resources.set(path, {records}); this._lease(path); resolve([path, LIBRARY]);
            });
        });
    }
    _lease(path) {
        const expires = Date.now() + 300000;
        this.resources.get(path).expires = expires;
        while (this.resources.size > 128) this._release(this.resources.keys().next().value);
        this._export(path, RESOURCE, {ExpiresAtMs: expires}, {Release: (_args, invocation) => {
            // Finish the invocation before unexporting its own skeleton and
            // dropping the JS roots that the in-flight C dispatch still uses.
            invocation.return_value(new GLib.Variant('()', []));
            later(() => this._release(path));
        }});
    }
    _release(path) {
        for (const [key, object] of this.objects) if (object.path === path) { object.exported.unexport(); this.objects.delete(key); }
        const resource = this.resources.get(path);
        if (resource?.file) try { Gio.File.new_for_path(resource.file).delete(null); } catch (_) {}
        this.resources.delete(path);
    }
    async _asset(path, width, height) {
        const source = Gio.File.new_for_path(path);
        const assetId = GLib.uuid_string_random().replaceAll('-', '');
        const directory = `${this.cacheDir}/assets`;
        GLib.mkdir_with_parents(directory, 0o700);
        const file = Gio.File.new_for_path(`${directory}/${assetId}.png`);
        await new Promise((resolve, reject) => source.copy_async(file, Gio.FileCopyFlags.NONE,
            GLib.PRIORITY_LOW, null, null, (f, result) => { try { resolve(f.copy_finish(result)); } catch (e) { reject(e); } }));
        const info = file.query_info('standard::size', 0, null);
        if (info.get_size() > 16 * 1024 * 1024) fail('TooLarge', 'Prepared image exceeds the asset limit');
        const bytes = await new Promise((resolve, reject) => file.load_contents_async(null, (f, r) => {
            try { resolve(f.load_contents_finish(r)[1]); } catch (e) { reject(e); }
        }));
        const objectPath = `${ROOT}/assets/a${assetId}`;
        this._export(objectPath, ASSET, {Kind: 'preview', MimeType: 'image/png', SizeBytes: bytes.length,
            Sha256: GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes), Width: width, Height: height}, {
            OpenReadOnly: async (_args, invocation) => {
                const stream = file.read(null); const fds = new Gio.UnixFDList();
                try { const index = fds.append(stream.get_fd()); invocation.return_value_with_unix_fd_list(new GLib.Variant('(h)', [index]), fds); }
                finally { stream.close(null); }
            },
        });
        this.resources.set(objectPath, {file: file.get_path()}); this._lease(objectPath); return objectPath;
    }
    _render(op, image, width, height, preview = null) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048)
            fail('InvalidArgument', 'Invalid preview dimensions');
        this._update(op, {Phase: 'preview'});
        const loader = new ThumbnailLoader(`${moduleRoot}/thumbnail-worker.js`, {width, height, preview, cacheDir: this.cacheDir});
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
                timeout = 0; settled = true; loader.cancel();
                reject(Object.assign(new Error('Preview worker exceeded its deadline'), {code: 'timeout'}));
                return GLib.SOURCE_REMOVE;
            });
            const cleanup = () => { if (timeout) GLib.source_remove(timeout); timeout = 0; loader.cancel(); };
            op.cancel = () => { if (settled) return; settled = true; cleanup(); reject(Object.assign(new Error('Preview cancelled'), {code: 'cancelled'})); };
            loader.enqueue(image, result => {
            if (settled) return;
            settled = true; cleanup();
            if (result.error) reject(result.error); else resolve(this._asset(result.outputPath, width, height));
            });
        });
    }
    async _preview(op, display, uri, mode, topology, width, height) {
        const monitor = this._display(display, topology);
        if (!MODES.has(mode)) fail('InvalidArgument', 'Invalid display mode');
        this._update(op, {TotalUnits: 1});
        const asset = await this._render(op, localPath(uri), width, height,
            {mode, monitorWidth: monitor.width, monitorHeight: monitor.height});
        this._display(display, topology); this._update(op, {CompletedUnits: 1}); return [asset, ASSET];
    }
    async _thumbnails(op, library, ids, width, height) {
        const records = this.resources.get(library)?.records;
        if (!records || ids.length < 1 || ids.length > 32) fail('InvalidArgument', 'Invalid library or thumbnail batch');
        this._update(op, {TotalUnits: ids.length});
        const items = [];
        for (const id of ids) {
            if (TERMINAL.has(op.props.State)) return null;
            const record = records.find(r => r.id === id);
            if (!record) { items.push([id, '/', 'not-found', 'Image is not in this library snapshot']); continue; }
            try { items.push([id, await this._render(op, record.path, width, height), '', '']); }
            catch (error) { items.push([id, '/', 'decode-failed', error.message.slice(0, 512)]); }
            this._update(op, {CompletedUnits: items.length, Progress: Math.floor(9500 * items.length / ids.length)});
        }
        const path = `${ROOT}/assets/c${GLib.uuid_string_random().replaceAll('-', '')}`;
        const iface = 'tech.norvi.SettingsAssetCollection1';
        this._export(path, iface, {}, {GetItems: () => [items]}); this.resources.set(path, {}); this._lease(path); return [path, iface];
    }
    async _apply(op, display, uri, mode, expectedUri, expectedMode, topology) {
        const monitor = this._display(display, topology);
        if (!MODES.has(mode) || !MODES.has(expectedMode)) fail('InvalidArgument', 'Invalid display mode');
        return this._delegate(op, 'Apply', {monitor: new GLib.Variant('s', monitor.connector),
            image: new GLib.Variant('s', localPath(uri)), mode: new GLib.Variant('s', mode),
            'expected-image': new GLib.Variant('s', localPath(expectedUri, true)),
            'expected-mode': new GLib.Variant('s', expectedMode), topology: new GLib.Variant('s', topology)});
    }
    async _undo(op, originalId, topology) {
        const original = Object.hasOwn(this.ledger.data.requests, originalId) ? this.ledger.data.requests[originalId] : null;
        if (original?.purpose !== 'Apply' || original.operation?.props.State !== 'succeeded')
            fail('InvalidArgument', 'Undo requires a retained successful Apply receipt');
        const [, [display, image, mode, previousImage, previousMode, originalTopology]] = JSON.parse(original.fingerprint);
        if (!previousImage || originalTopology !== topology) fail('Conflict', 'The display layout changed or there is no previous image');
        const monitor = this._display(display, topology);
        const assignments = resolveAssignments(this._dict('monitor-assignments'), this.monitors);
        const modes = resolveAssignments(this._dict('monitor-modes'), this.monitors);
        if (pathUri(assignments[monitor.connector] || '') !== image || (modes[monitor.connector] || 'zoom') !== mode)
            fail('Conflict', 'The current wallpaper changed after that Apply');
        return this._apply(op, display, previousImage, previousMode, image, mode, topology);
    }
    async _delegate(op, method, fields) {
        const owner = this.runtimeOwner;
        if (!this.active || !owner || await this._owner(RUNTIME) !== owner) fail('Unavailable', 'Runtime session changed');
        if (this.closed || TERMINAL.has(op.props.State)) return null;
        this._update(op, {CanCancel: false, Phase: 'publish'});
        op.runtimeOwner = owner; op.runtimeMethod = method; op.runtimeRequestId = op.props.RequestId; this._save();
        let runtimeId;
        try {
            [runtimeId] = await this._call(owner, RUNTIME_PATH, RUNTIME, method, new GLib.Variant('(a{sv})', [{...fields,
                source: new GLib.Variant('s', 'preferences'), 'request-id': new GLib.Variant('s', op.props.RequestId)}]), '(s)');
        } catch (_) {
            op.recoveryPending = true;
            return this._recoverOperation(op);
        }
        op.runtimeId = runtimeId; this._save();
        return this._followRuntime(op, owner, runtimeId);
    }
    async _recoverOperation(op) {
        op.recovering = true;
        if (!['Apply', 'Next', 'Undo'].includes(op.props.Kind) || !op.runtimeOwner)
            return this._complete(op, 'interrupted', 'outcome-unknown', 'The manager restarted before a verifiable runtime receipt was recorded.');
        const owner = this.runtimeOwner;
        let runtimeId = op.runtimeId || '';
        if (!runtimeId) {
            try {
                const [found, id] = await this._call(owner, RUNTIME_PATH, RUNTIME, 'GetRequestOperation',
                    new GLib.Variant('(ss)', ['preferences', op.runtimeRequestId || op.props.RequestId]), '(bs)');
                if (found) runtimeId = id;
            } catch (_) {}
        }
        if (!runtimeId || runtimeId.length > 128)
            return this._complete(op, 'interrupted', 'outcome-unknown', 'No prior runtime receipt could be verified; the action was not repeated.');
        op.runtimeId = runtimeId; this._save();
        this._update(op, {Phase: 'publish', CanCancel: false});
        return this._followRuntime(op, owner, runtimeId);
    }
    _followRuntime(op, owner, runtimeId) {
        const deadline = GLib.get_monotonic_time() + 30000000;
        return new Promise(resolve => {
            const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (this.closed || TERMINAL.has(op.props.State)) { op.pollSource = 0; resolve(null); return GLib.SOURCE_REMOVE; }
                if (GLib.get_monotonic_time() > deadline) {
                    this._complete(op, 'interrupted', 'outcome-unknown', 'Runtime outcome could not be confirmed; the action was not repeated.');
                    op.pollSource = 0; resolve(null); return GLib.SOURCE_REMOVE;
                }
                if (op.polling) return GLib.SOURCE_CONTINUE;
                op.polling = true;
                this._call(owner, RUNTIME_PATH, RUNTIME, 'GetOperation', new GLib.Variant('(s)', [runtimeId]), '(bsbbbssxx)').then(result => {
                    if (TERMINAL.has(op.props.State) || result[1] === 'running') return;
                    if (!result[0]) { this._complete(op, 'interrupted', 'outcome-unknown', 'Runtime receipt was unavailable.'); return; }
                    if (['interrupted', 'outcome-unknown'].includes(result[5])) {
                        this._complete(op, 'interrupted', 'outcome-unknown', result[6] || 'The runtime could not prove the prior publication outcome.'); return;
                    }
                    this._complete(op, result[0] && result[2] ? 'succeeded' : 'failed', result[5] || 'runtime-unavailable', result[6]);
                    this.refreshRuntime(true);
                }).catch(() => this._complete(op, 'interrupted', 'outcome-unknown', 'Runtime disconnected; inspect the current wallpaper before trying again.'))
                    .finally(() => { op.polling = false; });
                return GLib.SOURCE_CONTINUE;
            });
            op.pollSource = source;
        });
    }

    stop() {
        if (this.closed) return; this.closed = true; this.epoch++;
        if (this.pollSource) GLib.source_remove(this.pollSource);
        if (this.recoveryDeadline) GLib.source_remove(this.recoveryDeadline);
        if (this.settingsSignal) this.settings.disconnect(this.settingsSignal);
        if (this.runtimeWatch) Gio.bus_unwatch_name(this.runtimeWatch);
        if (this.displayWatch) Gio.bus_unwatch_name(this.displayWatch);
        if (this.displaySubscription) this.connection.signal_unsubscribe(this.displaySubscription);
        try { this.healthWorker?.force_exit(); } catch (_) {}
        for (const op of this.operations.values()) { op.cancel?.(); if (op.pollSource) GLib.source_remove(op.pollSource); }
        for (const object of this.objects.values()) object.exported.unexport();
        this.objects.clear(); this.indexer.dispose();
        if (this.ownerId) Gio.bus_unown_name(this.ownerId);
        this.ownerId = 0;
        this.onStopped?.();
    }
}

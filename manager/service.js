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
const MODES = new Set(['zoom', 'fit', 'stretch', 'center', 'tile']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const PURPOSES = new Set(['RefreshDisplays', 'RefreshLibrary', 'PreparePreview', 'PrepareThumbnails',
    'Apply', 'Next', 'SetLibraryFolder', 'SetRotation', 'SetRendering', 'SetPinned', 'UnpinAll']);
const CAPABILITIES = ['service.snapshot.v1', 'operations.v1', 'assets.fd.v1', 'wallpaper.displays.v1',
    'wallpaper.configuration.v1', 'wallpaper.library.v1', 'wallpaper.preview.v1',
    'wallpaper.thumbnails.v1', 'wallpaper.apply.v1', 'wallpaper.next.v1', 'wallpaper.rotation.v1', 'wallpaper.pin.v1'];
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
        this.topologyProvider = options.topologyProvider || null;
        this.instance = GLib.uuid_string_random();
        this.build = readBuildInfo(moduleRoot);
        this.objects = new Map(); this.resources = new Map(); this.operations = new Map();
        this.runtimeOwner = ''; this.monitors = []; this.topology = ''; this.active = false;
        this.closed = false; this.refreshing = false; this.epoch = 0;
        this.onStopped = options.onStopped || null;
        this.fault = ''; this.runtimeStatus = [0, false, false, false, ''];
        this.indexer = new LibraryIndexer(moduleRoot);
        this.interfaces = new Map();
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
            connection => { this.connection = connection; },
            () => this._acquired(), () => this.stop());
    }

    _acquired() {
        if (this.closed) return;
        this.ledger = new Ledger(this.statePath);
        try { this.ledger.bump(); } catch (error) { this.fault = error.message; }
        this.fault ||= this.ledger.fault;
        this._export(ROOT, BUS, {}, this._rootMethods());
        this._export(ROOT, OPS, {}, {
            CreateRequest: ([purpose]) => {
                if (!PURPOSES.has(purpose)) fail('NotSupported', 'Unknown operation');
                try { return this.ledger.create(purpose); }
                catch (error) { if (this.ledger.fault) this.stop(); throw error; }
            },
            LookupRequest: ([id]) => { const r = this.ledger.data.requests[id]; return [Boolean(r), r?.operation?.path || '/']; },
            ListOperations: ([cursor, limit]) => {
                if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !/^\d*$/.test(cursor)) fail('InvalidArgument', 'Invalid page');
                const list = [...this.operations.keys()]; const offset = Number(cursor || 0);
                return [list.slice(offset, offset + limit), offset + limit < list.length ? `${offset + limit}` : ''];
            },
        });
        for (const request of Object.values(this.ledger.data.requests))
            if (request.operation) this._exportOperation(request.operation);
        this._exportConfiguration();
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
        try { this.ledger.save(); }
        catch (error) { this.fault = error.message; this.stop(); throw error; }
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
        const info = Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0];
        const object = {path, iface, props, exported: null};
        const implementation = {};
        for (const property of info.properties || [])
            Object.defineProperty(implementation, property.name, {get: () => object.props[property.name]});
        for (const method of info.methods || []) {
            implementation[`${method.name}Async`] = (args, invocation) => {
                Promise.resolve().then(() => {
                    if (this.closed) fail('Unavailable', 'Manager is stopping');
                    if (!methods[method.name]) fail('NotSupported', 'This workflow is not implemented');
                    return methods[method.name](args, invocation);
                }).then(result => {
                    if (result === undefined) return;
                    const signature = `(${(method.out_args || []).map(a => a.signature).join('')})`;
                    invocation.return_value(new GLib.Variant(signature, result));
                }).catch(error => {
                    const code = /^[A-Za-z_][A-Za-z0-9_]*$/.test(`${error.code || ''}`) ? error.code : 'Failed';
                    invocation.return_dbus_error(`tech.norvi.Settings.Error.${code}`, `${error.message || error}`.slice(0, 4096));
                });
            };
        }
        object.exported = Gio.DBusExportedObject.wrapJSObject(xml, implementation);
        object.exported.export(this.connection, path);
        this.objects.set(key, object);
        return object;
    }

    _properties(path, iface, changed) {
        if (this.closed) return;
        const object = this.objects.get(`${path}:${iface}`);
        Object.assign(object.props, changed);
        const info = Gio.DBusNodeInfo.new_for_xml(this.interfaces.get(iface)).interfaces[0];
        for (const [name, value] of Object.entries(changed))
            object.exported.emit_property_changed(name, new GLib.Variant(info.properties.find(p => p.name === name).signature, value));
    }

    _rootMethods() {
        return {
            GetCapabilities: () => [1, 0, CAPABILITIES, {page: 100, displays: 64, thumbnails: 32, previewEdge: 2048, activeOperations: 8}],
            GetSnapshot: () => [this.instance, this.revision, !this.fault && this.active,
                this.fault ? 'state-corrupt' : this.active ? 'ready' : 'runtime-unavailable',
                this.fault || (this.active ? 'Wallpaper service is ready.' : 'The active Wallpaper Suite runtime and display session are required.'),
                this.build.version, this.build.version, false],
            GetConfiguration: () => [`${ROOT}/configuration`],
            GetDisplays: () => [this.topology, this.monitors.map(m => m.path)],
            GetRememberedDisplays: () => [Object.entries(this._dict('display-labels'))],
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
        };
    }

    _dict(key) { return this.settings.get_value(key).deepUnpack(); }
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
            this.monitors = topology.map(m => ({...m, identity: m.identity || bindings[m.bindingKey] || null,
                id: `d${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `${m.connector}|${m.identity || ''}`, -1).slice(0, 24)}`}));
            this.topology = topologyKey(this.monitors); this.runtimeOwner = owner; this.runtimeStatus = status; this.active = true;
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
        for (const [key, object] of this.objects) if (object.iface === DISPLAY && !livePaths.has(object.path)) {
            object.exported.unexport(); this.objects.delete(key);
        }
        for (const m of this.monitors) {
            m.path = `${ROOT}/displays/${m.id}`;
            this._export(m.path, DISPLAY, {Id: m.id, Name: labels[m.identity] || m.label || m.hardwareConnector || 'Display',
                Connector: m.hardwareConnector || m.connector, Geometry: [m.x, m.y, m.width, m.height], Scale: [Math.round((m.scale || 1) * 1000), 1000],
                ImageUri: pathUri(assignments[m.connector] || ''), Mode: modes[m.connector] || 'zoom',
                Pinned: pins.includes(m.identity) || pins.includes(m.connector), IdentityState: m.identity ? 'identified' : 'ambiguous',
                RememberedId: m.identity || '', CanBind: false, CanName: false});
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
        code = typeof code === 'string' ? code.slice(0, 128) : 'failed';
        this._update(op, {State: state, Phase: 'complete', CanCancel: false, Progress: state === 'succeeded' ? 10000 : op.props.Progress,
            ResultCode: code, Message: `${message || ''}`.slice(0, 4096), Result: result, ResultInterface: resultInterface, FinishedAtMs: Date.now()});
        this._signal(OP, 'Finished', '(ss)', [state, code], op.path);
    }
    _submit(id, kind, args, execute) {
        if (this.fault) fail('StateCorrupt', 'Manager metadata needs recovery');
        const request = this.ledger.data.requests[id]; const fingerprint = JSON.stringify([kind, args]);
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

    _configure(op, revision, changes) {
        if (revision !== this.revision) fail('Conflict', 'Configuration changed; refresh before applying');
        for (const key of Object.keys(changes)) if (!this.settings.is_writable(key)) fail('NotWritable', 'A setting is locked by policy');
        this._update(op, {CanCancel: false, Phase: 'commit'});
        this.settings.delay();
        for (const [key, [type, value]] of Object.entries(changes)) this.settings.set_value(key, new GLib.Variant(type, value));
        this.settings.apply(); return ['/'];
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
        this._export(path, RESOURCE, {ExpiresAtMs: expires}, {Release: () => { this._release(path); return []; }});
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
        const asset = await this._render(op, localPath(uri), width, height,
            {mode, monitorWidth: monitor.width, monitorHeight: monitor.height});
        this._display(display, topology); return [asset, ASSET];
    }
    async _thumbnails(op, library, ids, width, height) {
        const records = this.resources.get(library)?.records;
        if (!records || ids.length < 1 || ids.length > 32) fail('InvalidArgument', 'Invalid library or thumbnail batch');
        const items = [];
        for (const id of ids) {
            if (TERMINAL.has(op.props.State)) return null;
            const record = records.find(r => r.id === id);
            if (!record) { items.push([id, '/', 'not-found', 'Image is not in this library snapshot']); continue; }
            try { items.push([id, await this._render(op, record.path, width, height), '', '']); }
            catch (error) { items.push([id, '/', 'decode-failed', error.message.slice(0, 512)]); }
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
    async _delegate(op, method, fields) {
        const owner = this.runtimeOwner;
        if (!this.active || !owner || await this._owner(RUNTIME) !== owner) fail('Unavailable', 'Runtime session changed');
        if (this.closed || TERMINAL.has(op.props.State)) return null;
        this._update(op, {CanCancel: false, Phase: 'publish'});
        op.runtimeOwner = owner; this._save();
        let runtimeId;
        try {
            [runtimeId] = await this._call(owner, RUNTIME_PATH, RUNTIME, method, new GLib.Variant('(a{sv})', [{...fields,
                source: new GLib.Variant('s', 'preferences'), 'request-id': new GLib.Variant('s', op.props.RequestId)}]), '(s)');
        } catch (_) {
            this._complete(op, 'interrupted', 'outcome-unknown', 'Runtime acknowledgement was lost; the action was not repeated.');
            return null;
        }
        op.runtimeId = runtimeId; this._save();
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
        if (this.settingsSignal) this.settings.disconnect(this.settingsSignal);
        for (const op of this.operations.values()) { op.cancel?.(); if (op.pollSource) GLib.source_remove(op.pollSource); }
        for (const object of this.objects.values()) object.exported.unexport();
        this.objects.clear(); this.indexer.dispose();
        if (this.ownerId) Gio.bus_unown_name(this.ownerId);
        this.ownerId = 0;
        this.onStopped?.();
    }
}

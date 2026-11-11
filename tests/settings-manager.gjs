// Isolated manager contract tests: real image workers, synthetic runtime publication.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import GioUnix from 'gi://GioUnix';
import System from 'system';
import {WallpaperManager, BUS, ROOT} from '../manager/service.js';
import {ControlService} from '../controlService.js';

const [schemaDir, scratch] = ARGV;
if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory' || !scratch || !GLib.getenv('WALLPAPER_MANAGER_TEST'))
    throw new Error('A marked private test environment is required');
const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.wallpaper-suite', false)});
const bus = Gio.DBus.session;
const assert = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
const call = (path, iface, method, signature = null, args = [], fd = false) => new Promise((resolve, reject) => {
    const parameters = signature ? new GLib.Variant(signature, args) : null;
    if (fd) bus.call_with_unix_fd_list(BUS, path, iface, method, parameters, null, 0, 3000, null, null,
        (connection, result) => { try { resolve(connection.call_with_unix_fd_list_finish(result)); } catch (error) { reject(error); } });
    else bus.call(BUS, path, iface, method, parameters, null, 0, 3000, null,
        (connection, result) => { try { resolve(connection.call_finish(result).deepUnpack()); } catch (error) { reject(error); } });
});
const properties = async (path, iface) => {
    const [values] = await call(path, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)', [iface]);
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value?.deepUnpack ? value.deepUnpack() : value]));
};
const wait = async (predicate, message) => {
    const deadline = GLib.get_monotonic_time() + 10000000;
    while (GLib.get_monotonic_time() < deadline) { if (await predicate()) return; await pause(20); }
    throw new Error(`Timed out: ${message}`);
};
const terminal = async path => {
    let value;
    await wait(async () => { value = await properties(path, 'tech.norvi.SettingsOperation1'); return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.State); }, 'operation');
    return value;
};
const request = async (method, signature, args) => {
    const [id] = await call(ROOT, 'tech.norvi.SettingsOperations1', 'CreateRequest', '(s)', [method]);
    const [path] = await call(ROOT, BUS, method, signature, [id, ...args]);
    return {id, path, result: await terminal(path)};
};
const folder = `${scratch}/images`;
GLib.mkdir_with_parents(folder, 0o700);
const images = ['Amber', 'Ocean', 'Forest'].map((name, i) => {
    const path = `${folder}/${name}.png`;
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 320 + i * 10, 180);
    pixbuf.fill([0xee8833ff, 0x2277ccff, 0x228855ff][i]); pixbuf.savev(path, 'png', [], []); return path;
});
const uri = path => Gio.File.new_for_path(path).get_uri();
const topology = [0, 1, 2].map(index => ({x: index * 800, y: 0, width: 800, height: 600,
    scale: 1, connector: `800x600+${index * 800}+0`, hardwareConnector: `TEST-${index}`,
    identity: `display:TEST/Monitor/${index}`, label: `Test display ${index + 1}`}));
settings.set_string('wallpaper-folder', folder);
settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', Object.fromEntries(topology.map((m, i) => [m.connector, images[i]]))));
settings.set_value('monitor-modes', new GLib.Variant('a{ss}', Object.fromEntries(topology.map(m => [m.connector, 'zoom']))));
let dispatches = 0;
const runtime = new ControlService({getStatus: () => ({active: true}), onApply(options, done) {
    dispatches++;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 70, () => {
        const values = settings.get_value('monitor-assignments').deepUnpack();
        const modes = settings.get_value('monitor-modes').deepUnpack();
        if (values[options.monitor] !== options.expectedImage) done({ok: false, code: 'stale-context'});
        else {
            values[options.monitor] = options.image; modes[options.monitor] = options.mode;
            settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', values));
            settings.set_value('monitor-modes', new GLib.Variant('a{ss}', modes));
            done({ok: true, changed: true, published: true, code: 'published'});
        }
        return GLib.SOURCE_REMOVE;
    }); return true;
}, onNext(_options, done) { done({ok: true, changed: false, published: false, code: 'no-alternative'}); return true; }});
let manager;
const newManager = () => new WallpaperManager({settings, topologyProvider: async () => topology,
    statePath: `${scratch}/state/manager.json`, cacheDir: `${scratch}/cache`});
async function run() {
    runtime.start(); manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[2]; } catch (_) { return false; } }, 'manager ready');
    const [, , caps] = await call(ROOT, BUS, 'GetCapabilities');
    assert(caps.includes('wallpaper.displays.v1') && !caps.includes('wallpaper.panel.v1'), 'granular capabilities only');
    const [topologyToken, displays] = await call(ROOT, BUS, 'GetDisplays');
    assert(displays.length === 3, 'three synthetic displays');
    const display = await properties(displays[0], 'tech.norvi.WallpaperDisplay1');
    assert(display.Geometry[2] === 800 && display.ImageUri === uri(images[0]), 'typed geometry and assignments');
    const library = await request('RefreshLibrary', '(s)', []);
    assert(library.result.State === 'succeeded', `real index worker: ${library.result.Message}`);
    const [records, cursor, total] = await call(library.result.Result, 'tech.norvi.WallpaperLibrary1', 'GetPage', '(ssssu)', ['', 'name-asc', 'all', '', 100]);
    assert(total === 3 && !cursor && records.every(r => r[3] > 0), 'real indexed image dimensions');
    const [randomId, randomUri] = await call(ROOT, BUS, 'ChooseRandom', '(os)', [library.result.Result, records[0][0]]);
    assert(randomId !== records[0][0] && randomUri.startsWith('file:'), 'random choice excludes current image');
    const [located, pageCursor] = await call(library.result.Result, 'tech.norvi.WallpaperLibrary1', 'LocateImage', '(ssssu)', [records[2][1], '', 'name-asc', 'all', 2]);
    assert(located && pageCursor === '2', 'library location uses stable page offsets');
    const preview = await request('PreparePreview', '(sssssuu)', [display.Id, uri(images[1]), 'fit', topologyToken, 240, 160]);
    assert(preview.result.State === 'succeeded', `real preview worker: ${preview.result.Message}`);
    const asset = await properties(preview.result.Result, 'tech.norvi.SettingsAsset1');
    assert(asset.Width === 240 && asset.Height === 160 && asset.Sha256.length === 64, 'typed immutable PNG asset');
    const [handle, fds] = await call(preview.result.Result, 'tech.norvi.SettingsAsset1', 'OpenReadOnly', null, [], true);
    const stream = new GioUnix.InputStream({fd: fds.get(handle.deepUnpack()[0]), close_fd: true});
    const bytes = stream.read_bytes(8, null).get_data(); stream.close(null);
    assert(bytes[0] === 137 && bytes[1] === 80, 'read-only FD contains PNG');
    assert(settings.get_value('monitor-assignments').deepUnpack()[topology[0].connector] === images[0], 'preview makes no wallpaper change');
    const wrongTopology = await request('PreparePreview', '(sssssuu)', [display.Id, uri(images[1]), 'fit', 'old-topology', 240, 160]);
    assert(wrongTopology.result.State === 'failed' && wrongTopology.result.ResultCode === 'Conflict', 'stale topology cannot prepare a misleading display preview');
    const [cancelId] = await call(ROOT, 'tech.norvi.SettingsOperations1', 'CreateRequest', '(s)', ['Apply']);
    const [cancelPath] = await call(ROOT, BUS, 'Apply', '(sssssss)', [cancelId, display.Id, uri(images[2]), 'fit', uri(images[0]), 'zoom', topologyToken]);
    const [cancelled] = await call(cancelPath, 'tech.norvi.SettingsOperation1', 'Cancel');
    if (cancelled) {
        await pause(120);
        assert(dispatches === 0 && (await terminal(cancelPath)).State === 'cancelled', 'accepted cancellation prevents later runtime dispatch');
    } else {
        await terminal(cancelPath);
        settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', Object.fromEntries(topology.map((m, i) => [m.connector, images[i]]))));
        dispatches = 0;
    }
    const apply = await request('Apply', '(sssssss)', [display.Id, uri(images[1]), 'fit', uri(images[0]), 'zoom', topologyToken]);
    assert(apply.result.State === 'succeeded' && dispatches === 1, 'runtime Apply delegated once');
    const [duplicate] = await call(ROOT, BUS, 'Apply', '(sssssss)', [apply.id, display.Id, uri(images[1]), 'fit', uri(images[0]), 'zoom', topologyToken]);
    assert(duplicate === apply.path && dispatches === 1, 'lost reply recovery never redispatches');
    let mismatch = false;
    try { await call(ROOT, BUS, 'Apply', '(sssssss)', [apply.id, display.Id, uri(images[2]), 'fit', uri(images[0]), 'zoom', topologyToken]); } catch (_) { mismatch = true; }
    assert(mismatch, 'changed request input rejected');
    const [configPath] = await call(ROOT, BUS, 'GetConfiguration');
    const config = await properties(configPath, 'tech.norvi.WallpaperConfiguration1');
    const rotation = await request('SetRotation', '(sbusbbt)', [true, 45, 'sequential', true, false, config.Revision]);
    assert(rotation.result.State === 'succeeded' && settings.get_int('rotation-interval-minutes') === 45, 'rotation propagates through existing settings');
    const conflict = await request('UnpinAll', '(st)', [config.Revision]);
    assert(conflict.result.State === 'failed' && conflict.result.ResultCode === 'Conflict', 'stale configuration rejected');
    const before = (await call(ROOT, BUS, 'GetSnapshot'))[1];
    manager.stop(); await pause(80); manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[1] > before; } catch (_) { return false; } }, 'restart revision');
    const [known, retained] = await call(ROOT, 'tech.norvi.SettingsOperations1', 'LookupRequest', '(s)', [apply.id]);
    assert(known && retained === apply.path && dispatches === 1, 'restart retains receipt without runtime redispatch');
    manager.stop(); await pause(60);
    Gio.File.new_for_path(`${scratch}/state/manager.json`).replace_contents(new TextEncoder().encode('{broken'), null, false, Gio.FileCreateFlags.PRIVATE, null);
    manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[3] === 'state-corrupt'; } catch (_) { return false; } }, 'corrupt metadata fails closed');
    assert(!(await call(ROOT, BUS, 'GetSnapshot'))[2], 'damaged receipt ledger never reports readiness');
    print('PASS: typed displays/config/library, real preview worker+FD, Apply identity, rotation conflicts and durable restart');
}
const loop = new GLib.MainLoop(null, false);
run().then(() => { manager.stop(); runtime.stop(); loop.quit(); }).catch(error => {
    printerr(error.stack || error); manager?.stop(); runtime.stop(); System.exit(1);
});
loop.run();

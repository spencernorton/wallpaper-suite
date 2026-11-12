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
        (connection, result) => { try { resolve(connection.call_finish(result).deepUnpack()); } catch (error) { reject(new Error(`${iface}.${method} (${path}): ${error.message || error}`)); } });
});
const properties = async (path, iface) => {
    const [values] = await call(path, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)', [iface]);
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value?.deepUnpack ? value.deepUnpack() : value]));
};
const callOn = (connection, path, iface, method, signature = null, args = []) => new Promise((resolve, reject) =>
    connection.call(BUS, path, iface, method, signature ? new GLib.Variant(signature, args) : null,
        null, Gio.DBusCallFlags.NO_AUTO_START, 3000, null,
        (sender, result) => { try { resolve(sender.call_finish(result).deepUnpack()); } catch (error) { reject(error); } }));
const release = path => call(path, 'tech.norvi.SettingsResource1', 'Release');
const readConfiguration = async () => {
    const [path] = await call(ROOT, BUS, 'GetConfiguration');
    try { return await properties(path, 'tech.norvi.WallpaperConfiguration1'); }
    finally { await release(path); }
};
const readDisplays = async () => {
    const [token, paths] = await call(ROOT, BUS, 'GetDisplays');
    try { return [token, await Promise.all(paths.map(path => properties(path, 'tech.norvi.WallpaperDisplay1')))]; }
    finally { await Promise.all(paths.map(release)); }
};
const currentDisplay = async id => (await readDisplays())[1].find(display => display.Id === id);
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
    bindingKey: JSON.stringify([`TEST-${index}`, 'Test', 'Monitor', index < 2 ? `${index}` : 'unknown']),
    identity: index < 2 ? `display:TEST/Monitor/${index}` : null, label: `Test display ${index + 1}`}));
settings.set_string('wallpaper-folder', folder);
settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', Object.fromEntries(topology.map((m, i) => [m.connector, images[i]]))));
settings.set_value('monitor-modes', new GLib.Variant('a{ss}', Object.fromEntries(topology.map(m => [m.connector, 'zoom']))));
let dispatches = 0;
let publicationDelay = 70;
const runtime = new ControlService({getStatus: () => ({active: true, runtimeInstance: 'TEST-RUNTIME-1', sessionId: 'TEST-SESSION'}), onApply(options, done) {
    dispatches++;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, publicationDelay, () => {
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
    statePath: `${scratch}/state/manager.json`, cacheDir: `${scratch}/cache`, runtimeCacheDir: `${scratch}/runtime-cache`});
async function run() {
    runtime.start(); manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[2]; } catch (_) { return false; } }, 'manager ready');
    const [, , caps] = await call(ROOT, BUS, 'GetCapabilities');
    assert(caps.includes('wallpaper.displays.v1') && !caps.includes('wallpaper.panel.v1'), 'granular capabilities only');
    assert(caps.includes('wallpaper.display-previews.v1'), 'display preview capability advertised');
    const [topologyToken, displays] = await call(ROOT, BUS, 'GetDisplays');
    assert(displays.length === 3, 'three synthetic displays');
    for (let pass = 0; pass < 24; pass++) {
        const [view] = await call(ROOT, BUS, 'GetConfiguration');
        const [, views] = await call(ROOT, BUS, 'GetDisplays');
        System.gc();
        assert((await properties(view, 'tech.norvi.WallpaperConfiguration1')).Revision > 0,
            'configuration metadata survives collection');
        assert((await properties(views[0], 'tech.norvi.WallpaperDisplay1')).Geometry[2] === 800,
            'display metadata survives collection');
        await release(view); await Promise.all(views.map(release));
    }
    print('PASS: leased snapshot interfaces survive repeated garbage collection');
    const originalDisplays = await Promise.all(displays.map(path => properties(path, 'tech.norvi.WallpaperDisplay1')));
    const display = originalDisplays[0];
    assert(display.Geometry[2] === 800 && display.ImageUri === uri(images[0]), 'typed geometry and assignments');
    assert(display.IdentityState === 'automatic', 'physical identity uses the declared identity enum');
    await manager.refreshRuntime();
    const [sameTopology, refreshedDisplays] = await readDisplays();
    assert(sameTopology === topologyToken && refreshedDisplays.map(d => d.Id).join('/') === originalDisplays.map(d => d.Id).join('/'),
        'unchanged runtime refresh retains display IDs and topology across leased views');
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
    const [displayPreviews] = await call(ROOT, BUS, 'GetDisplayPreviews', '(su)', [topologyToken, 640]);
    assert(displayPreviews.length === 3 && displayPreviews.every(([id, image, mode, path, code]) => !code && path !== '/' &&
        mode === 'zoom' && image === uri(images[originalDisplays.findIndex(d => d.Id === id)])),
    'every display preview uses its current image and mode');
    const tile = await properties(displayPreviews[0][3], 'tech.norvi.SettingsAsset1');
    assert(tile.Width === 640 && tile.Height === 480, 'display previews use the shared integer sizing');
    let stalePreviews = false;
    try { await call(ROOT, BUS, 'GetDisplayPreviews', '(su)', ['old-topology', 640]); } catch (_) { stalePreviews = true; }
    assert(stalePreviews, 'display previews require the current topology');
    await Promise.all(displayPreviews.map(item => release(item[3])));
    print('PASS: every display preview renders the current wallpaper in one call');
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
    const unknown = await call(ROOT, 'tech.norvi.SettingsOperations1', 'LookupRequest', '(s)', ['__proto__']);
    assert(unknown[0] === false, 'prototype object names are not issued requests');
    const undo = await request('Undo', '(sss)', [apply.id, topologyToken]);
    assert(undo.result.State === 'succeeded' && dispatches === 2 && settings.get_value('monitor-assignments').deepUnpack()[topology[0].connector] === images[0], 'Undo delegates inverse Apply with expected-current state');
    const undoAgain = await request('Undo', '(sss)', [apply.id, topologyToken]);
    assert(undoAgain.result.State === 'failed' && undoAgain.result.ResultCode === 'Conflict' && dispatches === 2, 'Undo cannot overwrite a later wallpaper');
    const [configPath] = await call(ROOT, BUS, 'GetConfiguration');
    const config = await properties(configPath, 'tech.norvi.WallpaperConfiguration1');
    const rotation = await request('SetRotation', '(sbusbbt)', [true, 45, 'sequential', true, false, config.Revision]);
    assert(rotation.result.State === 'succeeded' && settings.get_int('rotation-interval-minutes') === 45, 'rotation propagates through existing settings');
    const conflict = await request('UnpinAll', '(st)', [config.Revision]);
    assert(conflict.result.State === 'failed' && conflict.result.ResultCode === 'Conflict', 'stale configuration rejected');
    let current = await readConfiguration();
    const named = await request('NameDisplay', '(sssst)', [display.Id, 'Left display', topologyToken, current.Revision]);
    assert(named.result.State === 'succeeded', `hardware display naming: ${named.result.Message}`);
    assert((await currentDisplay(display.Id)).Name === 'Left display', 'display label is visible through a new typed snapshot');
    current = await readConfiguration();
    const getTopology = async () => (await readDisplays())[0];
    const namedAmbiguous = await request('NameDisplay', '(sssst)', [originalDisplays[2].Id,
        'Right display', await getTopology(), current.Revision]);
    assert(namedAmbiguous.result.State === 'succeeded', 'ambiguous display receives a saved user identity');
    const third = await currentDisplay(originalDisplays[2].Id);
    assert(third.RememberedId.startsWith('user:') && third.CanBind && third.IdentityState === 'bound', 'saved display identity is available for remapping');
    current = await readConfiguration();
    const pin = await request('SetPinned', '(ssbst)', [third.Id, true, await getTopology(), current.Revision]);
    assert(pin.result.State === 'succeeded' && settings.get_strv('pinned-monitors').includes(third.RememberedId), 'pin uses stable identity');
    current = await readConfiguration();
    const unbound = await request('SetDisplayBinding', '(sssst)', [third.Id, '', await getTopology(), current.Revision]);
    assert(unbound.result.State === 'succeeded' && (await currentDisplay(third.Id)).RememberedId === '', 'layout-only mapping removes explicit identity');
    current = await readConfiguration();
    const bound = await request('SetDisplayBinding', '(sssst)', [third.Id, third.RememberedId, await getTopology(), current.Revision]);
    assert(bound.result.State === 'succeeded' && (await currentDisplay(third.Id)).RememberedId === third.RememberedId, 'saved display mapping is recoverable');
    current = await readConfiguration();
    const rendering = await request('SetRendering', '(sbut)', [false, 85, current.Revision]);
    assert(rendering.result.State === 'succeeded' && settings.get_int('composite-quality') === 85 && !settings.get_boolean('show-indicator'), 'rendering configuration propagates');
    await manager.refreshRuntime(true);
    assert(JSON.stringify(await properties(configPath, 'tech.norvi.WallpaperConfiguration1')) === JSON.stringify(config),
        'leased configuration stays immutable after settings and runtime refresh');
    assert(JSON.stringify(await Promise.all(displays.map(path => properties(path, 'tech.norvi.WallpaperDisplay1')))) === JSON.stringify(originalDisplays),
        'leased display snapshots stay immutable and survive internal topology refresh');
    await release(configPath); await Promise.all(displays.map(release));
    GLib.mkdir_with_parents(`${scratch}/runtime-cache`, 0o700);
    const healthCache = Gio.File.new_for_path(`${scratch}/runtime-cache/runtime-status.json`);
    const writeHealth = instance => healthCache.replace_contents(new TextEncoder().encode(JSON.stringify({schemaVersion: 2,
        runtimeInstance: instance, sessionId: 'TEST-SESSION', lastRenderAt: Date.now(), poolFolder: folder, poolLastAttemptOk: true})), null, false, Gio.FileCreateFlags.PRIVATE, null);
    writeHealth('OLD-RUNTIME');
    const [oldHealth] = await call(ROOT, BUS, 'GetHealth');
    const oldFacts = await properties(oldHealth, 'tech.norvi.WallpaperHealth1');
    assert(oldFacts.RuntimeAvailable && !oldFacts.LastRenderIsCurrentSession && oldFacts.LastRenderAtMs > 0, 'historical render never proves current session rendering');
    writeHealth('TEST-RUNTIME-1');
    const [newHealth] = await call(ROOT, BUS, 'GetHealth');
    assert((await properties(newHealth, 'tech.norvi.WallpaperHealth1')).LastRenderIsCurrentSession, 'matching live runtime identity verifies render provenance');
    const connectionFlags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION;
    const firstClient = Gio.DBusConnection.new_for_address_sync(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'), connectionFlags, null, null);
    const secondClient = Gio.DBusConnection.new_for_address_sync(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'), connectionFlags, null, null);
    try {
        assert(firstClient.get_unique_name() !== secondClient.get_unique_name(), 'health readers use independent bus connections');
        const [[firstPath], [secondPath]] = await Promise.all([
            callOn(firstClient, ROOT, BUS, 'GetHealth'), callOn(secondClient, ROOT, BUS, 'GetHealth')]);
        assert(firstPath !== secondPath, 'concurrent health readers receive distinct leased handles');
        const readHealth = (connection, path) => callOn(connection, path, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)', ['tech.norvi.WallpaperHealth1']);
        const [[firstFacts], [secondFacts]] = await Promise.all([readHealth(firstClient, firstPath), readHealth(secondClient, secondPath)]);
        assert(firstFacts.ObservedAtMs.deepUnpack() === secondFacts.ObservedAtMs.deepUnpack(), 'concurrent readers share one health inspection');
        await callOn(firstClient, firstPath, 'tech.norvi.SettingsResource1', 'Release');
        let released = false;
        try { await readHealth(firstClient, firstPath); } catch (_) { released = true; }
        assert(released, 'the first health reader actually releases its handle');
        const [remaining] = await readHealth(secondClient, secondPath);
        assert(remaining.LastRenderIsCurrentSession.deepUnpack(), 'releasing one health snapshot preserves another reader');
        await callOn(secondClient, secondPath, 'tech.norvi.SettingsResource1', 'Release');
        const [[firstConfiguration], [secondConfiguration]] = await Promise.all([
            callOn(firstClient, ROOT, BUS, 'GetConfiguration'), callOn(secondClient, ROOT, BUS, 'GetConfiguration')]);
        const [[firstTopology, firstViews], [secondTopology, secondViews]] = await Promise.all([
            callOn(firstClient, ROOT, BUS, 'GetDisplays'), callOn(secondClient, ROOT, BUS, 'GetDisplays')]);
        assert(firstConfiguration !== secondConfiguration && firstViews.every(path => !secondViews.includes(path)) && firstTopology === secondTopology,
            'independent readers receive distinct configuration and display leases without changing topology');
        await callOn(firstClient, firstConfiguration, 'tech.norvi.SettingsResource1', 'Release');
        await Promise.all(firstViews.map(path => callOn(firstClient, path, 'tech.norvi.SettingsResource1', 'Release')));
        const [otherConfiguration] = await callOn(secondClient, secondConfiguration, 'org.freedesktop.DBus.Properties', 'GetAll', '(s)', ['tech.norvi.WallpaperConfiguration1']);
        const [otherDisplay] = await callOn(secondClient, secondViews[0], 'org.freedesktop.DBus.Properties', 'GetAll', '(s)', ['tech.norvi.WallpaperDisplay1']);
        assert(otherConfiguration.Revision.deepUnpack() > 0 && otherDisplay.Id.deepUnpack() === display.Id,
            'releasing one configuration/display view preserves another reader');
        await callOn(secondClient, secondConfiguration, 'tech.norvi.SettingsResource1', 'Release');
        await Promise.all(secondViews.map(path => callOn(secondClient, path, 'tech.norvi.SettingsResource1', 'Release')));
    } finally { firstClient.close_sync(null); secondClient.close_sync(null); }
    const before = (await call(ROOT, BUS, 'GetSnapshot'))[1];
    manager.stop(); await pause(80); manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[1] > before; } catch (_) { return false; } }, 'restart revision');
    const [known, retained] = await call(ROOT, 'tech.norvi.SettingsOperations1', 'LookupRequest', '(s)', [apply.id]);
    assert(known && retained === apply.path && dispatches === 2, 'restart retains receipt without runtime redispatch');
    // Keep the runtime alive while the manager restarts during publication. The
    // receipt must be reconciled read-only, including when its acknowledgement
    // was never persisted. A new manager must never submit the action again.
    const recoverApply = async loseAcknowledgement => {
        publicationDelay = 800;
        const [token] = await call(ROOT, 'tech.norvi.SettingsOperations1', 'CreateRequest', '(s)', ['Apply']);
        const expectedDispatches = dispatches + 1;
        const [operation] = await call(ROOT, BUS, 'Apply', '(sssssss)', [token, display.Id,
            uri(images[1]), 'fit', uri(images[0]), 'zoom', await getTopology()]);
        await wait(() => dispatches === expectedDispatches, 'runtime accepted pending action');
        await wait(() => Boolean(manager.ledger.data.requests[token].operation.runtimeId), 'runtime acknowledgement persisted');
        manager.stop(); await pause(50);
        if (loseAcknowledgement) {
            const file = Gio.File.new_for_path(`${scratch}/state/manager.json`);
            const [, bytes] = file.load_contents(null);
            const value = JSON.parse(new TextDecoder().decode(bytes));
            delete value.requests[token].operation.runtimeId;
            file.replace_contents(new TextEncoder().encode(JSON.stringify(value)), null, false, Gio.FileCreateFlags.PRIVATE, null);
        }
        manager = newManager(); manager.start();
        await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[2]; } catch (_) { return false; } }, 'restarted manager ready');
        const result = await terminal(operation);
        assert(result.State === 'succeeded' && dispatches === expectedDispatches,
            loseAcknowledgement ? 'lost acknowledgement recovered by request lookup without dispatch' : 'pending runtime receipt reconciled without dispatch');
        const again = await request('Undo', '(sss)', [token, await getTopology()]);
        assert(again.result.State === 'succeeded', 'recovered Apply retains safe Undo context');
    };
    await recoverApply(false);
    await recoverApply(true);
    publicationDelay = 70;
    manager.stop(); await pause(60);
    Gio.File.new_for_path(`${scratch}/state/manager.json`).replace_contents(new TextEncoder().encode('{broken'), null, false, Gio.FileCreateFlags.PRIVATE, null);
    manager = newManager(); manager.start();
    await wait(async () => { try { return (await call(ROOT, BUS, 'GetSnapshot'))[3] === 'state-corrupt'; } catch (_) { return false; } }, 'corrupt metadata fails closed');
    assert(!(await call(ROOT, BUS, 'GetSnapshot'))[2], 'damaged receipt ledger never reports readiness');
    print('PASS: typed manager workflows, real image workers and read-only assets, safe Undo, health provenance, and restart reconciliation without redispatch');
}
const loop = new GLib.MainLoop(null, false);
run().then(() => { manager.stop(); runtime.stop(); loop.quit(); }).catch(error => {
    printerr(`${error.message || error}\n${error.stack || ""}`); manager?.stop(); runtime.stop(); System.exit(1);
});
loop.run();

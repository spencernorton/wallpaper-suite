import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ControlService} from '../controlService.js';
import {topologyKey} from '../displayIdentity.js';
import {readRuntimeStatus} from '../statusModel.js';

const [sourceRoot, extensionDir] = ARGV;
const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource); Gtk.init(); Adw.init();
const [, metadataBytes] = Gio.File.new_for_path(`${sourceRoot}/metadata.json`).load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
metadata.dir = Gio.File.new_for_path(extensionDir); metadata.path = sourceRoot;
const {default: Preferences} = await import(Gio.File.new_for_path(`${sourceRoot}/prefs.js`).get_uri());
const assert = (value, message) => { if (!value) throw new Error(message); };
const real = GLib.getenv('WALLPAPER_TEST_REAL_ENGINE') === '1';
const assets = GLib.dir_make_tmp('wallpaper-manager-assets-XXXXXX');
const image = (name, color) => {
    const p = `${assets}/${name}.png`;
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 960, 540);
    pixbuf.fill(color); pixbuf.savev(p, 'png', [], []); return p;
};
const images = [image('Amber', 0xee8833ff), image('Ocean', 0x2277ccff),
    image('Forest', 0x228855ff), image('Plum', 0x9955aaff), image('Preview', 0x5544ccff)];
let prefs, window, settings, service, dispatches = 0, serviceReady = false;
const open = () => {
    prefs = new Preferences(metadata); settings = prefs.getSettings();
    window = new Adw.PreferencesWindow({title: 'Wallpaper Suite'});
    prefs.fillPreferencesWindow(window); window.present();
};
const wait = (predicate, label, limit = 15000) => new Promise((resolve, reject) => {
    const start = Date.now();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        try {
            if (predicate()) { resolve(); return GLib.SOURCE_REMOVE; }
            if (Date.now() - start > limit) throw new Error(`Timed out: ${label}`);
        } catch (error) { reject(error); return GLib.SOURCE_REMOVE; }
        return GLib.SOURCE_CONTINUE;
    });
});
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => { resolve(); return GLib.SOURCE_REMOVE; }));
async function run() {
    const setup = new Preferences(metadata); settings = setup.getSettings();
    const list = Gdk.Display.get_default().get_monitors();
    const assignments = {}, modes = {};
    for (let i = 0; i < list.get_n_items(); i++) {
        const g = list.get_item(i).geometry;
        const key = `${g.width}x${g.height}+${g.x}+${g.y}`;
        assignments[key] = images[i % 3]; modes[key] = 'zoom';
    }
    settings.set_boolean('rotation-enabled', false);
    settings.set_string('wallpaper-folder', assets);
    settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', assignments));
    settings.set_value('monitor-modes', new GLib.Variant('a{ss}', modes));
    settings.set_strv('pinned-monitors', []);
    if (!real) {
        service = new ControlService({onAvailabilityChanged: value => { serviceReady = value; },
            getStatus: () => ({active: true, rotationEnabled: settings.get_boolean('rotation-enabled')}),
            onApply(options, onDone) {
                dispatches++;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    const current = settings.get_value('monitor-assignments').deepUnpack();
                    const currentModes = settings.get_value('monitor-modes').deepUnpack();
                    current[options.monitor] = options.image; currentModes[options.monitor] = options.mode;
                    settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', current));
                    settings.set_value('monitor-modes', new GLib.Variant('a{ss}', currentModes));
                    onDone({ok: true, changed: true, published: true, code: 'published'});
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            }, onNext(_options, onDone) {
                onDone({ok: true, changed: false, published: false, code: 'no-alternative', message: 'All displays are pinned'});
                return true;
            }});
        service.start();
    } else serviceReady = true;
    open();
    await wait(() => serviceReady && !prefs._identityClient.pending &&
        [...prefs._monitorRows.values()].every(row => row.previewReady), 'manager initial previews');
    const row = [...prefs._monitorRows.values()][0];
    const old = row.basePath;
    prefs._stageMonitor(row, images[4], 'fit');
    assert(settings.get_value('monitor-assignments').deepUnpack()[row.connector] === old,
        'browsing/preview leaves the durable wallpaper unchanged');
    await wait(() => row.previewReady && row.applyButton.sensitive, 'staged preview');
    prefs._applyPreview(row);
    assert(settings.get_value('monitor-assignments').deepUnpack()[row.connector] === old,
        'Apply stays tentative while rendering');
    await wait(() => !prefs._controlActionActive && !prefs._controlPendingRequestId, 'Apply publication');
    assert(settings.get_value('monitor-assignments').deepUnpack()[row.connector] === images[4], 'Apply commits chosen image');
    assert(settings.get_value('monitor-modes').deepUnpack()[row.connector] === 'fit', 'Apply commits chosen mode');
    assert(prefs._undoStack.length === 1, 'published Apply creates one undo action');
    row.pinRow.active = true;
    if (real)
        await wait(() => (readRuntimeStatus().pinnedMonitors || []).includes(row.identity || row.connector),
            'engine acknowledgement of pinned display');
    const beforeNext = settings.get_value('monitor-assignments').deepUnpack();
    prefs._triggerNext(prefs._nextButton);
    await wait(() => !prefs._controlActionActive && !prefs._controlPendingRequestId, 'Next with pin');
    const afterNext = settings.get_value('monitor-assignments').deepUnpack();
    assert(afterNext[row.connector] === images[4], 'global Next preserves pinned display');
    if (real && list.get_n_items() > 1)
        assert(Object.keys(assignments).some(key => key !== row.connector && beforeNext[key] !== afterNext[key]),
            'real Next advances unpinned displays');
    await wait(() => row.previewReady, 'published preview');
    await pause(250);
    if (GLib.getenv('WALLPAPER_TEST_SCREENSHOT')) {
        const capture = Gio.Subprocess.new(['import', '-window', 'root', GLib.getenv('WALLPAPER_TEST_SCREENSHOT')],
            Gio.SubprocessFlags.STDERR_PIPE);
        capture.wait_check(null);
    }
    prefs._undoLast(settings);
    await wait(() => !prefs._controlActionActive && !prefs._controlPendingRequestId, 'Undo publication');
    const undone = settings.get_value('monitor-assignments').deepUnpack();
    assert(undone[row.connector] === old, 'Undo restores previous image');
    for (const key of Object.keys(assignments).filter(key => key !== row.connector))
        assert(undone[key] === afterNext[key], 'Undo does not overwrite changes on other displays');
    if (!real) {
        assert(dispatches === 2, 'Apply and Undo each dispatch once');
        const action = {method: 'Apply', options: {monitor: row.connector, image: images[4], mode: 'fit',
            'expected-image': old, 'expected-mode': 'zoom', topology: topologyKey([...prefs._monitorRows.values()])}};
        service.Apply({source: 'preferences', 'request-id': 'reopen-apply', ...action.options});
        await wait(() => dispatches === 3 && settings.get_value('monitor-assignments').deepUnpack()[row.connector] === images[4], 'setup lost Apply reply');
        settings.set_value('control-pending-operation', new GLib.Variant('a{ss}',
            {'request-id': 'reopen-apply', action: JSON.stringify(action)}));
        window.close(); open();
        prefs._triggerNext();
        await wait(() => !prefs._controlActionActive && !prefs._controlPendingRequestId, 'reopen Apply recovery');
        assert(dispatches === 3, 'lost Apply reply is replayed without a duplicate engine dispatch');
        settings.set_value('control-pending-operation', new GLib.Variant('a{ss}',
            {'request-id': 'invalid-saved-apply', action: '{'}));
        window.close(); open(); prefs._triggerNext();
        assert(dispatches === 3 && settings.get_value('control-pending-operation').deepUnpack()['request-id'] === 'invalid-saved-apply',
            'malformed saved Apply is blocked without losing its recovery identity');
    }
    print(`manager ${real ? 'real engine' : 'D-Bus fixture'}: preview, Apply, pin, Next, Undo and recovery passed`);
}
try {
    await run();
} finally {
    window?.close(); service?.stop();
    if (!real)
        Gio.Subprocess.new(['rm', '-rf', '--', assets], Gio.SubprocessFlags.NONE).wait_check(null);
    else
        print(`Native test library retained at ${assets}`);
}

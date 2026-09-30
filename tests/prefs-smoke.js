import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

if (ARGV.length !== 2)
    throw new Error('Expected SOURCE_ROOT SCHEMA_EXTENSION_DIR');

const [sourceRoot, extensionDir] = ARGV;
const resourcePath = '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';
const resource = Gio.Resource.load(resourcePath);
Gio.resources_register(resource);

Gtk.init();
Adw.init();

const metadataFile = Gio.File.new_for_path(
    GLib.build_filenamev([sourceRoot, 'metadata.json']));
const [, metadataBytes] = metadataFile.load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
metadata.dir = Gio.File.new_for_path(extensionDir);
metadata.path = sourceRoot;

const moduleUri = Gio.File.new_for_path(
    GLib.build_filenamev([sourceRoot, 'prefs.js'])).get_uri();
const {default: Preferences} = await import(moduleUri);
const preferences = new Preferences(metadata);
const settings = preferences.getSettings();
const retainedRequestId = 'prefs-smoke-pending-request';
const retainedOperationId = 'prefs-smoke-pending-operation';
settings.set_value(
    'control-pending-operation',
    new GLib.Variant('a{ss}', {
        'request-id': retainedRequestId,
        'operation-id': retainedOperationId,
    })
);
const window = new Adw.PreferencesWindow();
preferences.fillPreferencesWindow(window);
window.present();

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    window.close();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

const retained = settings.get_value('control-pending-operation').deepUnpack();
if (retained['request-id'] !== retainedRequestId ||
    retained['operation-id'] !== retainedOperationId)
    throw new Error('closing Preferences discarded the pending request identity');

print('preferences window smoke test passed');

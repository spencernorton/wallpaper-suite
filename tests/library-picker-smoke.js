import Adw from 'gi://Adw';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

if (ARGV.length !== 2)
    throw new Error('Expected SOURCE_ROOT WORK_DIR');

const [sourceRoot, workDir] = ARGV;
Gtk.init();
Adw.init();

const library = GLib.build_filenamev([workDir, 'library']);
GLib.mkdir_with_parents(library, 0o700);
for (let index = 0; index < 35; index++) {
    const pixbuf = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, false, 8, 64, 36);
    pixbuf.fill((0x224466ff + index * 0x10000) >>> 0);
    pixbuf.savev(
        GLib.build_filenamev([library, `sample-${index}.png`]),
        'png', [], []);
}

const moduleUri = Gio.File.new_for_path(
    GLib.build_filenamev([sourceRoot, 'libraryPicker.js'])).get_uri();
const {openLibraryPicker} = await import(moduleUri);
const parent = new Adw.Window({default_width: 800, default_height: 600});
parent.present();

function findWidget(root, predicate) {
    if (predicate(root))
        return root;
    for (let child = root.get_first_child?.(); child; child = child.get_next_sibling()) {
        const found = findWidget(child, predicate);
        if (found)
            return found;
    }
    return null;
}

function waitFor(description, predicate, timeoutMs = 5000) {
    const loop = new GLib.MainLoop(null, false);
    const started = GLib.get_monotonic_time();
    let matched = false;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
        matched = Boolean(predicate());
        const timedOut = (GLib.get_monotonic_time() - started) / 1000 >= timeoutMs;
        if (matched || timedOut) {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    loop.run();
    if (!matched)
        throw new Error(`Timed out waiting for ${description}`);
}

const current = GLib.build_filenamev([library, 'sample-20.png']);
const picker = openLibraryPicker(parent, library, current, () => {});
if (!picker)
    throw new Error('Picker did not create a window');

waitFor('the populated async index', () => {
    const next = findWidget(picker, widget =>
        widget instanceof Gtk.Button && widget.label === 'Next');
    return next?.sensitive === true;
});
// Closing immediately after indexing leaves thumbnail workers in flight and
// exercises their real cancellation path.
picker.close();

const emptyLibrary = GLib.build_filenamev([workDir, 'empty-library']);
GLib.mkdir_with_parents(emptyLibrary, 0o700);
const emptyPicker = openLibraryPicker(parent, emptyLibrary, '', () => {});
waitFor('the empty-library Rescan action', () => {
    const rescan = findWidget(emptyPicker, widget =>
        widget instanceof Gtk.Button && widget.label === 'Rescan');
    return rescan?.visible === true;
});

const added = GLib.build_filenamev([emptyLibrary, 'added.png']);
const addedPixbuf = GdkPixbuf.Pixbuf.new(
    GdkPixbuf.Colorspace.RGB, false, 8, 64, 36);
addedPixbuf.fill(0x446688ff);
addedPixbuf.savev(added, 'png', [], []);
const rescan = findWidget(emptyPicker, widget =>
    widget instanceof Gtk.Button && widget.label === 'Rescan');
rescan.emit('clicked');
waitFor('Rescan to recover a newly added image', () => {
    const tile = findWidget(emptyPicker, widget =>
        widget instanceof Gtk.Button && widget.tooltip_text === added);
    return tile?.sensitive === true;
});

emptyPicker.close();
parent.close();

print('library picker smoke test passed');

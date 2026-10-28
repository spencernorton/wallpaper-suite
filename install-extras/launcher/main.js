import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {migrateLauncher} from './migration.js';

const UUID = 'wallpaper-suite@spencercnorton.github.io';
const migrateOnly = ARGV.length === 1 && ARGV[0] === '--migrate-only';
if (ARGV.length && !migrateOnly) {
    printerr('Usage: wallpaper-suite [--migrate-only]');
    System.exit(64);
}

try {
    const result = migrateLauncher();
    if (result.changed)
        print('Wallpaper Suite: retired the original launcher; backup retained.');
    else if (result.code === 'custom-launcher')
        printerr('Wallpaper Suite: kept a customized user launcher.');
} catch (error) {
    printerr(`Wallpaper Suite launcher migration: ${error.message}`);
    if (migrateOnly)
        System.exit(1);
}
if (migrateOnly)
    System.exit(0);

let failure = '';
try {
    const process = Gio.Subprocess.new(['gnome-extensions', 'prefs', UUID],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const loop = new GLib.MainLoop(null, false);
    process.communicate_utf8_async(null, null, (proc, result) => {
        try {
            const [, , stderr] = proc.communicate_utf8_finish(result);
            if (!proc.get_successful())
                failure = stderr || 'GNOME could not open the preferences window.';
        } catch (error) {
            failure = error.message;
        }
        loop.quit();
    });
    loop.run();
} catch (error) {
    failure = error.message;
}
if (!failure)
    System.exit(0);

printerr(`Wallpaper Suite: ${failure.trim()}`);
// Load GTK only for an error. Normal launch delegates single-window ownership
// to GNOME's preferences host and exits as soon as it accepts the request.
try {
    const {default: Adw} = await import('gi://Adw');
    const {default: Gtk} = await import('gi://Gtk?version=4.0');
    const app = new Adw.Application({application_id: 'io.github.spencernorton.WallpaperSuite.Launcher'});
    app.connect('activate', () => {
        const window = new Adw.ApplicationWindow({application: app, title: 'Wallpaper Suite',
            default_width: 480, default_height: 320});
        const page = new Adw.StatusPage({title: 'Wallpaper Suite could not open',
            icon_name: 'dialog-warning-symbolic',
            description: 'Sign in to a GNOME desktop session and try again. After installing or updating the extension, sign out and back in so GNOME can load it.'});
        const close = new Gtk.Button({label: 'Close', halign: Gtk.Align.CENTER,
            css_classes: ['suggested-action']});
        close.connect('clicked', () => window.close());
        page.set_child(close);
        window.set_content(page);
        window.present();
    });
    app.run([]);
} catch (_) {
    printerr('Sign in to a GNOME desktop session, then run wallpaper-suite again.');
}
System.exit(1);

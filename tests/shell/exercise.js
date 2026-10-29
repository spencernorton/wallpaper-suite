import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

let instance;
export async function exercise(extension, {wait, expect, phase}) {
    instance = extension;
    expect(extension._settings && extension._controlService, 'The extension did not initialize its real runtime');
    const image = GLib.build_filenamev([GLib.get_user_cache_dir(), `runtime-${phase}.svg`]);
    GLib.file_set_contents(image, `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="${phase === 'initial' ? '#336699' : '#993366'}"/></svg>`);
    for (let i = 0; i < 50 && !extension._monitorMgr.ready; i++)
        await wait(100);
    const monitor = extension._monitorMgr.monitors[0];
    expect(monitor, 'The extension did not enumerate the real virtual monitor');
    extension._settings.set_value('monitor-assignments', new GLib.Variant('a{ss}', {[monitor.connector]: image}));
    extension.applyComposite(true);
    for (let i = 0; i < 100; i++) {
        if (extension._lastRenderResult?.ok && extension._bgSettings.get_string('picture-uri').startsWith('file:'))
            break;
        await wait(100);
    }
    const result = extension._lastRenderResult;
    expect(result?.ok, `The packaged compositor did not render: ${JSON.stringify(result)}`);
    const uri = extension._bgSettings.get_string('picture-uri');
    expect(Gio.File.new_for_uri(uri).query_exists(null), 'The published wallpaper file is missing');
    expect(uri === extension._ssSettings.get_string('picture-uri'), 'Desktop and lock wallpaper publication disagreed');
    expect(Main.panel.statusArea[extension.uuid] === extension._indicator, 'The wallpaper indicator did not attach to the panel');
    extension._settings.set_boolean('rotation-enabled', false);
    extension._indicator._refresh();
    expect(extension._indicator._statusItem.label.text === 'Rotation paused', 'The real indicator did not show paused rotation');
}

export async function disabled({expect}) {
    expect(instance._controlService === null && instance._backgroundHandoff === null, 'Disabling left the control API or publication callbacks active');
}

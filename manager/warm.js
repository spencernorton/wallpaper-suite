// Background cache warmer for native Settings. Run by the user unit
// wallpaper-suite-warm.service at idle CPU and I/O priority. When nothing in
// the library changed it only enumerates the folder and checks cache files.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {LibraryIndexer} from '../libraryIndex.js';
import {ThumbnailLoader} from '../thumbnailCache.js';
import {topologyFromState, resolveAssignments} from '../displayIdentity.js';
import {LIBRARY_THUMBNAIL, DISPLAY_PREVIEW_EDGE, displayPreviewSize} from './previewSizing.js';

const SCHEMA = 'org.gnome.shell.extensions.wallpaper-suite';
const MODES = new Set(['zoom', 'fit', 'stretch', 'center', 'tile']);
const CACHE_NAME = /^[a-f0-9]{64}\.png$/;
const STALE_CACHE_USEC = 14 * 24 * 3600 * 1e6;
const STALE_ASSET_USEC = 24 * 3600 * 1e6;
const moduleRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const cacheDir = GLib.getenv('WALLPAPER_MANAGER_CACHE_DIR') ||
    GLib.build_filenamev([GLib.get_user_cache_dir(), 'wallpaper-suite', 'manager']);
const log = message => print(`wallpaper-suite-warm: ${message}`);

function settings() {
    const source = Gio.SettingsSchemaSource.get_default();
    const schema = source?.lookup(SCHEMA, true);
    if (!schema) throw new Error('Wallpaper Suite settings schema is not installed');
    return new Gio.Settings({settings_schema: schema});
}

function scan(folder) {
    return new Promise((resolve, reject) => {
        const indexer = new LibraryIndexer(moduleRoot);
        indexer.scanAsync(folder, {probeDimensions: true,
            dimensionCachePath: `${cacheDir}/library-dimensions-v1.json`}, result => {
            indexer.dispose();
            if (result.ok) resolve(result.files);
            else reject(new Error(result.message || result.code));
        });
    });
}

async function displayGroups(store) {
    // Without a graphical session there is nothing to size display previews for.
    let state;
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        state = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NO_AUTO_START, 3000, null).deepUnpack();
    } catch (_) {
        return [];
    }
    const monitors = topologyFromState(state);
    const modes = resolveAssignments(store.get_value('monitor-modes').deepUnpack(), monitors);
    const groups = new Map();
    for (const monitor of monitors) {
        const mode = MODES.has(modes[monitor.connector]) ? modes[monitor.connector] : 'zoom';
        const size = displayPreviewSize(monitor.width, monitor.height, DISPLAY_PREVIEW_EDGE);
        if (size) groups.set(`${monitor.width}x${monitor.height}:${mode}`,
            {size, preview: {mode, monitorWidth: monitor.width, monitorHeight: monitor.height}});
    }
    return [...groups.values()];
}

function render(paths, width, height, preview, expected) {
    if (!paths.length) return Promise.resolve({made: 0, failed: 0});
    return new Promise(resolve => {
        const loader = new ThumbnailLoader(`${moduleRoot}/thumbnail-worker.js`,
            {width, height, preview, cacheDir, concurrency: 1});
        let remaining = paths.length, made = 0, failed = 0;
        for (const path of paths) {
            loader.enqueue(path, result => {
                if (result.error) failed++;
                else {
                    expected.add(GLib.path_get_basename(result.outputPath));
                    if (!result.cached) made++;
                }
                if (--remaining === 0) resolve({made, failed});
            });
        }
    });
}

function prune(directory, keep, maxAgeUsec, pattern) {
    let removed = 0;
    try {
        const now = GLib.get_real_time();
        const children = Gio.File.new_for_path(directory).enumerate_children(
            'standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = children.next_file(null))) {
            const name = info.get_name();
            if (info.get_file_type() !== Gio.FileType.REGULAR || !pattern.test(name) || keep.has(name)) continue;
            const modified = info.get_attribute_uint64('time::modified') * 1e6;
            if (now - modified < maxAgeUsec) continue;
            try { GLib.unlink(GLib.build_filenamev([directory, name])); removed++; } catch (_) {}
        }
        children.close(null);
    } catch (_) {}
    return removed;
}

async function main() {
    const started = GLib.get_monotonic_time();
    const store = settings();
    const folder = store.get_string('wallpaper-folder');
    if (!folder) { log('no library folder configured'); return; }
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const files = (await scan(folder)).map(record => record.path);
    const expected = new Set();
    const thumbs = await render(files, LIBRARY_THUMBNAIL.width, LIBRARY_THUMBNAIL.height, null, expected);
    let previews = {made: 0, failed: 0};
    for (const group of await displayGroups(store)) {
        const result = await render(files, group.size[0], group.size[1], group.preview, expected);
        previews = {made: previews.made + result.made, failed: previews.failed + result.failed};
    }
    // Keep everything this run produced or confirmed. Interactive previews of
    // other sizes or folders expire after two idle weeks; leaked asset copies
    // after a day. Leased assets are far younger than that.
    const pruned = prune(cacheDir, expected, STALE_CACHE_USEC, CACHE_NAME) +
        prune(`${cacheDir}/assets`, new Set(), STALE_ASSET_USEC, /^[a-f0-9]{32}\.png$/);
    log(`${files.length} images; thumbnails ${thumbs.made} new/${thumbs.failed} failed; ` +
        `display previews ${previews.made} new/${previews.failed} failed; pruned ${pruned}; ` +
        `${Math.round((GLib.get_monotonic_time() - started) / 1000)} ms`);
}

const loop = new GLib.MainLoop(null, false);
let status = 0;
main().catch(error => { printerr(`wallpaper-suite-warm: ${error.message || error}`); status = 1; })
    .finally(() => loop.quit());
loop.run();
System.exit(status);

// Read-only diagnostic I/O is isolated from the service's main loop.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {readRuntimeStatus} from '../statusModel.js';
import {classifyManagedCacheName} from '../cacheJanitor.js';

const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
const [line] = input.read_line_utf8(null);
if (!line || line.length > 1024 * 1024) throw new Error('Invalid diagnostic job');
const job = JSON.parse(line);
if (typeof job.cacheRoot !== 'string' || !GLib.path_is_absolute(job.cacheRoot) ||
    !Array.isArray(job.displays) || job.displays.length > 64) throw new Error('Invalid diagnostic scope');
let runtime = {};
try {
    const status = Gio.File.new_for_path(`${job.cacheRoot}/runtime-status.json`);
    if (status.query_info('standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size() <= 512 * 1024)
        runtime = readRuntimeStatus(job.cacheRoot);
} catch (_) {}
const text = value => typeof value === 'string' ? value.slice(0, 4096) : '';
const number = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const facts = {};
for (const key of ['runtimeInstance', 'sessionId', 'poolFolder', 'poolError', 'lastError', 'lastSelectionError']) facts[key] = text(runtime[key]);
for (const key of ['lastRenderAt', 'updatedAt', 'lastRotationAttemptAt', 'lastRotationSuccessAt']) facts[key] = number(runtime[key]);
facts.poolIndexing = runtime.poolIndexing === true;
facts.poolLastAttemptOk = runtime.poolLastAttemptOk === true;
facts.poolWatcherDegraded = runtime.poolWatcherDegraded === true;
const issues = [];
for (const display of job.displays) {
    if (!display.image) issues.push([display.id, 'unassigned', 'No wallpaper is assigned to this display.']);
    else if (!GLib.file_test(display.image, GLib.FileTest.IS_REGULAR)) issues.push([display.id, 'missing-source', 'The assigned image is missing or is not a regular file.']);
    if (!display.identity) issues.push([display.id, 'identity-ambiguous', 'This display has no unique remembered identity.']);
}
let cacheBytes = 0, examined = 0, truncated = false;
try {
    const directory = Gio.File.new_for_path(job.cacheRoot).enumerate_children('standard::name,standard::size,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = directory.next_file(null))) {
        if (++examined > 10000) { truncated = true; break; }
        if (info.get_file_type() === Gio.FileType.REGULAR && classifyManagedCacheName(info.get_name())) cacheBytes += info.get_size();
    }
    directory.close(null);
} catch (_) {}
let dimensions = [0, 0];
try {
    const path = typeof runtime.outputPath === 'string' ? runtime.outputPath : '';
    if (GLib.path_get_dirname(path) === GLib.canonicalize_filename(job.cacheRoot, null) &&
        classifyManagedCacheName(GLib.path_get_basename(path))?.kind === 'output') {
        const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        if (width > 0 && height > 0) dimensions = [width, height];
    }
} catch (_) {}
print(JSON.stringify({facts, issues, cacheBytes, dimensions, truncated}));

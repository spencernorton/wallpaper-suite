// Standalone, local-only wallpaper library indexer.
//
// The worker performs all filesystem enumeration and image-header probing out
// of the GNOME Shell/preferences process. It scans the selected directory and
// its immediate child directories, emits exactly one JSON result on stdout,
// and never opens a network connection.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_FILES = 25000;
const HARD_MAX_FILES = 100000;
const DEFAULT_MAX_DIRECTORIES = 1024;
const HARD_MAX_DIRECTORIES = 10000;
const FILE_ATTRIBUTES = [
    'standard::name',
    'standard::type',
    'standard::size',
    'standard::content-type',
    'standard::is-hidden',
    'standard::is-symlink',
    'time::modified',
    'time::modified-usec',
].join(',');

let job = null;
const startedUs = GLib.get_monotonic_time();

function _durationMs() {
    return Math.max(0, Math.round((GLib.get_monotonic_time() - startedUs) / 1000));
}

function _message(error) {
    return `${error?.message || error || 'Unknown error'}`;
}

function _sortStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function _sortErrors(left, right) {
    return _sortStrings(
        `${left.path}\u001f${left.code}\u001f${left.message}`,
        `${right.path}\u001f${right.code}\u001f${right.message}`
    );
}

function _result(overrides = {}) {
    return {
        schemaVersion: SCHEMA_VERSION,
        ok: false,
        code: 'unknown',
        message: '',
        generation: Number(job?.generation) || 0,
        root: typeof job?.root === 'string' ? job.root : '',
        files: [],
        directories: [],
        errors: [],
        watcher: {
            degraded: false,
            directories: [],
            errors: [],
        },
        truncated: false,
        durationMs: _durationMs(),
        ...overrides,
    };
}

function _finish(result, exitCode = 0) {
    print(JSON.stringify({...result, durationMs: _durationMs()}));
    if (exitCode !== 0 && result.message)
        printerr(`wallpaper-suite-library-index: ${result.message}`);
    System.exit(exitCode);
}

function _fail(code, message, exitCode = 2) {
    _finish(_result({code, message}), exitCode);
}

function _positiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1)
        return fallback;
    return Math.min(maximum, Math.floor(parsed));
}

function _isImage(name, contentType) {
    if (contentType?.startsWith('image/'))
        return true;
    try {
        const [guessed] = Gio.content_type_guess(name, null);
        return guessed?.startsWith('image/') === true;
    } catch (_) {
        return false;
    }
}

function _probeDimensions(path) {
    try {
        const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
        if (Number.isInteger(width) && width > 0 &&
            Number.isInteger(height) && height > 0)
            return {width, height};
    } catch (_) {
        // Header metadata is opportunistic. The compositor remains the source
        // of truth for full decoding and will fail closed before publication.
    }
    return {width: null, height: null};
}

function _recordFor(root, directoryPath, info) {
    const name = info.get_name();
    const path = GLib.build_filenamev([directoryPath, name]);
    const rootPrefix = root === GLib.DIR_SEPARATOR_S
        ? root
        : `${root}${GLib.DIR_SEPARATOR_S}`;
    const relativePath = path.startsWith(rootPrefix)
        ? path.slice(rootPrefix.length)
        : name;
    const contentType = info.get_content_type() ||
        Gio.content_type_guess(name, null)[0] || '';
    return {
        path,
        name,
        relativePath,
        size: Number(info.get_size()),
        mtimeSec: Number(info.get_attribute_uint64('time::modified')),
        mtimeUsec: info.get_attribute_uint32('time::modified-usec'),
        contentType,
        width: null,
        height: null,
    };
}

// The root of this heap is the lexicographically largest retained path. This
// lets the worker keep only the deterministic smallest maxFiles+1 candidates
// regardless of filesystem enumeration order. Every entry is inspected, but
// memory and expensive image-header probes stay bounded by the configured cap.
function _heapPush(heap, record) {
    heap.push(record);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (_sortStrings(heap[parent].path, heap[index].path) >= 0)
            break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
    }
}

function _heapReplaceRoot(heap, record) {
    heap[0] = record;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let largest = index;
        if (left < heap.length &&
            _sortStrings(heap[left].path, heap[largest].path) > 0)
            largest = left;
        if (right < heap.length &&
            _sortStrings(heap[right].path, heap[largest].path) > 0)
            largest = right;
        if (largest === index)
            return;
        [heap[index], heap[largest]] = [heap[largest], heap[index]];
        index = largest;
    }
}

function _retainCandidate(state, record) {
    state.discovered++;
    if (state.heap.length < state.limit) {
        _heapPush(state.heap, record);
        return;
    }
    if (_sortStrings(record.path, state.heap[0].path) < 0)
        _heapReplaceRoot(state.heap, record);
}

function _enumerateDirectory(root, directoryPath, candidates, errors,
    childDirectories = null) {
    let enumerator = null;
    let succeeded = true;
    try {
        enumerator = Gio.File.new_for_path(directoryPath).enumerate_children(
            FILE_ATTRIBUTES,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name || name.startsWith('.') || info.get_is_hidden())
                continue;
            if (info.get_is_symlink())
                continue;

            const type = info.get_file_type();
            const path = GLib.build_filenamev([directoryPath, name]);
            if (type === Gio.FileType.DIRECTORY) {
                if (childDirectories !== null)
                    _retainCandidate(childDirectories, {path});
                continue;
            }
            if (type !== Gio.FileType.REGULAR)
                continue;

            const contentType = info.get_content_type() || '';
            if (!_isImage(name, contentType))
                continue;
            _retainCandidate(candidates, _recordFor(root, directoryPath, info));
        }
    } catch (error) {
        succeeded = false;
        errors.push({
            path: directoryPath,
            code: 'enumeration-failed',
            message: _message(error),
        });
    } finally {
        try { enumerator?.close(null); } catch (_) {}
    }
    return succeeded;
}

if (typeof ARGV === 'undefined' || ARGV.length !== 1)
    _fail('bad-job', 'Expected one JSON job argument');

try {
    job = JSON.parse(ARGV[0]);
} catch (error) {
    _fail('bad-job', `Invalid job JSON: ${_message(error)}`);
}

if (!job || typeof job !== 'object' || typeof job.root !== 'string' ||
    !GLib.path_is_absolute(job.root))
    _fail('bad-job', 'Job root must be an absolute local filesystem path');

const root = GLib.canonicalize_filename(job.root, null);
job.root = root;
const probeDimensions = job.probeDimensions !== false;
const maxFiles = _positiveInteger(job.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES);
const maxDirectories = _positiveInteger(
    job.maxDirectories, DEFAULT_MAX_DIRECTORIES, HARD_MAX_DIRECTORIES);

try {
    const rootInfo = Gio.File.new_for_path(root).query_info(
        'standard::type', Gio.FileQueryInfoFlags.NONE, null);
    if (rootInfo.get_file_type() !== Gio.FileType.DIRECTORY)
        _fail('invalid-root', 'Library root is not a directory', 0);
} catch (error) {
    _finish(_result({
        code: 'invalid-root',
        message: `Cannot access library root: ${_message(error)}`,
        errors: [{path: root, code: 'root-unavailable', message: _message(error)}],
    }));
}

const candidates = {
    heap: [],
    limit: maxFiles + 1,
    discovered: 0,
};
const errors = [];
const childDirectoryCandidates = {
    heap: [],
    limit: maxDirectories,
    discovered: 0,
};
const rootEnumerated = _enumerateDirectory(
    root, root, candidates, errors, childDirectoryCandidates);

if (!rootEnumerated) {
    errors.sort(_sortErrors);
    const directories = [root];
    _finish(_result({
        code: 'scan-failed',
        message: 'Library root could not be enumerated',
        root,
        directories,
        errors,
    }));
}

const childDirectories = childDirectoryCandidates.heap
    .map(record => record.path)
    .sort(_sortStrings);
for (const directoryPath of childDirectories)
    _enumerateDirectory(root, directoryPath, candidates, errors);

const retained = candidates.heap.sort((left, right) => _sortStrings(left.path, right.path));
const files = retained.slice(0, maxFiles);
if (probeDimensions) {
    for (const record of files) {
        const dimensions = _probeDimensions(record.path);
        record.width = dimensions.width;
        record.height = dimensions.height;
    }
}
errors.sort(_sortErrors);
const directories = [root, ...childDirectories].sort(_sortStrings);
const fileLimitReached = candidates.discovered > maxFiles;
const directoryLimitReached =
    childDirectoryCandidates.discovered > maxDirectories;
const truncated = fileLimitReached || directoryLimitReached;
if (fileLimitReached) {
    errors.push({
        path: root,
        code: 'file-limit-reached',
        message: `Library contains more than the configured ${maxFiles} image limit`,
    });
}
if (directoryLimitReached) {
    errors.push({
        path: root,
        code: 'directory-limit-reached',
        message: `Library contains more than the configured ${maxDirectories} subfolder limit`,
    });
}
errors.sort(_sortErrors);

const partial = errors.length > 0;
_finish(_result({
    ok: true,
    code: partial ? 'indexed-with-errors' : 'indexed',
    message: partial ? 'Library index completed with recoverable errors' : '',
    root,
    files,
    directories,
    errors,
    truncated,
}));

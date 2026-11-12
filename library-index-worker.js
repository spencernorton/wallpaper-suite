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

const HEADER_WALK_LIMIT = 4 * 1024 * 1024;
const EXIF_READ_LIMIT = 64 * 1024;
const DIMENSION_CACHE_VERSION = 1;
const DIMENSION_CACHE_MAX_BYTES = 32 * 1024 * 1024;

function _readAt(stream, offset, length) {
    stream.seek(offset, GLib.SeekType.SET, null);
    const bytes = stream.read_bytes(length, null);
    return bytes ? bytes.toArray() : new Uint8Array(0);
}

function _be16(data, offset) {
    return (data[offset] << 8) | data[offset + 1];
}

function _be32(data, offset) {
    return ((data[offset] << 24) >>> 0) + (data[offset + 1] << 16) +
        (data[offset + 2] << 8) + data[offset + 3];
}

function _validDimensions(width, height) {
    return Number.isInteger(width) && width > 0 && width <= 1048576 &&
        Number.isInteger(height) && height > 0 && height <= 1048576;
}

// Returns the EXIF orientation from an APP1 payload, or 1 when absent.
function _exifOrientation(data) {
    if (data.length < 14 || String.fromCharCode(...data.subarray(0, 6)) !== 'Exif\0\0')
        return 1;
    const tiff = 6;
    const order = String.fromCharCode(data[tiff], data[tiff + 1]);
    if (order !== 'II' && order !== 'MM')
        return 1;
    const little = order === 'II';
    const u16 = offset => little
        ? data[offset] | (data[offset + 1] << 8) : _be16(data, offset);
    const u32 = offset => little
        ? (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16)) +
          ((data[offset + 3] << 24) >>> 0)
        : _be32(data, offset);
    if (u16(tiff + 2) !== 42)
        return 1;
    const ifd = tiff + u32(tiff + 4);
    if (ifd + 2 > data.length)
        return 1;
    const count = u16(ifd);
    for (let index = 0; index < count; index++) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > data.length)
            break;
        if (u16(entry) === 0x0112)
            return u16(entry + 8);
    }
    return 1;
}

// Read PNG and baseline/progressive JPEG sizes from their headers. On Ubuntu
// 26.04 every GdkPixbuf probe starts a sandboxed glycin loader, which costs
// 100-500 ms per image. Anything unusual returns null and uses GdkPixbuf.
function _probeHeader(path) {
    let stream = null;
    try {
        stream = Gio.File.new_for_path(path).read(null);
        const head = _readAt(stream, 0, 24);
        if (head.length >= 24 && _be32(head, 0) === 0x89504e47 && _be32(head, 4) === 0x0d0a1a0a &&
            String.fromCharCode(...head.subarray(12, 16)) === 'IHDR') {
            const width = _be32(head, 16);
            const height = _be32(head, 20);
            return _validDimensions(width, height) ? {width, height} : null;
        }
        if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8)
            return null;
        let offset = 2;
        while (offset < HEADER_WALK_LIMIT) {
            const marker = _readAt(stream, offset, 4);
            if (marker.length < 2 || marker[0] !== 0xff)
                return null;
            const code = marker[1];
            if (code === 0xff) {
                offset += 1;
                continue;
            }
            if (code === 0x01 || (code >= 0xd0 && code <= 0xd8)) {
                offset += 2;
                continue;
            }
            if (code === 0xd9 || code === 0xda || marker.length < 4)
                return null;
            const length = _be16(marker, 2);
            if (length < 2)
                return null;
            if (code === 0xe1) {
                const exif = _readAt(stream, offset + 4, Math.min(length - 2, EXIF_READ_LIMIT));
                // Rotated images are rare for wallpapers; let GdkPixbuf
                // report them exactly as the decoder will.
                if (_exifOrientation(exif) >= 5)
                    return null;
            } else if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
                const frame = _readAt(stream, offset + 5, 4);
                if (frame.length < 4)
                    return null;
                const height = _be16(frame, 0);
                const width = _be16(frame, 2);
                return _validDimensions(width, height) ? {width, height} : null;
            }
            offset += 2 + length;
        }
    } catch (_) {
        // Fall back to the image library below.
    } finally {
        try {
            stream?.close(null);
        } catch (_) {}
    }
    return null;
}

function _probeDimensions(path) {
    const header = _probeHeader(path);
    if (header)
        return header;
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
const dimensionCachePath = typeof job.dimensionCachePath === 'string' &&
    GLib.path_is_absolute(job.dimensionCachePath) ? job.dimensionCachePath : '';

// Persistent size/mtime keyed header results let routine rescans finish with
// directory enumeration alone. The cache is advisory: any problem reprobes.
function _loadDimensionCache(path) {
    const cache = new Map();
    if (!path)
        return cache;
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_size() > DIMENSION_CACHE_MAX_BYTES)
            return cache;
        const [, bytes] = file.load_contents(null);
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (value?.version !== DIMENSION_CACHE_VERSION || value.root !== root ||
            !value.entries || typeof value.entries !== 'object')
            return cache;
        for (const [entryPath, entry] of Object.entries(value.entries)) {
            if (Array.isArray(entry) && entry.length === 5 &&
                entry.slice(0, 3).every(Number.isSafeInteger) &&
                (entry[3] === null || _validDimensions(entry[3], entry[4])))
                cache.set(entryPath, entry);
        }
    } catch (_) {
        cache.clear();
    }
    return cache;
}

function _saveDimensionCache(path, entries) {
    const temporary = `${path}.tmp-${GLib.uuid_string_random()}`;
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        const text = JSON.stringify({version: DIMENSION_CACHE_VERSION, root, entries});
        GLib.file_set_contents_full(temporary, new TextEncoder().encode(text), GLib.FileSetContentsFlags.NONE, 0o600);
        Gio.File.new_for_path(temporary).move(Gio.File.new_for_path(path),
            Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch (_) {
        try {
            GLib.unlink(temporary);
        } catch (_unused) {}
    }
}
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
    const cache = _loadDimensionCache(dimensionCachePath);
    const entries = {};
    let changed = cache.size !== files.length;
    for (const record of files) {
        const key = [record.size, record.mtimeSec, record.mtimeUsec];
        const known = cache.get(record.path);
        let dimensions;
        if (known && known[0] === key[0] && known[1] === key[1] && known[2] === key[2]) {
            dimensions = {width: known[3], height: known[4]};
        } else {
            dimensions = _probeDimensions(record.path);
            changed = true;
        }
        record.width = dimensions.width;
        record.height = dimensions.height;
        entries[record.path] = [...key, record.width, record.height];
    }
    if (dimensionCachePath && changed)
        _saveDimensionCache(dimensionCachePath, entries);
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

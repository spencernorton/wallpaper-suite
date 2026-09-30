// Pure library filtering and pagination helpers.
//
// Keeping these transformations independent from GTK makes the picker easy to
// test and prevents UI rebuilds from changing selection semantics.

export const PAGE_SIZE = 30;

export const SORT_OPTIONS = [
    {id: 'name-asc', label: 'Name (A–Z)'},
    {id: 'name-desc', label: 'Name (Z–A)'},
    {id: 'newest', label: 'Recently modified'},
];

export const TYPE_OPTIONS = [
    {id: 'all', label: 'All images'},
    {id: 'jpeg', label: 'JPEG'},
    {id: 'png', label: 'PNG'},
    {id: 'other', label: 'Other formats'},
];

export function imageKind(path) {
    const match = /\.([^.\/]+)$/.exec(path.toLocaleLowerCase());
    const ext = match ? match[1] : '';
    if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe')
        return 'jpeg';
    if (ext === 'png')
        return 'png';
    return 'other';
}

export function prepareLibraryRecords(records, options = {}) {
    const query = (options.query || '').trim().toLocaleLowerCase();
    const kind = options.kind || 'all';
    const sort = options.sort || 'name-asc';

    const filtered = records.filter(record => {
        if (kind !== 'all' && imageKind(record.path) !== kind)
            return false;
        if (!query)
            return true;
        return record.name.toLocaleLowerCase().includes(query) ||
            record.path.toLocaleLowerCase().includes(query);
    });

    filtered.sort((a, b) => {
        if (sort === 'newest') {
            const byTime = Number(b.modifiedUsec || 0) - Number(a.modifiedUsec || 0);
            if (byTime !== 0)
                return byTime;
        }
        const byName = a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: 'base',
        });
        if (sort === 'name-desc')
            return -byName;
        return byName;
    });
    return filtered;
}

export function pageSlice(records, requestedPage, pageSize = PAGE_SIZE) {
    const size = Math.max(1, Math.floor(pageSize));
    const totalPages = Math.max(1, Math.ceil(records.length / size));
    const page = Math.max(0, Math.min(Math.floor(requestedPage), totalPages - 1));
    const start = page * size;
    return {
        items: records.slice(start, start + size),
        page,
        totalPages,
        totalItems: records.length,
        start,
    };
}

export function pageForPath(records, path, pageSize = PAGE_SIZE) {
    const index = records.findIndex(record => record.path === path);
    return index < 0 ? -1 : Math.floor(index / Math.max(1, pageSize));
}

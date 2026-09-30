import {
    imageKind,
    pageForPath,
    pageSlice,
    prepareLibraryRecords,
} from '../libraryModel.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const records = [];
for (let i = 0; i < 67; i++) {
    const suffix = i % 3 === 0 ? 'jpg' : i % 3 === 1 ? 'png' : 'webp';
    records.push({
        path: `/library/album-${Math.floor(i / 10)}/wallpaper-${i}.${suffix}`,
        name: `wallpaper-${i}.${suffix}`,
        modifiedUsec: i * 1000,
    });
}

assert(imageKind('/tmp/PHOTO.JPEG') === 'jpeg', 'JPEG classification is case-insensitive');
assert(imageKind('/tmp/photo.png') === 'png', 'PNG classification');
assert(imageKind('/tmp/photo.avif') === 'other', 'Other format classification');

const all = prepareLibraryRecords(records, {sort: 'name-asc'});
const first = pageSlice(all, 0, 30);
const last = pageSlice(all, 99, 30);
assert(first.items.length === 30, 'First page is bounded');
assert(last.page === 2 && last.items.length === 7, 'Out-of-range page clamps to final page');
assert(new Set([
    ...pageSlice(all, 0, 30).items,
    ...pageSlice(all, 1, 30).items,
    ...pageSlice(all, 2, 30).items,
].map(record => record.path)).size === 67, 'Pagination exposes the entire library');

const search = prepareLibraryRecords(records, {query: 'wallpaper-6'});
assert(search.length === 8, 'Search returns every matching record, not a top-N slice');
const png = prepareLibraryRecords(records, {kind: 'png'});
assert(png.length === 22, 'Format filter includes all PNG files');

const newest = prepareLibraryRecords(records, {sort: 'newest'});
assert(newest[0].modifiedUsec === 66000, 'Newest sort uses microsecond timestamp');
assert(pageForPath(all, all[40].path, 30) === 1, 'Current item maps to its page');
assert(pageForPath(all, '/missing.jpg', 30) === -1, 'Missing current item is explicit');

print('library model tests passed');

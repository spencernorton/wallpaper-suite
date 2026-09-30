import assert from 'node:assert/strict';

import {
    computeCanvasBounds,
    nextRotationDeadline,
    selectAssignments,
    selectCandidate,
    translateMonitor,
} from '../runtimeCore.js';

const bounds = computeCanvasBounds([
    {connector: 'left', x: -1920, y: 120, width: 1920, height: 1080},
    {connector: 'main', x: 0, y: 0, width: 2560, height: 1440},
    {connector: 'top', x: 400, y: -900, width: 1600, height: 900},
]);
assert.deepEqual(bounds, {
    minX: -1920,
    minY: -900,
    maxX: 2560,
    maxY: 1440,
    width: 4480,
    height: 2340,
});
assert.deepEqual(
    translateMonitor({x: -1920, y: 120, width: 1920, height: 1080}, bounds),
    {x: -1920, y: 120, width: 1920, height: 1080, drawX: 0, drawY: 1020}
);
assert.equal(computeCanvasBounds([{x: 0, y: 0, width: 0, height: 10}]), null);
assert.equal(computeCanvasBounds([]), null);

const randomState = {index: -1};
assert.equal(
    selectCandidate(['a', 'b', 'c'], 'random', ['a'], [], randomState, () => 0),
    'b',
    'random selection excludes the current item when an alternative exists'
);
assert.equal(
    selectCandidate(['a', 'b', 'c'], 'random', ['a'], ['b'], randomState, () => 0),
    'c',
    'used items are excluded when another changed candidate exists'
);

const sequentialState = {index: 0};
assert.equal(selectCandidate(['a', 'b', 'c'], 'sequential', ['b'], [], sequentialState), 'c');
assert.equal(selectCandidate(['a', 'b', 'c'], 'sequential', ['c'], [], sequentialState), 'a');
assert.equal(sequentialState.lastPath, 'a', 'sequential selection records a stable path cursor');

const insertedState = {index: -1, lastPath: '/wall/b.jpg'};
assert.equal(
    selectCandidate(
        ['/wall/c.jpg', '/wall/a.jpg', '/wall/bb.jpg', '/wall/b.jpg'],
        'sequential', [], [], insertedState),
    '/wall/bb.jpg',
    'an inserted path follows the persisted cursor in lexical order'
);
const deletedState = {index: 99, lastPath: '/wall/b.jpg'};
assert.equal(
    selectCandidate(['/wall/d.jpg', '/wall/a.jpg', '/wall/c.jpg'],
        'sequential', [], [], deletedState),
    '/wall/c.jpg',
    'a deleted cursor continues at its lexical successor instead of a stale index'
);
assert.equal(
    selectCandidate(['/wall/a.jpg', '/wall/c.jpg'], 'sequential', [], [],
        {index: -1, lastPath: '/wall/z.jpg'}),
    '/wall/a.jpg',
    'a deleted cursor beyond the pool wraps to the first lexical path'
);
assert.equal(selectCandidate(['only'], 'random', ['only']), 'only');
assert.equal(selectCandidate([], 'random', []), null);

const selectionMonitors = [{connector: 'one'}, {connector: 'two'}];
assert.deepEqual(
    selectAssignments(selectionMonitors, ['a', 'b'], {one: 'a', two: 'b'}, {
        sync: false,
        random: () => 0,
    }),
    {one: 'b', two: 'a'},
    'manual and scheduled non-sync selection changes both monitors without duplicates'
);
assert.deepEqual(
    selectAssignments([{connector: 'one'}], ['a', 'b'], {one: 'a'}, {
        sync: true,
        random: () => 0,
    }),
    {one: 'b'},
    'sync selection cannot no-op when an alternative exists'
);

assert.equal(nextRotationDeadline(1000, 1800, 0), 2800);
assert.equal(nextRotationDeadline(1000, 1800, 2500), 2500);
assert.equal(nextRotationDeadline(1000, 1800, 2500, true), 2800);
assert.equal(nextRotationDeadline(1000, 1, 0), 1060);

console.log('runtime-core: all tests passed');

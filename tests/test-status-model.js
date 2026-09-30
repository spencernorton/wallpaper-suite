import {assignmentHealth, formatBytes, formatHealth} from '../statusModel.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

const assignments = {
    left: '/library/left.jpg',
    center: '/library/missing.jpg',
};
const health = assignmentHealth(assignments, ['left', 'center', 'right'],
    path => !path.includes('missing'));
assert(health.assigned === 2, 'Assigned count');
assert(health.unassigned === 1, 'Unassigned count');
assert(health.missing === 1, 'Missing source count');
assert(health.healthy === false, 'Incomplete assignments are unhealthy');
assert(formatHealth(36, health).includes('1 missing source'), 'Health text calls out missing source');
assert(formatBytes(1536) === '1.5 KiB', 'Byte formatting');

print('status model tests passed');

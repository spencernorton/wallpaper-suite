import assert from 'node:assert/strict';
import {physicalIdentity, topologyFromState, attachIdentities, resolveAssignments,
    withIdentityAliases, withIdentityPins, topologyKey} from '../displayIdentity.js';
import {selectAssignments} from '../runtimeCore.js';

const a = ['DP-1', 'Example', 'Panel', 'serial-a'];
const b = ['DP-2', 'Example', 'Panel', 'serial-b'];
const mode = ['4k', 3840, 2160, 60, 1, [1, 1.25], {'is-current': true}];
const state = [1, [[a, [mode], {}], [b, [mode], {}]],
    [[-3072, 0, 1.25, 0, false, [a], {}], [0, 0, 1.25, 0, true, [b], {}]], {'layout-mode': 1}];
const topology = topologyFromState(state);
assert.equal(topology[0].connector, '3072x1728+-3072+0');
assert.equal(topology[0].identity, physicalIdentity(a));
assert.equal(physicalIdentity(['DP-5', ...a.slice(1)]), physicalIdentity(a), 'port rename preserves identity');
assert.equal(physicalIdentity(['DP-1', 'Example', 'Panel', '000000']), null);
const duplicate = topologyFromState([1, [[a, [mode], {}], [['DP-2', ...a.slice(1)], [mode], {}]],
    [[0, 0, 1, 0, true, [a], {}]], {}]);
assert.equal(duplicate[0].identity, null, 'duplicate serials never select an arbitrary saved display');
const attached = attachIdentities(topology.map(m => ({...m, identity: null})), topology);
const original = {'3840x2160+0+0': '/images/old.jpg', [physicalIdentity(a)]: '/images/a.jpg',
    [physicalIdentity(b)]: '/images/b.jpg'};
const resolved = resolveAssignments(original, attached);
assert.equal(resolved[topology[0].connector], '/images/a.jpg');
assert.equal(resolved[topology[1].connector], '/images/b.jpg');
assert.equal(resolved['3840x2160+0+0'], '/images/old.jpg', 'legacy layout is retained');
assert.deepEqual(original, {'3840x2160+0+0': '/images/old.jpg',
    [physicalIdentity(a)]: '/images/a.jpg', [physicalIdentity(b)]: '/images/b.jpg'}, 'resolution does not mutate durable input');
const seeded = withIdentityAliases({[topology[0].connector]: '/images/legacy.jpg'}, [topology[0]]);
assert.equal(seeded[physicalIdentity(a)], '/images/legacy.jpg', 'legacy assignment can seed a physical display');
assert.equal(withIdentityAliases({}, [topology[0]], 'zoom')[physicalIdentity(a)], 'zoom');
assert.deepEqual(withIdentityPins([topology[0].connector], topology), [physicalIdentity(a)]);
const explicit = attachIdentities([{...duplicate[0], identity: null}], duplicate,
    {[duplicate[0].bindingKey]: 'user:chosen-display'});
assert.equal(explicit[0].identity, 'user:chosen-display', 'ambiguous hardware needs an explicit mapping');
assert.equal(attachIdentities([topology[0]], topology)[0].identity, null, 'transient partial layouts do not borrow identities');
assert.equal(topologyKey(attached), topologyKey([...attached].reverse()), 'UI and engine topology tokens ignore enumeration order');

const monitors = [{connector: 'left', identity: 'display:a'}, {connector: 'right', identity: 'display:b'}];
for (const sync of [true, false]) {
    for (const selectionMode of ['random', 'sequential']) {
        const cursor = {lastPath: 'a', index: 0};
        const next = selectAssignments(monitors, ['a', 'b', 'c'], {left: 'a', right: 'b'},
            {pinned: ['display:a'], sync, mode: selectionMode, state: cursor, random: () => 0});
        assert.equal(next.left, 'a', 'pinned display stays unchanged');
        assert.equal(next.right, 'c', 'unpinned display changes without duplicating pinned image');
        assert.equal(next['display:b'], 'c', 'successful choice carries physical identity');
    }
}
const cursor = {lastPath: 'a', index: 0};
assert.deepEqual(selectAssignments(monitors, ['a', 'b'], {left: 'a', right: 'b'},
    {pinned: ['display:a', 'right'], state: cursor, mode: 'sequential'}), {left: 'a', right: 'b'});
assert.deepEqual(cursor, {lastPath: 'a', index: 0}, 'all-pinned no-op preserves sequential progress');
console.log('display identity, migration, ambiguity and rotation pinning tests passed');
assert.deepEqual(selectAssignments([{connector:'unknown'}], ['a','b'], {unknown:'a'},
    {pinned:['display:remembered'],random:()=>0}), {unknown:'a'},
    'unresolved remembered pins retain the current image instead of rotating an unidentified display');

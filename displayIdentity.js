// Pure display identity and legacy-assignment helpers; no toolkit imports.
const unpack = value => value?.deepUnpack ? value.deepUnpack() : value;
export const geometryKey = m => `${m.width}x${m.height}+${m.x}+${m.y}`;
export const topologyKey = monitors => JSON.stringify(monitors.map(m =>
    [m.connector, m.identity || '']).sort(([a], [b]) => a.localeCompare(b)));

export function physicalIdentity(spec) {
    if (!Array.isArray(spec) || spec.length !== 4 ||
        !spec.every(v => typeof v === 'string' && v.length <= 512))
        return null;
    const [, vendor, product, serial] = spec;
    if (!vendor || !product || !serial.trim() || /^(0+|unknown|none|n\/a)$/i.test(serial.trim()))
        return null;
    return 'display:' + [vendor, product, serial].map(encodeURIComponent).join('/');
}

export function topologyFromState(state) {
    if (!Array.isArray(state) || !Array.isArray(state[1]) || !Array.isArray(state[2]) ||
        state[1].length > 64 || state[2].length > 64)
        return [];
    const physical = state[1];
    const counts = new Map();
    for (const [spec] of physical) {
        const id = physicalIdentity(spec);
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const layoutMode = Number(unpack(state[3]?.['layout-mode']) || 1);
    return state[2].flatMap(logical => {
        const [x, y, scale, transform, primary, specs] = logical;
        if (!Array.isArray(specs) || specs.length !== 1 || !Number.isFinite(scale) || scale <= 0)
            return [];
        const spec = specs[0];
        const record = physical.find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(spec));
        const mode = record?.[1]?.find(entry => unpack(entry[6]?.['is-current']) === true);
        if (!mode || ![x, y, mode[1], mode[2]].every(Number.isFinite))
            return [];
        const divisor = layoutMode === 2 ? 1 : scale;
        let width = Math.round(mode[1] / divisor), height = Math.round(mode[2] / divisor);
        if (Number(transform) % 2) [width, height] = [height, width];
        const id = physicalIdentity(spec);
        return [{x, y, width, height, connector: geometryKey({x, y, width, height}),
            identity: id && counts.get(id) === 1 ? id : null,
            hardwareConnector: spec[0], bindingKey: JSON.stringify(spec), primary: Boolean(primary),
            label: `${spec[1]} ${spec[2]}`.trim(),
            identityReason: id && counts.get(id) === 1 ? '' : 'This display has no unique identifier.'}];
    });
}

export function attachIdentities(monitors, topology, bindings = {}) {
    const current = new Set(monitors.map(m => m.connector));
    const snapshot = new Set(topology.map(m => m.connector));
    const matches = current.size === snapshot.size && [...current].every(key => snapshot.has(key));
    return monitors.map(monitor => {
        const match = matches ? topology.find(entry => entry.connector === monitor.connector) : null;
        return {...monitor, ...(match || {}),
            identity: match?.identity || (match?.bindingKey ? bindings[match.bindingKey] || null : null),
            identityReason: match?.identityReason || (matches ? '' : 'Display identity is unavailable in this session.')};
    });
}

export function resolveAssignments(stored, monitors) {
    const result = {...stored};
    for (const monitor of monitors) {
        if (monitor.identity && typeof stored[monitor.identity] === 'string')
            result[monitor.connector] = stored[monitor.identity];
    }
    return result;
}

export function withIdentityAliases(assignments, monitors, defaultValue = null) {
    const result = {...assignments};
    for (const monitor of monitors) {
        const value = assignments[monitor.connector] ?? defaultValue;
        if (monitor.identity && typeof value === 'string')
            result[monitor.identity] = value;
    }
    return result;
}

export function withIdentityPins(pins, monitors) {
    const next = new Set(pins);
    for (const monitor of monitors) {
        if (monitor.identity && next.has(monitor.connector)) {
            next.delete(monitor.connector);
            next.add(monitor.identity);
        }
    }
    return [...next];
}

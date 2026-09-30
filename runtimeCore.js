// Pure runtime helpers shared by the shell, worker, scheduler, and tests.
// Keep this module free of GI imports so the correctness-critical geometry and
// selection rules can be tested with ordinary Node.js as well as GJS.

/**
 * Return the full virtual-desktop bounds, including layouts whose origin is
 * left of or above (0, 0). Invalid monitor geometry returns null.
 */
export function computeCanvasBounds(monitors) {
    if (!Array.isArray(monitors) || monitors.length === 0)
        return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const monitor of monitors) {
        const x = Number(monitor?.x);
        const y = Number(monitor?.y);
        const width = Number(monitor?.width);
        const height = Number(monitor?.height);
        if (![x, y, width, height].every(Number.isFinite) ||
            !Number.isInteger(x) || !Number.isInteger(y) ||
            !Number.isInteger(width) || !Number.isInteger(height) ||
            width <= 0 || height <= 0)
            return null;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
    }

    const width = maxX - minX;
    const height = maxY - minY;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width <= 0 || height <= 0)
        return null;

    return {minX, minY, maxX, maxY, width, height};
}

/** Translate a monitor from global coordinates into composite-canvas space. */
export function translateMonitor(monitor, bounds) {
    return {
        ...monitor,
        drawX: monitor.x - bounds.minX,
        drawY: monitor.y - bounds.minY,
    };
}

/**
 * Select a candidate while preferring both a real change and no duplicate in
 * the current tick. `state.index` is updated for sequential mode.
 */
export function selectCandidate(
    pool,
    mode,
    currentPaths = [],
    usedPaths = [],
    state = {index: -1},
    random = Math.random
) {
    const uniquePool = [...new Set((pool || []).filter(Boolean))];
    if (uniquePool.length === 0)
        return null;

    // Sequential order must be stable across rescans and extension lifecycles.
    // The library index is sorted, but sorting here keeps the pure API correct
    // for every caller and makes insertion/deletion behavior deterministic.
    const orderedPool = mode === 'sequential' ? [...uniquePool].sort() : uniquePool;

    const current = new Set((currentPaths || []).filter(Boolean));
    const used = new Set((usedPaths || []).filter(Boolean));

    // Changing the current wallpaper is the first priority. If every library
    // item is already current somewhere (sync mode), a change may still be
    // possible for at least one monitor, so fall back to the complete pool.
    let candidates = orderedPool.filter(path => !current.has(path));
    if (candidates.length === 0)
        candidates = orderedPool;

    // Avoid duplicates within this tick when the pool is large enough, but do
    // not sacrifice the change guarantee when it is not.
    const unused = candidates.filter(path => !used.has(path));
    if (unused.length > 0)
        candidates = unused;

    if (mode === 'sequential') {
        let start = Number.isInteger(state.index) ? state.index : -1;
        if (typeof state.lastPath === 'string' && state.lastPath) {
            const exact = orderedPool.indexOf(state.lastPath);
            if (exact >= 0) {
                start = exact;
            } else {
                // The last item may have been deleted while the extension was
                // stopped. Continue at its lexical successor instead of using
                // an index that now refers to a different asset.
                const successor = orderedPool.findIndex(path => path > state.lastPath);
                start = successor >= 0 ? successor - 1 : orderedPool.length - 1;
            }
        }
        const allowed = new Set(candidates);
        for (let offset = 1; offset <= orderedPool.length; offset++) {
            const index = (start + offset + orderedPool.length) % orderedPool.length;
            if (allowed.has(orderedPool[index])) {
                state.index = index;
                state.lastPath = orderedPool[index];
                return orderedPool[index];
            }
        }
    }

    const value = Number(random());
    const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999999) : 0;
    return candidates[Math.floor(normalized * candidates.length)];
}

/**
 * Build one complete monitor assignment using the same change-first and
 * no-duplicate rules for scheduled rotations and manual preference actions.
 */
export function selectAssignments(
    monitors,
    pool,
    currentAssignments = {},
    options = {}
) {
    const next = {...currentAssignments};
    const sync = options.sync === true;
    const mode = options.mode || 'random';
    const state = options.state || {index: -1};
    const random = options.random || Math.random;
    const currentMonitors = Array.isArray(monitors) ? monitors : [];

    if (sync) {
        const currentPaths = currentMonitors
            .map(monitor => currentAssignments[monitor.connector])
            .filter(Boolean);
        const chosen = selectCandidate(
            pool, mode, currentPaths, [], state, random);
        for (const monitor of currentMonitors)
            next[monitor.connector] = chosen;
        return next;
    }

    const usedThisTick = [];
    for (const monitor of currentMonitors) {
        const chosen = selectCandidate(
            pool,
            mode,
            [currentAssignments[monitor.connector]],
            usedThisTick,
            state,
            random);
        next[monitor.connector] = chosen;
        usedThisTick.push(chosen);
    }
    return next;
}

/** Return an epoch deadline, preserving a future persisted deadline. */
export function nextRotationDeadline(nowEpoch, intervalSeconds, storedDeadline = 0, reset = false) {
    const now = Math.max(0, Math.floor(Number(nowEpoch) || 0));
    const interval = Math.max(60, Math.floor(Number(intervalSeconds) || 0));
    const stored = Math.max(0, Math.floor(Number(storedDeadline) || 0));
    if (reset || stored === 0)
        return now + interval;
    return stored;
}

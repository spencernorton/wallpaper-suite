// Shared sizes for cached previews. Native Settings requests exactly these
// dimensions, so the background warmer and interactive requests hit one cache.

export const LIBRARY_THUMBNAIL = Object.freeze({width: 432, height: 270});
export const DISPLAY_PREVIEW_EDGE = 640;

/** Integer-only so the C client computes byte-identical cache dimensions. */
export function displayPreviewSize(monitorWidth, monitorHeight, edge = DISPLAY_PREVIEW_EDGE) {
    if (![monitorWidth, monitorHeight, edge].every(n => Number.isInteger(n) && n > 0))
        return null;
    const clamp = n => Math.min(2048, Math.max(1, n));
    if (monitorWidth >= monitorHeight)
        return [clamp(edge), clamp(Math.floor((2 * edge * monitorHeight + monitorWidth) / (2 * monitorWidth)))];
    return [clamp(Math.floor((2 * edge * monitorWidth + monitorHeight) / (2 * monitorHeight))), clamp(edge)];
}

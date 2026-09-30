// Shared pixbuf drawing primitives.
//
// Both the shell-side compositor and the prefs-side preview thumbnail use
// the same mode logic so they cannot drift out of sync.

import GdkPixbuf from 'gi://GdkPixbuf';

export const VALID_MODES = new Set(['zoom', 'fit', 'stretch', 'center', 'tile']);

/**
 * Return the source decode size required for a mode-accurate preview.
 *
 * Center and tile are pixel-relative modes: one source pixel maps to one
 * monitor pixel in the real compositor. A preview therefore maps source
 * pixels by previewPixels / actualMonitorPixels before drawIntoRect() uses
 * its normal 1:1 center/tile paths. This avoids the old behavior where an
 * arbitrary 1024px decode made a centered image appear fitted and made tile
 * density depend on the preview loader's cap.
 */
export function previewDecodeSize(imageWidth, imageHeight,
    monitorWidth, monitorHeight, previewWidth, previewHeight, mode,
    maxDimension = 4096) {
    const values = [imageWidth, imageHeight, monitorWidth, monitorHeight,
        previewWidth, previewHeight];
    if (values.some(value => !Number.isFinite(value) || value <= 0))
        return null;

    let width;
    let height;
    let preserveAspectRatio = true;

    if (mode === 'center' || mode === 'tile') {
        width = Math.max(1, Math.round(imageWidth * previewWidth / monitorWidth));
        height = Math.max(1, Math.round(imageHeight * previewHeight / monitorHeight));
        // Independent rounding mirrors the preview canvas' independently
        // rounded dimensions and keeps both axes at the real pixel density.
        preserveAspectRatio = false;
    } else if (mode === 'stretch') {
        width = Math.max(1, Math.round(previewWidth));
        height = Math.max(1, Math.round(previewHeight));
        preserveAspectRatio = false;
    } else {
        // Zoom/fit depend on aspect ratio, not original pixel density. Decode
        // at 2x preview resolution for a crisp but bounded result.
        const cap = Math.max(previewWidth, previewHeight) * 2;
        const scale = Math.min(1, cap / Math.max(imageWidth, imageHeight));
        width = Math.max(1, Math.round(imageWidth * scale));
        height = Math.max(1, Math.round(imageHeight * scale));
    }

    let approximate = false;
    if (Math.max(width, height) > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        approximate = true;
    }

    return {width, height, preserveAspectRatio, approximate};
}

/**
 * Draw `src` into the rectangle (mx, my, mw, mh) of `dest`, respecting `mode`.
 * The rect clips on every mode — overflow does not bleed onto neighbour monitors
 * in the composite case, nor outside the preview canvas in the prefs case.
 */
export function drawIntoRect(dest, src, mx, my, mw, mh, mode) {
    const iw = src.get_width();
    const ih = src.get_height();
    if (iw <= 0 || ih <= 0 || mw <= 0 || mh <= 0)
        return;

    const interp = GdkPixbuf.InterpType.BILINEAR;

    switch (mode) {
        case 'stretch': {
            const sx = mw / iw;
            const sy = mh / ih;
            src.composite(dest, mx, my, mw, mh, mx, my, sx, sy, interp, 255);
            return;
        }
        case 'zoom': {
            // cover: scale to fill, crop overflow
            const scale = Math.max(mw / iw, mh / ih);
            const sw = iw * scale;
            const sh = ih * scale;
            const ox = mx + (mw - sw) / 2;
            const oy = my + (mh - sh) / 2;
            src.composite(dest, mx, my, mw, mh, ox, oy, scale, scale, interp, 255);
            return;
        }
        case 'fit': {
            // contain: fit entirely, letterbox
            const scale = Math.min(mw / iw, mh / ih);
            const sw = iw * scale;
            const sh = ih * scale;
            const ox = mx + (mw - sw) / 2;
            const oy = my + (mh - sh) / 2;
            src.composite(dest, mx, my, mw, mh, ox, oy, scale, scale, interp, 255);
            return;
        }
        case 'center': {
            const ox = mx + (mw - iw) / 2;
            const oy = my + (mh - ih) / 2;
            src.composite(dest, mx, my, mw, mh, ox, oy, 1.0, 1.0,
                GdkPixbuf.InterpType.NEAREST, 255);
            return;
        }
        case 'tile': {
            for (let ty = my; ty < my + mh; ty += ih) {
                for (let tx = mx; tx < mx + mw; tx += iw) {
                    src.composite(dest, mx, my, mw, mh, tx, ty, 1.0, 1.0,
                        GdkPixbuf.InterpType.NEAREST, 255);
                }
            }
            return;
        }
    }
}

import {previewDecodeSize} from '../pixbufModes.js';

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

// A 1920×1080 image centered on a 3840×2160 monitor occupies exactly half
// of each axis. The 320×180 preview must therefore decode it as 160×90.
for (const mode of ['center', 'tile']) {
    const result = previewDecodeSize(1920, 1080, 3840, 2160, 320, 180, mode);
    assertEqual(result.width, 160, `${mode} width preserves source/monitor pixel ratio`);
    assertEqual(result.height, 90, `${mode} height preserves source/monitor pixel ratio`);
    assertEqual(result.preserveAspectRatio, false, `${mode} preserves independent canvas rounding`);
}

const largeTile = previewDecodeSize(7680, 4320, 3840, 2160, 320, 180, 'tile');
assertEqual(largeTile.width, 640, '2× monitor image tiles at 2× preview density');
assertEqual(largeTile.height, 360, '2× monitor image height');

const stretch = previewDecodeSize(6000, 4000, 3840, 2160, 320, 180, 'stretch');
assertEqual(stretch.width, 320, 'Stretch decodes to preview width');
assertEqual(stretch.height, 180, 'Stretch decodes to preview height');

const bounded = previewDecodeSize(100000, 50000, 100, 50, 320, 160, 'center', 4096);
assertEqual(Math.max(bounded.width, bounded.height), 4096, 'Pathological decode is bounded');
assertEqual(bounded.approximate, true, 'Bounded pixel-density preview is labeled approximate');
assertEqual(previewDecodeSize(0, 100, 100, 100, 10, 10, 'center'), null,
    'Invalid dimensions are rejected');

print('preview math tests passed');

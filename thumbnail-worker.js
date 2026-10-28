// Standalone thumbnail renderer. Invoked as:
//   gjs -m thumbnail-worker.js SOURCE OUTPUT TEMP WIDTH HEIGHT

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {drawIntoRect, previewDecodeSize} from './pixbufModes.js';

function fail(message) {
    printerr(message);
    System.exit(1);
}

if (![5, 6].includes(ARGV.length))
    fail('Expected SOURCE OUTPUT TEMP WIDTH HEIGHT [PREVIEW]');

const [sourcePath, outputPath, tempPath, widthArg, heightArg] = ARGV;
const width = Number.parseInt(widthArg, 10);
const height = Number.parseInt(heightArg, 10);
if (!Number.isInteger(width) || !Number.isInteger(height) ||
    width < 1 || height < 1 || width > 2048 || height > 2048)
    fail('Invalid thumbnail dimensions');

try {
    if (!GLib.file_test(sourcePath, GLib.FileTest.IS_REGULAR))
        throw new Error('Source is missing or not a regular file');

    const parent = GLib.path_get_dirname(outputPath);
    if (GLib.path_get_dirname(tempPath) !== parent ||
        !GLib.path_get_basename(tempPath).startsWith(
            `${GLib.path_get_basename(outputPath)}.tmp-`))
        throw new Error('Temporary thumbnail path is outside the output contract');
    GLib.mkdir_with_parents(parent, 0o700);

    const preview = ARGV.length === 6 ? JSON.parse(ARGV[5]) : null;
    if (preview && (!['zoom', 'fit', 'stretch', 'center', 'tile'].includes(preview.mode) ||
        ![preview.monitorWidth, preview.monitorHeight].every(n =>
            Number.isInteger(n) && n > 0 && n <= 65536)))
        throw new Error('Invalid preview geometry or mode');
    let decode = {width: width * 2, height: height * 2, preserveAspectRatio: true};
    if (preview) {
        const [, sourceWidth, sourceHeight] = GdkPixbuf.Pixbuf.get_file_info(sourcePath);
        decode = previewDecodeSize(sourceWidth, sourceHeight,
            preview.monitorWidth, preview.monitorHeight, width, height, preview.mode);
        if (!decode)
            throw new Error('Image dimensions are unavailable');
    }
    const src = GdkPixbuf.Pixbuf.new_from_file_at_scale(
        sourcePath, decode.width, decode.height, decode.preserveAspectRatio);
    if (!src || src.get_width() < 1 || src.get_height() < 1)
        throw new Error('Image decoder returned an empty image');

    const dest = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    dest.fill(preview ? 0x000000ff : 0x1e1e1eff);

    const scale = Math.max(width / src.get_width(), height / src.get_height());
    const offsetX = (width - src.get_width() * scale) / 2;
    const offsetY = (height - src.get_height() * scale) / 2;
    if (preview)
        drawIntoRect(dest, src, 0, 0, width, height, preview.mode);
    else
        src.composite(dest, 0, 0, width, height,
            offsetX, offsetY, scale, scale,
            GdkPixbuf.InterpType.BILINEAR, 255);

    try {
        dest.savev(tempPath, 'png', preview ? ['tEXt::Comment'] : [],
            preview ? [decode.approximate ? 'approximate' : 'exact'] : []);
        Gio.File.new_for_path(tempPath).move(
            Gio.File.new_for_path(outputPath),
            Gio.FileCopyFlags.OVERWRITE,
            null,
            null);
    } finally {
        if (GLib.file_test(tempPath, GLib.FileTest.EXISTS))
            GLib.unlink(tempPath);
    }
} catch (error) {
    fail(`${error.message || error}`);
}

// Standalone thumbnail renderer. Invoked as:
//   gjs -m thumbnail-worker.js SOURCE OUTPUT TEMP WIDTH HEIGHT

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

function fail(message) {
    printerr(message);
    System.exit(1);
}

if (ARGV.length !== 5)
    fail('Expected SOURCE OUTPUT TEMP WIDTH HEIGHT');

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

    const src = GdkPixbuf.Pixbuf.new_from_file_at_scale(
        sourcePath, width * 2, height * 2, true);
    if (!src || src.get_width() < 1 || src.get_height() < 1)
        throw new Error('Image decoder returned an empty image');

    const dest = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    dest.fill(0x1e1e1eff);

    const scale = Math.max(width / src.get_width(), height / src.get_height());
    const offsetX = (width - src.get_width() * scale) / 2;
    const offsetY = (height - src.get_height() * scale) / 2;
    src.composite(dest, 0, 0, width, height,
        offsetX, offsetY, scale, scale,
        GdkPixbuf.InterpType.BILINEAR, 255);

    try {
        dest.savev(tempPath, 'png', [], []);
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

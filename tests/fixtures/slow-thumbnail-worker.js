import GLib from 'gi://GLib';

// Publish the parent-provided partial path before blocking so cancellation can
// prove it reaps a temp even when SIGKILL bypasses child cleanup.
const tempPath = ARGV[2];
GLib.mkdir_with_parents(GLib.path_get_dirname(tempPath), 0o700);
GLib.file_set_contents(tempPath, 'partial thumbnail');
GLib.usleep(2_000_000);

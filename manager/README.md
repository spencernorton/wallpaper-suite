# Standalone Settings manager

This development service exposes `tech.norvi.WallpaperManager1` on the user
session bus. Run `gjs -m manager/main.js` from a source tree with the Wallpaper
Suite schema installed or compiled under `schemas/`. It does not install,
enable or replace the Shell extension. No activation file is installed yet.

The manager reuses the existing display identity helpers, asynchronous library
indexer and thumbnail/preview workers. Wallpaper publication and scheduling
remain with `dev.norvi.WallpaperSuite1` runtime API 2. The runtime and Mutter's
DisplayConfig must belong to the same bus owner before display actions are
available. Settings clients never import rendering code or write application
state directly.

Implemented workflows include display/configuration snapshots, paged library
search, random choice and image location, previews and thumbnail batches via
read-only PNG file descriptors, Apply/Next delegation, rotation and rendering
configuration, and display pins. Each mutating or expensive request uses a
service-issued identity and a retained asynchronous operation. Repeating the
same accepted request returns its original operation; changing its arguments
is rejected. Unfinished receipts become interrupted after a manager restart
and are never automatically dispatched again. A lost runtime acknowledgement
reports an uncertain outcome rather than retrying a new action.

Only granular capabilities are advertised. Complete panel parity, Undo,
display identity editing, comprehensive health, activation and packaging are
not claimed by this first slice. All XML methods outside the implemented
capabilities return a typed NotSupported error. The unchanged shared interface
descriptions are under `interfaces/`.

Manager metadata is private under `$XDG_STATE_HOME/wallpaper-suite/`; prepared
assets use the private cache. Invalid receipt metadata fails closed rather
than resetting request history. Resource objects have five-minute leases and
bounded retention. User selections and schedules continue to use the existing
Wallpaper Suite GSettings schema.

Run `bash tests/test-settings-manager.sh` to qualify the typed service against
real image workers and an explicitly synthetic runtime. It uses a fresh bus,
private XDG directories and in-process memory-backed settings, preserving HOME.
A real multi-process Shell test requires a private dconf profile/service so
configuration changes can propagate between the manager and extension.

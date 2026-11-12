# Standalone Settings manager

This development service exposes `tech.norvi.WallpaperManager1` on the user
session bus. Run `gjs -m manager/main.js` from a source tree with the Wallpaper
Suite schema installed or compiled under `schemas/`. It does not install,
enable or replace the Shell extension.

The manager reuses the existing display identity helpers, asynchronous library
indexer and thumbnail/preview workers. Wallpaper publication and scheduling
remain with `dev.norvi.WallpaperSuite1` runtime API 2. The runtime and Mutter's
DisplayConfig must belong to the same bus owner before display actions are
available. Settings clients never import rendering code or write application
state directly.

Implemented workflows include display/configuration snapshots, paged library
search, random choice and image location, previews and thumbnail batches via
read-only PNG file descriptors, Apply/Next delegation, rotation and rendering
configuration, display pins, receipt-bound Undo, remembered display labels and
bindings, and asynchronous health diagnostics. Each mutating or expensive request uses a
service-issued identity and a retained asynchronous operation. Repeating the
same accepted request returns its original operation; changing its arguments
is rejected. On restart, pending delegated actions are reconciled through
read-only runtime receipt lookup. They never dispatch again. Missing or
unverifiable receipts become interrupted with an uncertain outcome. A lost
runtime acknowledgement uses the same read-only check rather than retrying an action.

Only granular capabilities are advertised. Complete panel qualification and
physical desktop acceptance remain release gates. All XML methods outside the implemented
capabilities return a typed NotSupported error. The shared interface
descriptions are under `interfaces/`.

The Debian package includes a D-Bus activation entry and a static systemd user
unit, without an autostart target or a change to extension enablement.
`GetDisplayPreviews` renders every display's current wallpaper in its mode at
the shared sizes in `previewSizing.js`. The enabled `wallpaper-suite-warm.timer`
runs `wallpaper-suite-manager --warm` at idle CPU and I/O priority 15 minutes
after login and nightly. It indexes the library, then prepares any missing
library thumbnails and per-display previews in the same cache. With no changes
it only enumerates the folder and checks cache files. Library dimensions come
from PNG/JPEG headers and a size/mtime-keyed index, because each GdkPixbuf probe
may start a sandboxed loader on current distributions. The
extension archive also includes the manager and workers; activation files remain
distribution install extras. Building these files never installs or starts them.
Runtime API 2's additive `GetSessionInfo()` method provides the runtime identity
used to distinguish a current render report from a historical cache. Older
runtimes remain supported; their render provenance stays unverified.
The additive `GetRequestOperation(source, request_id)` method permits safe
lookup when an acknowledgement was lost before its runtime operation ID was saved.

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

<h1 align="center">Wallpaper Suite</h1>

<p align="center">
  <strong>A different wallpaper on every monitor, in GNOME.</strong><br>
  A GNOME Shell extension for per-monitor wallpapers with five display modes, scheduled rotation from a library folder, and a session-bus API and CLI to drive it.
</p>

<p align="center">
  <a href="https://github.com/spencernorton/norvi-os"><img alt="Part of NorviOS" src="https://img.shields.io/badge/NorviOS-component-FD8024.svg"></a>
  <a href="https://github.com/spencernorton/wallpaper-suite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/spencernorton/wallpaper-suite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/spencernorton/wallpaper-suite/tags"><img alt="Latest release" src="https://img.shields.io/github/v/tag/spencercnorton/wallpaper-suite?label=release&sort=semver"></a>
  <a href="#install"><img alt="Install for GNOME Shell" src="https://img.shields.io/badge/install-GNOME%20Shell-4a86cf.svg"></a>
  <a href="LICENSE"><img alt="Licence" src="https://img.shields.io/badge/licence-MIT-blue.svg"></a>
  <a href="https://buy.stripe.com/8x26oH2U44f65TRe574wM04"><img alt="Donate" src="https://img.shields.io/badge/donate-Stripe-635bff.svg?logo=stripe&logoColor=white"></a>
</p>

GNOME supports one wallpaper for all monitors. Wallpaper Suite gives each monitor its own image by rendering them into one composite that GNOME spans across the desktop. It is part of the [NorviOS](https://github.com/spencernorton/norvi-os) desktop, was built and tested on Ubuntu 26.04 with GNOME 50 on Wayland and three 4K monitors, and supports GNOME 46 to 50.

## Features

- **Per-monitor wallpapers** — assign a different image to each connected
  display. Unique hardware identity keeps assignments through position, scale,
  and connector changes. Name and map ambiguous displays explicitly; existing
  geometry assignments remain available.
- **Five display modes per monitor** — Zoom (cover), Fit (contain), Stretch,
  Center, Tile. Rendered via GdkPixbuf (no Cairo dep).
- **Library + scheduler** — point at a folder of images, enable rotation
  (1–10080 min interval), pick random or sequential, optionally sync all
  monitors to the same image per tick. Recurses one level into subfolders,
  watches the pool for changes, and preserves the next deadline across shell
  restarts so a missed tick is caught up once. Sequential mode also resumes
  after the last successfully published image, including after a Shell restart.
- **Visual wallpaper manager** — a display arrangement with current previews,
  per-display library browsing, mode selection, explicit Apply and Undo.
  Choices remain previews until their exact composite publishes successfully.
  Display controls refresh automatically on connect, disconnect and geometry
  changes. Rotation and Library holds the folder, schedule and advanced settings.
- **Pin individual displays** — keep selected screens unchanged during automatic
  rotation and global Next. Explicit per-display Apply still works. Pause, Next
  and the next scheduled change sit on the Wallpapers page; optionally restart
  the timer after a manual Next.
- **Top-bar indicator** (toggle-able) — Next Background, Reapply, Pause rotation,
  Settings, with a live countdown to next rotation.
- **Stable control API** — the versioned session-bus interface
  `dev.norvi.WallpaperSuite1` accepts non-blocking Next actions, returns an
  operation ID immediately, records exactly one terminal result, emits an
  at-most-once live completion signal, retains bounded queryable results in a
  durable per-user ledger, and deduplicates safe caller retries across Shell
  restarts. Manual Next remains available while scheduled rotation is paused.
  API version 2 adds per-display Apply on the same compatible interface, with
  the same durable operation/retry contract.
- **Command-line control** — `wallpaper-suitectl next --wait --json` and
  `wallpaper-suitectl status --json` expose the same operation contract for
  shortcuts, scripts, diagnostics, and integrations.
- **Library grid picker** — searchable, sortable, paginated browsing with a
  current-image marker, progress and per-image failure states. A cancellable,
  bounded library-index worker opens the window immediately, while a
  cancellable two-process thumbnail queue keeps image decoding off the
  preferences UI. Index snapshots are capped at 25,000 images and 1,024
  immediate subfolders; any truncation or unreadable location is reported.
- **Idempotent, verified composite cache** — trusted sidecars make warm hits
  effectively instant while stale or corrupt outputs are decoded and repaired.
  A conservative exact-name, age-based janitor removes only recognized,
  unreferenced artifacts and protects active light/dark/lock files plus every
  in-flight generation.
- **Off-main-loop rendering** — the heavy decode/scale/encode runs in a
  subprocess (`compositor-worker.js`), so the Wayland compositor never freezes
  during a rotation. (No more multi-second stalls when the wallpaper changes.)
- **No duplicate across monitors** — a single shuffle won't assign the same
  image to two monitors unless the library is too small to avoid it.
- **Lock screen matches** — the same spanned composite is mirrored onto the
  lock screen so every head is covered (not just the primary).
- **Fail-closed publication** — every source is validated and decoded before
  drawing; light, dark and lock-screen settings retain the previous composite
  if rendering or publication fails.
- **Status and health** — preferences show the installed build, extension
  state, library/assignment health, last render, rotation deadline and errors.

## Architecture (one paragraph)

GNOME only natively supports a single `picture-uri` system-wide. The extension
composites a single image at the true minimum/maximum union of all monitor
rectangles (including layouts with negative coordinates)
(e.g. 11520×2160 for 3× 4K horizontal) where each monitor's region holds its
assigned image rendered per its display mode, writes that composite to
`~/.cache/wallpaper-suite/composite-<hash>.jpg`, and sets:
- `org.gnome.desktop.background.picture-uri[-dark]` → `file://<composite>`
- `org.gnome.desktop.background.picture-options` → `spanned`

Mutter then renders the slice that lives at each monitor's region. No Mutter
monkey-patching, no Clutter actor swaps — survives shell updates.

The composite (~25 megapixels for 3× 4K) is **rendered in a subprocess**
(`compositor-worker.js`, spawned via `Gio.Subprocess`), not on the GNOME Shell
main loop. That main loop *is* the Wayland compositor, so doing the
decode→scale→JPEG-encode inline froze every monitor for 1.6–5 s per rotation.
`compositor.js` keeps a verified sidecar-based cache fast path inline and only
forks the worker for a new or suspect render. Generation tokens cancel and
reap superseded workers; the async completion callback publishes only the
newest complete result. Light, dark and lock-screen URIs are verified before
old exact cache paths are released. Assignment and topology fingerprints are
checked again immediately before publication, and failed renders/publications
leave the last published assignments untouched. Explicit Next actions use a
bounded FIFO so each selection starts from durable published state; scheduled
ticks yield while a user action is active. Library enumeration follows the same
last-request-wins model in `library-index-worker.js`, so folder traversal and
metadata reads never block GNOME Shell or the preferences UI. The Shell keeps
at most 128 live folder watches; action-fresh scans and five-minute
reconciliation cover larger libraries without unbounded inotify pressure.

## Install

### GNOME Shell — the release zip

Download `wallpaper-suite.shell-extension.zip`, `wallpaper-suitectl` and `SHA256SUMS.txt` from the [latest release](https://github.com/spencernorton/wallpaper-suite/releases/latest), then:

```bash
sha256sum --check --ignore-missing SHA256SUMS.txt
gnome-extensions install --force wallpaper-suite.shell-extension.zip
install -Dm755 wallpaper-suitectl ~/.local/bin/wallpaper-suitectl   # optional CLI

# Log out, log back in (Wayland can't hot-reload extensions), then:
gnome-extensions enable wallpaper-suite@spencercnorton.github.io
```

### Ubuntu 26.04 — the release package

The same release carries `wallpaper-suite_*_all.deb`, which installs the extension for every user, its settings schema, the `wallpaper-suitectl` command with its manual page, and an app-grid entry: `sudo apt install ./wallpaper-suite_*_all.deb`. Then log out and in and enable it as above.

### From source

```bash
build/package-extension.sh dist
(cd dist && sha256sum -c wallpaper-suite@spencercnorton.github.io.shell-extension.zip.sha256)
gnome-extensions install --force \
  dist/wallpaper-suite@spencercnorton.github.io.shell-extension.zip

# Optional: the .desktop entry, icon and CLI for your user
install -Dm755 install-extras/wallpaper-suite ~/.local/bin/wallpaper-suite
mkdir -p ~/.local/share/wallpaper-suite/launcher/
cp install-extras/launcher/*.js ~/.local/share/wallpaper-suite/launcher/
cp install-extras/wallpaper-suite.desktop ~/.local/share/applications/
mkdir -p ~/.local/share/icons/hicolor/scalable/apps/
cp install-extras/wallpaper-suite.svg ~/.local/share/icons/hicolor/scalable/apps/
install -Dm755 install-extras/wallpaper-suitectl ~/.local/bin/wallpaper-suitectl
gtk-update-icon-cache -f ~/.local/share/icons/hicolor/ || true
```

The Debian package also checks for the original user-installed app shortcut at
login. It moves that exact unmodified shortcut into
`~/.local/state/wallpaper-suite/launcher-backups/`, allowing the current packaged
entry to open. Customized shortcuts are preserved. Run
`wallpaper-suite --migrate-only` to perform the same check without opening a
window. Normal launch displays a useful error if GNOME cannot open preferences.

## Control API

The session-bus contract is intentionally independent from the Shell UI so
external clients do not import extension internals:

```text
bus       dev.norvi.WallpaperSuite1
object    /dev/norvi/WallpaperSuite1
interface dev.norvi.WallpaperSuite1

Next(a{sv} options) -> operation_id
Apply(a{sv} options) -> operation_id
GetOperation(operation_id) -> found, state, ok, changed, published,
                              code, message, timestamps
GetStatus() -> api_version, active, busy, rotation_enabled,
               current_operation_id
OperationFinished(operation_id, ok, code, message)
```

`Next` understands `source`, `reset-timer`, and an optional 128-character
`request-id`. Reusing the same source/request ID returns the original operation
instead of advancing twice after a client timeout or Shell restart. The bounded
ledger lives at
`~/.local/state/wallpaper-suite/control-operations-v1.json`; an operation found
in progress after a crash is closed conservatively as `interrupted` and keeps
its identity, so retrying that ID never triggers a second advance. Operational
failures are terminal results rather than transport errors. A current-only
library reports the accurate successful no-op `no-alternative` with
`changed=false`.

`GetOperation` is authoritative; completion signals are a live convenience and
cannot be replayed across a process crash. The CLI polls that record. If a
transport timeout leaves the result uncertain, it prints the generated request
ID and a same-ID command that safely resumes or replays the existing operation.
For a known terminal failure it distinguishes a new attempt (new identity) from
replaying the recorded result (same identity), so retry wording never implies
that an idempotent replay will execute the action again.

Preferences follows the same rule without blocking the UI. If a transport
failure or window close leaves an operation uncertain, it retains the request
and returned operation identities atomically. “Recheck” queries a known
operation directly, or replays the same request identity if the original reply
was lost. It will not create a new identity until the old result is known or
the user explicitly allows one.

`Apply` accepts `monitor`, `image`, `mode`, `expected-image`, `expected-mode`
and `topology` strings in addition to source/request identity. It requires an
absolute image path, an active geometry key and a topology token produced by
`topologyKey()` in `displayIdentity.js`. The expected current image/mode and
topology are checked before dispatch and again before publication. Image and
mode stay tentative until the renderer publishes. Undo is a per-display Apply
against the last successful selection, so it cannot overwrite newer changes
on another screen. Request IDs identify one operation across both methods.

The GNOME Shell extension currently owns this name and delegates to its tested
render pipeline. Keeping the interface independent is the migration boundary
for moving scheduler/render ownership into the standalone controller without
changing DING, the CLI, or other clients.

## Settings (gsettings keys)

Schema: `org.gnome.shell.extensions.wallpaper-suite`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `wallpaper-folder` | `s` | `""` | Library folder (recurses 1 level into subdirs) |
| `monitor-assignments` | `a{ss}` | `{}` | geometry and remembered-display keys → image path |
| `monitor-modes` | `a{ss}` | `{}` | geometry and remembered-display keys → display mode |
| `display-bindings` | `a{ss}` | `{}` | Explicit mappings for displays without unique hardware identity |
| `display-labels` | `a{ss}` | `{}` | User names for remembered displays |
| `pinned-monitors` | `as` | `[]` | Display identities or legacy geometry keys excluded from rotation/Next |
| `manual-next-reset-timer` | `b` | `true` | Restart the interval after Next in the manager or indicator |
| `rotation-enabled` | `b` | `false` | Auto-rotate on a schedule |
| `rotation-interval-minutes` | `i` | `30` | 1–10080 min |
| `rotation-mode` | enum | `random` | `random` or `sequential` |
| `rotation-sync-monitors` | `b` | `false` | All monitors rotate to the same image |
| `rotation-next-deadline` | `x` | `0` | Persisted epoch time for the next rotation |
| `rotation-last-run` | `x` | `0` | Epoch time of the last scheduled attempt |
| `rotation-last-success` | `x` | `0` | Epoch time of the last successfully published scheduled rotation |
| `rotation-sequential-state` | `a{ss}` | `{}` | Atomically committed path and canonical folder for the last successfully published sequential image |
| `composite-quality` | `i` | `92` | JPEG quality 60–100 |
| `show-indicator` | `b` | `true` | Top-bar indicator visibility |
| `control-pending-operation` | `a{ss}` | `{}` | Internal atomic request/operation identity retained while a manual Next result is uncertain |

## Layout

```
extension.js         entry: indicator + apply loop + signal wiring
prefs.js             Adwaita prefs window (General + Monitors pages)
compositor.js        async render orchestration + hash-keyed cache
compositor-worker.js standalone gjs subprocess: GdkPixbuf decode/scale/encode
cacheJanitor.js      strict, age-based cleanup for managed composite artifacts
libraryIndex.js      cancellable, generation-aware library scan controller
library-index-worker.js bounded one-level filesystem/metadata index subprocess
runtimeCore.js       pure geometry, deadline, and image-selection primitives
scheduler.js         rotation timer + live asynchronous library index lifecycle
controlService.js    versioned D-Bus actions + bounded operation result ledger
monitorManager.js    shell-side monitor enumeration + change signal
libraryPicker.js     searchable/filterable/paginated library dialog
thumbnailCache.js    bounded cancellable thumbnail queue + disk cache
thumbnail-worker.js  isolated thumbnail decode subprocess
statusModel.js       read-only runtime/build/assignment health helpers
pixbufModes.js       shared display-mode drawing primitives
metadata.json        GNOME extension manifest
schemas/             gsettings schema
icons/               extension icon
install-extras/      .desktop entry, hicolor icon, and wallpaper-suitectl
```

## Gotchas worth knowing

- **Wayland can't hot-reload extensions.** Code changes only take effect after
  a logout/login. `ReloadExtension` over DBus is deprecated and returns
  `NotSupported` on GNOME 46–50.
- **`disable-user-extensions=true`.** After major Ubuntu upgrades this flips
  to `true` and silently disables every user extension. Check first:
  `gsettings get org.gnome.shell disable-user-extensions`.
- **NVIDIA + multi-monitor + VRR.** Variable Refresh Rate on multi-monitor
  NVIDIA causes mutter damage-tracking failures that show stale window
  content over the wallpaper. Not a wallpaper-suite bug — disable VRR per
  monitor in Settings → Displays if you see this.
- **Display identity.** Rendering still uses logical geometry. Saved assignments
  use unique vendor/product/serial identities from Mutter when available;
  original geometry entries are retained. Duplicate or missing serials never
  select an arbitrary saved display. Name the display or choose its saved
  mapping explicitly; ambiguous displays may need remapping after port changes.

## Versioning

Semantic versioning; each release is a tag, and [CHANGELOG.md](CHANGELOG.md) has one entry per release.

## Verification and release artifacts

`tests/run-core-tests.sh` exercises geometry, selection, asynchronous indexing,
scheduler persistence, worker failures, cancellation, cache repair, and exact
janitor boundaries. CI also runs the preferences and picker GTK smoke tests,
static checks, a deterministic double package build, and an isolated
`gnome-extensions install` verification. See
`docs/release-artifacts.md` for the ZIP, checksum and manifest contract.

## Contributing and support

- Bugs and feature requests: [open an issue](https://github.com/spencernorton/wallpaper-suite/issues/new/choose). Questions: [Discussions](https://github.com/spencernorton/wallpaper-suite/discussions).
- Security reports: [private vulnerability reporting](https://github.com/spencernorton/wallpaper-suite/security/advisories/new). See [SECURITY.md](SECURITY.md). There is no e-mail address; that is deliberate.
- Pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes are reviewed and merged on GitHub, then shipped in tagged releases.
- If this saves you time, you can [support its development](https://buy.stripe.com/8x26oH2U44f65TRe574wM04).

## Licence

[MIT](LICENSE) © Spencer Norton

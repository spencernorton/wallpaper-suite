# Changelog

All notable changes to Wallpaper Suite are documented here.

## 2.3.0-rc3 — 2026-11-12

- Warm larger 432×270 library thumbnails, matching the native Settings photo grid.

## 2.3.0-rc2 — 2026-11-12

- Read PNG and JPEG dimensions from file headers and keep a persistent dimension index. A 49-image library refresh drops from about 10 seconds to tens of milliseconds where each decoder probe starts a sandboxed loader.
- Add an idle-priority `wallpaper-suite-warm.timer` that prepares library thumbnails and per-display previews after login and nightly, so Settings opens from cache.
- Add `GetDisplayPreviews` so Settings can show every display's current wallpaper at once.

## 2.3.0-rc1 — 2026-11-11

- Add a typed, on-demand service for native display, library, rotation and health settings, with worker previews and durable operation recovery.
- Provide a separate Debian manager package that can coexist with the installed 2.2 extension. Installing it does not replace or restart the extension.
- Add optional runtime identity and request lookup methods while retaining the existing control API.

## 2.2.0 — 2026-10-28

- Prepare one upcoming rotation in a low-priority worker, with a fresh library and display-context check before Next consumes it. Preparation never advances the sequential cursor or publishes a wallpaper.
- Prepare the native background image before publishing its URI, keeping the previous wallpaper on native loading failures.
- Warm upcoming textures and release retired images while input is idle. Reuse static GNOME backgrounds and their monitor buffers during publication.
- Shorten only Wallpaper Suite’s background fade so a switch does not spend a full second drawing both desktops.
- Avoid a redundant apply triggered by saving the assignment that was just published.

## 2.1.1 — 2026-10-28

- Remove the monitor-wake delay from Next and Apply when the display layout is stable. Rendering starts on the next main-loop turn instead of waiting 1.5 seconds.
- Preserve the full trailing settling window during startup, monitor wake and reconnect so manual actions cannot publish a transient layout.

## 2.1.0 — 2026-10-27

- Open on a visual display overview with direct library browsing, background previews, explicit Apply, and publication-aware Undo.
- Refresh display controls live when monitors connect or change geometry. Remember unique physical displays through layout and scale changes, retaining legacy assignments and explicit mappings for ambiguous hardware.
- Pin individual displays during rotation and global Next, show the schedule alongside pause/next controls, and choose whether manual Next restarts the timer.
- Add durable, idempotent per-display Apply operations to the compatible session-bus interface. Reopening an uncertain request recovers its original result.
- Keep all source metadata and preview decoding off the preferences UI thread, and timestamp historical runtime-health fallbacks.

## 2.0.1 — 2026-10-27

- Restore app-grid opening after migration from the original user installation. Keep a backup of the exact legacy shortcut and preserve customized entries.
- Add a stable launcher with visible, actionable GNOME session errors.
- Record the full source revision in Debian and ZIP artifacts.

## 2.0.0 — 2026-09-29

The first public release.

- Per-monitor wallpapers composited into one spanned image, with Zoom, Fit, Stretch, Center and Tile modes per monitor, rendered in a subprocess so GNOME Shell never stalls.
- A library folder with scheduled rotation (random or sequential, optionally the same image on every monitor), a searchable grid picker and a verified composite cache with a conservative janitor.
- The lock screen shows the same composite, and publication fails closed: a failed render keeps the previous wallpaper.
- The session-bus API `dev.norvi.WallpaperSuite1` and the `wallpaper-suitectl` command, with idempotent Next actions and a durable operation ledger.
- The UUID is `wallpaper-suite@spencercnorton.github.io`. Supports GNOME Shell 46 to 50.

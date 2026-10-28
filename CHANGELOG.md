# Changelog

All notable changes to Wallpaper Suite are documented here.

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

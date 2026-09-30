# Changelog

All notable changes to Wallpaper Suite are documented here.

## 2.0.0 — 2026-09-29

The first public release.

- Per-monitor wallpapers composited into one spanned image, with Zoom, Fit, Stretch, Center and Tile modes per monitor, rendered in a subprocess so GNOME Shell never stalls.
- A library folder with scheduled rotation (random or sequential, optionally the same image on every monitor), a searchable grid picker and a verified composite cache with a conservative janitor.
- The lock screen shows the same composite, and publication fails closed: a failed render keeps the previous wallpaper.
- The session-bus API `dev.norvi.WallpaperSuite1` and the `wallpaper-suitectl` command, with idempotent Next actions and a durable operation ledger.
- The UUID is `wallpaper-suite@spencercnorton.github.io`. Supports GNOME Shell 46 to 50.

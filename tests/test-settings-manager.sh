#!/usr/bin/env bash
set -euo pipefail
manager_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
manager_scratch="$(mktemp -d)"
trap 'rm -rf "$manager_scratch"' EXIT
mkdir -p "$manager_scratch"/{schemas,config,data,state,cache,runtime}
chmod 700 "$manager_scratch/runtime"
cp "$manager_source"/schemas/*.xml "$manager_scratch/schemas/"
glib-compile-schemas --strict "$manager_scratch/schemas"
env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_STARTER_ADDRESS -u DBUS_STARTER_BUS_TYPE \
    -u DISPLAY -u WAYLAND_DISPLAY -u AT_SPI_BUS_ADDRESS \
    XDG_CONFIG_HOME="$manager_scratch/config" XDG_DATA_HOME="$manager_scratch/data" \
    XDG_STATE_HOME="$manager_scratch/state" XDG_CACHE_HOME="$manager_scratch/cache" \
    XDG_RUNTIME_DIR="$manager_scratch/runtime" GSETTINGS_BACKEND=memory GIO_USE_VFS=local \
    WALLPAPER_MANAGER_TEST=1 dbus-run-session -- \
    gjs -m "$manager_source/tests/settings-manager.gjs" "$manager_scratch/schemas" "$manager_scratch"

# Exercise the actual executable module as a separate process too: a nested
# main loop entered from a top-level async module can own its name while never
# dispatching the promise-based method handlers.
# shellcheck disable=SC2016 # Variables belong to the private child shell.
env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_STARTER_ADDRESS -u DBUS_STARTER_BUS_TYPE \
    -u DISPLAY -u WAYLAND_DISPLAY -u AT_SPI_BUS_ADDRESS \
    XDG_CONFIG_HOME="$manager_scratch/config" XDG_DATA_HOME="$manager_scratch/data" \
    XDG_STATE_HOME="$manager_scratch/state" XDG_CACHE_HOME="$manager_scratch/cache" \
    XDG_RUNTIME_DIR="$manager_scratch/runtime" GSETTINGS_BACKEND=memory GIO_USE_VFS=local \
    GSETTINGS_SCHEMA_DIR="$manager_scratch/schemas" dbus-run-session -- bash -c '
        set -euo pipefail
        gjs -m "$1/manager/main.js" &
        entry_pid=$!
        trap '\''kill "$entry_pid" 2>/dev/null || true'\'' EXIT
        gdbus wait --session --timeout 5 tech.norvi.WallpaperManager1
        gdbus call --session --timeout 3 --dest tech.norvi.WallpaperManager1 \
            --object-path /tech/norvi/WallpaperManager1 \
            --method tech.norvi.WallpaperManager1.GetCapabilities >/dev/null
        kill "$entry_pid"
        wait "$entry_pid"
        echo "PASS: standalone entry point dispatches real D-Bus requests"
    ' manager-entry-test "$manager_source"

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

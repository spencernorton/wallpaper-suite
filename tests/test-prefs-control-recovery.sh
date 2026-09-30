#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/extension/schemas"
cp "$ROOT/schemas/org.gnome.shell.extensions.wallpaper-suite.gschema.xml" \
    "$WORK/extension/schemas/"
glib-compile-schemas --strict "$WORK/extension/schemas"

dbus-run-session -- env \
    GI_TYPELIB_PATH="/usr/lib/gnome-shell/girepository-1.0${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
    GSETTINGS_BACKEND=memory \
    xvfb-run -a gjs -m "$ROOT/tests/prefs-control-recovery.gjs" \
        "$ROOT" "$WORK/extension"

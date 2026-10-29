#!/usr/bin/env bash
# Load the packaged extension in an isolated, software-rendered GNOME Shell.
set -euo pipefail
candidate=$(realpath "$1")
test_sources=$(cd "$(dirname "$0")" && pwd)
runtime_root=$(mktemp -d)
trap 'rm -rf "$runtime_root"' EXIT
extensions="$runtime_root/data/gnome-shell/extensions"
mkdir -p "$extensions/candidate" "$runtime_root/config" "$runtime_root/cache" "$runtime_root/state"
mkdir -m 0700 "$runtime_root/run"
if [ -d "$candidate" ]; then
    cp -r "$candidate/." "$extensions/candidate/"
else
    unzip -q "$candidate" -d "$extensions/candidate"
fi
uuid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$extensions/candidate/metadata.json")
mv "$extensions/candidate" "$extensions/$uuid"
probe="$extensions/runtime-probe@extensions.test"
mkdir -p "$probe"
cp "$test_sources/runtime-probe.js" "$probe/extension.js"
cp "$test_sources/exercise.js" "$probe/exercise.js"
printf '%s\n' '{"uuid":"runtime-probe@extensions.test","name":"Runtime acceptance probe","description":"Disposable CI probe","shell-version":["50"],"session-modes":["user","unlock-dialog"]}' > "$probe/metadata.json"
log="$runtime_root/shell.log"

# Only the child session gets a disposable home and XDG directories.
# shellcheck disable=SC2016
env HOME="$runtime_root" XDG_CONFIG_HOME="$runtime_root/config" \
    XDG_DATA_HOME="$runtime_root/data" XDG_CACHE_HOME="$runtime_root/cache" \
    XDG_STATE_HOME="$runtime_root/state" XDG_RUNTIME_DIR="$runtime_root/run" \
    XDG_CURRENT_DESKTOP=GNOME LIBGL_ALWAYS_SOFTWARE=1 RUNTIME_EXTENSION_UUID="$uuid" \
    dbus-run-session -- bash -c '
        set -eu
        if [ -f "$2" ]; then
            # Use the real GNOME zip installer, including schema compilation.
            gnome-extensions install --force "$2"
        fi
        gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
        gsettings set org.gnome.desktop.interface enable-animations false
        # Keep the observer first: Shell reloads later extensions when an
        # earlier extension is toggled, which would restart the observer.
        gsettings set org.gnome.shell enabled-extensions "[\"runtime-probe@extensions.test\", \"$RUNTIME_EXTENSION_UUID\"]"
        gnome-shell --headless --wayland --virtual-monitor 1280x800 > "$1" 2>&1 &
        shell_pid=$!
        trap '\''kill "$shell_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true'\'' EXIT
        for _ in $(seq 90); do
            grep -q "RUNTIME-ACCEPTANCE done" "$1" && break
            kill -0 "$shell_pid" 2>/dev/null || break
            sleep 1
        done
    ' bash "$log" "$candidate"
cat "$log"
if grep -E 'JS ERROR:|RUNTIME-ACCEPTANCE result: fail' "$log"; then
    exit 1
fi
test "$(grep -c 'RUNTIME-ACCEPTANCE result: pass' "$log")" -eq 1
grep -q '^.*RUNTIME-ACCEPTANCE result: pass$' "$log"
grep -q '^.*RUNTIME-ACCEPTANCE done$' "$log"

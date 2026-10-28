#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT

export SOURCE_DATE_EPOCH=1710000000
export WALLPAPER_SUITE_VERSION=1.3.0-test
export WALLPAPER_SUITE_COMMIT=0123456789ab

"$ROOT/build/package-extension.sh" "$WORK/one" >/dev/null
"$ROOT/build/package-extension.sh" "$WORK/two" >/dev/null

ARCHIVE=wallpaper-suite@spencercnorton.github.io.shell-extension.zip
cmp "$WORK/one/$ARCHIVE" "$WORK/two/$ARCHIVE"
cmp "$WORK/one/$ARCHIVE.sha256" "$WORK/two/$ARCHIVE.sha256"
cmp "$WORK/one/wallpaper-suitectl" "$WORK/two/wallpaper-suitectl"
cmp "$WORK/one/wallpaper-suitectl.sha256" "$WORK/two/wallpaper-suitectl.sha256"
cmp "$WORK/one/release-manifest.json" "$WORK/two/release-manifest.json"

python3 - "$WORK/one/$ARCHIVE" <<'PY'
import json
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    info = json.loads(archive.read("build-info.json"))

assert info == {"version": "1.3.0-test", "commit": "0123456789ab"}
assert "schemas/org.gnome.shell.extensions.wallpaper-suite.gschema.xml" in names
assert "cacheJanitor.js" in names
assert "controlService.js" in names
assert "displayIdentity.js" in names
assert "displayIdentityClient.js" in names
assert "runtimeCore.js" in names
assert "library-index-worker.js" in names
assert "libraryIndex.js" in names
assert "thumbnail-worker.js" in names
assert "AGENTS.md" not in names
assert not any(name.startswith(("tests/", ".git/", "docs/")) for name in names)
assert names == sorted(names), "normalized package entries are sorted"
PY

test -x "$WORK/one/wallpaper-suitectl"
if gjs -m "$WORK/one/wallpaper-suitectl" >/dev/null 2>&1; then
    echo 'wallpaper-suitectl without a command unexpectedly succeeded' >&2
    exit 1
else
    test "$?" -eq 64
fi
python3 - "$WORK/one/release-manifest.json" "$WORK/one/wallpaper-suitectl" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
cli = Path(sys.argv[2])
assert manifest["cli_artifact"] == cli.name
assert manifest["cli_sha256"] == hashlib.sha256(cli.read_bytes()).hexdigest()
PY

INSTALL_HOME="$WORK/install-home"
mkdir -p "$INSTALL_HOME"
HOME="$INSTALL_HOME" \
XDG_DATA_HOME="$INSTALL_HOME/.local/share" \
    dbus-run-session -- gnome-extensions install --force "$WORK/one/$ARCHIVE" \
    >/dev/null 2>&1
INSTALL_DIR="$INSTALL_HOME/.local/share/gnome-shell/extensions/wallpaper-suite@spencercnorton.github.io"
test -f "$INSTALL_DIR/metadata.json"
test -f "$INSTALL_DIR/cacheJanitor.js"
test -f "$INSTALL_DIR/controlService.js"
test -f "$INSTALL_DIR/displayIdentity.js"
test -f "$INSTALL_DIR/displayIdentityClient.js"
test -f "$INSTALL_DIR/runtimeCore.js"
test -f "$INSTALL_DIR/library-index-worker.js"
test -f "$INSTALL_DIR/libraryIndex.js"
test -f "$INSTALL_DIR/thumbnail-worker.js"
test -f "$INSTALL_DIR/schemas/gschemas.compiled"

echo "deterministic package tests passed"

#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=${1:-"$ROOT/dist"}
UUID=wallpaper-suite@spencercnorton.github.io
ARCHIVE="$OUT_DIR/$UUID.shell-extension.zip"
CLI="$OUT_DIR/wallpaper-suitectl"

for command in gnome-extensions python3; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Required command not found: $command" >&2
        exit 1
    fi
done

VERSION=${WALLPAPER_SUITE_VERSION:-$(
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
        "$ROOT/build-info.json"
)}
if [[ -n ${WALLPAPER_SUITE_COMMIT:-} ]]; then
    COMMIT=$WALLPAPER_SUITE_COMMIT
elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    COMMIT=$(git -C "$ROOT" rev-parse HEAD)
else
    COMMIT=unknown
fi
if [[ -n ${SOURCE_DATE_EPOCH:-} ]]; then
    BUILD_EPOCH=$SOURCE_DATE_EPOCH
elif git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    BUILD_EPOCH=$(git -C "$ROOT" log -1 --format=%ct)
else
    BUILD_EPOCH=315532800
fi

WORK=$(mktemp -d)
cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT
STAGE="$WORK/source"
RAW="$WORK/raw"
mkdir -p "$STAGE" "$RAW" "$OUT_DIR"

if [[ ! -f "$ROOT/install-extras/wallpaper-suitectl" ]]; then
    echo "Required CLI source is missing: install-extras/wallpaper-suitectl" >&2
    exit 1
fi
cp "$ROOT/install-extras/wallpaper-suitectl" "$CLI"
chmod 0755 "$CLI"

SOURCES=(
    build-info.json
    cacheJanitor.js
    compositor-worker.js
    compositor.js
    controlService.js
    extension.js
    library-index-worker.js
    libraryIndex.js
    libraryModel.js
    libraryPicker.js
    metadata.json
    monitorManager.js
    pixbufModes.js
    prefs.js
    runtimeCore.js
    scheduler.js
    statusModel.js
    thumbnail-worker.js
    thumbnailCache.js
)
for source in "${SOURCES[@]}"; do
    if [[ ! -f "$ROOT/$source" ]]; then
        echo "Required extension source is missing: $source" >&2
        exit 1
    fi
    cp "$ROOT/$source" "$STAGE/$source"
done
cp -R "$ROOT/schemas" "$STAGE/schemas"
cp -R "$ROOT/icons" "$STAGE/icons"

python3 - "$STAGE/build-info.json" "$VERSION" "$COMMIT" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
path.write_text(
    json.dumps({"version": sys.argv[2], "commit": sys.argv[3]}, indent=2) + "\n",
    encoding="utf-8",
)
PY

# This is GNOME's own pack path (gnome-extensions pack). The isolated stage guarantees
# tests, docs, git metadata, and developer-only install extras cannot leak into
# the distributable extension.
PACK_ARGS=(
    --force
    --out-dir "$RAW"
    --schema schemas/org.gnome.shell.extensions.wallpaper-suite.gschema.xml
)
for source in "${SOURCES[@]}"; do
    case "$source" in
        metadata.json|extension.js|prefs.js) ;;
        *) PACK_ARGS+=(--extra-source "$source") ;;
    esac
done
PACK_ARGS+=(--extra-source icons/wallpaper-suite.svg)
(
    cd "$STAGE"
    gnome-extensions pack "${PACK_ARGS[@]}" .
)
RAW_ARCHIVE="$RAW/$UUID.shell-extension.zip"
if [[ ! -f "$RAW_ARCHIVE" ]]; then
    echo "gnome-extensions did not create $RAW_ARCHIVE" >&2
    exit 1
fi
cp "$RAW_ARCHIVE" "$ARCHIVE"
python3 "$ROOT/build/normalize_zip.py" "$ARCHIVE" --epoch "$BUILD_EPOCH"

python3 - "$ARCHIVE" "$VERSION" "$COMMIT" "$BUILD_EPOCH" "$CLI" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

archive = Path(sys.argv[1])
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
checksum = archive.with_suffix(archive.suffix + ".sha256")
checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
cli = Path(sys.argv[5])
cli_digest = hashlib.sha256(cli.read_bytes()).hexdigest()
cli.with_suffix(cli.suffix + ".sha256").write_text(
    f"{cli_digest}  {cli.name}\n", encoding="utf-8"
)
manifest = {
    "artifact": archive.name,
    "version": sys.argv[2],
    "commit": sys.argv[3],
    "source_date_epoch": int(sys.argv[4]),
    "sha256": digest,
    "cli_artifact": cli.name,
    "cli_sha256": cli_digest,
}
(archive.parent / "release-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY

python3 - "$ARCHIVE" <<'PY'
import sys
import zipfile

required = {
    "metadata.json",
    "extension.js",
    "prefs.js",
    "cacheJanitor.js",
    "compositor-worker.js",
    "controlService.js",
    "library-index-worker.js",
    "libraryIndex.js",
    "runtimeCore.js",
    "thumbnail-worker.js",
    "thumbnailCache.js",
    "build-info.json",
    "schemas/org.gnome.shell.extensions.wallpaper-suite.gschema.xml",
}
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = set(archive.namelist())
missing = required - names
if missing:
    raise SystemExit(f"Package is incomplete; missing: {sorted(missing)}")
PY

echo "Created $ARCHIVE"
echo "Created $CLI"

#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

node "$ROOT/tests/runtime-core.test.mjs"
node "$ROOT/tests/display-identity.test.mjs"
node "$ROOT/tests/background-handoff.test.mjs"
node "$ROOT/tests/rotation-preparation.test.mjs"
node "$ROOT/tests/extension-render-ownership.test.mjs" "$ROOT"
node "$ROOT/tests/unlock-storm.test.mjs" "$ROOT"
node "$ROOT/tests/dev-harness-inert.test.mjs" "$ROOT"
glib-compile-schemas --strict "$ROOT/schemas"

if command -v gjs >/dev/null 2>&1; then
    gjs -m "$ROOT/tests/library-index-async.gjs" "$ROOT"
    gjs -m "$ROOT/tests/worker-integration.gjs" "$ROOT"
    gjs -m "$ROOT/tests/compositor-async.gjs" "$ROOT"
    gjs -m "$ROOT/tests/monitor-previews.gjs" "$ROOT"
    gjs -m "$ROOT/tests/scheduler-integration.gjs" "$ROOT"
    gjs -m "$ROOT/tests/cache-janitor.gjs" "$ROOT"
    if command -v dbus-run-session >/dev/null 2>&1; then
        dbus-run-session -- gjs -m "$ROOT/tests/control-service.gjs" "$ROOT"
        gjs -m "$ROOT/tests/control-apply.gjs"
        "$ROOT/tests/test-control-cli.sh"
    else
        echo 'dbus-run-session unavailable; control API round-trip skipped' >&2
    fi
else
    echo 'gjs unavailable; GI integration tests skipped' >&2
fi

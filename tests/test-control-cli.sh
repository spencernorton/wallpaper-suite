#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

# The single-quoted body is intentionally expanded by the inner shell only.
# shellcheck disable=SC2016
dbus-run-session -- sh -eu -c '
    root=$1
    tmp=$(mktemp)
    gjs -m "$root/tests/control-cli-fixture.gjs" &
    service_pid=$!
    cleanup() {
        kill "$service_pid" 2>/dev/null || true
        wait "$service_pid" 2>/dev/null || true
        rm -f "$tmp"
    }
    trap cleanup EXIT HUP INT TERM

    expect_usage_error() {
        label=$1
        shift
        if "$@" >"$tmp" 2>&1; then
            echo "$label unexpectedly succeeded" >&2
            exit 1
        else
            status=$?
        fi
        if [ "$status" -ne 64 ]; then
            echo "$label exited $status instead of 64" >&2
            cat "$tmp" >&2
            exit 1
        fi
    }

    attempts=0
    while ! gdbus call --session \
        --dest dev.norvi.WallpaperSuite1 \
        --object-path /dev/norvi/WallpaperSuite1 \
        --method dev.norvi.WallpaperSuite1.GetStatus \
        >/dev/null 2>&1; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 50 ]; then
            echo "control fixture did not acquire its bus name" >&2
            exit 1
        fi
        sleep 0.02
    done

    status=$(gjs -m "$root/install-extras/wallpaper-suitectl" status --json)
    printf "%s\n" "$status" | grep -q "\"apiVersion\":1"
    printf "%s\n" "$status" | grep -q "\"active\":true"

    gjs -m "$root/install-extras/wallpaper-suitectl" --help >"$tmp"
    grep -q "Usage:" "$tmp"
    "$root/install-extras/wallpaper-suitectl" --help >"$tmp"
    grep -q "Usage:" "$tmp"
    expect_usage_error "status --wait" \
        gjs -m "$root/install-extras/wallpaper-suitectl" status --wait
    expect_usage_error "blank request ID" \
        gjs -m "$root/install-extras/wallpaper-suitectl" next --request-id "   "
    expect_usage_error "mistyped timeout" \
        gjs -m "$root/install-extras/wallpaper-suitectl" next --wait --timeout soon
    expect_usage_error "irrelevant timeout" \
        gjs -m "$root/install-extras/wallpaper-suitectl" next --timeout 5

    normalized=$(gjs -m "$root/install-extras/wallpaper-suitectl" \
        next --json --request-id "  cli-normalized  ")
    printf "%s\n" "$normalized" | grep -q "\"requestId\":\"cli-normalized\""

    result=$(gjs -m "$root/install-extras/wallpaper-suitectl" \
        next --wait --json --request-id cli-integration --timeout 5)
    printf "%s\n" "$result" | grep -q "\"state\":\"succeeded\""
    printf "%s\n" "$result" | grep -q "\"code\":\"published\""
    printf "%s\n" "$result" | grep -q "\"changed\":true"
    printf "%s\n" "$result" | grep -q "\"published\":true"

    if failure=$(gjs -m "$root/install-extras/wallpaper-suitectl" \
        next --wait --json --request-id cli-failure --timeout 5 2>&1); then
        echo "failed operation unexpectedly succeeded" >&2
        exit 1
    else
        status=$?
    fi
    test "$status" -eq 2
    printf "%s\n" "$failure" | grep -q "\"code\":\"render-failed\""
    printf "%s\n" "$failure" | grep -q "\"requestId\":\"cli-failure\""
    printf "%s\n" "$failure" | grep -q "\"retry\":"

    if interrupted=$(gjs -m "$root/install-extras/wallpaper-suitectl" \
        next --wait --json --request-id cli-interrupted --timeout 5 2>&1); then
        echo "interrupted operation unexpectedly succeeded" >&2
        exit 1
    else
        status=$?
    fi
    test "$status" -eq 2
    printf "%s\n" "$interrupted" | grep -q "\"code\":\"interrupted\""
    printf "%s\n" "$interrupted" | grep -q "\"requestId\":\"cli-interrupted\""
    printf "%s\n" "$interrupted" | grep -q "\"replay\":"
    printf "%s\n" "$interrupted" | grep -q "\"guidance\":"
    if printf "%s\n" "$interrupted" | grep -q "\"retry\":"; then
        echo "interrupted operation exposed an unsafe new-ID retry" >&2
        exit 1
    fi

    if timeout=$(gjs -m "$root/install-extras/wallpaper-suitectl" \
        next --wait --json --no-reset-timer --timeout 1 2>&1); then
        echo "hanging operation unexpectedly succeeded" >&2
        exit 1
    else
        status=$?
    fi
    test "$status" -eq 3
    printf "%s\n" "$timeout" | grep -q "\"code\":\"client-timeout\""
    printf "%s\n" "$timeout" | grep -Eq "\"requestId\":\"[^\"]+\""
    printf "%s\n" "$timeout" | grep -q "\"retry\":"

    echo "control CLI tests passed"
' sh "$ROOT"

if unavailable=$(dbus-run-session -- \
    gjs -m "$ROOT/install-extras/wallpaper-suitectl" next --json 2>&1); then
    echo "Next without a control service unexpectedly succeeded" >&2
    exit 1
else
    status=$?
fi
test "$status" -eq 3
printf '%s\n' "$unavailable" | grep -q '"code":"client-error"'
printf '%s\n' "$unavailable" | grep -Eq '"requestId":"[^"]+"'
printf '%s\n' "$unavailable" | grep -q '"retry":'

echo "control CLI unavailable-service test passed"

#!/usr/bin/env bash
# The scroll end-to-end test: every recorded gesture (tests/scroll-e2e/gestures)
# through Pear Up's libinput plugin and real libinput, into a headless GNOME
# Shell 50 with Pear Up, to a GTK 4 and a Chromium client, and what they drew
# measured against a MacBook Air's own stream (tests/scroll-e2e/fixtures).
#
#   tests/run-scroll-e2e.sh [out-dir]           # all gestures, all modes
#   E2E_STAGES=1 tests/run-scroll-e2e.sh        # stage 1 only (libinput)
#   E2E_GESTURES="flick double-flick" tests/run-scroll-e2e.sh
#
# Modes: now (the plugin as framy has it: Medium, engine off), engine (Mac
# scroll engine on, Medium), engine-mac (engine on, "As on a MacBook").
# Thresholds: tests/scroll-e2e/thresholds.py. Report: <out-dir>/report.md and
# PNGs; by default <out-dir> is tests/scroll-e2e/out.
#
# Stage 1 and the hand-off checks run the plugin live inside this machine's
# libinput, as root (sudo): a uinput touchpad that the run grabs the moment
# libinput opens it, so the desktop's compositor sees a touchpad come and go
# but never gets an event from it (tests/scroll-e2e/live.py). Stage 2, the
# headless shell and its clients, runs in a container. Nothing is simulated.
#
#   E2E_HANDOFFS=0 tests/run-scroll-e2e.sh      # skip the hand-off checks
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
E2E="$REPO_DIR/tests/scroll-e2e"
OUT="${1:-$E2E/out}"
RUNTIME="${CONTAINER_RUNTIME:-podman}"
STAGES="${E2E_STAGES:-1 2}"
NAME="pear-up-scroll-e2e-$$"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

read -r -a GESTURES <<< "${E2E_GESTURES:-}"
if [[ " $STAGES " == *" 1 "* ]]; then
    echo "==> Stage 1: the plugin live in this machine's libinput ($(rpm -q --qf '%{VERSION}' libinput 2>/dev/null || echo '?'))"
    sudo -n env E2E_REPEATS="${E2E_REPEATS:-5}" python3 "$E2E/stream.py" "$E2E/gestures" "$OUT/stream.json"
    sudo -n chown "$(id -u):$(id -g)" "$OUT/stream.json"
    if [[ "${E2E_HANDOFFS:-1}" == 1 ]]; then
        echo "==> Hand-offs, the plugin live in libinput"
        sudo -n python3 "$E2E/check-handoffs.py" | tee "$OUT/handoffs.txt"
    fi
fi

if ! "$RUNTIME" image exists localhost/pear-up-test:gnome50 2>/dev/null; then
    "$RUNTIME" build --build-arg FEDORA=44 -t localhost/pear-up-test:gnome50 \
        -f "$REPO_DIR/tests/integration/Containerfile" "$REPO_DIR/tests/integration"
fi
"$RUNTIME" build -q -t localhost/pear-up-scroll-e2e -f "$E2E/Containerfile" "$E2E" >/dev/null

cleanup() { "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$RUNTIME" run -d --name "$NAME" --systemd=always --privileged \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp --device /dev/dri \
    -v "$REPO_DIR:/src:ro,Z" -v "$OUT:/out:Z" localhost/pear-up-scroll-e2e >/dev/null
for _ in $(seq 1 60); do
    state="$("$RUNTIME" exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
done

if [[ " $STAGES " == *" 2 "* ]]; then
    echo "==> Stage 2: GNOME Shell 50 headless at 120 Hz, GTK 4 and Chromium clients"
    "$RUNTIME" exec -e E2E_CHROMIUM="${E2E_CHROMIUM:-1}" "$NAME" bash /src/tests/scroll-e2e/clients/session.sh /src /out/stream.json /out/clients "${GESTURES[@]}"
fi
echo "==> Report"
set +e
"$RUNTIME" exec "$NAME" python3 /src/tests/scroll-e2e/report.py /out/stream.json \
    /src/tests/scroll-e2e/fixtures/mac-air-events.log /out/clients /out
status=$?
echo
echo "Report: $OUT/report.md"
exit $status

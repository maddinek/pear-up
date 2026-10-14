#!/usr/bin/env bash
# Stage 2 of the scroll end-to-end test, inside a container: a headless GNOME
# Shell at 120 Hz with Pear Up enabled, the GTK 4 probe and (when installed)
# Chromium as Wayland clients, and each stage-1 stream played into the shell.
#
#   session.sh <src> <stream.json> <out-dir> [gesture ...]
#
# Writes <out-dir>/<gesture>.<mode>.{gtk,chromium,fed}.jsonl.
set -uo pipefail
SRC="$1" STREAM="$2" OUT="$3"
shift 3
mkdir -p "$OUT"
export HOME=/root XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
UUID=pear-up@maddinek.github.io
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$EXT"
cp -r "$SRC"/*.js "$SRC"/metadata.json "$SRC"/stylesheet.css "$SRC"/schemas "$SRC"/icons "$SRC"/assets "$EXT"/ 2>/dev/null
glib-compile-schemas "$EXT/schemas"
# The integration tests' hook extension: the only way into a headless shell
# (no Looking Glass, no Eval), used here to put the pointer on the window.
HOOK="$HOME/.local/share/gnome-shell/extensions/pear-up-test-hook@localhost"
mkdir -p "$HOOK" && cp "$SRC"/tests/integration/hook-extension/* "$HOOK"/

# The shell wants a system bus (logind, time limits); a bare one will do.
if [[ ! -S /run/dbus/system_bus_socket ]]; then
    mkdir -p /run/dbus && dbus-daemon --system --fork
fi

GESTURES=("$@")
if [[ ${#GESTURES[@]} -eq 0 ]]; then
    mapfile -t GESTURES < <(python3 -c "import json,sys; print('\n'.join(json.load(open('$STREAM'))))")
fi

dbus-run-session -- bash -c '
    set -uo pipefail
    OUT="'"$OUT"'" STREAM="'"$STREAM"'" SRC="'"$SRC"'"
    pipewire > "$OUT/pipewire.log" 2>&1 &
    wireplumber > "$OUT/wireplumber.log" 2>&1 &
    sleep 1
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"'"$UUID"'\", \"pear-up-test-hook@localhost\"]"
    gsettings set org.gnome.shell disable-extension-version-validation true
    gnome-shell --headless --no-x11 --virtual-monitor 1440x960@120 > "$OUT/shell.log" 2>&1 &
    for _ in $(seq 1 60); do
        gdbus introspect --session --dest org.gnome.Mutter.RemoteDesktop \
            --object-path /org/gnome/Mutter/RemoteDesktop >/dev/null 2>&1 && break
        sleep 1
    done
    sleep 6
    # The shell starts in the overview, where scrolling switches desktops.
    for _ in 1 2 3; do
        gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive "<false>" > /dev/null
        sleep 1
    done
    export WAYLAND_DISPLAY=wayland-0
    hook() {
        gdbus call --session --dest org.gnome.Shell --object-path /io/github/maddinek/PearUpTestHook \
            --method io.github.maddinek.PearUpTestHook."$@" > /dev/null
    }
    # The pointer once, early: the first move after start-up only creates it.
    hook HideOverview; hook MovePointer 700 470; sleep 1; hook MovePointer 720 480
    for g in '"${GESTURES[*]}"'; do
        for mode in $(python3 -c "import json; print(\" \".join(k for k in json.load(open(\"$STREAM\"))[\"$g\"] if k in (\"now\",\"engine\",\"engine-mac\")))"); do
            GDK_DEBUG=no-portals PROBE_LOG="$OUT/$g.$mode.gtk.jsonl" gjs -m "$SRC/tests/scroll-e2e/clients/gtk-probe.js" > "$OUT/$g.$mode.gtk.log" 2>&1 &
            P=$!
            for _ in $(seq 1 100); do
                grep -q ready "$OUT/$g.$mode.gtk.jsonl" 2>/dev/null && break
                sleep 0.2
            done
            hook FocusFirstWindow; hook MovePointer 720 480; sleep 0.3; hook MovePointer 721 481
            sleep 0.5
            python3 "$SRC/tests/scroll-e2e/clients/feed.py" "$STREAM" "$g" "$mode" "$OUT/$g.$mode.fed.jsonl"
            sleep 0.5
            kill $P 2>/dev/null; wait $P 2>/dev/null
            if [[ "${E2E_CHROMIUM:-1}" == 1 ]] && command -v chromium-browser >/dev/null; then
                chromium-browser --ozone-platform=wayland --no-sandbox --no-first-run --user-data-dir=/tmp/chr \
                    --kiosk --enable-logging=stderr --v=0 \
                    --app="file://$SRC/tests/scroll-e2e/clients/chromium-probe.html" 2> "$OUT/$g.$mode.chromium.raw" &
                C=$!
                for _ in $(seq 1 100); do
                    grep -q "E2E {.k.:.ready" "$OUT/$g.$mode.chromium.raw" 2>/dev/null && break
                    sleep 0.2
                done
                hook FocusFirstWindow; hook MovePointer 720 480; sleep 0.3; hook MovePointer 721 481
                sleep 1
                python3 "$SRC/tests/scroll-e2e/clients/feed.py" "$STREAM" "$g" "$mode" "$OUT/$g.$mode.cfed.jsonl"
                sleep 0.5
                kill $C 2>/dev/null; wait $C 2>/dev/null
                grep -o "E2E {.*}" "$OUT/$g.$mode.chromium.raw" | sed "s/^E2E //; s/\\\\\"/\"/g" > "$OUT/$g.$mode.chromium.jsonl"
            fi
            echo "  $g $mode: gtk $(grep -c frame "$OUT/$g.$mode.gtk.jsonl" 2>/dev/null) frames"
        done
    done
'

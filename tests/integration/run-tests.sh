#!/usr/bin/env bash
# Run inside the container, once systemd has booted and logind is answering.
# Installs the extension, starts a headless shell with it enabled from the
# start — the way a login would — and checks what it actually did.
set -uo pipefail

SRC=/src
ARTIFACTS=/artifacts
export HOME=/root
export XDG_RUNTIME_DIR=/run/user/0

UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/metadata.json")"
if [[ -z "$UUID" ]]; then
    echo "FAIL: could not read the uuid from metadata.json"
    exit 1
fi

mkdir -p "$ARTIFACTS" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

echo "== GNOME =="
gnome-shell --version
echo "logind: $(systemctl is-active systemd-logind.service)"

echo
echo "== installing $UUID =="
if ! bash "$SRC/install.sh" > "$ARTIFACTS/install.log" 2>&1; then
    echo "FAIL: install.sh failed"
    tail -20 "$ARTIFACTS/install.log"
    exit 1
fi
echo "installed"

echo
echo "== starting a headless shell =="
dbus-run-session -- bash -c '
    set -uo pipefail
    UUID="'"$UUID"'"
    ARTIFACTS="'"$ARTIFACTS"'"

    # Enabled before the shell starts, so it loads the way it would at login
    # rather than being switched on afterwards. That ordering is what exposed
    # the power icon being hidden before Quick Settings had been built.
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"$UUID\"]"

    # The only way to ask the running shell what the extension did: a headless
    # session has no Looking Glass, so Eval is permanently refused.
    schemas="$HOME/.local/share/gnome-shell/extensions/$UUID/schemas"
    GSETTINGS_SCHEMA_DIR="$schemas" \
        gsettings set org.gnome.shell.extensions.pear-up debug-interface true

    # A virtual monitor gives the shell somewhere to draw with no display
    # attached. --debug-control exports the interface that turns on unsafe mode,
    # which is what lets a test inspect the live panel.
    gnome-shell --headless --virtual-monitor 1280x800 --debug-control \
        > "$ARTIFACTS/shell.log" 2>&1 &
    SHELL_PID=$!

    for _ in $(seq 1 90); do
        if gdbus introspect --session --dest org.gnome.Shell \
             --object-path /org/gnome/Shell >/dev/null 2>&1; then
            break
        fi
        if ! kill -0 $SHELL_PID 2>/dev/null; then
            echo "FAIL: the shell exited while starting"
            tail -40 "$ARTIFACTS/shell.log"
            exit 1
        fi
        sleep 1
    done

    if ! gdbus introspect --session --dest org.gnome.Shell \
           --object-path /org/gnome/Shell >/dev/null 2>&1; then
        echo "FAIL: the shell never appeared on the bus"
        tail -40 "$ARTIFACTS/shell.log"
        exit 1
    fi
    echo "shell is up"

    # Extensions are enabled shortly after the shell claims its bus name.
    sleep 6

    python3 /src/tests/integration/assert.py "$UUID" "$ARTIFACTS"
    status=$?

    kill $SHELL_PID 2>/dev/null
    wait $SHELL_PID 2>/dev/null
    exit $status
'

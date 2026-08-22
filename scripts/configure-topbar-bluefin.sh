#!/usr/bin/env bash
# macOS-like top bar: blur panel, clock on the far right, global menu polish.
set -euo pipefail

SSH_HOST="${BLUEFIN_SSH:-vm-bluefin}"

if [[ "$SSH_HOST" == *"@"* ]]; then
    SSH_TARGET="$SSH_HOST"
    SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)
elif [[ "$SSH_HOST" != "127.0.0.1" && "$SSH_HOST" != *"."* ]]; then
    SSH_TARGET="$SSH_HOST"
    SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)
else
    SSH_KEY="${BLUEFIN_SSH_KEY:-$HOME/.ssh/vm-key}"
    SSH_PORT="${BLUEFIN_SSH_PORT:-2223}"
    SSH_USER="${BLUEFIN_SSH_USER:-martin}"
    SSH_TARGET="${SSH_USER}@127.0.0.1"
    SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -i "$SSH_KEY" -p "$SSH_PORT")
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Deploying global-menu extension (stylesheet + menus)"
bash "$REPO_DIR/scripts/deploy-bluefin.sh"

EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/metadata.json")"

echo "==> Applying macOS-like top bar settings on ${SSH_TARGET}"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$EXTENSION_UUID" <<'REMOTE'
set -euo pipefail
EXTENSION_UUID="$1"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"

# Translucent blurred panel (blur-my-shell)
export GSETTINGS_SCHEMA_DIR="/usr/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas"
BLUR=org.gnome.shell.extensions.blur-my-shell.panel
gsettings set "$BLUR" blur true
gsettings set "$BLUR" static-blur true
gsettings set "$BLUR" sigma 40
gsettings set "$BLUR" brightness 0.55
gsettings set "$BLUR" override-background true

# macOS-style clock: weekday + time, no seconds
gsettings set org.gnome.desktop.interface clock-show-weekday true
gsettings set org.gnome.desktop.interface clock-show-seconds false

# Spotlight replacement (Search Light) in the menu bar
export GSETTINGS_SCHEMA_DIR="/usr/share/gnome-shell/extensions/search-light@icedman.github.com/schemas"
gsettings set org.gnome.shell.extensions.search-light show-panel-icon true
gnome-extensions enable search-light@icedman.github.com 2>/dev/null || true

# macOS puts the window buttons on the left, close first
gsettings set org.gnome.desktop.wm.preferences button-layout 'close,minimize,maximize:appmenu'

# Global menu housekeeping
export GSETTINGS_SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/${EXTENSION_UUID}/schemas"
gsettings set org.gnome.shell.extensions.pear-up debug-logging false
gsettings set org.gnome.shell.extensions.pear-up hide-overview-button true
gsettings set org.gnome.shell.extensions.pear-up logo-icon-size 14

# Reload extension so stylesheet applies
gnome-extensions disable "$EXTENSION_UUID"
sleep 1
gnome-extensions enable "$EXTENSION_UUID"

echo "Top bar settings applied."
REMOTE

echo "==> Done. Log out/in if the panel style does not update immediately."

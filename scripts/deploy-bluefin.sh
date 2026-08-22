#!/usr/bin/env bash
# Deploy global-menu-for-gnome to the Bluefin VM and apply macOS-like settings.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH_HOST="${BLUEFIN_SSH:-vm-bluefin}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)

if [[ "$SSH_HOST" == *"@"* ]]; then
    SSH_TARGET="$SSH_HOST"
elif [[ "$SSH_HOST" != "127.0.0.1" && "$SSH_HOST" != *"."* ]]; then
    # Use ~/.ssh/config Host alias (e.g. vm-bluefin)
    SSH_TARGET="$SSH_HOST"
else
    SSH_KEY="${BLUEFIN_SSH_KEY:-$HOME/.ssh/vm-key}"
    SSH_PORT="${BLUEFIN_SSH_PORT:-2223}"
    SSH_USER="${BLUEFIN_SSH_USER:-martin}"
    SSH_TARGET="${SSH_USER}@127.0.0.1"
    SSH_OPTS+=(-i "$SSH_KEY" -p "$SSH_PORT")
fi

REMOTE_DIR="${BLUEFIN_REMOTE_DIR:-~/global-menu-for-gnome}"
EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/metadata.json")"

echo "==> Syncing repo to ${SSH_TARGET}:${REMOTE_DIR}"
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'vm-screenshot*.png' \
  --exclude '*.ppm' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$REPO_DIR/" "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Installing extension on VM"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cd ${REMOTE_DIR} && bash install.sh"

echo "==> Disabling conflicting logomenu extension"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "gnome-extensions disable logomenu@aryan_k 2>/dev/null || true"

echo "==> Applying Bluefin-tuned settings"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$EXTENSION_UUID" <<'REMOTE'
set -euo pipefail
EXTENSION_UUID="$1"
export GSETTINGS_SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/${EXTENSION_UUID}/schemas"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"

SCHEMA=org.gnome.shell.extensions.pear-up

gsettings set "$SCHEMA" hide-overview-button true
gsettings set "$SCHEMA" logo-distro-icon 'pear'
gsettings set "$SCHEMA" logo-distro-icon-symbolic true
gsettings set "$SCHEMA" software-center-command 'flatpak run io.github.kolunmi.Bazaar'
gsettings set "$SCHEMA" system-monitor-command 'missioncenter-helper'
gsettings set "$SCHEMA" extensions-app-id 'com.mattjakeman.ExtensionManager.desktop'
gsettings set "$SCHEMA" terminal-command 'ptyxis'

echo "Settings applied:"
gsettings list-recursively "$SCHEMA" | grep -E 'hide-overview|logo-distro|software-center|system-monitor|extensions-app|terminal-command'
REMOTE

cat <<EOF

==> Done. Log out and back in on the VM (or Alt+F2 → r on X11) to reload GNOME Shell.

Optional screenshot:
  flatpak run --command=virsh org.virt_manager.virt-manager -c qemu:///session screenshot bluefin --file /tmp/bluefin.ppm
EOF

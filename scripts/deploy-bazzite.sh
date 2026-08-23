#!/usr/bin/env bash
# Deploy Pear Up to the bazzite-gnome-test VM.
# Does not apply Bluefin-specific commands (Bazaar, Ptyxis, …).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH_KEY="${BAZZITE_SSH_KEY:-$HOME/VMs/bazzite-gnome-test/id_ed25519}"
SSH_PORT="${BAZZITE_SSH_PORT:-2224}"
SSH_USER="${BAZZITE_SSH_USER:-martin}"
SSH_TARGET="${SSH_USER}@127.0.0.1"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -i "$SSH_KEY" -p "$SSH_PORT")

REMOTE_DIR="${BAZZITE_REMOTE_DIR:-~/.cache/pear-up-deploy}"

echo "==> Syncing repo to ${SSH_TARGET}:${REMOTE_DIR} (port ${SSH_PORT})"
RSYNC_SSH="$(printf '%q ' ssh "${SSH_OPTS[@]}")"

rsync -avz --delete \
  --exclude '.git' \
  --exclude 'assets/screenshots' \
  --exclude 'contrib' \
  --exclude '*.ppm' \
  --exclude '*.png' \
  -e "$RSYNC_SSH" \
  "$REPO_DIR/" "${SSH_TARGET}:${REMOTE_DIR}/"

echo "==> Installing extension on Bazzite"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cd ${REMOTE_DIR} && bash install.sh"

echo "==> Disabling conflicting logomenu extension"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "gnome-extensions disable logomenu@aryan_k 2>/dev/null || true"

cat <<EOF

==> Done. Log out and back in on bazzite-gnome-test (or Alt+F2 → r on X11)
    to reload GNOME Shell.
EOF

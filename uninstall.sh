#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# Without a UUID the path below would be the extensions directory itself, and
# removing it would take every installed extension with it.
EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/metadata.json")"
if [[ -z "$EXTENSION_UUID" ]]; then
    echo "Could not read \"uuid\" from $SOURCE_DIR/metadata.json" >&2
    exit 1
fi

EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "--------------------------------------------------"
echo "🧹 Removing Pear Up ($EXTENSION_UUID)"
echo "--------------------------------------------------"

gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
rm -rf "$EXTENSION_DIR"

echo "✅ Removed. Log out and back in to unload it from the running session."

#!/bin/bash

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/metadata.json")"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "--------------------------------------------------"
echo "🧹 Starting uninstallation of Global Menu"
echo "--------------------------------------------------"

echo "🚫 Disabling the extension..."
gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null

echo "🗑️ Deleting extension directory..."
rm -rf "$EXTENSION_DIR"

echo "--------------------------------------------------"
echo "✅ Uninstallation complete!"
echo "--------------------------------------------------"

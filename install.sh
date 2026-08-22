#!/bin/bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

# metadata.json is the single source of truth for the UUID. Refuse to continue
# without one: every path below is built from it, and an empty value would make
# the install directory the extensions directory itself — which then gets
# deleted.
EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/metadata.json")"
if [[ -z "$EXTENSION_UUID" ]]; then
    echo "Could not read \"uuid\" from $SOURCE_DIR/metadata.json" >&2
    exit 1
fi

EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

echo "--------------------------------------------------"
echo "🍐 Installing Pear Up ($EXTENSION_UUID)"
echo "--------------------------------------------------"

echo "🧹 Clearing old structures..."
rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR"

echo "📄 Copying extension files..."
# Copy every .js file and the schemas/ directory automatically, so newly
# added source files are never silently left out of the installed copy.
cp "$SOURCE_DIR"/*.js "$EXTENSION_DIR/"
cp "$SOURCE_DIR"/*.css "$EXTENSION_DIR/"
cp "$SOURCE_DIR/metadata.json" "$EXTENSION_DIR/"
cp -r "$SOURCE_DIR/schemas" "$EXTENSION_DIR/"
cp -r "$SOURCE_DIR/icons" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/uninstall.sh" "$SOURCE_DIR/logs.sh" "$EXTENSION_DIR/"

echo "⚙️ Compiling GSettings schemas..."
glib-compile-schemas "$EXTENSION_DIR/schemas/"

echo "--------------------------------------------------"
echo "✅ Installed. Log out and back in, then enable Pear Up."
echo "--------------------------------------------------"

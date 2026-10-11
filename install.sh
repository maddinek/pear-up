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
cp -r "$SOURCE_DIR/libinput" "$EXTENSION_DIR/"
cp "$SOURCE_DIR/uninstall.sh" "$SOURCE_DIR/logs.sh" "$EXTENSION_DIR/"

echo "⚙️ Compiling GSettings schemas..."
glib-compile-schemas "$EXTENSION_DIR/schemas/"

# GNOME Settings cannot be extended — every panel in its sidebar is compiled
# into gnome-control-center, which has no plugin interface. An application entry
# is the closest thing available: it puts these preferences in the app grid and
# makes them turn up when you search for "pear".
echo "🔎 Installing the settings launcher..."
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS_DIR"
sed -e "s|@UUID@|$EXTENSION_UUID|g" \
    -e "s|@ICON@|$EXTENSION_DIR/icons/distro-pear-color.svg|g" \
    "$SOURCE_DIR/desktop/pear-up-settings.desktop.in" \
    > "$APPS_DIR/pear-up-settings.desktop"
update-desktop-database "$APPS_DIR" 2>/dev/null || true

# The scroll acceleration plugin is installed by the preferences, not here. If
# they have installed it, it is replaced by this version's, keeping the strength
# it was installed with; the compositor loads the new one at the next login. A
# file of that name that is not Pear Up's — no strength line, or no mention of
# Pear Up — is left alone, as the preferences leave it.
PLUGIN_NAME="10-pear-up-scroll-acceleration.lua"
PLUGIN_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/libinput/plugins/$PLUGIN_NAME"
if [[ -f "$PLUGIN_PATH" ]] && grep -q 'Pear Up' "$PLUGIN_PATH"; then
    gain="$(sed -n 's/^local SLOW_GAIN = \([0-9.]*\)$/\1/p' "$PLUGIN_PATH" | head -n 1)"
    if [[ -n "$gain" ]]; then
        echo "🖱️ Updating the scroll acceleration plugin..."
        sed "s/^local SLOW_GAIN = [0-9.]*$/local SLOW_GAIN = $gain/" \
            "$SOURCE_DIR/libinput/$PLUGIN_NAME" > "$PLUGIN_PATH.pear-up-new"
        mv "$PLUGIN_PATH.pear-up-new" "$PLUGIN_PATH"
    fi
fi

# The macOS keys plugin likewise: an installed copy is replaced by this
# version's, keeping the five lines the preferences write into it — the Alt/Cmd
# swap, the three switches and the Cmd key list, edited by hand or not. A copy
# without each of those lines once, as the preferences write them, or without
# a mention of Pear Up, is not Pear Up's and is left alone.
KEYS_PLUGIN_NAME="10-pear-up-macos-keys.lua"
KEYS_PLUGIN_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/libinput/plugins/$KEYS_PLUGIN_NAME"
KEYS_PLUGIN_LINES='^local (SWAPPED|WORDS|DESKTOPS|SHORTCUTS) = (true|false)$|^local SHORTCUT_KEYS = "[A-Za-z0-9_ ]*"$'
keys_plugin_is_pear_ups() {
    [[ -f "$1" ]] && grep -q 'Pear Up' "$1" || return 1
    local name
    for name in SWAPPED WORDS DESKTOPS SHORTCUTS SHORTCUT_KEYS; do
        [[ "$(grep -E "$KEYS_PLUGIN_LINES" "$1" | grep -c "^local $name = ")" == 1 ]] || return 1
    done
}
if keys_plugin_is_pear_ups "$KEYS_PLUGIN_PATH"; then
    echo "⌨️ Updating the macOS keys plugin..."
    awk -v lines="$KEYS_PLUGIN_LINES" '
        NR == FNR { if ($0 ~ lines) kept[$2] = $0; next }
        $0 ~ lines && ($2 in kept) { print kept[$2]; next }
        { print }
    ' "$KEYS_PLUGIN_PATH" "$SOURCE_DIR/libinput/$KEYS_PLUGIN_NAME" > "$KEYS_PLUGIN_PATH.pear-up-new"
    mv "$KEYS_PLUGIN_PATH.pear-up-new" "$KEYS_PLUGIN_PATH"
fi

echo "--------------------------------------------------"
echo "✅ Installed. Log out and back in, then enable Pear Up."
echo "--------------------------------------------------"

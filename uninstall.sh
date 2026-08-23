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

RESET_SETTINGS=false
if [[ "${1:-}" == "--reset-settings" ]]; then
    RESET_SETTINGS=true
elif [[ -n "${1:-}" ]]; then
    echo "Unknown option: $1" >&2
    echo "Usage: uninstall.sh [--reset-settings]" >&2
    exit 1
fi

echo "--------------------------------------------------"
echo "🧹 Removing Pear Up ($EXTENSION_UUID)"
echo "--------------------------------------------------"

gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true
rm -rf "$EXTENSION_DIR"

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
rm -f "$APPS_DIR/pear-up-settings.desktop"
update-desktop-database "$APPS_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Keyboard/system settings written by the preferences window.
#
# prefs.js appends accelerators to GNOME's own keybinding lists rather than
# replacing them, so undoing that means removing exactly those entries instead
# of resetting the whole list — resetting would throw away bindings of the
# user's own. Values it overwrites outright (Dash to Dock conflicts, button
# layout) are only reset when they still hold the exact value prefs writes;
# anything else means the user has touched them since, and we leave them alone.
#
# The helpers live in their own file so tests/check-uninstall.sh can exercise
# them against a fake gsettings without running any of this script.

DIR_OF_THIS_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR_OF_THIS_SCRIPT/scripts/lib/gsettings-undo.sh"

D2D_SCHEMA="org.gnome.shell.extensions.dash-to-dock"
D2D_UUID="dash-to-dock@micxgx.gmail.com"
D2D_SCHEMAS="$HOME/.local/share/gnome-shell/extensions/$D2D_UUID/schemas"
if [[ ! -d "$D2D_SCHEMAS" ]]; then
    for data_dir in ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
        if [[ -d "$data_dir/gnome-shell/extensions/$D2D_UUID/schemas" ]]; then
            D2D_SCHEMAS="$data_dir/gnome-shell/extensions/$D2D_UUID/schemas"
            break
        fi
    done
fi

RESTORED=()

if $RESET_SETTINGS; then
    # Appended accelerators: the macOS screenshot, window and dock sets.
    remove_accel org.gnome.shell.keybindings screenshot '<Super><Shift>3'
    remove_accel org.gnome.shell.keybindings show-screenshot-ui '<Super><Shift>4'
    remove_accel org.gnome.shell.keybindings show-screen-recording-ui '<Super><Shift>5'
    remove_accel org.gnome.shell.keybindings toggle-overview '<Control>Up'
    remove_accel org.gnome.desktop.wm.keybindings close '<Super>q'
    remove_accel org.gnome.desktop.wm.keybindings close '<Super>w'
    remove_accel org.gnome.desktop.wm.keybindings minimize '<Super>m'
    remove_accel org.gnome.desktop.wm.keybindings toggle-fullscreen '<Super><Control>f'
    remove_accel org.gnome.settings-daemon.plugins.media-keys screensaver '<Super><Control>q'
    for i in 1 2 3 4 5 6 7 8 9; do
        remove_accel "$D2D_SCHEMA" "app-hotkey-$i" "<Super>F$i" --schemadir "$D2D_SCHEMAS"
    done

    # Outright overwrites: reset only if untouched since prefs wrote them.
    reset_if_matches "$D2D_SCHEMA" hot-keys 'false' --schemadir "$D2D_SCHEMAS"
    reset_if_matches "$D2D_SCHEMA" shortcut '[]' --schemadir "$D2D_SCHEMAS"

    # Alt/Cmd swap is an appended xkb option like any other.
    current_options="$(gsettings get org.gnome.desktop.input-sources xkb-options)" || current_options=""
    if [[ "$current_options" == *"'altwin:swap_alt_win'"* ]]; then
        updated_options="${current_options//'altwin:swap_alt_win', /}"
        updated_options="${updated_options//, 'altwin:swap_alt_win'/}"
        updated_options="${updated_options//'altwin:swap_alt_win'/}"
        [[ "$updated_options" == "['']" ]] && updated_options="[]"
        gsettings set org.gnome.desktop.input-sources xkb-options "$updated_options"
        RESTORED+=("org.gnome.desktop.input-sources xkb-options: removed 'altwin:swap_alt_win'")
    fi

    # Button layout: reset only when it equals one of the two strings prefs sets.
    current_layout="$(gsettings get org.gnome.desktop.wm.preferences button-layout)" || current_layout=""
    case "$current_layout" in
        "'close,minimize,maximize:appmenu'"|"'appmenu:minimize,maximize,close'")
            gsettings reset org.gnome.desktop.wm.preferences button-layout
            RESTORED+=("org.gnome.desktop.wm.preferences button-layout: reset to default")
            ;;
        *)
            RESTORED+=("org.gnome.desktop.wm.preferences button-layout: left alone (not the value this extension wrote)")
            ;;
    esac

    # Dash to Dock's schema lives inside its extension directory, where plain
    # gsettings cannot see it without pointing --schemadir at it. If neither
    # copy exists there is nothing to restore for it anyway.
    if [[ ! -d "$D2D_SCHEMAS" ]]; then
        echo "⚠️  Dash to Dock schemas not found; its keys were not checked." >&2
    fi

    echo ""
    echo "Keyboard and system settings:"
    if [[ ${#RESTORED[@]} -eq 0 ]]; then
        echo "  Nothing to restore."
    else
        for line in "${RESTORED[@]}"; do
            echo "  • $line"
        done
    fi
else
    echo ""
    echo "⚠️  Note: keyboard and desktop changes made from Preferences (macOS shortcut"
    echo "   sets, Alt/Cmd swap, Dash to Dock hot keys, button layout) are NOT reverted"
    echo "   by a plain uninstall. Run 'bash $0 --reset-settings' to restore them too —"
    echo "   ideally before the extension files are gone, while its schemas still exist."
fi

echo "✅ Removed. Log out and back in to unload it from the running session."

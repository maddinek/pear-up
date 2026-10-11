#!/usr/bin/env bash
# install.sh refreshes the libinput plugins the preferences put in
# ~/.config/libinput/plugins, keeping what they wrote into them — the scroll
# acceleration's strength, the macOS keys' swap, switches and key list — and
# uninstall.sh removes them; neither touches a file of either name that is not
# Pear Up's, nor installs one that was never asked for.
#
#   bash tests/libinput/check-install-scripts.sh <repo>
#
# Container only, which tests/lib/check-libinput-here.sh is: uninstall.sh asks
# GNOME Shell to disable the extension, and on a desktop that would be the
# session in use. Here there is no shell to ask, and HOME is a directory made
# for the run.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
if [[ ! -e /run/.containerenv && ! -e /.dockerenv ]]; then
    echo "Not in a container: uninstall.sh would disable Pear Up in this session" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" XDG_DATA_HOME="$WORK/home/.local/share"
mkdir -p "$HOME"
PLUGIN="$XDG_CONFIG_HOME/libinput/plugins/10-pear-up-scroll-acceleration.lua"
SOURCE="$SRC/libinput/10-pear-up-scroll-acceleration.lua"

failed=0
check() {
    if [[ "$2" == "$3" ]]; then
        echo "  ok   $1"
    else
        printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$3" "$2"
        failed=$((failed + 1))
    fi
}
quiet() { "$@" >/dev/null 2>&1; }

quiet bash "$SRC/install.sh"
check "install.sh installs no plugin of its own accord" "$([[ -e $PLUGIN ]] && echo yes || echo no)" no
UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/metadata.json")"
check "the extension carries the plugin for the preferences to install" \
    "$(cmp -s "$SOURCE" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID/libinput/10-pear-up-scroll-acceleration.lua" && echo same || echo different)" same

# An older copy at the strong setting: replaced, strength kept.
mkdir -p "$(dirname "$PLUGIN")"
sed 's/^local SLOW_GAIN = .*$/local SLOW_GAIN = 0.2/' "$SOURCE" | sed 's/^local FLICK_GAIN = .*$/local FLICK_GAIN = 1.3/' > "$PLUGIN"
echo 'libinput:register({1})' > "$XDG_CONFIG_HOME/libinput/plugins/20-of-my-own.lua"
quiet bash "$SRC/install.sh"
check "install.sh replaces an older copy, keeping its strength" \
    "$(cmp -s <(sed 's/^local SLOW_GAIN = .*$/local SLOW_GAIN = 0.2/' "$SOURCE") "$PLUGIN" && echo current || echo stale)" current
check "and leaves the plugins of others alone" "$(cat "$XDG_CONFIG_HOME/libinput/plugins/20-of-my-own.lua")" 'libinput:register({1})'

quiet bash "$SRC/uninstall.sh"
check "uninstall.sh removes Pear Up's plugin" "$([[ -e $PLUGIN ]] && echo yes || echo no)" no
check "and nothing else" "$(cat "$XDG_CONFIG_HOME/libinput/plugins/20-of-my-own.lua")" 'libinput:register({1})'

# A file of the same name that is not Pear Up's survives both.
echo 'print("mine")' > "$PLUGIN"
quiet bash "$SRC/install.sh"
check "install.sh leaves a file of the same name that is not Pear Up's" "$(cat "$PLUGIN")" 'print("mine")'
quiet bash "$SRC/uninstall.sh"
check "and so does uninstall.sh" "$(cat "$PLUGIN")" 'print("mine")'

# The macOS keys plugin.
KEYS="$XDG_CONFIG_HOME/libinput/plugins/10-pear-up-macos-keys.lua"
KEYS_SOURCE="$SRC/libinput/10-pear-up-macos-keys.lua"
written() {     # the shipped plugin with the preferences' lines as given
    sed -e "s/^local SWAPPED = .*$/local SWAPPED = $1/" -e "s/^local WORDS = .*$/local WORDS = $2/" \
        -e "s/^local DESKTOPS = .*$/local DESKTOPS = $3/" -e "s/^local SHORTCUTS = .*$/local SHORTCUTS = $4/" \
        -e "s/^local SHORTCUT_KEYS = .*$/local SHORTCUT_KEYS = \"$5\"/" "$KEYS_SOURCE"
}
rm -f "$KEYS"
quiet bash "$SRC/install.sh"
check "install.sh installs no macOS keys plugin of its own accord" "$([[ -e $KEYS ]] && echo yes || echo no)" no
check "the extension carries the macOS keys plugin" \
    "$(cmp -s "$KEYS_SOURCE" "$XDG_DATA_HOME/gnome-shell/extensions/$UUID/libinput/10-pear-up-macos-keys.lua" && echo same || echo different)" same

# An older copy, swapped, words off, a key list of the user's own: replaced,
# all of that kept.
{ written true false true true "C V Q"; echo '-- an older line'; } > "$KEYS"
quiet bash "$SRC/install.sh"
check "install.sh replaces an older macOS keys copy, keeping the swap, the switches and the key list" \
    "$(cmp -s <(written true false true true "C V Q") "$KEYS" && echo current || echo stale)" current
check "and leaves the other plugins alone" "$(cat "$XDG_CONFIG_HOME/libinput/plugins/20-of-my-own.lua")" 'libinput:register({1})'

quiet bash "$SRC/uninstall.sh"
check "uninstall.sh removes Pear Up's macOS keys plugin" "$([[ -e $KEYS ]] && echo yes || echo no)" no
check "and nothing else" "$(cat "$XDG_CONFIG_HOME/libinput/plugins/20-of-my-own.lua")" 'libinput:register({1})'

# Files of the same name that are not Pear Up's: one of the user's own, and
# one that mentions Pear Up but lacks a line the preferences write.
echo 'print("mine")' > "$KEYS"
quiet bash "$SRC/install.sh"
check "install.sh leaves a macOS keys file that is not Pear Up's" "$(cat "$KEYS")" 'print("mine")'
quiet bash "$SRC/uninstall.sh"
check "and so does uninstall.sh" "$(cat "$KEYS")" 'print("mine")'
grep -v '^local SWAPPED = ' "$KEYS_SOURCE" > "$KEYS"
quiet bash "$SRC/install.sh"
check "install.sh leaves a copy without its SWAPPED line as it is" \
    "$(cmp -s <(grep -v '^local SWAPPED = ' "$KEYS_SOURCE") "$KEYS" && echo untouched || echo rewritten)" untouched

exit "$failed"

#!/usr/bin/env bash
# install.sh refreshes the scroll acceleration plugin the preferences put in
# ~/.config/libinput/plugins, keeping its strength, and uninstall.sh removes it;
# neither touches a file of that name that is not Pear Up's, nor installs one
# that was never asked for.
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

exit "$failed"

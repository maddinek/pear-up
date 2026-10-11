#!/usr/bin/env bash
# Check Pear Up's libinput plugins against the libinput *on this machine*: the
# scroll acceleration and the macOS keys.
#
# Meant to be run inside a Fedora container with libinput 1.30 or later — one
# started by tests/run-libinput-tests.sh, or the job container in CI — and
# refusing anything else: one part installs the plugin into
# /etc/libinput/plugins, which on a desktop is a directory its compositor reads,
# and another runs uninstall.sh, which asks the running shell to disable Pear Up.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PLUGIN="$SRC/libinput/10-pear-up-scroll-acceleration.lua"
KEYS_PLUGIN="$SRC/libinput/10-pear-up-macos-keys.lua"

if [[ ! -e /run/.containerenv && ! -e /.dockerenv ]]; then
    echo "Not in a container: use tests/run-libinput-tests.sh" >&2
    exit 1
fi

dnf install -q -y lua libinput umockdev python3 glib2 diffutils \
    libxkbcommon-utils xkeyboard-config gsettings-desktop-schemas >/dev/null 2>&1

echo "  lua: $(lua -v 2>&1 | cut -d' ' -f2), libinput: $(libinput --version), umockdev: $(rpm -q --qf '%{VERSION}' umockdev)"

# The arithmetic, with frames of its own, in libinput's sandbox.
echo
echo "  the plugin's arithmetic:"
lua "$SRC/tests/libinput/check-scroll-acceleration.lua" "$PLUGIN" | sed 's/^/  /'

# The plugin inside real libinput, against a touchpad umockdev makes up.
echo
echo "  the plugin in libinput:"
python3 "$SRC/tests/libinput/check-with-libinput.py" "$PLUGIN" | sed 's/^/  /'

# The macOS keys: the logic with keys of its own, then the plugin in real
# libinput against a keyboard umockdev makes up.
echo
echo "  the macOS keys' logic:"
lua "$SRC/tests/libinput/check-macos-keys.lua" "$KEYS_PLUGIN" | sed 's/^/  /'

echo
echo "  the macOS keys in libinput:"
python3 "$SRC/tests/libinput/check-keys-with-libinput.py" "$KEYS_PLUGIN" | sed 's/^/  /'

# install.sh and uninstall.sh, in a home directory of their own.
echo
echo "  install.sh and uninstall.sh:"
bash "$SRC/tests/libinput/check-install-scripts.sh" "$SRC" | sed 's/^/  /'

#!/usr/bin/env bash
# Check the scroll acceleration plugin against the libinput *on this machine*.
#
# Meant to be run inside a Fedora container with libinput 1.30 or later — one
# started by tests/run-libinput-tests.sh, or the job container in CI — and
# refusing anything else: one part installs the plugin into
# /etc/libinput/plugins, which on a desktop is a directory its compositor reads,
# and another runs uninstall.sh, which asks the running shell to disable Pear Up.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PLUGIN="$SRC/libinput/10-pear-up-scroll-acceleration.lua"

if [[ ! -e /run/.containerenv && ! -e /.dockerenv ]]; then
    echo "Not in a container: use tests/run-libinput-tests.sh" >&2
    exit 1
fi

dnf install -q -y lua libinput umockdev python3 glib2 diffutils >/dev/null 2>&1

echo "  lua: $(lua -v 2>&1 | cut -d' ' -f2), libinput: $(libinput --version), umockdev: $(rpm -q --qf '%{VERSION}' umockdev)"

# The arithmetic, with frames of its own, in libinput's sandbox.
echo
echo "  the plugin's arithmetic:"
lua "$SRC/tests/libinput/check-scroll-acceleration.lua" "$PLUGIN" | sed 's/^/  /'

# The plugin inside real libinput, against a touchpad umockdev makes up.
echo
echo "  the plugin in libinput:"
python3 "$SRC/tests/libinput/check-with-libinput.py" "$PLUGIN" | sed 's/^/  /'

# install.sh and uninstall.sh, in a home directory of their own.
echo
echo "  install.sh and uninstall.sh:"
bash "$SRC/tests/libinput/check-install-scripts.sh" "$SRC" | sed 's/^/  /'

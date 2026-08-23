#!/usr/bin/env bash
# Build every preferences page against the GTK and libadwaita *on this machine*.
#
# Meant to be run inside a Fedora container of the right vintage — either one
# started by tests/run-prefs-smoke.sh, or the job container in CI.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORK="${WORK_DIR:-/tmp/ext}"

dnf install -q -y gjs gtk4 libadwaita glib2 gsettings-desktop-schemas \
    gnome-shell xorg-x11-server-Xvfb >/dev/null 2>&1

echo "  libadwaita: $(rpm -q --qf '%{VERSION}' libadwaita)"

# A writable copy: the schemas have to be compiled, and the base-class import
# swapped for the stub.
rm -rf "$WORK"
cp -r "$SRC" "$WORK"
glib-compile-schemas "$WORK/schemas"

# The real ExtensionPreferences lives in the Extensions app bundle and drags in
# its D-Bus service and the Shew typelib, neither of which is here. See
# tests/prefs-stub.js.
sed -i "s|resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js|file://$WORK/tests/prefs-stub.js|" \
    "$WORK/prefs.js"

# Writes go nowhere: a smoke test must not depend on, or leave behind, a dconf
# database. And anything GTK considers a programming error fails the run.
export GSETTINGS_BACKEND=memory
export G_DEBUG=fatal-criticals

xvfb-run -a gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

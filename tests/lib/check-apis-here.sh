#!/usr/bin/env bash
# Check the API manifest against the GNOME installed *on this machine*.
#
# Meant to be run inside a Fedora container of the right vintage — either one
# started by tests/run-api-matrix.sh, or the job container in CI. Keeping the
# work here means both routes run the same code instead of a copy each.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$SRC"

dnf install -q -y gjs gnome-shell python3 >/dev/null 2>&1

echo "  gnome-shell present: $(rpm -q --qf '%{VERSION}' gnome-shell | cut -d. -f1)"

# Clutter and Meta ship in mutter's private directory, St and Shell in
# gnome-shell's; both are versioned and neither is on the default search path.
typelibs=$(find /usr/lib64 /usr/lib -maxdepth 2 \
    \( -name "Meta-*.typelib" -o -name "St-*.typelib" -o -name "Shell-*.typelib" \) \
    -printf "%h\n" 2>/dev/null | sort -u | paste -sd:)
export GI_TYPELIB_PATH="$typelibs"
# The typelibs name libmutter-*.so, which lives beside them rather than on the
# default loader path.
export LD_LIBRARY_PATH="$typelibs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
echo "  typelibs: ${typelibs:-<none found>}"

gjs -m tests/check-api.js tests/api-manifest.json
gjs -m tests/check-menu-templates.js
gjs -m tests/check-menu-pin.js
python3 tests/check-shell-internals.py tests/api-manifest.json

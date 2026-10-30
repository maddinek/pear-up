#!/usr/bin/env bash
# Every module the extension imports from its own folder has to be named in
# scripts/pack.sh, or the packed zip installs and then fails to load anywhere
# but here (install.sh copies every .js, so a local install never notices).
#
#   tests/check-pack-sources.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# gnome-extensions pack ships these two by itself.
missing=0
for module in $(grep -ho "from '\./[A-Za-z0-9_]*\.js'" ./*.js | sed "s/from '\.\/\(.*\)'/\1/" | sort -u); do
    [[ "$module" == extension.js || "$module" == prefs.js ]] && continue
    if ! grep -qE "^ {4}$module\$" scripts/pack.sh; then
        echo "FAIL: $module is imported but not in scripts/pack.sh's EXTRA_SOURCES"
        missing=1
    fi
done

if (( missing )); then
    exit 1
fi
echo "PASS: every imported module is packed"

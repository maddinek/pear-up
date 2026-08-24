#!/usr/bin/env bash
# Build the distributable zip, the way extensions.gnome.org expects it.
#
#   scripts/pack.sh            # writes pear-up@maddinek.github.io.shell-extension.zip
#
# Why a script rather than a note in the README: `gnome-extensions pack` ships
# extension.js, prefs.js, metadata.json, stylesheet.css and schemas, and nothing
# else — every other file has to be named. Getting that list wrong produces a zip
# that installs and then fails at runtime on a machine that is not this one, so
# the list belongs somewhere it can be reviewed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

OUT_DIR="${1:-$REPO_DIR/dist}"
mkdir -p "$OUT_DIR"

UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' metadata.json)"
if [[ -z "$UUID" ]]; then
    echo "Could not read the uuid from metadata.json" >&2
    exit 1
fi

# The modules and data the extension needs at runtime. Tests, screenshots, the
# contrib patch, the lint config and node_modules are all deliberately absent:
# none of it runs on a user's machine. LICENSE ships because the menu engine
# came from another GPL-3 project, and its terms require the licence — plus
# attribution to its author — to travel with the code that carries it.
EXTRA_SOURCES=(
    LICENSE
    menuManager.js
    menuTemplates.js
    systemMenu.js
    searchButton.js
    recentItems.js
    forceQuit.js
    util.js
    icons
)

PACK_ARGS=()
for source in "${EXTRA_SOURCES[@]}"; do
    [[ -e "$source" ]] || { echo "Missing source: $source" >&2; exit 1; }
    PACK_ARGS+=("--extra-source=$source")
done

# The site compiles the schemas itself and rejects a zip carrying the compiled
# file, so make sure a local build has not left one behind.
rm -f schemas/gschemas.compiled

gnome-extensions pack "${PACK_ARGS[@]}" --force --out-dir "$OUT_DIR" .

ZIP="$OUT_DIR/$UUID.shell-extension.zip"
echo
echo "==> $ZIP"
echo "    $(du -h "$ZIP" | cut -f1), $(unzip -l "$ZIP" | tail -1 | awk '{print $2}') files"
echo
echo "Contents:"
unzip -l "$ZIP" | awk 'NR>3 && NF>3 {print "    " $4}' | sed '/^ *$/d'

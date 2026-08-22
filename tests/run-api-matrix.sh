#!/usr/bin/env bash
# Check the APIs this extension uses against several GNOME versions, without
# installing any of them: each runs in a container, headless, in about a minute.
#
#   tests/run-api-matrix.sh            # every version below
#   tests/run-api-matrix.sh 48 50      # just these
#
# What this proves: the APIs exist and still have the shape the code expects.
# What it cannot prove: that they behave the same. A symbol can be present and
# still not be ready at the moment the extension runs — see the note in
# api-manifest.json. Behaviour needs a running shell.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# GNOME ships with a known Fedora release, which is the cheapest way to get a
# specific version's libraries.
declare -A IMAGE_FOR=(
    [45]=fedora:39
    [46]=fedora:40
    [47]=fedora:41
    [48]=fedora:42
    [49]=fedora:43
    [50]=fedora:44
)

VERSIONS=("$@")
if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    VERSIONS=(45 46 47 48 49 50)
fi

RUNTIME="${CONTAINER_RUNTIME:-podman}"
if ! command -v "$RUNTIME" >/dev/null; then
    echo "Need podman or docker; set CONTAINER_RUNTIME to choose." >&2
    exit 1
fi

failed=()
skipped=()

for version in "${VERSIONS[@]}"; do
    image="${IMAGE_FOR[$version]:-}"
    if [[ -z "$image" ]]; then
        echo "No image known for GNOME $version" >&2
        skipped+=("$version")
        continue
    fi

    echo
    echo "=============================================================="
    echo " GNOME $version   ($image)"
    echo "=============================================================="

    # gnome-shell brings the shell library; gjs and the mutter typelibs are what
    # the introspection check needs. No X, no Wayland, no session.
    if ! "$RUNTIME" run --rm \
        -v "$REPO_DIR:/src:ro,Z" \
        -w /src \
        "$image" \
        bash -c '
            set -e
            dnf install -q -y gjs gnome-shell python3 >/dev/null 2>&1

            installed=$(rpm -q --qf "%{VERSION}" gnome-shell | cut -d. -f1)
            echo "  gnome-shell present: $installed"

            # Clutter and Meta live in mutter private directories that vary by
            # release, so point the loader at whichever is here.
            # Clutter and Meta ship in mutter'"'"'s private directory, St and Shell
            # in gnome-shell'"'"'s; both are versioned and neither is on the default
            # search path.
            typelibs=$(find /usr/lib64 /usr/lib -maxdepth 2 \
                \( -name "Meta-*.typelib" -o -name "St-*.typelib" \
                   -o -name "Shell-*.typelib" \) \
                -printf "%h\n" 2>/dev/null | sort -u | paste -sd:)
            export GI_TYPELIB_PATH="$typelibs"
            # The typelibs name libmutter-*.so, which lives beside them rather
            # than on the default loader path.
            export LD_LIBRARY_PATH="$typelibs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            echo "  typelibs: ${typelibs:-<none found>}"

            gjs -m tests/check-api.js tests/api-manifest.json
            python3 tests/check-shell-internals.py tests/api-manifest.json
        '
    then
        failed+=("$version")
    fi
done

echo
echo "=============================================================="
if [[ ${#failed[@]} -eq 0 ]]; then
    echo " All checked versions passed: ${VERSIONS[*]}"
    [[ ${#skipped[@]} -gt 0 ]] && echo " Skipped: ${skipped[*]}"
    echo
    echo " Remember: this checks that the APIs exist, not that they behave."
    exit 0
fi

echo " Failed: ${failed[*]}"
echo " Do not claim those in metadata.json until the gaps are handled."
exit 1

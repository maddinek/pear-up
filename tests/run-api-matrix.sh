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

# :Z relabels the mount for SELinux, which podman needs and docker rejects.
MOUNT="ro"
[[ "$RUNTIME" == *podman* ]] && MOUNT="ro,Z"

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
        -v "$REPO_DIR:/src:$MOUNT" \
        -w /src \
        "$image" \
        bash /src/tests/lib/check-apis-here.sh /src
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

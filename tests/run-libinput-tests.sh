#!/usr/bin/env bash
# Check Pear Up's libinput plugins in a container: the scroll acceleration's
# arithmetic and the macOS keys' logic, then each plugin loaded into real
# libinput, replaying gestures on a made-up touchpad and keys on a made-up
# keyboard.
#
#   tests/run-libinput-tests.sh         # GNOME 50's Fedora, libinput 1.31
#   tests/run-libinput-tests.sh 50      # the same, by GNOME release
#
# Only releases whose compositor loads the user's libinput plugins are worth
# checking, and GNOME 50 is the first. Nothing here touches the desktop it is
# run from: the touchpad and the keyboard exist only inside umockdev, which
# fakes the device node for the one process it runs, rather than through
# uinput, whose devices every libinput on the machine would see.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/tests/lib/gnome-images.sh"

VERSIONS=("$@")
if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    VERSIONS=(50)
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

for version in "${VERSIONS[@]}"; do
    image="${IMAGE_FOR[$version]:-}"
    if [[ -z "$image" ]]; then
        echo "No image known for GNOME $version" >&2
        failed+=("$version")
        continue
    fi

    echo
    echo "=============================================================="
    echo " GNOME $version   ($image)"
    echo "=============================================================="

    if ! "$RUNTIME" run --rm \
        -v "$REPO_DIR:/src:$MOUNT" \
        "$image" \
        bash /src/tests/lib/check-libinput-here.sh /src
    then
        failed+=("$version")
    fi
done

echo
echo "=============================================================="
if [[ ${#failed[@]} -eq 0 ]]; then
    echo " The libinput plugins passed on: ${VERSIONS[*]}"
    echo
    echo " Remember: how they feel is for fingers on a real touchpad and keyboard to say."
    exit 0
fi

echo " Failed: ${failed[*]}"
exit 1

#!/usr/bin/env bash
# Open the preferences window on several GNOME versions, headless, and fail if
# any page throws while being built.
#
#   tests/run-prefs-smoke.sh            # every version
#   tests/run-prefs-smoke.sh 49 50      # just these
#
# Preferences are a separate process from the shell, so the integration suite
# never touches them. This is the cheapest thing that would have caught a
# property that libadwaita does not have on an older release.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/tests/lib/gnome-images.sh"

VERSIONS=("$@")
if [[ ${#VERSIONS[@]} -eq 0 ]]; then
    VERSIONS=("${ALL_VERSIONS[@]}")
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
        bash -c '
            set -e
            dnf install -q -y gjs gtk4 libadwaita glib2 gsettings-desktop-schemas \
                gnome-shell xorg-x11-server-Xvfb >/dev/null 2>&1

            echo "  libadwaita: $(rpm -q --qf "%{VERSION}" libadwaita)"

            # A writable copy, because the schemas have to be compiled and the
            # base-class import swapped for the stub.
            cp -r /src /tmp/ext
            glib-compile-schemas /tmp/ext/schemas

            # The real ExtensionPreferences lives in the Extensions app bundle and
            # drags in its D-Bus service and the Shew typelib, neither of which is
            # here. See tests/prefs-stub.js.
            sed -i "s|resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js|file:///tmp/ext/tests/prefs-stub.js|" \
                /tmp/ext/prefs.js

            # Writes go nowhere: a smoke test must not depend on, or leave behind,
            # a dconf database.
            export GSETTINGS_BACKEND=memory
            # Anything GTK considers a programming error fails the run.
            export G_DEBUG=fatal-criticals

            xvfb-run -a gjs -m /tmp/ext/tests/prefs-smoke.js /tmp/ext
        '
    then
        failed+=("$version")
    fi
done

echo
echo "=============================================================="
if [[ ${#failed[@]} -eq 0 ]]; then
    echo " Preferences built on every checked version: ${VERSIONS[*]}"
    echo
    echo " Remember: this proves the pages build, not that they are usable."
    exit 0
fi

echo " Failed: ${failed[*]}"
exit 1

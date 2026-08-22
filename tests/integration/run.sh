#!/usr/bin/env bash
# Boot a real GNOME Shell in a container, load the extension into it, check that
# it behaves, then throw the container away.
#
#   tests/integration/run.sh                        # GNOME 50
#   tests/integration/run.sh 48                     # GNOME 48, via Fedora 42
#   PEAR_UP_SCREENSHOT=0 tests/integration/run.sh   # skip the picture
#
# Nothing is installed on this machine and no display is used, so this is a way
# to try a change before letting it near a desktop you depend on. It needs no
# VM either, which means it can run in CI.
#
# The screenshot is of the container's own virtual monitor — the throwaway shell
# started in here. No display from the host is passed in, so nothing outside the
# container is visible to it.
set -euo pipefail

GNOME_VERSION="${1:-50}"
SCREENSHOT="${PEAR_UP_SCREENSHOT:-1}"

declare -A FEDORA_FOR=(
    [45]=39 [46]=40 [47]=41 [48]=42 [49]=43 [50]=44
)

FEDORA="${FEDORA_FOR[$GNOME_VERSION]:-}"
if [[ -z "$FEDORA" ]]; then
    echo "Unknown GNOME version '$GNOME_VERSION'. Known: ${!FEDORA_FOR[*]}" >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONTEXT="$REPO_DIR/tests/integration"
ARTIFACTS="$CONTEXT/artifacts/gnome-$GNOME_VERSION"
IMAGE="pear-up-test:gnome$GNOME_VERSION"
NAME="pear-up-test-$GNOME_VERSION-$$"

RUNTIME="${CONTAINER_RUNTIME:-podman}"
command -v "$RUNTIME" >/dev/null || {
    echo "Need podman or docker; set CONTAINER_RUNTIME." >&2
    exit 1
}

rm -rf "$ARTIFACTS"
mkdir -p "$ARTIFACTS"

cleanup() {
    "$RUNTIME" rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building the GNOME $GNOME_VERSION image (fedora:$FEDORA)"
"$RUNTIME" build \
    --build-arg "FEDORA=$FEDORA" \
    -t "$IMAGE" \
    -f "$CONTEXT/Containerfile" \
    "$CONTEXT"

echo
echo "==> Booting systemd in the container"
# The shell will not start without logind, and logind will not start without
# more privilege than a container normally gets: it wants its own seat, cgroup
# control and device access. GNOME 48 fails outright without it, where 50
# tolerates its absence.
#
# This is a container built here from a Fedora base, used once and deleted, with
# nothing of the host mounted but this repository (read-only). Set
# PEAR_UP_PRIVILEGED=0 to withhold it — expect older releases not to boot.
PRIVILEGE=(--privileged)
if [[ "${PEAR_UP_PRIVILEGED:-1}" == "0" ]]; then
    PRIVILEGE=(--cap-add SYS_ADMIN)
    echo "    (running unprivileged; logind will not start)"
fi

"$RUNTIME" run -d --name "$NAME" \
    --systemd=always \
    "${PRIVILEGE[@]}" \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
    --device /dev/dri \
    -e "PEAR_UP_SCREENSHOT=$SCREENSHOT" \
    -v "$REPO_DIR:/src:ro,Z" \
    -v "$ARTIFACTS:/artifacts:Z" \
    "$IMAGE" >/dev/null

# Wait for the boot to settle. "degraded" is expected and fine: several units
# have nothing to do in a container.
for _ in $(seq 1 60); do
    state="$("$RUNTIME" exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
    case "$state" in
        running|degraded) break ;;
    esac
    sleep 1
done
echo "systemd: ${state:-unknown}"

echo
echo "==> Running the checks"
set +e
"$RUNTIME" exec "$NAME" /usr/local/bin/run-tests.sh
status=$?
set -e

echo
echo "Logs and any screenshot: $ARTIFACTS"
exit $status

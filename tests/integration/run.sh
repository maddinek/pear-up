#!/usr/bin/env bash
# Boot a real GNOME Shell in a container, load the extension into it, check that
# it behaves, then throw the container away.
#
#   tests/integration/run.sh          # GNOME 50
#   tests/integration/run.sh 48       # GNOME 48, via Fedora 42
#
# Nothing is installed on this machine and no display is used, so this is a way
# to try a change before letting it near a desktop you depend on. It needs no
# VM either, which means it can run in CI.
set -euo pipefail

GNOME_VERSION="${1:-50}"

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
# systemd needs a writable cgroup and a tmpfs for /run; logind additionally
# wants SYS_ADMIN. /dev/dri gives mutter software rendering to draw into.
"$RUNTIME" run -d --name "$NAME" \
    --systemd=always \
    --cap-add SYS_ADMIN \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
    --device /dev/dri \
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

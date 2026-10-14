#!/usr/bin/env bash
# Records the end-to-end test's gestures on this machine's real touchpad, to
# replace the synthetic ones in gestures/. Run it yourself, at the desk:
#
#   tests/scroll-e2e/record-gestures.sh            # all of them, one by one
#   tests/scroll-e2e/record-gestures.sh flick      # just these
#
# `libinput record` reads the touchpad's device node, which only root may
# open, so sudo asks for your password once. Reading does not take the
# touchpad away from the desktop: it keeps working while you record, so do
# each gesture over a window that does not mind being scrolled.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/gestures"

declare -A WHAT=(
    [slow-scroll]="two fingers, slowly (about 1.5 cm a second) for about a second, then stop and lift"
    [medium-scroll]="two fingers at an easy reading pace, lifting while still moving"
    [flick]="one ordinary flick, as you would to page down"
    [fast-flick]="one fast flick, as hard as you would to get far"
    [double-flick]="a flick, then another about a quarter of a second after the first lifted"
    [quick-reflick]="two flicks in quick succession, as fast as you repeat them"
    [flick-touch-stop]="a flick, then rest one finger on the pad a moment later to stop it"
    [tiny-move]="a precise nudge: move two fingers a couple of millimetres, slowly, then lift"
)
ORDER=(slow-scroll medium-scroll flick fast-flick double-flick quick-reflick flick-touch-stop tiny-move)
[[ $# -gt 0 ]] && ORDER=("$@")

node="$(libinput list-devices 2>/dev/null | awk '/^Device:.*[Tt]ouchpad/{t=1} t&&/^Kernel:/{print $2; exit}')"
if [[ -z "$node" ]]; then
    node="$(sudo libinput list-devices | awk '/^Device:.*[Tt]ouchpad/{t=1} t&&/^Kernel:/{print $2; exit}')"
fi
[[ -n "$node" ]] || { echo "No touchpad found." >&2; exit 1; }
echo "Touchpad: $node"
sudo -v

for name in "${ORDER[@]}"; do
    echo
    echo "== $name: ${WHAT[$name]:-?}"
    read -r -p "   Press Enter, then do it within 4 seconds..." _
    sudo timeout -s INT 4 libinput record --output-file "/tmp/$name.yaml" "$node" >/dev/null 2>&1 || true
    sudo chown "$(id -u):$(id -g)" "/tmp/$name.yaml"
    mv "/tmp/$name.yaml" "$DIR/$name.yaml"
    echo "   saved gestures/$name.yaml ($(grep -c '^  - evdev:' "$DIR/$name.yaml") frames)"
done
echo
echo "Done. Run tests/run-scroll-e2e.sh; the report marks these as recorded."

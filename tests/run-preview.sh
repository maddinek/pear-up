#!/usr/bin/env bash
# Pictures of this checkout on this machine's desktop, taken in a throwaway
# container. A thin wrapper, so it sits with the other tests/run-*.sh; see
# tests/preview/README.md for what it does and does not show.
#
#   tests/run-preview.sh                        # this checkout, outputs in the cache
#   tests/run-preview.sh ../other-checkout out  # another checkout, into ./out
#   tests/run-preview.sh --size 1920x1080 --scale 1
set -euo pipefail

exec "$(dirname "${BASH_SOURCE[0]}")/preview/run.sh" "$@"

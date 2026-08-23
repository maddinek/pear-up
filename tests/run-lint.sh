#!/usr/bin/env bash
# Runs eslint in a container, so linting needs nothing installed on the host.
# CI runs the same eslint directly, having a Node toolchain already.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${CONTAINER_RUNTIME:-podman}"
IMAGE="${LINT_IMAGE:-docker.io/library/node:22-alpine}"

exec "$RUNTIME" run --rm \
    -v "$REPO_ROOT:/src:Z" \
    -w /src \
    "$IMAGE" \
    sh -c 'npm install --no-audit --no-fund --silent && npx eslint .'

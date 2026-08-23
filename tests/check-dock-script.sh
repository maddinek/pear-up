#!/usr/bin/env bash
# Prove the dock configure script forwards DOCK_SET_FAVORITES to the remote
# shell. The opt-out used to be swallowed by the quoted heredoc and the user's
# pinned favourites were overwritten anyway; this is the regression test for it.
#
#   tests/check-dock-script.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/ssh" <<'FAKE'
#!/usr/bin/env bash
# Record every argument, one per line, then succeed without touching stdin.
printf '%s\n' "$@" > "$SSH_CALL_LOG"
exit 0
FAKE
chmod +x "$FAKE_BIN/ssh"

failed=0
expect_favorites_arg() {
    local env_value="$1" want="$2" label="$3"
    local log="$WORK/args.log"
    rm -f "$log"
    if ! (export PATH="$FAKE_BIN:$PATH" SSH_CALL_LOG="$log" BLUEFIN_SSH="vm-bluefin" \
              DOCK_SET_FAVORITES="$env_value";
          bash "$REPO_ROOT/scripts/configure-dock-bluefin.sh" \
              > /dev/null 2>&1); then
        echo "  FAIL $label (script exited nonzero)" >&2
        failed=$((failed + 1))
        return
    fi
    # The remote command is everything after the options and target: the last
    # five arguments are the positional parameters of `bash -s --`.
    local got
    got="$(tail -1 "$log")"
    if [[ "$got" == "$want" ]]; then
        echo "  ok   $label"
    else
        printf '  FAIL %s\n       expected 5th positional arg: %s\n       actual: %s\n' \
            "$label" "$want" "$got" >&2
        failed=$((failed + 1))
    fi
}

expect_favorites_arg 0 0 "DOCK_SET_FAVORITES=0 reaches the remote shell"
expect_favorites_arg 1 1 "DOCK_SET_FAVORITES=1 reaches the remote shell"

# Unset must keep today's default: favourites are replaced unless asked not to.
rm -f "$WORK/args.log"
if (export PATH="$FAKE_BIN:$PATH" SSH_CALL_LOG="$WORK/args.log" BLUEFIN_SSH="vm-bluefin";
    unset DOCK_SET_FAVORITES;
    bash "$REPO_ROOT/scripts/configure-dock-bluefin.sh" > /dev/null 2>&1); then
    got="$(tail -1 "$WORK/args.log")"
    if [[ "$got" == "1" ]]; then
        echo "  ok   unset defaults to replacing favourites"
    else
        printf '  FAIL unset default\n       expected 5th positional arg: 1\n       actual: %s\n' "$got" >&2
        failed=$((failed + 1))
    fi
fi

if [[ $failed -eq 0 ]]; then
    echo "dock configure script: all checks passed"
else
    echo "dock configure script: $failed failed" >&2
fi
exit $((failed > 0))

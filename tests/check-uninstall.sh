#!/usr/bin/env bash
# Exercise uninstall.sh's gsettings undo helpers against a fake gsettings, so
# the string surgery on printed GVariant lists is tested rather than trusted.
#
#   tests/check-uninstall.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_BIN="$WORK/bin"
STATE="$WORK/state"
mkdir -p "$FAKE_BIN" "$STATE"

# A gsettings that keeps one file per "schema|key" holding the printed value,
# ignoring any --schemadir-style options in between. reset deletes the entry.
cat > "$FAKE_BIN/gsettings" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
STATE="${GSETTINGS_FAKE_STATE:?}"
op="$1"; shift
while [[ "${1:-}" == --* ]]; do shift 2; done
schema="$1"; key="$2"
file="$STATE/$schema|$key"
case "$op" in
    get)  cat "$file" ;;
    set)  printf '%s\n' "$3" > "$file" ;;
    reset) rm -f "$file" ;;
    *) echo "fake gsettings: unknown op $op" >&2; exit 64 ;;
esac
FAKE
chmod +x "$FAKE_BIN/gsettings"

export GSETTINGS_FAKE_STATE="$STATE"
export PATH="$FAKE_BIN:$PATH"

RESTORED=()
source "$REPO_ROOT/scripts/lib/gsettings-undo.sh"

failed=0
check() {
    if [[ "$2" == "$3" ]]; then
        print_ok="  ok   $1"
    else
        print_ok=""
        printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$3" "$2" >&2
        failed=$((failed + 1))
    fi
    [[ -n "$print_ok" ]] && echo "$print_ok"
}

put() { printf '%s\n' "$2" > "$STATE/$1"; }

# --- remove_accel -----------------------------------------------------------
put 'org.test|x' "[<'other', '<Super>q', 'plain']"
RESTORED=()
remove_accel org.test x '<Super>q'
check "middle accel removed, neighbours intact" \
    "$(cat "$STATE/org.test|x")" "[<'other', 'plain']"

put 'org.test|y' "['a', '<Super>q']"
remove_accel org.test y '<Super>q'
check "last accel removed" "$(cat "$STATE/org.test|y")" "['a']"

put 'org.test|z' "['<Super>q', 'b']"
remove_accel org.test z '<Super>q'
check "first accel removed" "$(cat "$STATE/org.test|z")" "['b']"

put 'org.test|solo' "['<Super>q']"
remove_accel org.test solo '<Super>q'
check "sole accel collapses to []" "$(cat "$STATE/org.test|solo")" "[]"

put 'org.test|untouched' "['a', 'b']"
RESTORED=()
remove_accel org.test untouched '<Super>q'
check "absent accel leaves the list alone" \
    "$(cat "$STATE/org.test|untouched")" "['a', 'b']"
check "absent accel records nothing" "${#RESTORED[@]}" "0"

# --- reset_if_matches -------------------------------------------------------
put 'org.test|hot' 'false'
RESTORED=()
reset_if_matches org.test hot 'false'
check "exact match is reset" "$(cat "$STATE/org.test|hot" 2>/dev/null || echo RESET)" "RESET"

put 'org.test|empty' '@as []'
reset_if_matches org.test empty '[]'
check "type-annotated empty strv is reset" \
    "$(cat "$STATE/org.test|empty" 2>/dev/null || echo RESET)" "RESET"

put 'org.test|touched' 'true'
RESTORED=()
reset_if_matches org.test touched 'false'
check "user-modified value is left alone" "$(cat "$STATE/org.test|touched")" "true"
check "left-alone case is reported" "${#RESTORED[@]}" "1"

if [[ $failed -eq 0 ]]; then
    echo "uninstall helpers: all checks passed"
else
    echo "uninstall helpers: $failed failed" >&2
fi
exit $((failed > 0))

# Shell helpers that undo what the preferences window wrote to settings owned
# by other parts of the desktop. Sourced by uninstall.sh; exercised directly by
# tests/check-uninstall.sh against a fake gsettings, so nothing here may run at
# source time and every call must go through whatever `gsettings` is on PATH.

# Remove one accelerator from a strv key if present, leaving everything else.
# The printed form is ['a', 'b'], each entry wrapped in single quotes, so the
# token stripped here is the quoted entry plus whichever separator follows or
# precedes it, collapsing the now-empty list back to [].
remove_accel() {
    local schema="$1" key="$2" accel="$3"
    shift 3
    local current updated tok
    tok="'$accel'"
    current="$(gsettings get "$@" "$schema" "$key")" || return 0
    [[ "$current" == *"$tok"* ]] || return 0
    updated="${current//"$tok", /}"
    updated="${updated//, "$tok"/}"
    updated="${updated//"$tok"/}"
    [[ "$updated" == "['']" ]] && updated="[]"
    gsettings set "$@" "$schema" "$key" "$updated"
    RESTORED+=("$schema $key: removed '$accel'")
}

# Reset a key only while it still holds the value prefs.js writes.
reset_if_matches() {
    local schema="$1" key="$2" expected="$3"
    shift 3
    local current
    current="$(gsettings get "$@" "$schema" "$key")" || return 0
    if [[ "$current" == "$expected" || "$current" == "@as $expected" ]]; then
        # An empty strv prints as "@as []", so accept the type-annotated form too.
        gsettings reset "$@" "$schema" "$key"
        RESTORED+=("$schema $key: reset to default")
    else
        RESTORED+=("$schema $key: left alone (not the value this extension wrote)")
    fi
}
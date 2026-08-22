#!/usr/bin/env bash
# Leave exactly one extension installed on the Bluefin VM.
#
# Several things put stale copies on disk. Debugging GNOME 50 needed a
# throwaway UUID, because a Wayland session never re-imports an extension's
# JavaScript: the only way to load fixed code without logging out is to install
# it under a name the shell has not seen yet. Renaming the extension away from
# the upstream author's UUID left that older directory behind. The panel tweaks
# (clock position, hidden indicators, Spotlight placement) also started life as
# small separate "macos*" helpers before moving into the extension itself.
#
# Run this and then log out. The switch cannot take effect in the running
# session, so the panel keeps using whatever is already loaded until the shell
# restarts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SSH_HOST="${BLUEFIN_SSH:-vm-bluefin}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no)

if [[ "$SSH_HOST" == *"@"* ]]; then
    SSH_TARGET="$SSH_HOST"
elif [[ "$SSH_HOST" != "127.0.0.1" && "$SSH_HOST" != *"."* ]]; then
    SSH_TARGET="$SSH_HOST"
else
    SSH_KEY="${BLUEFIN_SSH_KEY:-$HOME/.ssh/vm-key}"
    SSH_PORT="${BLUEFIN_SSH_PORT:-2223}"
    SSH_USER="${BLUEFIN_SSH_USER:-martin}"
    SSH_TARGET="${SSH_USER}@127.0.0.1"
    SSH_OPTS+=(-i "$SSH_KEY" -p "$SSH_PORT")
fi

KEEP_UUID="${KEEP_UUID:-$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/metadata.json")}"

echo "==> Keeping ${KEEP_UUID}, removing superseded copies and helpers on ${SSH_TARGET}"

ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$KEEP_UUID" <<'REMOTE'
set -euo pipefail
KEEP_UUID="$1"
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"

if [[ ! -f "$EXT_DIR/$KEEP_UUID/menuManager.js" ]]; then
    echo "ERROR: $KEEP_UUID is not installed; run deploy-bluefin.sh first." >&2
    exit 1
fi

python3 - "$KEEP_UUID" <<'PY'
import ast, subprocess, sys

keep = sys.argv[1]
raw = subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
# An empty list comes back as "@as []", which is not Python syntax.
if raw.startswith('@'):
    raw = raw.split(' ', 1)[1]

# Drop earlier builds of this extension plus the retired helpers, named in full
# so an unrelated extension cannot be caught by a prefix.
SUPERSEDED = {
    'globalmenu@ShiroOSL.github.io',
    'globalmenu@maddinek.github.io',
    'globalmenu-fixed@maddinek.local',
    'macosbar@globalmenu.local',
    'macosclock@globalmenu.local',
    'macoscluster@globalmenu.local',
}
enabled = [uuid for uuid in ast.literal_eval(raw)
           if uuid == keep or uuid not in SUPERSEDED]
if keep not in enabled:
    enabled.append(keep)

# GVariant array literal; UUIDs never contain quotes.
literal = '[' + ', '.join(f"'{uuid}'" for uuid in enabled) + ']'
subprocess.check_call(
    ['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', literal])
print('enabled-extensions ->', literal)
PY

# Named in full rather than globbed: "macos*" would also match somebody else's
# extension that happens to start the same way.
for uuid in \
    globalmenu@ShiroOSL.github.io \
    globalmenu@maddinek.github.io \
    globalmenu-fixed@maddinek.local \
    macosbar@globalmenu.local \
    macosclock@globalmenu.local \
    macoscluster@globalmenu.local
do
    [[ "$uuid" == "$KEEP_UUID" ]] && continue
    [[ -d "$EXT_DIR/$uuid" ]] || continue
    rm -rf "$EXT_DIR/$uuid"
    echo "Removed $EXT_DIR/$uuid"
done

echo "Extensions still installed here:"
ls -1 "$EXT_DIR"
REMOTE

echo
echo "==> Done. Log out and back in; only ${KEEP_UUID} will load."

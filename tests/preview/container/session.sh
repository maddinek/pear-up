#!/usr/bin/env bash
# Runs as root inside the preview container once systemd has booted. Sets the
# container up like the host desktop from what run.sh staged under /host,
# installs the Pear Up snapshot from /src the way its own harness does, then
# starts the session as a normal user named like the host's (Nautilus refuses to
# run as root).
#
# Mounts: /src (checkout snapshot, ro), /host (the host's settings, ro),
# /preview (tests/preview, ro), ~U/.local/share/icons/* and /host-icons/* (the
# host's themes, ro), /out (pictures and logs).
set -uo pipefail

U="${PREVIEW_USER:-preview}"
UHOME="/home/$U"
RUNTIME=/run/user/1000
WORK=/tmp/preview-out          # the user writes here; copied to /out at the end
mkdir -p "$WORK/logs" /out
LOGS="$WORK/logs"

step() { echo "-- $*"; }
finish() {
    cp -r "$WORK/." /out/ 2>/dev/null
}
trap finish EXIT

step "user $U"
id -u "$U" >/dev/null 2>&1 || useradd -M -u 1000 -d "$UHOME" -s /bin/bash \
    -c "${PREVIEW_USER_NAME:-$U}" "$U"
mkdir -p "$UHOME/.local/share/icons" "$RUNTIME"
# Not recursive: the icon themes under .local/share/icons are read-only mounts.
chown "$U:" "$UHOME" "$UHOME/.local" "$UHOME/.local/share" "$UHOME/.local/share/icons" \
    "$RUNTIME" "$WORK" "$LOGS"
chmod 700 "$RUNTIME"

step "the host's schema overrides (its distribution's defaults: dark scheme, blur, ...)"
cp /host/schema-overrides/*.override /usr/share/glib-2.0/schemas/ 2>/dev/null
# and the schemas of packaged extensions that keep theirs in the system directory
cp /host/schemas/*.gschema.xml /usr/share/glib-2.0/schemas/ 2>/dev/null
glib-compile-schemas /usr/share/glib-2.0/schemas >"$LOGS/schemas.log" 2>&1 \
    || echo "   (glib-compile-schemas complained, see logs/schemas.log)"

step "the host's extensions"
cp -a /host/extensions/system/. /usr/share/gnome-shell/extensions/
# Copied as root and handed over: e.g.o installs leave metadata.json mode 600.
EXT="$UHOME/.local/share/gnome-shell/extensions"
mkdir -p "$EXT"
cp -a /host/extensions/user/. "$EXT/"
chown -R "$U:" "$UHOME/.local/share/gnome-shell"
chmod -R u+rwX,go+rX "$EXT" /usr/share/gnome-shell/extensions

step "system icon themes the image lacks (the host's, linked from /host-icons)"
for theme in /host-icons/*/; do
    [[ -d "$theme" ]] || continue
    name="$(basename "$theme")"
    [[ -e "/usr/share/icons/$name" ]] || ln -s "/host-icons/$name" "/usr/share/icons/$name"
done

step "battery (mock UPower on the system bus, the host's current charge)"
BAT_PERCENT=80 BAT_STATE=2 BAT_ICON=battery-good-symbolic BAT_PRESENT=false
# shellcheck disable=SC1091  # written by run.sh, which only has it when it exists
[[ -f /host/battery.env ]] && . /host/battery.env
if [[ "$BAT_PRESENT" == "true" ]]; then
    systemctl mask --runtime --now upower.service >/dev/null 2>&1
    # UPower's bus policy only admits its own interfaces; the mock's setup
    # interface needs this to be callable.
    cp /preview/container/upower-mock-policy.conf \
        /etc/dbus-1/system.d/pear-up-preview-upower-mock.conf
    gdbus call --system --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.ReloadConfig >/dev/null
    python3 -m dbusmock --system --template upower >"$LOGS/upower-mock.log" 2>&1 &
    for _ in $(seq 1 40); do
        gdbus introspect --system --dest org.freedesktop.UPower \
            --object-path /org/freedesktop/UPower >/dev/null 2>&1 && break
        sleep 0.25
    done
    # type 2 = battery; energies and times are only there to look plausible
    gdbus call --system --dest org.freedesktop.UPower \
        --object-path /org/freedesktop/UPower \
        --method org.freedesktop.DBus.Mock.SetupDisplayDevice \
        2 "$BAT_STATE" "$BAT_PERCENT" 50.0 60.0 6.0 36000 0 true "$BAT_ICON" 1 \
        >/dev/null && echo "   ${BAT_PERCENT}% state=$BAT_STATE" \
        || echo "   (could not set up the mock battery, see logs/upower-mock.log)"
fi

as_user() {
    runuser -u "$U" -- env -i \
        HOME="$UHOME" USER="$U" LOGNAME="$U" SHELL=/bin/bash \
        PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 \
        XDG_RUNTIME_DIR="$RUNTIME" \
        LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe NO_AT_BRIDGE=1 \
        PREVIEW_OUT="$WORK" \
        PREVIEW_SIZE="${PREVIEW_SIZE:-2880x1920}" \
        PREVIEW_SCALE="${PREVIEW_SCALE:-2}" \
        PREVIEW_LAYOUT="${PREVIEW_LAYOUT:-logical}" \
        PREVIEW_SHOTS="${PREVIEW_SHOTS:-}" \
        PREVIEW_FRONT_APP="${PREVIEW_FRONT_APP:-org.gnome.Nautilus.desktop}" \
        PREVIEW_TRAY_ICON="${PREVIEW_TRAY_ICON:-applications-system}" \
        PREVIEW_HOLD="${PREVIEW_HOLD:-0}" \
        "$@"
}

step "Pear Up from the checkout (its install.sh)"
as_user bash /preview/container/user-setup.sh || exit 1  # via bash: a synced or unzipped tree may have lost its exec bits

step "session"
as_user dbus-run-session -- bash /preview/container/in-session.sh 2>>"$LOGS/session-stderr.log"

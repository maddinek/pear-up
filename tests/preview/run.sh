#!/usr/bin/env bash
# Pictures of what a Pear Up checkout looks like on this machine's desktop,
# without going near the live session: everything runs in a throwaway podman
# container with its own headless GNOME Shell, set up like the desktop it is
# run from.
#
#   tests/preview/run.sh [--size WxH] [--scale N] [checkout] [out-dir]
#
# The checkout defaults to the repository this script is in. Host files are only
# read: the checkout is copied to a temp dir first, the desktop's settings are
# read with `dconf dump` and `gsettings get`, extensions, wallpaper and CSS are
# copied, the icon themes are mounted read-only. The virtual monitor has the
# size and scale of this desktop's primary monitor (read from mutter, which only
# reads); --size and --scale override that, and 2880x1920 at scale 2 is used when
# there is no session to ask.
#
# Env: PREVIEW_SHOTS="desktop file_menu"  only these shots (see container/driver.py)
#      PREVIEW_FRONT_APP=org.gnome.TextEditor.desktop  the app in front
#      PREVIEW_TRAY_ICON=<icon name>  the fake tray item (default: steam if the
#                                     icon theme has it, else applications-system)
#      PREVIEW_EXTENSIONS="uuid uuid"  load these instead of the enabled ones
#      PREVIEW_KEEP=1  keep the container afterwards
#      PREVIEW_HOLD=1  leave the session running after the shots, for poking at
#      PEAR_UP_PREVIEW_CACHE=<dir>  where the work files and the outputs go
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HERE/../.." && pwd)"
CACHE="${PEAR_UP_PREVIEW_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pear-up-preview}"
IMAGE="localhost/pear-up-preview:gnome50"

# When mutter cannot be asked (no session bus, say over ssh): a 2880x1920 panel
# at scale 2.
DEFAULT_SIZE=2880x1920
DEFAULT_SCALE=2

# Enabled extensions that stay out of the picture. None changes how the bar, the
# menus or the dock look, and several want something the container has not got:
# a phone (GSConnect), a Flatpak store (Bazaar), a pointer barrier (HotEdge),
# the power targets (Restart To), a shell theme (User Themes, whose theme is not
# copied).
SKIP_EXTS=(caffeine@patapon.info gsconnect@andyholmes.github.io
           hotedge@jonathan.jdoda.ca restartto@tiagoporsch.github.io
           bazaar-integration@kolunmi.github.io
           user-theme@gnome-shell-extensions.gcampax.github.com)
DCONF_PATHS=(/org/gnome/desktop/interface/ /org/gnome/desktop/wm/preferences/
             /org/gnome/mutter/ /org/gnome/shell/ /org/gnome/desktop/background/
             /org/gnome/desktop/input-sources/ /org/gnome/desktop/wm/keybindings/
             /org/gnome/settings-daemon/plugins/media-keys/)

die() { echo "preview: $*" >&2; exit 1; }

usage() {
    sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

OPT_SIZE="" OPT_SCALE="" SIZE="" SCALE="" LAYOUT="" SOURCE="" TRAY_ICON="" ICON_THEME="" ICON_THEME_DIR=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --size)  [[ $# -ge 2 ]] || die "--size needs WxH";  OPT_SIZE="$2";  shift 2 ;;
        --scale) [[ $# -ge 2 ]] || die "--scale needs N";   OPT_SCALE="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) die "unknown option $1 (see --help)" ;;
        *) break ;;
    esac
done
[[ -z "$OPT_SIZE" || "$OPT_SIZE" =~ ^[0-9]+x[0-9]+$ ]] || die "--size wants WIDTHxHEIGHT, like 2880x1920"
[[ -z "$OPT_SCALE" || "$OPT_SCALE" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--scale wants a number, like 2 or 1.25"
[[ $# -le 2 ]] || die "too many arguments (see --help)"

CHECKOUT="$(realpath "${1:-$REPO_DIR}")"
[[ -f "$CHECKOUT/metadata.json" && -f "$CHECKOUT/install.sh" ]] \
    || die "$CHECKOUT is not a Pear Up checkout"
: "${USER:=$(id -un)}"
for tool in podman dconf gsettings rsync python3; do
    command -v "$tool" >/dev/null || die "needs $tool"
done

# rev-parse only reads; `git status` would rewrite another agent's index.
BRANCH="$(git -C "$CHECKOUT" rev-parse --abbrev-ref HEAD 2>/dev/null || basename "$CHECKOUT")"
BRANCH_SAFE="${BRANCH//\//-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$(realpath -m "${2:-$CACHE/out/$BRANCH_SAFE-$STAMP}")"
WORK="$CACHE/work/$BRANCH_SAFE-$STAMP-$$"
NAME="pear-up-preview-$$"
H="$WORK/host"
mkdir -p "$OUT" "$H"
START=$SECONDS

# shellcheck disable=SC2329  # runs from the trap
cleanup() {
    if [[ "${PREVIEW_KEEP:-0}" != "1" ]]; then
        podman rm -f -t 2 "$NAME" >/dev/null 2>&1 || true
    else
        echo "container kept: podman exec -it $NAME bash   (podman rm -f $NAME when done)"
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- the host
# Where a desktop keeps things, in the order GNOME looks.
USER_DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
SYSTEM_DATA=()
IFS=: read -ra SYSTEM_DATA <<<"${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"

# The value of a string setting, without the quotes gsettings prints.
setting() { gsettings get "$1" "$2" | tr -d "'"; }

# A string field of a metadata.json: json_field uuid metadata.json
json_field() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$2" | head -1
}

stage_settings() {
    mkdir -p "$H/dconf"
    local path file
    for path in "${DCONF_PATHS[@]}"; do
        file="$H/dconf/$(echo "${path#/}" | sed 's#/$##' | tr / .).ini"
        dconf dump "$path" | python3 "$HERE/dconf-filter.py" >"$file"
    done
    # Bazzite's, Fedora's or Ubuntu's own defaults (they set the dark scheme,
    # panel blur and so on, which the user's dconf alone does not show).
    mkdir -p "$H/schema-overrides"
    cp /usr/share/glib-2.0/schemas/*.override "$H/schema-overrides/" 2>/dev/null || true
    [[ -f "$HOME/.config/gtk-3.0/gtk.css" ]] && cp "$HOME/.config/gtk-3.0/gtk.css" "$H/gtk-3.0.css"
    [[ -f "$HOME/.config/gtk-4.0/gtk.css" ]] && cp "$HOME/.config/gtk-4.0/gtk.css" "$H/gtk-4.0.css"
    return 0
}

is_skipped() {
    local uuid
    for uuid in "${SKIP_EXTS[@]}"; do [[ "$uuid" == "$1" ]] && return 0; done
    return 1
}

# The enabled extensions that exist here, in the order the desktop enables them
# (which decides who claims what in the bar). Pear Up itself is the checkout's,
# whatever is installed on this machine, and is enabled even if it is not.
stage_extensions() {
    mkdir -p "$H/extensions/user" "$H/extensions/system" "$H/schemas"
    local pear_uuid enabled uuid where src schema d pear_listed=0
    pear_uuid="$(json_field uuid "$CHECKOUT/metadata.json")"
    if [[ -n "${PREVIEW_EXTENSIONS:-}" ]]; then
        enabled="$PREVIEW_EXTENSIONS"
    else
        enabled="$(gsettings get org.gnome.shell enabled-extensions | grep -o "'[^']*'" | tr -d "'" || true)"
    fi
    : >"$H/extensions.txt"
    for uuid in $enabled; do
        if [[ "$uuid" == "$pear_uuid" ]]; then
            echo "$uuid" >>"$H/extensions.txt"
            pear_listed=1
            continue
        fi
        if [[ -z "${PREVIEW_EXTENSIONS:-}" ]] && is_skipped "$uuid"; then
            echo "    (left out: $uuid)"
            continue
        fi
        src="" where=""
        if [[ -d "$USER_DATA/gnome-shell/extensions/$uuid" ]]; then
            src="$USER_DATA/gnome-shell/extensions/$uuid" where=user
        else
            for d in "${SYSTEM_DATA[@]}"; do
                [[ -d "$d/gnome-shell/extensions/$uuid" ]] || continue
                src="$d/gnome-shell/extensions/$uuid" where=system
                break
            done
        fi
        if [[ -z "$src" ]]; then
            echo "    (not installed here: $uuid)"
            continue
        fi
        # -H: an extension linked in from a working copy is copied, not linked.
        cp -aH "$src" "$H/extensions/$where/"
        echo "$uuid" >>"$H/extensions.txt"
        # A packaged extension may keep its schema in the system's schema
        # directory instead of its own schemas/.
        schema="$(json_field settings-schema "$src/metadata.json")"
        if [[ -n "$schema" && ! -d "$src/schemas" ]]; then
            for d in "${SYSTEM_DATA[@]}"; do
                [[ -f "$d/glib-2.0/schemas/$schema.gschema.xml" ]] || continue
                cp "$d/glib-2.0/schemas/$schema.gschema.xml" "$H/schemas/"
                break
            done
        fi
    done
    [[ $pear_listed == 1 ]] || echo "$pear_uuid" >>"$H/extensions.txt"
    return 0
}

# --- icon and cursor themes
# GTK looks in the user's data directory, ~/.icons, then each system data
# directory. A theme in the user's own directories is mounted where the
# container's lookup finds it; a system theme goes to /host-icons, from where
# session.sh links the ones the image does not already have (Adwaita and Breeze
# it has).
ICON_SEARCH=("$USER_DATA/icons" "$HOME/.icons")
for d in "${SYSTEM_DATA[@]}" /usr/share; do ICON_SEARCH+=("$d/icons"); done
ICON_MOUNTS=()
CHAIN_DIRS=()
declare -A THEME_SEEN=() THEME_MOUNTED=()

find_theme() {
    local dir
    for dir in "${ICON_SEARCH[@]}"; do
        [[ -f "$dir/$1/index.theme" ]] && { echo "$dir/$1"; return 0; }
    done
    return 1
}

# A theme, then what it inherits, once each. hicolor is the image's own.
add_theme() {
    local name="$1" dir parent
    [[ -n "$name" && "$name" != hicolor && -z "${THEME_SEEN[$name]:-}" ]] || return 0
    THEME_SEEN[$name]=1
    dir="$(find_theme "$name")" || return 0
    CHAIN_DIRS+=("$dir")
    # Some themes quote the list: Inherits="hicolor"
    for parent in $(sed -n 's/^Inherits=//p' "$dir/index.theme" | head -1 | tr -d '"\r' | tr ',' ' '); do
        add_theme "$parent"
    done
}

mount_theme() {
    local dir="$1" name
    name="$(basename "$dir")"
    [[ -z "${THEME_MOUNTED[$name]:-}" ]] || return 0
    THEME_MOUNTED[$name]=1
    case "$dir" in
        "$USER_DATA/icons"/*|"$HOME/.icons"/*)
            ICON_MOUNTS+=(-v "$dir:/home/$USER/.local/share/icons/$name:ro") ;;
        *)  ICON_MOUNTS+=(-v "$dir:/host-icons/$name:ro") ;;
    esac
}

stage_icon_themes() {
    local dir theme
    ICON_THEME="$(setting org.gnome.desktop.interface icon-theme)"
    ICON_THEME_DIR="$(find_theme "$ICON_THEME" || true)"
    add_theme "$ICON_THEME"
    add_theme "$(setting org.gnome.desktop.interface cursor-theme)"
    for dir in "${CHAIN_DIRS[@]}"; do mount_theme "$dir"; done
    # Everything else the user installed themselves, and their hicolor, which
    # holds the icons apps put there. Themes link into each other (MacTahoe-dark
    # is half symlinks into ../MacTahoe), and the preferences list what is
    # installed, so the rest of them go in as well.
    for dir in "$USER_DATA/icons" "$HOME/.icons"; do
        for theme in "$dir"/*/; do
            [[ -d "$theme" ]] || continue
            theme="${theme%/}"
            if [[ -f "$theme/index.theme" || "$(basename "$theme")" == hicolor ]]; then
                mount_theme "$theme"
            fi
        done
    done
    return 0
}

# The wallpaper files the background settings point at, copied: a path from
# this machine means nothing in the container. Dynamic wallpapers (.xml) point at
# further files and are not followed.
stage_wallpaper() {
    local variant key uri file
    for variant in light:picture-uri dark:picture-uri-dark; do
        key="${variant#*:}"
        uri="$(setting org.gnome.desktop.background "$key")"
        file="${uri#file://}"
        file="$(printf '%b' "${file//%/\\x}")"    # %20 and the like
        if [[ "$uri" == file://* && -f "$file" && "$file" != *.xml ]]; then
            mkdir -p "$H/wallpaper/${variant%%:*}"
            cp -L "$file" "$H/wallpaper/${variant%%:*}/"
        else
            echo "    (no wallpaper copied for $key: ${uri:-unset})"
        fi
    done
}

# Is there art for this icon name in the theme in use? -L: themes are partly
# symlinks to each other.
in_theme() {
    [[ -n "$ICON_THEME_DIR" && -n "$(find -L "$ICON_THEME_DIR" -name "$1.*" -print -quit 2>/dev/null)" ]]
}

# Stand-ins for the dock favourites: the name and icon of this machine's own
# entry, Exec=true, so the dock looks the same and launches nothing.
stage_favourites() {
    mkdir -p "$H/apps" "$H/app-icons"
    local app_dirs=() extra_icon_dirs=() d id dir entry name icon found
    app_dirs+=("$USER_DATA/applications")
    for d in "${SYSTEM_DATA[@]}"; do
        app_dirs+=("$d/applications")
        extra_icon_dirs+=("$d/icons/hicolor" "$d/pixmaps")
    done

    for id in $(setting org.gnome.shell favorite-apps | tr -d '[],'); do
        [[ "$id" == *.desktop ]] || continue
        entry=""
        for dir in "${app_dirs[@]}"; do
            [[ -f "$dir/$id" ]] && { entry="$dir/$id"; break; }
        done
        [[ -n "$entry" ]] || continue
        name="$(sed -n '/^\[Desktop Entry\]/,/^\[/{s/^Name=//p}' "$entry" | head -1)"
        icon="$(sed -n '/^\[Desktop Entry\]/,/^\[/{s/^Icon=//p}' "$entry" | head -1)"
        if [[ "$icon" == /* ]]; then
            if [[ -f "$icon" ]]; then
                cp "$icon" "$H/app-icons/${id%.desktop}.${icon##*.}"
                icon="/host/app-icons/${id%.desktop}.${icon##*.}"
            fi
        elif [[ -n "$icon" ]] && ! in_theme "$icon"; then
            # Not in the theme, so the container would have to look in hicolor
            # for it, and its hicolor is not this machine's: copy the file.
            found="$(find "${extra_icon_dirs[@]}" \( -name "$icon.svg" -o -name "$icon.png" \) 2>/dev/null \
                     | grep -E 'scalable|512|256|128' | head -1 || true)"
            [[ -z "$found" ]] && found="$(find "${extra_icon_dirs[@]}" \( -name "$icon.svg" -o -name "$icon.png" \) 2>/dev/null | head -1 || true)"
            if [[ -n "$found" ]]; then
                cp "$found" "$H/app-icons/${id%.desktop}.${found##*.}"
                icon="/host/app-icons/${id%.desktop}.${found##*.}"
            fi
        fi
        printf '[Desktop Entry]\nType=Application\nName=%s\nExec=true\nIcon=%s\n' \
            "$name" "$icon" >"$H/apps/$id"
    done

    # The fake tray item wants an icon the theme has art for.
    TRAY_ICON="${PREVIEW_TRAY_ICON:-}"
    if [[ -z "$TRAY_ICON" ]]; then
        if in_theme steam; then TRAY_ICON=steam; else TRAY_ICON=applications-system; fi
    fi
    return 0
}

# The battery as it is right now, for the mock UPower. A machine without one
# gets no mock, and so no battery in the bar.
stage_battery() {
    local bat pct st ic
    if bat="$(upower -i /org/freedesktop/UPower/devices/DisplayDevice 2>/dev/null)" \
            && grep -q 'present:.*yes' <<<"$bat"; then
        pct="$(sed -n 's/^ *percentage: *\([0-9.]*\)%.*/\1/p' <<<"$bat" | head -1)"
        st="$(sed -n 's/^ *state: *//p' <<<"$bat" | head -1)"
        ic="$(sed -n "s/^ *icon-name: *'\(.*\)'/\1/p" <<<"$bat" | head -1)"
        case "$st" in charging) st=1;; discharging) st=2;; empty) st=3;;
                      fully-charged) st=4;; pending-charge) st=5;; *) st=6;; esac
        printf 'BAT_PRESENT=true\nBAT_PERCENT=%s\nBAT_STATE=%s\nBAT_ICON=%s\n' \
            "${pct:-80}" "$st" "${ic:-battery-good-symbolic}" >"$H/battery.env"
    else
        echo 'BAT_PRESENT=false' >"$H/battery.env"
    fi
}

# The primary monitor: what mutter says, unless --size/--scale say otherwise.
stage_display() {
    local detected="" size="" scale=""
    detected="$(python3 "$HERE/display-info.py" 2>/dev/null)" || detected=""
    read -r size scale LAYOUT <<<"$detected" || true
    SOURCE="read from the primary monitor"
    if [[ -z "$size" ]]; then
        size=$DEFAULT_SIZE scale=$DEFAULT_SCALE
        SOURCE="the default, as there is no session to ask"
    fi
    LAYOUT="${LAYOUT:-logical}"
    SIZE="${OPT_SIZE:-$size}" SCALE="${OPT_SCALE:-$scale}"
    if [[ -n "$OPT_SIZE" && -n "$OPT_SCALE" ]]; then
        SOURCE="from --size and --scale"
    elif [[ -n "$OPT_SIZE$OPT_SCALE" ]]; then
        SOURCE="${OPT_SIZE:+--size}${OPT_SCALE:+--scale} given, the other $SOURCE"
    fi
}

# ---------------------------------------------------------------- go
echo "==> $BRANCH  ($CHECKOUT)"
echo "    snapshot -> $WORK/src"
rsync -a --exclude .git --exclude node_modules --exclude dist \
    --exclude 'tests/integration/artifacts' "$CHECKOUT/" "$WORK/src/"

echo "==> reading this machine's setup (read-only)"
echo "    this desktop: $(gnome-shell --version 2>/dev/null || echo 'no GNOME Shell'); the container: Fedora 44's GNOME Shell 50"
stage_settings
stage_extensions
stage_icon_themes
stage_wallpaper
stage_favourites
stage_battery
stage_display
# Everything staged is read by a different uid in the container.
chmod -R a+rX "$H"
echo "    extensions: $(paste -sd' ' "$H/extensions.txt")"
echo "    icon theme: $ICON_THEME"
echo "    monitor: $SIZE at scale $SCALE, $LAYOUT layout ($SOURCE)"

echo "==> image $IMAGE"
podman build -q -t "$IMAGE" -f "$HERE/Containerfile" "$HERE" >"$CACHE/build.log" 2>&1 \
    || { tail -20 "$CACHE/build.log"; die "image build failed (log: $CACHE/build.log)"; }

# gnome-rounded-blur (Blur-1.0 typelib + libblur-effect), where a desktop has
# it: Blur my Shell uses it to round its blur under menus and banners. Stock
# Fedora in the image lacks it, so without these mounts every menu shows a square
# dark blur behind it.
BLUR_MOUNTS=()
for libdir in /usr/lib64 /usr/lib /usr/lib/x86_64-linux-gnu; do
    [[ -e "$libdir/girepository-1.0/Blur-1.0.typelib" ]] || continue
    for f in "$libdir/girepository-1.0/Blur-1.0.typelib" "$libdir"/libblur-effect-1.0.so*; do
        [[ -e "$f" ]] || continue
        target="/usr/lib64/${f#"$libdir"/}"
        BLUR_MOUNTS+=(-v "$f:$target:ro")
    done
    break
done

DEVICES=()
[[ -e /dev/dri ]] && DEVICES+=(--device /dev/dri)

echo "==> booting the container"
# Privileged for logind, as in Pear Up's integration harness. label=disable
# instead of :Z, so no host file gets relabelled.
podman run -d --name "$NAME" \
    --systemd=always --privileged --security-opt label=disable --tz=local \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
    "${DEVICES[@]}" \
    -v "$WORK/src:/src:ro" \
    -v "$H:/host:ro" \
    -v "$HERE:/preview:ro" \
    -v "$OUT:/out" \
    "${ICON_MOUNTS[@]}" \
    "${BLUR_MOUNTS[@]}" \
    "$IMAGE" >/dev/null

state=""
for _ in $(seq 1 60); do
    state="$(podman exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
    [[ "$state" == running || "$state" == degraded ]] && break
    sleep 1
done
echo "    systemd: ${state:-unknown}"

ENV=(-e "PREVIEW_USER=$USER" -e "PREVIEW_USER_NAME=$(getent passwd "$USER" | cut -d: -f5)"
     -e "PREVIEW_SIZE=$SIZE" -e "PREVIEW_SCALE=$SCALE" -e "PREVIEW_LAYOUT=$LAYOUT"
     -e "PREVIEW_SHOTS=${PREVIEW_SHOTS:-}"
     -e "PREVIEW_FRONT_APP=${PREVIEW_FRONT_APP:-org.gnome.Nautilus.desktop}"
     -e "PREVIEW_TRAY_ICON=$TRAY_ICON"
     -e "PREVIEW_HOLD=${PREVIEW_HOLD:-0}")

echo "==> shooting"
if [[ "${PREVIEW_HOLD:-0}" == "1" ]]; then
    podman exec -d "${ENV[@]}" "$NAME" bash /preview/container/session.sh
    echo "    session left running in $NAME; pictures land in /tmp/preview-out inside it."
    echo "    poke: podman exec -it $NAME runuser -u $USER -- env DBUS_SESSION_BUS_ADDRESS=\$(cat /tmp/preview-bus) bash"
    echo "    done: podman rm -f $NAME; rm -rf $WORK"
    trap - EXIT
    exit 0
fi
set +e
timeout 900 podman exec "${ENV[@]}" "$NAME" bash /preview/container/session.sh
status=$?
set -e

echo
echo "==> $BRANCH: $(( SECONDS - START ))s, logs in $OUT/logs"
if [[ -f "$OUT/shots.txt" ]]; then
    sed "s#^#$OUT/#" "$OUT/shots.txt"
fi
exit $status

#!/usr/bin/env bash
# As the session user: Pear Up from the snapshot via its own install.sh (which
# compiles its schemas), the preview hook, and the look-and-feel files. Icon
# themes are already mounted read-only.
set -uo pipefail
LOGS="$PREVIEW_OUT/logs"

EXT="$HOME/.local/share/gnome-shell/extensions"

if ! (cd /tmp && bash /src/install.sh) >"$LOGS/install.log" 2>&1; then
    echo "FAIL: Pear Up's install.sh failed"
    tail -20 "$LOGS/install.log"
    exit 1
fi
cp -r /preview/container/hook "$EXT/pear-up-preview-hook@localhost"
for ext in "$EXT"/*@* /usr/share/gnome-shell/extensions/*@*; do
    [[ -e "$ext" ]] && echo "   ${ext##*/}"
done

mkdir -p "$HOME/.config/gtk-3.0" "$HOME/.config/gtk-4.0"
[[ -f /host/gtk-3.0.css ]] && cp /host/gtk-3.0.css "$HOME/.config/gtk-3.0/gtk.css"
[[ -f /host/gtk-4.0.css ]] && cp /host/gtk-4.0.css "$HOME/.config/gtk-4.0/gtk.css"
# The virtual monitor, set up like the host's primary one.
sed -e "s/@WIDTH@/${PREVIEW_SIZE%x*}/" -e "s/@HEIGHT@/${PREVIEW_SIZE#*x}/" \
    -e "s/@SCALE@/$PREVIEW_SCALE/" -e "s/@LAYOUT@/$PREVIEW_LAYOUT/" \
    /preview/container/monitors.xml.in >"$HOME/.config/monitors.xml"
mkdir -p "$HOME"/{Desktop,Documents,Downloads,Music,Pictures,Videos,Public,Templates}

# Stand-ins for the host's dock favourites, unless the image has the real app.
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
for entry in /host/apps/*.desktop; do
    [[ -e "$entry" ]] || continue
    id="$(basename "$entry")"
    if [[ -e "/usr/share/applications/$id" ]]; then
        echo "   real     $id"
    else
        cp "$entry" "$APPS/$id"
        echo "   stand-in $id"
    fi
done
cat >"$APPS/io.github.maddinek.PearUpTestWindow.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Pear Up Test Window
Exec=gjs -m /preview/container/preview-window.js
Icon=applications-system
EOF
update-desktop-database "$APPS" 2>/dev/null || true
exit 0

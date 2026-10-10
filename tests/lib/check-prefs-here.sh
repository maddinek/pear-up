#!/usr/bin/env bash
# Build every preferences page against the GTK and libadwaita *on this machine*.
#
# Meant to be run inside a Fedora container of the right vintage — either one
# started by tests/run-prefs-smoke.sh, or the job container in CI.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORK="${WORK_DIR:-/tmp/ext}"

dnf install -q -y gjs gtk4 libadwaita glib2 gsettings-desktop-schemas \
    gnome-shell xorg-x11-server-Xvfb >/dev/null 2>&1

echo "  libadwaita: $(rpm -q --qf '%{VERSION}' libadwaita)"

# A writable copy: the schemas have to be compiled, and the base-class import
# swapped for the stub.
rm -rf "$WORK"
cp -r "$SRC" "$WORK"
glib-compile-schemas "$WORK/schemas"

# The real ExtensionPreferences lives in the Extensions app bundle and drags in
# its D-Bus service and the Shew typelib, neither of which is here. See
# tests/prefs-stub.js.
sed -i "s|resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js|file://$WORK/tests/prefs-stub.js|" \
    "$WORK/prefs.js"

# Writes go nowhere: a smoke test must not depend on, or leave behind, a dconf
# database. And anything GTK considers a programming error fails the run.
export GSETTINGS_BACKEND=memory
export G_DEBUG=fatal-criticals

# The Windows page edits gtk.css in the user's config directory, so that
# directory is one of ours: made here, named so the test can tell it from
# anyone's real one, and said to the test in PREFS_SMOKE_CONFIG. The test writes
# there only when that is where GLib says the user's config directory is, and
# empties it between cases.
# xvfb-run's default screen is 640x480, and a window cannot be opened wider than
# the screen it is on: the page labels in the switcher are checked at the width
# the window asks for, so the screen has to be larger than that.
XVFB=(xvfb-run -a -s "-screen 0 1280x1024x24")

export XDG_CONFIG_HOME="$WORK/pear-up-smoke-config"
export PREFS_SMOKE_CONFIG="$XDG_CONFIG_HOME"
mkdir -p "$XDG_CONFIG_HOME"

echo "  without Dash to Dock:"
"${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

# Then again with this release's packaged Dash to Dock, whose schema turns the
# Dock page from a notice into rows that write its keys. Its version differs
# per release, which is the point: the rows have to cope with what is there.
dnf install -q -y gnome-shell-extension-dash-to-dock >/dev/null 2>&1
# Its warnings are about other packages' schema paths, and noise here.
glib-compile-schemas /usr/share/glib-2.0/schemas 2>/dev/null
echo "  with Dash to Dock $(rpm -q --qf '%{VERSION}' gnome-shell-extension-dash-to-dock):"
PREFS_SMOKE_DOCK=1 "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

# And once more with icon and cursor themes dropped into the XDG directories
# the Appearance page scans: the user's data directory, ~/.icons and a system
# data directory, as this container has them. The fixtures are as small as a
# theme can be and cover what the scan has to tell apart — icon themes, cursor
# themes, a theme that is both, one that hides itself, the fallbacks that are
# never offered, a name found in two places, and one reached through a symlink.
# tests/prefs-smoke.js knows these names.
THEMES="$WORK/theme-fixtures"
rm -rf "$THEMES"

icon_theme() {      # <icons dir> <name> [extra key in [Icon Theme]]
    local dir="$1/$2"
    mkdir -p "$dir/16x16/apps"
    printf '[Icon Theme]\nName=%s\nDirectories=16x16/apps\n%s\n\n[16x16/apps]\nSize=16\nType=Fixed\n' \
        "$2" "${3:-}" > "$dir/index.theme"
}
cursor_theme() {    # <icons dir> <name>: the cursors directory is all that makes one
    mkdir -p "$1/$2/cursors"
    : > "$1/$2/cursors/left_ptr"
}
cursor_index() {    # <icons dir> <name>: the index.theme a cursor-only theme has
    printf '[Icon Theme]\nName=%s\nInherits=hicolor\n' "$2" > "$1/$2/index.theme"
}

user_icons="$THEMES/data/icons"
home_icons="$THEMES/home/.icons"
system_icons="$THEMES/share/icons"

icon_theme "$user_icons" MacTahoe-Test
icon_theme "$user_icons" Zeta-Icons
icon_theme "$user_icons" Hidden-Icons 'Hidden=true'
cursor_theme "$user_icons" macOS-Test
cursor_index "$user_icons" macOS-Test
cursor_theme "$user_icons" Plain-Cursors
icon_theme "$user_icons" hicolor
cursor_theme "$user_icons" hicolor
icon_theme "$user_icons" locolor
cursor_theme "$user_icons" default
icon_theme "$THEMES/elsewhere" Linked-Icons
ln -s "$THEMES/elsewhere/Linked-Icons" "$user_icons/Linked-Icons"

icon_theme "$home_icons" WhiteSur-Test
cursor_theme "$home_icons" WhiteSur-Test
icon_theme "$home_icons" Zeta-Icons

icon_theme "$system_icons" Alpha-Icons
cursor_theme "$system_icons" Alpha-Cursors
icon_theme "$system_icons" MacTahoe-Test

# The same run has Inter installed, the font the Appearance page falls back on
# where Adwaita Sans is not (it comes with GNOME 48). Without it the releases
# before that would never see Pango find a font at all, only not find one.
dnf install -q -y rsms-inter-fonts >/dev/null 2>&1 || echo "  (Inter is not installable here)"

echo "  with Inter and icon and cursor themes installed:"
HOME="$THEMES/home" XDG_DATA_HOME="$THEMES/data" \
    XDG_DATA_DIRS="$THEMES/share:/usr/local/share:/usr/share" \
    PREFS_SMOKE_THEMES="$THEMES" \
    "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

# And once more with the two extensions the Windows page drives installed, where
# GNOME looks for them: Rounded Window Corners Reborn in the user's data
# directory and Magic Lamp in a system one, as Bazzite ships it. Real ones would
# need the shell they run in; the page only needs to find them, read the one
# key of the first that it writes, and ask the shell to switch them, which the
# smoke test stands in for. So these are the metadata and, for the first, the
# schema of that key, with the types and the shape of the default the real
# extension has.
HELPERS="$WORK/extension-fixtures"
rm -rf "$HELPERS"

rounded="$HELPERS/data/gnome-shell/extensions/rounded-window-corners@fxgn"
mkdir -p "$rounded/schemas"
cat > "$rounded/metadata.json" <<'JSON'
{
  "uuid": "rounded-window-corners@fxgn",
  "name": "Rounded Window Corners Reborn (fixture)",
  "description": "Stands in for the extension in tests/lib/check-prefs-here.sh",
  "settings-schema": "org.gnome.shell.extensions.rounded-window-corners-reborn",
  "shell-version": ["45", "46", "47", "48", "49", "50"],
  "version": 25
}
JSON
cat > "$rounded/schemas/org.gnome.shell.extensions.rounded-window-corners-reborn.gschema.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.rounded-window-corners-reborn"
          path="/org/gnome/shell/extensions/rounded-window-corners-reborn/">
    <key name="global-rounded-corner-settings" type="a{sv}">
      <summary>Global rounded corners settings for all windows</summary>
      <default>
        {
          'padding': &lt;{
            'left': &lt;uint32 1&gt;,
            'right': &lt;uint32 1&gt;,
            'top': &lt;uint32 1&gt;,
            'bottom': &lt;uint32 1&gt;
          }&gt;,
          'keepRoundedCorners': &lt;{
            'maximized': &lt;false&gt;,
            'fullscreen': &lt;false&gt;
          }&gt;,
          'borderRadius': &lt;uint32 15&gt;,
          'smoothing': &lt;0&gt;,
          'borderColor': &lt;[0.5, 0.5, 0.5, 1.0]&gt;,
          'enabled': &lt;true&gt;
        }
      </default>
    </key>
  </schema>
</schemalist>
XML
glib-compile-schemas "$rounded/schemas"

lamp="$HELPERS/share/gnome-shell/extensions/compiz-alike-magic-lamp-effect@hermes83.github.com"
mkdir -p "$lamp"
cat > "$lamp/metadata.json" <<'JSON'
{
  "uuid": "compiz-alike-magic-lamp-effect@hermes83.github.com",
  "name": "Compiz alike magic lamp effect (fixture)",
  "description": "Stands in for the extension in tests/lib/check-prefs-here.sh",
  "shell-version": ["45", "46", "47", "48", "49", "50"],
  "version": 25
}
JSON

echo "  with Rounded Window Corners Reborn and Magic Lamp installed:"
XDG_DATA_HOME="$HELPERS/data" \
    XDG_DATA_DIRS="$HELPERS/share:/usr/local/share:/usr/share" \
    PREFS_SMOKE_HELPERS="$HELPERS" \
    "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

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
# The shell's config module, the same way; tests/config-stub.js reports the
# version of the gnome-shell this container has.
sed -i "s|resource:///org/gnome/Shell/Extensions/js/misc/config.js|file://$WORK/tests/config-stub.js|" \
    "$WORK/prefs.js"
PREFS_SMOKE_SHELL_VERSION="$(rpm -q --qf '%{VERSION}' gnome-shell)"
export PREFS_SMOKE_SHELL_VERSION
echo "  gnome-shell: $PREFS_SMOKE_SHELL_VERSION, libinput: $(rpm -q --qf '%{VERSION}' libinput 2>/dev/null || echo none)"

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

# And with Blur my Shell, which the Dock page's Glass group drives. Bazzite ships
# it in a system directory, as here. The schemas are those of the three of its
# components that matter to the test, as version 74 has them: the dock one the
# group writes, in full, and the panel and popup ones, which it must never write,
# with a few of their keys. The real file also holds the other components and
# the pipelines the dock's blur draws from; the group reads none of those.
BLUR="$WORK/blur-fixtures"
rm -rf "$BLUR"

blur_ext="$BLUR/share/gnome-shell/extensions/blur-my-shell@aunetx"
mkdir -p "$blur_ext/schemas"
cat > "$blur_ext/metadata.json" <<'JSON'
{
  "uuid": "blur-my-shell@aunetx",
  "name": "Blur my Shell (fixture)",
  "description": "Stands in for the extension in tests/lib/check-prefs-here.sh",
  "settings-schema": "org.gnome.shell.extensions.blur-my-shell",
  "shell-version": ["46", "47", "48", "49", "50"],
  "version": 74
}
JSON
cat > "$blur_ext/schemas/org.gnome.shell.extensions.blur-my-shell.gschema.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
    <schema id="org.gnome.shell.extensions.blur-my-shell.dash-to-dock"
        path="/org/gnome/shell/extensions/blur-my-shell/dash-to-dock/">
        <key type="b" name="blur">
            <default>true</default>
            <summary>Boolean, whether to blur activate the blur for this component or not</summary>
        </key>
        <key type="s" name="pipeline">
            <default>"pipeline_default_rounded"</default>
            <summary>String, the name of the pipeline to use. It must exist, else "pipeline_default" will be used</summary>
        </key>
        <key type="b" name="customize">
            <default>false</default>
            <summary>Boolean, whether to customize the blur effect sigma/brightness or use general values</summary>
        </key>
        <key type="i" name="sigma">
            <default>30</default>
            <summary>Gaussian sigma to use for the blur effect</summary>
        </key>
        <key type="d" name="brightness">
            <default>0.6</default>
            <summary>Brightness to use for the blur effect</summary>
        </key>
        <key type="(dddd)" name="color">
            <default>(0.,0.,0.,0.)</default>
            <summary>Color to mix with the blur effect</summary>
        </key>
        <key type="d" name="noise-amount">
            <default>0.</default>
            <summary>Amount of noise to add to the blur effect</summary>
        </key>
        <key type="d" name="noise-lightness">
            <default>0.</default>
            <summary>Lightness of the noise added to the blur effect</summary>
        </key>
        <key type="b" name="static-blur">
            <default>true</default>
            <summary>Boolean, whether to use static or dynamic blur for this component</summary>
        </key>
        <key type="b" name="override-background">
            <default>true</default>
            <summary>Boolean, whether to override the background or not</summary>
        </key>
        <key type="i" name="style-dash-to-dock">
            <default>0</default>
            <summary>Enum to select the style of dash to dock (0 transparent, 1 light, 2 dark)</summary>
        </key>
        <key type="b" name="unblur-in-overview">
            <default>false</default>
            <summary>Boolean, whether to disable blur from this component when opening the overview or not</summary>
        </key>
        <key type="i" name="corner-radius">
            <default>18</default>
            <summary>Radius for the corner rounding effect</summary>
        </key>
    </schema>

    <schema id="org.gnome.shell.extensions.blur-my-shell.panel"
        path="/org/gnome/shell/extensions/blur-my-shell/panel/">
        <key type="b" name="blur">
            <default>true</default>
            <summary>Boolean, whether to blur activate the blur for this component or not</summary>
        </key>
        <key type="d" name="brightness">
            <default>0.6</default>
            <summary>Brightness to use for the blur effect</summary>
        </key>
        <key type="b" name="static-blur">
            <default>true</default>
            <summary>Boolean, whether to use static or dynamic blur for this component</summary>
        </key>
    </schema>

    <schema id="org.gnome.shell.extensions.blur-my-shell.popup"
        path="/org/gnome/shell/extensions/blur-my-shell/popup/">
        <key type="b" name="blur">
            <default>true</default>
            <summary>Boolean, whether to blur popup menus, notifications, switchers, and dialogs or not</summary>
        </key>
        <key type="b" name="static-blur">
            <default>false</default>
            <summary>Boolean, whether to use a static blur on popup surfaces</summary>
        </key>
        <key type="d" name="brightness">
            <default>0.6</default>
            <summary>Brightness to use for the blur effect</summary>
        </key>
        <key type="i" name="menu-corner-radius">
            <default>20</default>
            <summary>Radius for popup menu corner rounding</summary>
        </key>
        <key type="i" name="style-popup">
            <default>3</default>
            <summary>Enum to select the style of popup surfaces (0 transparent, 1 light, 2 dark, 3 automatic)</summary>
        </key>
    </schema>
</schemalist>
XML
glib-compile-schemas "$blur_ext/schemas"

echo "  with Dash to Dock and Blur my Shell installed:"
XDG_DATA_DIRS="$BLUR/share:/usr/local/share:/usr/share" \
    PREFS_SMOKE_BLUR=full \
    "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

# Installed and unreadable: the metadata of an extension in the user's data
# directory with no schemas, as a download that is only half there, or one so
# old it has no dock component. The group has to say so, not fail.
blur_half="$BLUR/data/gnome-shell/extensions/blur-my-shell@aunetx"
mkdir -p "$blur_half"
sed 's/ (fixture)/ (fixture, without schemas)/' "$blur_ext/metadata.json" > "$blur_half/metadata.json"

echo "  with Blur my Shell installed but without its settings:"
XDG_DATA_HOME="$BLUR/data" \
    PREFS_SMOKE_BLUR=settingless \
    "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

# And with a Steam installation in the user's data directory, as the native
# client has it: the Windows page then shows Steam: Buttons on the Left, which
# patches two of its stylesheets. Two made-up ones are enough.
STEAM_DATA="$WORK/steam-fixtures/data"
rm -rf "$WORK/steam-fixtures"
mkdir -p "$STEAM_DATA/Steam/steamui/css"
{ printf '.title-area{display:flex}\n'; for i in $(seq 40); do printf '.x%s{color:red}\n' "$i"; done; } \
    > "$STEAM_DATA/Steam/steamui/css/library.css"
{ printf '._3rMEP{position:absolute}\n'; for i in $(seq 20); do printf '.y%s{color:blue}\n' "$i"; done; } \
    > "$STEAM_DATA/Steam/steamui/css/gamerecording.css"
printf 'x={TopBar:"tb",OSX:"o",WindowControls:"wc",DragArea:"d",TitleBarControls:"c",TitleBar:"t"}' \
    > "$STEAM_DATA/Steam/steamui/chunk~test.js"

echo "  with Steam installed:"
XDG_DATA_HOME="$STEAM_DATA" \
    PREFS_SMOKE_STEAM="$STEAM_DATA/Steam" \
    "${XVFB[@]}" gjs -m "$WORK/tests/prefs-smoke.js" "$WORK"

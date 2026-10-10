// Pear Up carries parts of these preferences from Global Menu for GNOME by
// ShiroOSL (https://github.com/ShiroOSL/global-menu-for-gnome),
// GPL-3.0-or-later. Heavily modified here; see the project README's Credits
// for what remains theirs and what changed.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import PangoCairo from 'gi://PangoCairo';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The dock itself is Dash to Dock; these pages only drive its settings so the
// whole macOS-style desktop can be configured from one window.
const DASH_TO_DOCK_UUID = 'dash-to-dock@micxgx.gmail.com';
const DASH_TO_DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';

// GNOME has no binding that quits an app, so Cmd+Q is one of our own.
const PEAR_UP_SCHEMA = 'org.gnome.shell.extensions.pear-up';

// Window controls live in a GNOME-wide setting, not in this extension.
const WM_PREFERENCES_SCHEMA = 'org.gnome.desktop.wm.preferences';
const INPUT_SOURCES_SCHEMA = 'org.gnome.desktop.input-sources';
const SWAP_ALT_CMD_OPTION = 'altwin:swap_alt_win';

// Fonts, accent, icons and cursor are GNOME-wide settings too, and the
// Appearance page only sets them.
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

// The shell sets the brightness itself from GNOME 49, the release in which its
// own keybindings took the brightness keys over from gnome-settings-daemon.
// Asked of those, so that the preferences know without a shell to ask.
const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';

function shellSetsBrightness() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(SHELL_KEYBINDINGS_SCHEMA, true);
    return schema?.has_key('screen-brightness-up') ?? false;
}

// Our own settings keys that remember what a switch on these pages displaced,
// so switching it off can hand the user's values back (see _getDisplacedMap).
const DISPLACED_KEYBINDINGS = 'displaced-keybindings';
const DISPLACED_SETTINGS = 'displaced-settings';

// What macOS sets its text in is not available here. GNOME's own Inter fork,
// Adwaita Sans, is the closest and ships from GNOME 48; Inter is what it was
// forked from and is what older releases can have. The first one installed
// wins. Whether one is installed is asked of Pango, not worked out from the
// GNOME version: distributions package it separately, and an older release can
// have it too.
const MACOS_TYPE_FAMILIES = ['Adwaita Sans', 'Inter'];

// The two theme pickers differ only in which key they write, which themes
// count as a theme of that kind, and what to say when no macOS-style one is
// installed. `macOS` matches by name, because that is all a theme directory
// gives away; the families are MacTahoe and WhiteSur for icons, and the
// ful1e5 macOS cursors, whose names start with macOS, besides.
const THEME_PICKERS = [
    {
        key: 'icon-theme',
        kind: 'icons',
        groupTitle: 'Icons',
        rowTitle: 'Icon Theme',
        macOS: /^(MacTahoe|WhiteSur)/i,
        missing: {
            title: 'No macOS-style icon theme installed',
            subtitle: 'Clone MacTahoe or WhiteSur and run ./install.sh: it installs into ' +
                '~/.local/share/icons and needs no root',
            links: [
                ['MacTahoe', 'https://github.com/vinceliuice/MacTahoe-icon-theme'],
                ['WhiteSur', 'https://github.com/vinceliuice/WhiteSur-icon-theme'],
            ],
        },
    },
    {
        key: 'cursor-theme',
        kind: 'cursors',
        groupTitle: 'Cursor',
        rowTitle: 'Cursor Theme',
        macOS: /^(macOS|MacTahoe|WhiteSur)/i,
        missing: {
            title: 'No macOS-style cursor theme installed',
            subtitle: 'Download macOS.tar.xz from the apple_cursor releases and unpack it into ' +
                '~/.local/share/icons: no root needed',
            links: [
                ['apple_cursor', 'https://github.com/ful1e5/apple_cursor'],
            ],
        },
    },
];

// Directories under icons/ that are not themes to pick: the fallbacks every
// theme inherits from, and the X11 name for whichever cursor is the default.
const THEMES_NEVER_OFFERED = new Set(['hicolor', 'locolor', 'default']);

// Adwaita is the stock choice and what the key holds until it is changed, but
// its icon theme marks itself Hidden, as fallbacks do. A hidden theme is
// otherwise left out, except the one in use, which has to be shown to be read.
const STOCK_THEME = 'Adwaita';

// The Windows page drives GNOME's own window settings, the user's GTK
// stylesheets and two other extensions. The extensions are not Pear Up's to
// install: their rows appear when they are there, and when they are not, a link
// says where to get them. The links are the extensions' pages on
// extensions.gnome.org, whose numbers the uuids cannot give.
const MUTTER_SCHEMA = 'org.gnome.mutter';
const SHELL_SCHEMA = 'org.gnome.shell';

const ROUNDED_CORNERS_UUID = 'rounded-window-corners@fxgn';
const ROUNDED_CORNERS_SCHEMA = 'org.gnome.shell.extensions.rounded-window-corners-reborn';
const ROUNDED_CORNERS_KEY = 'global-rounded-corner-settings';
const ROUNDED_CORNERS_URL = 'https://extensions.gnome.org/extension/7048/rounded-window-corners-reborn/';
const ROUNDED_CORNERS_RADIUS = { lower: 0, upper: 40 };

const MAGIC_LAMP_UUID = 'compiz-alike-magic-lamp-effect@hermes83.github.com';
const MAGIC_LAMP_URL = 'https://extensions.gnome.org/extension/3740/compiz-alike-magic-lamp-effect/';

// The Dock page's Glass group drives one component of Blur my Shell, the one
// that blurs Dash to Dock, and nothing else of it: its panel, overview and
// popup components are other schemas and are never written. Like the two
// extensions above it is not Pear Up's to install, so when it is absent the
// group is a link. Its number cannot be had from the uuid either.
const BLUR_MY_SHELL_UUID = 'blur-my-shell@aunetx';
const BLUR_DOCK_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.dash-to-dock';
const BLUR_MY_SHELL_URL = 'https://extensions.gnome.org/extension/3193/blur-my-shell/';

// What the Dock component calls its three looks, as `style-dash-to-dock`:
// the background it draws over the blur is nothing, white at 58% or a dark
// grey at 22%, the last two with a hairline border.
const GLASS_TINTS = [
    { title: 'Transparent', style: 0 },
    { title: 'Light', style: 1 },
    { title: 'Dark', style: 2 },
];
const GLASS_TINT_OTHER = 'Set in Blur my Shell';
const GLASS_BRIGHTNESS = 0.9;
const GLASS_BRIGHTNESS_RANGE = { lower: 50, upper: 100 };

// Smaller window buttons are CSS in the user's own gtk.css, one file per GTK
// major version, because an app reads the one for the toolkit it was built
// with: gtk-4.0 reaches libadwaita apps, gtk-3.0 reaches GTK 3 apps and the
// Electron ones that draw GTK 3 title buttons. Pear Up owns one block in each,
// between two marker lines, and nothing outside it. The numbers take libadwaita's
// 20px circle to 12px, about 40% smaller and nearer to the size macOS draws.
// `own` recognises sizing rules written by hand outside the block, which count
// as the buttons already being small.
const WINDOW_BUTTONS_BEGIN = '/* >>> pear-up window buttons >>> */';
const WINDOW_BUTTONS_END = '/* <<< pear-up window buttons <<< */';
const WINDOW_BUTTONS_NOTE = [
    '/* Written by Pear Up (Preferences, Windows, Small Window Buttons). Switching',
    '   that off removes this block; nothing outside it is ever touched. */',
];
const WINDOW_BUTTONS_CSS = [
    {
        dir: 'gtk-4.0',
        own: /windowcontrols[^{}]*\{[^}]*(?:min-width|min-height|padding|-gtk-icon-size)\s*:/,
        rules: [
            'windowcontrols > button {',
            '  min-width: 14px;',
            '  min-height: 14px;',
            '  padding: 3px;',
            '}',
            'windowcontrols > button > image {',
            '  -gtk-icon-size: 8px;',
            '  padding: 2px;',
            '}',
        ],
    },
    {
        dir: 'gtk-3.0',
        own: /titlebutton[^{}]*\{[^}]*(?:min-width|min-height|padding|margin|-gtk-icon-transform|-gtk-icon-size)\s*:/,
        rules: [
            'headerbar button.titlebutton,',
            '.titlebar button.titlebutton {',
            '  min-width: 14px;',
            '  min-height: 14px;',
            '  padding: 2px;',
            '  margin: 0 1px;',
            '}',
            'headerbar button.titlebutton image,',
            '.titlebar button.titlebutton image {',
            '  -gtk-icon-transform: scale(0.6);',
            '}',
        ],
    },
];

// A Magic Keyboard reports Cmd as Super, so binding the Super combinations
// gives the real macOS chords rather than an approximation of them. Each entry
// is added alongside GNOME's own binding instead of replacing it, so Print and
// Alt+F4 keep working and nothing has to be backed up to undo this.
const MACOS_SCREENSHOT_SHORTCUTS = [
    ['org.gnome.shell.keybindings', 'screenshot', '<Super><Shift>3', 'Whole screen, straight to a file'],
    ['org.gnome.shell.keybindings', 'show-screenshot-ui', '<Super><Shift>4', 'Pick a region, window or screen'],
    ['org.gnome.shell.keybindings', 'show-screen-recording-ui', '<Super><Shift>5', 'Screen recording'],
];

const MACOS_WINDOW_SHORTCUTS = [
    [PEAR_UP_SCHEMA, 'quit-app', '<Super>q', 'Quit the app, every window (Cmd+Q)'],
    ['org.gnome.desktop.wm.keybindings', 'close', '<Super>w', 'Close the window (Cmd+W)'],
    ['org.gnome.desktop.wm.keybindings', 'minimize', '<Super>m', 'Minimize (Cmd+M)'],
    ['org.gnome.desktop.wm.keybindings', 'toggle-fullscreen', '<Super><Control>f', 'Full screen (Ctrl+Cmd+F)'],
    ['org.gnome.shell.keybindings', 'toggle-overview', '<Control>Up', 'Overview, like Mission Control'],
    ['org.gnome.settings-daemon.plugins.media-keys', 'screensaver', '<Super><Control>q', 'Lock the screen (Ctrl+Cmd+Q)'],
];

// Dash to Dock claims Cmd+number to launch dock items, including the
// Cmd+Shift+3/4/5 that macOS uses for screenshots, and Cmd+Q to reveal the
// dock. Those grabs win over the shell's, so they have to give way. Switching a
// set back off resets them to their owner's default.
const MACOS_SCREENSHOT_CONFLICTS = [
    [DASH_TO_DOCK_SCHEMA, 'hot-keys', () => GLib.Variant.new_boolean(false),
        'Dash to Dock stops launching apps with Cmd+number'],
];

const MACOS_WINDOW_CONFLICTS = [
    [DASH_TO_DOCK_SCHEMA, 'shortcut', () => GLib.Variant.new_strv([]),
        'Dash to Dock stops revealing the dock with Cmd+Q'],
];

// Somewhere to put the dock shortcuts that Cmd+number gave up. Cmd+F1 is
// GNOME's help shortcut, so that one has to be taken over rather than shared —
// two grabs on one accelerator have no defined winner.
const DOCK_FUNCTION_KEY_SHORTCUTS = Array.from({ length: 9 }, (_, index) => [
    DASH_TO_DOCK_SCHEMA,
    `app-hotkey-${index + 1}`,
    `<Super>F${index + 1}`,
    `Dock item ${index + 1}`,
]);

const DOCK_FUNCTION_KEY_CONFLICTS = [
    ['org.gnome.settings-daemon.plugins.media-keys', 'help', () => GLib.Variant.new_strv(['']),
        "GNOME's help shortcut gives up Cmd+F1"],
];

// Schemas that live inside another extension rather than the system set.
const EXTENSION_SCHEMA_OWNERS = {
    [DASH_TO_DOCK_SCHEMA]: DASH_TO_DOCK_UUID,
    [ROUNDED_CORNERS_SCHEMA]: ROUNDED_CORNERS_UUID,
    [BLUR_DOCK_SCHEMA]: BLUR_MY_SHELL_UUID,
};

const BUTTON_LAYOUT_LEFT = 'close,minimize,maximize:appmenu';
const BUTTON_LAYOUT_RIGHT = 'appmenu:minimize,maximize,close';

const DOCK_POSITIONS = [
    ['LEFT', 'Left'],
    ['BOTTOM', 'Bottom'],
    ['RIGHT', 'Right'],
    ['TOP', 'Top'],
];

// Whatever the icon is pointed at, it falls back to GNOME's own search when
// that thing is missing, so the button is never a dead end.
const SEARCH_TARGETS = [
    ['overview', 'GNOME Search', 'The shell\u2019s own search — needs nothing installed'],
    ['search-light', 'Search Light', 'The Search Light extension, when it is installed and enabled'],
    ['command', 'Custom Command', 'A launcher of your own, such as ulauncher or rofi'],
];

// Dash to Dock spreads visibility across three booleans plus a mode enum.
// Collapse the combinations people actually want into single choices.
const DOCK_VISIBILITY = [
    {
        title: 'Always Visible',
        subtitle: 'The dock keeps its own space and windows never cover it',
        apply: dock => {
            dock.set_boolean('dock-fixed', true);
            dock.set_boolean('autohide', false);
            dock.set_boolean('intellihide', false);
        },
    },
    {
        title: 'Hide When a Window Is in the Way',
        subtitle: 'Hidden as soon as a window overlaps it',
        apply: (dock, has) => {
            dock.set_boolean('dock-fixed', false);
            dock.set_boolean('autohide', true);
            dock.set_boolean('intellihide', true);
            if (has('intellihide-mode'))
                dock.set_string('intellihide-mode', 'ALL_WINDOWS');
        },
    },
    {
        title: 'Hide Until Pointed At',
        subtitle: 'Slides out when the pointer reaches the edge',
        apply: dock => {
            dock.set_boolean('dock-fixed', false);
            dock.set_boolean('autohide', true);
            dock.set_boolean('intellihide', false);
        },
    },
];

// How Dash to Dock marks a running app. It has no style that draws nothing:
// show-running only drops unpinned running apps from the dock, and pinned ones
// keep their dots. So "None" is the single dot drawn fully transparent — the
// dot style already hides GNOME's own, and a zero border leaves nothing to see.
const RUNNING_DOT_KEYS = [
    'running-indicator-style',
    'custom-theme-customize-running-dots',
    'custom-theme-running-dots-color',
    'custom-theme-running-dots-border-width',
];
const RUNNING_DOT_INVISIBLE = 'rgba(255,255,255,0)';
const RUNNING_INDICATORS = [
    {
        title: 'One Dot, Like macOS',
        apply: dock => {
            dock.set_string('running-indicator-style', 'DOT');
            dock.set_boolean('custom-theme-customize-running-dots', true);
            dock.set_string('custom-theme-running-dots-color', '#ffffff');
            dock.set_int('custom-theme-running-dots-border-width', 0);
        },
    },
    {
        title: 'GNOME Default',
        apply: dock => {
            dock.set_string('running-indicator-style', 'DEFAULT');
            dock.set_boolean('custom-theme-customize-running-dots', false);
        },
    },
    {
        title: 'None',
        apply: dock => {
            dock.set_string('running-indicator-style', 'DOT');
            dock.set_boolean('custom-theme-customize-running-dots', true);
            dock.set_string('custom-theme-running-dots-color', RUNNING_DOT_INVISIBLE);
            dock.set_int('custom-theme-running-dots-border-width', 0);
        },
    },
];

const DISTRO_ICONS = [
    ['pear', 'Bitten Pear'],
    ['apple', 'Apple'],
    ['fedora', 'Fedora'],
    ['debian', 'Debian'],
    ['ubuntu', 'Ubuntu'],
    ['arch', 'Arch'],
    ['manjaro', 'Manjaro'],
    ['popos', 'Pop!_OS'],
    ['opensuse', 'openSUSE'],
    ['redhat', 'Red Hat'],
    ['gentoo', 'Gentoo'],
    ['freebsd', 'FreeBSD'],
    ['zorin', 'Zorin OS'],
    ['gnome', 'GNOME'],
];

export default class GlobalMenuPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildGeneralPage(settings, window));
        window.add(this._buildMenusPage(settings));
        window.add(this._buildCustomMenuPage(settings));
        window.add(this._buildDockPage(settings));
        window.add(this._buildAppearancePage());
        window.add(this._buildWindowsPage());
        window.add(this._buildKeyboardPage());
        window.add(this._buildAboutPage());

        // Wide enough for the eight page labels in the switcher along the bottom,
        // which gives each an eighth of the width and cuts "Custom Menus" to
        // "Custom Me…" at 680 in Adwaita Sans 11. 780 is where that font fits;
        // 820 leaves room for a size up. Content is clamped, so the rest is margin.
        window.set_default_size(820, 780);
    }

    // Other extensions keep their schemas inside their own directories, where
    // the default source cannot see them, so fall back to searching those.
    // Returns null when the schema is not installed at all.
    _settingsForSchema(schemaId) {
        this._schemaCache ??= new Map();
        if (this._schemaCache.has(schemaId))
            return this._schemaCache.get(schemaId);

        let settings = null;
        if (schemaId === PEAR_UP_SCHEMA) {
            settings = this.getSettings();
            this._schemaCache.set(schemaId, settings);
            return settings;
        }
        const extensionUuid = EXTENSION_SCHEMA_OWNERS[schemaId];
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
        if (schema) {
            settings = new Gio.Settings({ settings_schema: schema });
        } else if (extensionUuid) {
            const dataDirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
            for (const dataDir of dataDirs) {
                const schemaDir = GLib.build_filenamev([
                    dataDir, 'gnome-shell', 'extensions', extensionUuid, 'schemas',
                ]);
                if (!GLib.file_test(schemaDir, GLib.FileTest.IS_DIR))
                    continue;
                try {
                    const source = Gio.SettingsSchemaSource.new_from_directory(
                        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
                    const found = source.lookup(schemaId, true);
                    if (found) {
                        settings = new Gio.Settings({ settings_schema: found });
                        break;
                    }
                } catch {
                    // Unreadable or stale schema directory; try the next one.
                }
            }
        }

        this._schemaCache.set(schemaId, settings);
        return settings;
    }

    _dashToDockSettings() {
        return this._settingsForSchema(DASH_TO_DOCK_SCHEMA);
    }

    // Shown instead of the dock settings when Dash to Dock is not installed.
    // Nothing here installs anything: which dock to run, and how to get it, is
    // the user's call. It just answers the question the empty page raises.
    _buildDockMissingGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: 'Dash to Dock Is Not Installed',
            description: 'GNOME has no dock of its own — its dash only appears in the ' +
                'overview and goes away with it. Dash to Dock turns that dash into a dock ' +
                'that stays. Install it, log out and back in, and this page becomes its ' +
                'settings: edge, icon size, length, visibility and which display.',
        });
        page.add(group);

        const command = this._dockInstallCommand();
        if (command) {
            const row = new Adw.ActionRow({
                title: command,
                subtitle: 'Packaged for this system, so it updates along with it',
            });
            // Selectable so it can be copied; there is no clipboard button here
            // because a preferences window has no business writing to the
            // clipboard unasked.
            row.set_title_selectable(true);
            row.add_css_class('monospace');
            group.add(row);
        }

        const linkRow = new Adw.ActionRow({
            title: 'Or install it from the GNOME Extensions site',
            subtitle: 'extensions.gnome.org/extension/307/dash-to-dock',
        });
        linkRow.add_suffix(new Gtk.LinkButton({
            uri: 'https://extensions.gnome.org/extension/307/dash-to-dock/',
            label: 'Open',
            valign: Gtk.Align.CENTER,
        }));
        group.add(linkRow);
    }

    // The packaged route, when this system is one we can name a package for.
    // Guessing a command for a distribution we cannot identify would be worse
    // than saying nothing, so unknown systems get the link alone.
    _dockInstallCommand() {
        const ids = [
            GLib.get_os_info('ID') ?? '',
            ...(GLib.get_os_info('ID_LIKE') ?? '').split(' '),
        ];
        if (!ids.includes('fedora'))
            return null;

        // Image-based Fedora — Silverblue, Bazzite, Bluefin — layers packages
        // instead of installing them.
        return GLib.file_test('/run/ostree-booted', GLib.FileTest.EXISTS)
            ? 'rpm-ostree install gnome-shell-extension-dash-to-dock'
            : 'sudo dnf install gnome-shell-extension-dash-to-dock';
    }

    _buildDockPage(settings) {
        const page = new Adw.PreferencesPage({ title: 'Dock', icon_name: 'view-grid-symbolic' });
        const dock = this._dashToDockSettings();

        if (!dock) {
            this._buildDockMissingGroup(page);
            return page;
        }

        const has = key => this._schemaHasKey(dock, key);

        const layoutGroup = new Adw.PreferencesGroup({
            title: 'Placement',
            description: 'These settings belong to Dash to Dock and apply immediately',
        });
        page.add(layoutGroup);

        if (has('dock-position')) {
            const positionRow = new Adw.ComboRow({
                title: 'Screen Edge',
                model: Gtk.StringList.new(DOCK_POSITIONS.map(([, label]) => label)),
                selected: Math.max(0, DOCK_POSITIONS.findIndex(
                    ([value]) => value === dock.get_string('dock-position'))),
            });
            layoutGroup.add(positionRow);
            positionRow.connect('notify::selected', () => {
                dock.set_string('dock-position', DOCK_POSITIONS[positionRow.selected][0]);
            });
        }

        if (has('dash-max-icon-size')) {
            const iconSizeRow = this._addScaleRow(layoutGroup, 'Icon Size', {
                lower: 16, upper: 64, marks: [16, 24, 32, 48, 64],
                value: dock.get_int('dash-max-icon-size'),
                onChange: value => dock.set_int('dash-max-icon-size', value),
            });
            dock.connect('changed::dash-max-icon-size',
                () => iconSizeRow.setValue(dock.get_int('dash-max-icon-size')));
        }

        let spanRow = null;
        if (has('extend-height')) {
            spanRow = new Adw.SwitchRow({
                title: 'Span the Whole Edge',
                subtitle: 'Stretch the dock across the full width or height of the display',
                active: dock.get_boolean('extend-height'),
            });
            layoutGroup.add(spanRow);
            spanRow.connect('notify::active',
                () => dock.set_boolean('extend-height', spanRow.active));
        }

        // height-fraction is how much of the edge the dock may use. It only has
        // an effect while the dock is not stretched to the full edge.
        if (has('height-fraction')) {
            const lengthRow = this._addScaleRow(layoutGroup, 'Maximum Length', {
                lower: 20, upper: 100, marks: [20, 40, 60, 80, 100], unit: '%',
                value: Math.round(dock.get_double('height-fraction') * 100),
                onChange: value => dock.set_double('height-fraction', value / 100),
            });

            const syncLengthSensitivity = () =>
                lengthRow.row.set_sensitive(!spanRow?.active);
            syncLengthSensitivity();
            spanRow?.connect('notify::active', syncLengthSensitivity);
        }

        this._buildDockMagnificationGroup(page, settings);
        this._buildGlassGroup(page);

        if (has('dock-fixed') && has('autohide') && has('intellihide')) {
            const visibilityGroup = new Adw.PreferencesGroup({ title: 'Visibility' });
            page.add(visibilityGroup);

            const visibilityRow = new Adw.ComboRow({
                title: 'When to Show the Dock',
                model: Gtk.StringList.new(DOCK_VISIBILITY.map(mode => mode.title)),
                selected: this._currentDockVisibility(dock),
            });
            visibilityGroup.add(visibilityRow);

            const syncVisibilitySubtitle = () => {
                visibilityRow.set_subtitle(DOCK_VISIBILITY[visibilityRow.selected].subtitle);
            };
            syncVisibilitySubtitle();

            visibilityRow.connect('notify::selected', () => {
                DOCK_VISIBILITY[visibilityRow.selected].apply(dock, has);
                syncVisibilitySubtitle();
            });
        }

        const runningGroup = new Adw.PreferencesGroup({ title: 'Running Apps' });
        page.add(runningGroup);
        this._buildDockIndicatorRow(runningGroup, dock);
        this._buildDockFocusRow(runningGroup, settings);

        this._buildDockDisplayGroup(page, dock);

        return page;
    }

    // Touching a key a schema does not define is a fatal GSettings error, not
    // a catchable exception: it would take the whole preferences process down.
    // Dash to Dock versions differ, so ask before reading or writing.
    _schemaHasKey(settings, key) {
        return settings?.settings_schema?.has_key(key) ?? false;
    }

    // Text entries fire on every keystroke, and several of these settings make
    // the extension rebuild the whole menu bar — so writing per character makes
    // the panel flicker and closes any open menu. Wait for a pause instead.
    _onTextSettled(row, write) {
        let pendingId = 0;

        row.connect('notify::text', () => {
            if (pendingId)
                GLib.source_remove(pendingId);
            pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                pendingId = 0;
                write();
                return GLib.SOURCE_REMOVE;
            });
        });

        // A half-typed value must not be lost if the window closes first.
        row.connect('destroy', () => {
            if (pendingId) {
                GLib.source_remove(pendingId);
                pendingId = 0;
                write();
            }
        });
    }

    // Type, color, icons and cursor as macOS has them. None of it is Pear Up's
    // own: these are GNOME's settings, which every app reads, so each switch
    // remembers what it replaced and hands it back, and a row is absent on a
    // system without the setting rather than shown and broken.
    _buildAppearancePage() {
        const page = new Adw.PreferencesPage({
            title: 'Appearance',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const lookGroup = new Adw.PreferencesGroup({
            title: 'Look',
            description: 'GNOME settings that every app shares, applied at once. ' +
                'Switching one off puts back what it replaced',
        });
        const rows = [
            this._addMacOSTypeRow(lookGroup),
            this._addAccentRow(lookGroup),
        ];
        if (rows.some(row => row))
            page.add(lookGroup);

        const installed = this._installedThemes();
        for (const picker of THEME_PICKERS)
            this._addThemePicker(page, picker, installed);

        return page;
    }

    // Where icon and cursor themes are looked for: the places GTK and the
    // cursor loader look. A name found in more than one is offered once.
    _themeDirs() {
        return [...new Set([
            GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
            GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
            ...GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, 'icons'])),
        ])];
    }

    // What every theme directory says about itself, by name: whether it has
    // icons (an index.theme naming Directories, which a cursor-only theme
    // lacks), whether it hides itself, and whether it has a cursors/ directory.
    // An unreadable directory or index is skipped, so the worst a broken theme
    // can do is leave itself out.
    _installedThemes() {
        const found = new Map();
        for (const dir of this._themeDirs()) {
            for (const name of this._directoryNames(dir)) {
                const themeDir = GLib.build_filenamev([dir, name]);
                if (THEMES_NEVER_OFFERED.has(name) || !GLib.file_test(themeDir, GLib.FileTest.IS_DIR))
                    continue;

                const theme = found.get(name) ?? { icons: false, hidden: false, cursors: false };
                found.set(name, theme);

                if (!theme.icons) {
                    try {
                        const index = new GLib.KeyFile();
                        index.load_from_file(
                            GLib.build_filenamev([themeDir, 'index.theme']), GLib.KeyFileFlags.NONE);
                        // Throws for a missing group or key, which is the answer.
                        if (index.get_value('Icon Theme', 'Directories')) {
                            theme.icons = true;
                            try {
                                theme.hidden = index.get_boolean('Icon Theme', 'Hidden');
                            } catch {
                                // No Hidden key, which is the usual case.
                            }
                        }
                    } catch {
                        // No index.theme, or not one that can be read.
                    }
                }
                theme.cursors ||= GLib.file_test(
                    GLib.build_filenamev([themeDir, 'cursors']), GLib.FileTest.IS_DIR);
            }
        }
        return found;
    }

    // What a directory holds, by name. Empty when it is missing or unreadable,
    // which is the common case for most of the places themes are looked for.
    _directoryNames(dir) {
        const names = [];
        try {
            const listing = Gio.File.new_for_path(dir).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info = listing.next_file(null); info; info = listing.next_file(null))
                names.push(info.get_name());
            listing.close(null);
        } catch {
            // Whatever was read before an error stands.
        }
        return names;
    }

    // The names to offer for one picker: macOS-style first, then the rest,
    // each in alphabetical order.
    _offeredThemes(installed, picker, current) {
        const offered = [...installed]
            .filter(([name, theme]) => picker.kind === 'icons'
                ? theme.icons && (!theme.hidden || name === STOCK_THEME || name === current)
                : theme.cursors)
            .map(([name]) => name);
        const rank = name => picker.macOS.test(name) ? 0 : 1;
        const order = name => name.toLowerCase();
        return offered.sort((a, b) =>
            rank(a) - rank(b) || (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    }

    // A drop-down of the installed themes of one kind that writes one key, with
    // a pointer to where to get a macOS-style one when there is none. Absent
    // altogether where the key is.
    _addThemePicker(page, picker, installed) {
        const settings = this._settingsForSchema(INTERFACE_SCHEMA);
        if (!this._schemaHasKey(settings, picker.key) || !settings.is_writable(picker.key))
            return;

        const current = settings.get_string(picker.key);
        const offered = this._offeredThemes(installed, picker, current);

        // The theme in use is always in the list, installed or not, so the row
        // never shows a theme that is not the one in effect.
        const names = [...offered];
        const labelOf = name => name === ''
            ? 'Not set'
            : (offered.includes(name) ? name : `${name} (not installed)`);
        if (!names.includes(current))
            names.push(current);

        const group = new Adw.PreferencesGroup({
            title: picker.groupTitle,
            description: 'Installed on this system, with the macOS-style themes first',
        });
        page.add(group);

        const model = Gtk.StringList.new(names.map(labelOf));
        const row = new Adw.ComboRow({
            title: picker.rowTitle,
            model,
            selected: names.indexOf(current),
        });
        group.add(row);

        // The row is written from the key and from the user; showing the key
        // must not write it back.
        let following = false;
        row.connect('notify::selected', () => {
            const name = names[row.selected];
            if (!following && name && name !== settings.get_string(picker.key))
                settings.set_string(picker.key, name);
        });

        const watched = settings.connect(`changed::${picker.key}`, () => {
            const now = settings.get_string(picker.key);
            if (!names.includes(now)) {
                names.push(now);
                model.append(labelOf(now));
            }
            following = true;
            row.set_selected(names.indexOf(now));
            following = false;
        });
        row.connect('destroy', () => settings.disconnect(watched));

        if (!offered.some(name => picker.macOS.test(name))) {
            const missing = new Adw.ActionRow({
                title: picker.missing.title,
                subtitle: picker.missing.subtitle,
            });
            missing.set_subtitle_lines(0);
            for (const [label, uri] of picker.missing.links) {
                missing.add_suffix(new Gtk.LinkButton({ uri, label, valign: Gtk.Align.CENTER }));
            }
            group.add(missing);
        }
    }

    // Whether a font family is installed, asked of Pango in this process: the
    // same font map the window itself draws with.
    _fontFamilyInstalled(family) {
        const wanted = family.toLowerCase();
        try {
            return PangoCairo.FontMap.get_default().list_families()
                .some(found => found.get_name().toLowerCase() === wanted);
        } catch {
            // No font map to ask: report it as absent rather than guess.
            return false;
        }
    }

    _macOSTypeFamily() {
        return MACOS_TYPE_FAMILIES.find(family => this._fontFamilyInstalled(family)) ?? null;
    }

    // macOS does not hint its text — on a high-resolution screen the hinting
    // only blurs it — and sets window titles bold. 11 is GNOME's own size.
    _macOSTypeTargets(family) {
        return [
            [INTERFACE_SCHEMA, 'font-name', GLib.Variant.new_string(`${family} 11`)],
            [INTERFACE_SCHEMA, 'document-font-name', GLib.Variant.new_string(`${family} 11`)],
            [WM_PREFERENCES_SCHEMA, 'titlebar-font', GLib.Variant.new_string(`${family} Bold 11`)],
            [INTERFACE_SCHEMA, 'font-hinting', GLib.Variant.new_string('none')],
        ];
    }

    _addMacOSTypeRow(group) {
        const family = this._macOSTypeFamily();
        return this._addDisplacingSwitchRow(group, {
            title: 'macOS-Like Type',
            subtitle: `${family ?? MACOS_TYPE_FAMILIES[0]} for the interface, documents and ` +
                'window titles, with font hinting off, as on macOS',
            targets: this._macOSTypeTargets(family ?? MACOS_TYPE_FAMILIES[0]),
            unavailable: family === null
                ? `Needs ${MACOS_TYPE_FAMILIES.join(' or ')}, and this system has neither. ` +
                    'Adwaita Sans comes with GNOME 48 and later'
                : null,
        });
    }

    // GNOME has had an accent color since 47; before that there is nothing to
    // set, and the row is not shown.
    _addAccentRow(group) {
        return this._addDisplacingSwitchRow(group, {
            title: 'Blue Accent, Like macOS',
            subtitle: 'The color of selections, switches and buttons in apps that follow GNOME’s accent',
            targets: [[INTERFACE_SCHEMA, 'accent-color', GLib.Variant.new_string('blue')]],
        });
    }

    // Window chrome and behaviour as macOS has it. As on the Appearance page,
    // none of this is Pear Up's own: the button layout and automatic
    // maximizing are GNOME's settings, the corners and the genie effect belong
    // to two other extensions, and the small buttons are rules in the user's
    // own gtk.css. So each row reads the state of the thing it drives, whoever
    // put it there, and is absent or a link where that thing is not there.
    _buildWindowsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Windows',
            icon_name: 'focus-windows-symbolic',
        });

        const buttonsGroup = new Adw.PreferencesGroup({ title: 'Buttons' });
        page.add(buttonsGroup);
        this._addWindowButtonsRow(buttonsGroup);
        this._addSmallButtonsRow(buttonsGroup);

        const openingGroup = new Adw.PreferencesGroup({
            title: 'Opening',
            description: 'A GNOME setting, applied at once. Switching it off puts back what it replaced',
        });
        const maximizeRow = this._addDisplacingSwitchRow(openingGroup, {
            title: 'Don’t Maximize New Windows',
            subtitle: 'GNOME maximizes a window that opens almost as large as the screen; macOS leaves it as it is',
            targets: [[MUTTER_SCHEMA, 'auto-maximize', GLib.Variant.new_boolean(false)]],
        });
        if (maximizeRow)
            page.add(openingGroup);

        this._buildRoundedCornersGroup(page);
        this._buildGenieGroup(page);

        return page;
    }

    // Close/minimize/maximize sit on the right in GNOME and on the left in
    // macOS. The layout string puts everything before the colon on the left,
    // so read the current side from where "close" falls.
    _addWindowButtonsRow(group) {
        const wm = new Gio.Settings({ schema_id: WM_PREFERENCES_SCHEMA });

        const buttonsOnLeft = () => {
            const [left = ''] = wm.get_string('button-layout').split(':');
            return left.includes('close');
        };

        const row = new Adw.SwitchRow({
            title: 'Window Buttons on the Left',
            subtitle: 'Close, minimize and maximize in macOS order. Turning this off restores the GNOME default',
            active: buttonsOnLeft(),
        });
        group.add(row);

        row.connect('notify::active', () => {
            wm.set_string('button-layout', row.active ? BUTTON_LAYOUT_LEFT : BUTTON_LAYOUT_RIGHT);
        });
        wm.connect('changed::button-layout', () => {
            const onLeft = buttonsOnLeft();
            if (row.active !== onLeft)
                row.set_active(onLeft);
        });
    }

    // The window buttons shrunk by the two gtk.css blocks. On when every file is
    // covered, by Pear Up's block or by rules of the user's own that already do
    // the same: a switch reads on whenever the thing is in place, whoever put it
    // there. Rules of the user's own are never removed, so a switch that is on
    // for them alone has nothing to undo and is greyed out, saying where they are.
    _addSmallButtonsRow(group) {
        const subtitle = 'Close, minimize and maximize at about the size macOS draws them. Apps pick ' +
            'it up the next time they start, and so do the Electron ones that draw GTK 3 title ' +
            'buttons, such as Claude, ChatGPT and Cursor.';
        const row = new Adw.SwitchRow({ title: 'Small Window Buttons', subtitle });
        row.set_subtitle_lines(0);
        group.add(row);

        // What went wrong the last time it was switched, until the next time.
        let problem = null;
        let busy = false;
        const refresh = () => {
            if (busy)
                return;
            busy = true;
            const { on, ownOnly, ownFiles } = this._windowButtonsState();
            const notes = [];
            if (ownOnly)
                notes.push(`Already on, from rules of your own in ${ownFiles.join(' and ')}. ` +
                    'Pear Up leaves those alone: remove them there to undo it.');
            else if (ownFiles.length > 0)
                notes.push(`Your own rules for these buttons in ${ownFiles.join(' and ')} are left as they are.`);
            row.set_active(on);
            row.set_sensitive(!ownOnly);
            row.set_subtitle(problem ?? [subtitle, ...notes].join(' '));
            busy = false;
        };
        refresh();

        row.connect('notify::active', () => {
            // Showing the files is not the user switching the row. `busy` only
            // covers the call that sets it: a set made from inside this handler
            // is announced after it returns, so a row that already shows what
            // the files say is left alone as well.
            if (busy || row.active === this._windowButtonsState().on)
                return;
            problem = this._setWindowButtons(row.active);
            // Show what is on disk, not what was asked for.
            refresh();
        });
    }

    _windowButtonsFiles() {
        const configDir = GLib.get_user_config_dir();
        return WINDOW_BUTTONS_CSS.map(target => ({
            ...target,
            path: GLib.build_filenamev([configDir, target.dir, 'gtk.css']),
        }));
    }

    _tildePath(path) {
        const home = GLib.get_home_dir();
        return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    }

    // The stylesheet's text, or null when there is none. Anything that is not
    // text Pear Up can hand back unchanged — a directory, a file in another
    // encoding — is an error, because the file is written back whole. That is
    // checked rather than assumed: the text is encoded again and has to be the
    // bytes that were read. A byte order mark is held out of the decoder, which
    // does not agree with itself between engines about whether to strip one, and
    // put back in front of the text.
    _readStylesheet(path) {
        let bytes;
        try {
            [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw e;
        }

        const marked = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        let text;
        try {
            text = this._decodeUtf8(marked ? bytes.subarray(3) : bytes);
        } catch {
            throw new Error('it is not valid UTF-8');
        }
        if (marked)
            text = `\uFEFF${text}`;

        const again = new TextEncoder().encode(text);
        if (again.length !== bytes.length || again.some((byte, index) => byte !== bytes[index]))
            throw new Error('it cannot be written back exactly as it is');
        return text;
    }

    _decodeUtf8(bytes) {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }

    // Replaces the file whole, the way an editor saves: written beside it and
    // moved over it, so it is never seen half written. A symlink is followed to
    // the file it points at, as a dotfile manager's would be, and stays a link.
    // GIO will not take empty contents, which is what switching the block off
    // can leave, so an empty file is made by replacing it with nothing.
    _writeStylesheet(path, text) {
        const file = Gio.File.new_for_path(path);
        if (text === '')
            file.replace(null, false, Gio.FileCreateFlags.NONE, null).close(null);
        else
            file.replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.NONE, null);
    }

    // The first and last line of Pear Up's block, or null. A start marker with
    // no end after it is not a block, and when a start is followed by another
    // start, the nearer one is: a stray marker of the user's, or half a block,
    // must never make the content between it and a real block part of it.
    _managedBlock(lines) {
        let first = -1;
        for (const [index, line] of lines.entries()) {
            const marker = line.trim();
            if (marker === WINDOW_BUTTONS_BEGIN)
                first = index;
            else if (marker === WINDOW_BUTTONS_END && first >= 0)
                return [first, index];
        }
        return null;
    }

    // `text` with the block for `target` in it: replaced where it is, so that
    // the same call twice changes nothing, else after everything the user has,
    // set off by a blank line.
    _withManagedBlock(text, target) {
        const block = [WINDOW_BUTTONS_BEGIN, ...WINDOW_BUTTONS_NOTE, ...target.rules, WINDOW_BUTTONS_END];
        const lines = text.split('\n');
        const found = this._managedBlock(lines);
        if (found) {
            lines.splice(found[0], found[1] - found[0] + 1, ...block);
            return lines.join('\n');
        }
        if (text === '')
            return `${block.join('\n')}\n`;
        return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block.join('\n')}\n`;
    }

    // `text` without any complete block, and without the one blank line that
    // set it off. A file that ended without a newline comes back with one.
    _withoutManagedBlock(text) {
        const lines = text.split('\n');
        for (let found = this._managedBlock(lines); found; found = this._managedBlock(lines)) {
            let [first, last] = found;
            if (first > 0 && lines[first - 1].trim() === '')
                first -= 1;
            lines.splice(first, last - first + 1);
        }
        return lines.join('\n');
    }

    // Whether Pear Up's block is in `text`, and whether rules of the user's own
    // outside it already size the buttons. Comments do not count as rules.
    _stylesheetCoverage(text, target) {
        const outside = this._withoutManagedBlock(text).replace(/\/\*[\s\S]*?\*\//g, '');
        return {
            managed: this._managedBlock(text.split('\n')) !== null,
            own: target.own.test(outside),
        };
    }

    _windowButtonsState() {
        const covered = this._windowButtonsFiles().map(file => {
            try {
                return { file, ...this._stylesheetCoverage(this._readStylesheet(file.path) ?? '', file) };
            } catch {
                // Unreadable counts as not covered; switching on says why.
                return { file, managed: false, own: false };
            }
        });
        const on = covered.every(({ managed, own }) => managed || own);
        return {
            on,
            ownOnly: on && !covered.some(({ managed }) => managed),
            ownFiles: covered.filter(({ own }) => own).map(({ file }) => this._tildePath(file.path)),
        };
    }

    // Puts the block in each gtk.css that is not already covered by rules of
    // the user's own, or takes it out of each that has it. All or nothing: every
    // file is read before any is written, so one that cannot be read stops the
    // change, and if a write fails the files already written are put back. A
    // file that did not exist before goes again; the directory stays. Returns
    // what went wrong, or null.
    _setWindowButtons(on) {
        const edits = [];
        for (const file of this._windowButtonsFiles()) {
            try {
                const text = this._readStylesheet(file.path);
                const covered = this._stylesheetCoverage(text ?? '', file);
                let next = text;
                if (on && (covered.managed || !covered.own))
                    next = this._withManagedBlock(text ?? '', file);
                else if (!on && covered.managed)
                    next = this._withoutManagedBlock(text);
                if (next !== text)
                    edits.push({ file, before: text, after: next });
            } catch (e) {
                return `Could not read ${this._tildePath(file.path)}: ${e.message}`;
            }
        }

        const written = [];
        for (const edit of edits) {
            try {
                const dir = GLib.path_get_dirname(edit.file.path);
                if (GLib.mkdir_with_parents(dir, 0o755) !== 0)
                    throw new Error(`${this._tildePath(dir)} cannot be created`);
                this._writeStylesheet(edit.file.path, edit.after);
                written.push(edit);
            } catch (e) {
                for (const done of written) {
                    try {
                        if (done.before === null)
                            Gio.File.new_for_path(done.file.path).delete(null);
                        else
                            this._writeStylesheet(done.file.path, done.before);
                    } catch {
                        // Nothing more can be done for a file that will not be
                        // written back; the row will show what is on disk.
                    }
                }
                return `Could not write ${this._tildePath(edit.file.path)}: ${e.message}`;
            }
        }
        return null;
    }

    // Whether an extension is installed, in the places GNOME looks for them:
    // the user's data directory and each system one. Not whether it is on.
    _extensionInstalled(uuid) {
        return [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()].some(dir =>
            GLib.file_test(
                GLib.build_filenamev([dir, 'gnome-shell', 'extensions', uuid, 'metadata.json']),
                GLib.FileTest.EXISTS));
    }

    // Shown in place of an extension's rows when it is not installed. Nothing
    // here installs it: that is the user's call, as with Dash to Dock.
    _addExtensionMissingRow(group, { title, subtitle, url }) {
        const row = new Adw.ActionRow({ title, subtitle });
        row.set_subtitle_lines(0);
        row.add_suffix(new Gtk.LinkButton({ uri: url, label: 'Open', valign: Gtk.Align.CENTER }));
        group.add(row);
    }

    // The extension's switch on GNOME's side: in `enabled-extensions`, not in
    // `disabled-extensions` (which wins over it) and not switched off wholesale.
    // The shell's own rule, the same on every release from 45 to 50.
    _extensionEnabled(uuid) {
        const shell = this._settingsForSchema(SHELL_SCHEMA);
        if (!shell)
            return false;
        return !shell.get_boolean('disable-user-extensions') &&
            shell.get_strv('enabled-extensions').includes(uuid) &&
            !shell.get_strv('disabled-extensions').includes(uuid);
    }

    // Asks the shell to switch an extension on or off, the way the Extensions
    // app does: org.gnome.Shell.Extensions on the session bus. The shell then
    // loads or unloads it at once and keeps `enabled-extensions` and
    // `disabled-extensions` in step. Writing those keys from here would not
    // do the same: a uuid left in `disabled-extensions` beats one in
    // `enabled-extensions`, and nothing says whether the shell knows the
    // extension. Resolves to whether it did — false for one installed since
    // the session began, which Wayland cannot load until the next login.
    _callShellExtensions(method, uuid) {
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                'org.gnome.Shell.Extensions', method,
                new GLib.Variant('(s)', [uuid]), new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE, 5000, null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result).deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    // Returns what went wrong, or null.
    async _setExtensionEnabled(uuid, enabled) {
        try {
            const known = await this._callShellExtensions(
                enabled ? 'EnableExtension' : 'DisableExtension', uuid);
            return known ? null : 'GNOME has not loaded this extension yet. Log out and back in, then try again.';
        } catch (e) {
            return `Could not reach GNOME Shell: ${e.message}`;
        }
    }

    // A switch for another extension. It reads the shell's own keys, so it is
    // on whenever the extension is, whoever switched it, follows them when they
    // change elsewhere, and is written only through the shell. A call the shell
    // does not carry out puts the switch back and says why.
    _addExtensionSwitchRow(group, { uuid, title, subtitle }) {
        const shell = this._settingsForSchema(SHELL_SCHEMA);
        if (!['enabled-extensions', 'disabled-extensions', 'disable-user-extensions']
            .every(key => this._schemaHasKey(shell, key)))
            return null;

        const row = new Adw.SwitchRow({ title, subtitle });
        row.set_subtitle_lines(0);
        group.add(row);

        let problem = null;
        let busy = false;
        let pending = 0;
        let gone = false;
        // The subtitle and whether the switch can be used. Extensions switched
        // off as a whole are out of the switch's reach.
        const describe = () => {
            const allOff = shell.get_boolean('disable-user-extensions');
            row.set_sensitive(!allOff);
            row.set_subtitle(allOff
                ? 'Extensions are switched off in GNOME’s Extensions app'
                : problem ?? subtitle);
        };
        // While a call is out the switch is the user's, not the keys': they
        // change in two steps, and reading them between would flick it back.
        const refresh = () => {
            if (busy || pending > 0 || gone)
                return;
            busy = true;
            row.set_active(this._extensionEnabled(uuid));
            describe();
            busy = false;
        };
        refresh();

        row.connect('notify::active', () => {
            if (busy)
                return;
            // Every flip is a request, also one made while another is out: they
            // reach the shell in order, and the last one is what stands.
            problem = null;
            pending++;
            this._setExtensionEnabled(uuid, row.active).then(reason => {
                pending--;
                problem = reason;
                if (gone)
                    return;
                // Done: the keys will say so in a moment, not yet — read at once,
                // they still show the old state on 45 and 48, where the reply
                // is ahead of dconf's notice. Refused: they say otherwise now.
                if (reason === null)
                    describe();
                else
                    refresh();
            });
        });

        const watched = ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions']
            .map(key => shell.connect(`changed::${key}`, refresh));
        row.connect('destroy', () => {
            gone = true;
            for (const id of watched)
                shell.disconnect(id);
        });

        return row;
    }

    // The corner radius is one entry of a dictionary of mixed types the
    // extension keeps all its global settings in. It is read from the user's
    // value, else the schema's default; a missing or oddly typed entry is the
    // default's.
    _cornerRadius(settings) {
        for (const dict of [settings.get_value(ROUNDED_CORNERS_KEY), settings.get_default_value(ROUNDED_CORNERS_KEY)]) {
            for (let index = 0; index < dict.n_children(); index++) {
                const entry = dict.get_child_value(index);
                if (entry.get_child_value(0).get_string()[0] !== 'borderRadius')
                    continue;
                const radius = entry.get_child_value(1).get_variant().unpack();
                if (typeof radius === 'number')
                    return radius;
            }
        }
        return ROUNDED_CORNERS_RADIUS.lower;
    }

    // The same dictionary with the radius changed and every other entry exactly
    // as it was, type and order included: they are the extension's to write.
    // It stores the radius as an unsigned integer, so that is what goes back.
    _withCornerRadius(dict, radius) {
        const builder = new GLib.VariantBuilder(new GLib.VariantType('a{sv}'));
        const entryOf = (name, value) => GLib.Variant.new_dict_entry(
            GLib.Variant.new_string(name), GLib.Variant.new_variant(value));
        let found = false;
        for (let index = 0; index < dict.n_children(); index++) {
            const entry = dict.get_child_value(index);
            const name = entry.get_child_value(0).get_string()[0];
            if (name === 'borderRadius') {
                found = true;
                builder.add_value(entryOf(name, GLib.Variant.new_uint32(radius)));
            } else {
                builder.add_value(entry);
            }
        }
        if (!found)
            builder.add_value(entryOf('borderRadius', GLib.Variant.new_uint32(radius)));
        return builder.end();
    }

    _buildRoundedCornersGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: 'Rounded Corners',
            description: 'Rounded Window Corners Reborn does the rounding. Pear Up switches it ' +
                'on and off and sets the radius; the rest stays in its own preferences',
        });
        page.add(group);

        if (!this._extensionInstalled(ROUNDED_CORNERS_UUID)) {
            this._addExtensionMissingRow(group, {
                title: 'Rounded Window Corners Reborn is not installed',
                subtitle: 'It rounds the corners of every window, as macOS does. Install it from ' +
                    'the GNOME Extensions site and log out and back in: this page then switches ' +
                    'it on and off and sets the radius.',
                url: ROUNDED_CORNERS_URL,
            });
            return;
        }

        const switchRow = this._addExtensionSwitchRow(group, {
            uuid: ROUNDED_CORNERS_UUID,
            title: 'Rounded Corners',
            subtitle: 'Round the corners of every window',
        });

        // Its settings live in a schema inside the extension. Without the key,
        // or with one of another type, the radius is left to the extension.
        const settings = this._settingsForSchema(ROUNDED_CORNERS_SCHEMA);
        if (!switchRow || !this._schemaHasKey(settings, ROUNDED_CORNERS_KEY) ||
            settings.settings_schema.get_key(ROUNDED_CORNERS_KEY).get_value_type().dup_string() !== 'a{sv}')
            return;

        const radius = this._addScaleRow(group, 'Corner Radius', {
            lower: ROUNDED_CORNERS_RADIUS.lower, upper: ROUNDED_CORNERS_RADIUS.upper,
            marks: [0, 10, 20, 30, 40], unit: 'px',
            value: this._cornerRadius(settings),
            onChange: value => {
                if (value !== this._cornerRadius(settings)) {
                    settings.set_value(ROUNDED_CORNERS_KEY,
                        this._withCornerRadius(settings.get_value(ROUNDED_CORNERS_KEY), value));
                }
            },
        });
        const watched = settings.connect(`changed::${ROUNDED_CORNERS_KEY}`,
            () => radius.setValue(this._cornerRadius(settings)));
        radius.row.connect('destroy', () => settings.disconnect(watched));

        // Nothing to set while the extension is off, as with the other sliders.
        radius.row.set_sensitive(switchRow.active);
        switchRow.connect('notify::active', () => radius.row.set_sensitive(switchRow.active));
    }

    _buildGenieGroup(page) {
        const group = new Adw.PreferencesGroup({
            title: 'Minimizing',
            description: 'Magic Lamp does the effect. Pear Up switches it on and off',
        });
        page.add(group);

        if (!this._extensionInstalled(MAGIC_LAMP_UUID)) {
            this._addExtensionMissingRow(group, {
                title: 'Magic Lamp is not installed',
                subtitle: 'The “Compiz alike magic lamp effect” extension folds a window into the ' +
                    'dock when it is minimized, as macOS does. Install it from the GNOME ' +
                    'Extensions site and log out and back in: this page then switches it on and off.',
                url: MAGIC_LAMP_URL,
            });
            return;
        }

        this._addExtensionSwitchRow(group, {
            uuid: MAGIC_LAMP_UUID,
            title: 'Genie Effect',
            subtitle: 'Minimized windows fold into the dock like a genie lamp, as on macOS',
        });
    }

    _buildKeyboardPage() {
        const page = new Adw.PreferencesPage({
            title: 'Keyboard',
            icon_name: 'input-keyboard-symbolic',
        });

        const keyGroup = new Adw.PreferencesGroup();
        page.add(keyGroup);
        const keyNote = new Adw.ActionRow({
            title: 'Cmd means Command ⌘',
            subtitle: 'On an Apple keyboard that key already acts as Super, so these shortcuts ' +
                'are the real macOS ones. On a PC keyboard it is the Super or Windows key.',
        });
        keyNote.set_subtitle_lines(0);
        keyGroup.add(keyNote);

        const shotGroup = new Adw.PreferencesGroup({
            title: 'Screenshots',
            description: 'GNOME saves shots to ~/Pictures/Screenshots. Print keeps working either way',
        });
        page.add(shotGroup);
        this._addShortcutSetRow(shotGroup, {
            title: 'macOS Screenshot Shortcuts',
            subtitle: 'Cmd+Shift+3, Cmd+Shift+4 and Cmd+Shift+5',
            shortcuts: MACOS_SCREENSHOT_SHORTCUTS,
            conflicts: MACOS_SCREENSHOT_CONFLICTS,
        });

        const windowGroup = new Adw.PreferencesGroup({ title: 'Windows' });
        page.add(windowGroup);
        this._addShortcutSetRow(windowGroup, {
            title: 'macOS Window Shortcuts',
            subtitle: 'Quit, close, minimize, full screen, lock and the overview',
            shortcuts: MACOS_WINDOW_SHORTCUTS,
            conflicts: MACOS_WINDOW_CONFLICTS,
        });

        if (this._dashToDockSettings()) {
            const dockGroup = new Adw.PreferencesGroup({
                title: 'Dock',
                description: 'Where the dock shortcuts go once Cmd+number is used for screenshots',
            });
            page.add(dockGroup);
            this._addShortcutSetRow(dockGroup, {
                title: 'Launch Dock Items with Cmd+F1…F9',
                subtitle: 'On an Apple keyboard these are fn+F1 to fn+F9',
                shortcuts: DOCK_FUNCTION_KEY_SHORTCUTS,
                conflicts: DOCK_FUNCTION_KEY_CONFLICTS,
                rows: [{
                    title: 'Cmd+F1 … Cmd+F9',
                    subtitle: 'Activates the first nine items in the dock',
                }],
            });
        }

        const layoutGroup = new Adw.PreferencesGroup({ title: 'Layout' });
        page.add(layoutGroup);

        const input = new Gio.Settings({ schema_id: INPUT_SOURCES_SCHEMA });
        const swapRow = new Adw.SwitchRow({
            title: 'Swap Alt and Cmd',
            subtitle: 'For PC keyboards, so the key beside the space bar behaves like Cmd',
            active: input.get_strv('xkb-options').includes(SWAP_ALT_CMD_OPTION),
        });
        layoutGroup.add(swapRow);
        swapRow.connect('notify::active', () => {
            const options = input.get_strv('xkb-options');
            const has = options.includes(SWAP_ALT_CMD_OPTION);
            if (swapRow.active && !has)
                input.set_strv('xkb-options', [...options, SWAP_ALT_CMD_OPTION]);
            else if (!swapRow.active && has)
                input.set_strv('xkb-options', options.filter(o => o !== SWAP_ALT_CMD_OPTION));
        });

        const noteGroup = new Adw.PreferencesGroup();
        page.add(noteGroup);
        const note = new Adw.ActionRow({
            title: 'Shortcuts inside applications',
            subtitle: 'Cmd+C, Cmd+V and Cmd+S within an app are sent by the app itself, not the ' +
                'desktop, so they cannot be rebound from here. Matching those needs a key ' +
                'remapper such as keyd.',
        });
        note.set_subtitle_lines(0);
        noteGroup.add(note);

        return page;
    }

    // What a switch displaced has to survive the preferences process exiting:
    // keeping it only in a Map meant that closing the window between enabling a
    // shortcut set and disabling it again fell back to settings.reset(), which
    // clobbers the user's own binding with the schema default. It is stored in
    // our own settings under `storeKey` as JSON mapping '<schemaId>:<key>' to
    // the displaced GVariant serialized with variant.print(true), which
    // round-trips through GLib.Variant.parse. null stands for a key that was at
    // its default, which has to go back to the default rather than to a copy of
    // it: the user never set it.
    _getDisplacedMap(storeKey = DISPLACED_KEYBINDINGS) {
        this._displacedMaps ??= new Map();
        if (!this._displacedMaps.has(storeKey)) {
            const displaced = new Map();
            this._displacedMaps.set(storeKey, displaced);
            try {
                const parsed = JSON.parse(this.getSettings().get_string(storeKey) || '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    for (const [id, serialized] of Object.entries(parsed)) {
                        if (serialized === null) {
                            displaced.set(id, null);
                            continue;
                        }
                        if (typeof serialized !== 'string')
                            continue;
                        try {
                            // All four arguments: GJS wants the out parameter
                            // passed as well, and throws without it.
                            displaced.set(id, GLib.Variant.parse(null, serialized, null, null));
                        } catch {
                            // One bad entry must not sink the rest; skip it.
                        }
                    }
                }
            } catch {
                // Corrupt or unreadable JSON: start from an empty map rather
                // than failing to build the page.
            }
        }
        return this._displacedMaps.get(storeKey);
    }

    _saveDisplacedMap(storeKey = DISPLACED_KEYBINDINGS) {
        const displaced = this._displacedMaps?.get(storeKey);
        if (!displaced)
            return;
        const serialized = {};
        for (const [id, variant] of displaced.entries())
            serialized[id] = variant === null ? null : variant.print(true);
        try {
            this.getSettings().set_string(storeKey, JSON.stringify(serialized));
        } catch {
            // Losing durability is better than losing the page; the in-memory
            // map still covers this session.
        }
    }

    // One switch drives a whole set of accelerators. Each is appended to
    // GNOME's existing list and removed again on the way out, so a user's own
    // bindings for the same action are never disturbed. Conflicting grabs from
    // other extensions are stood down while the set is on.
    _addShortcutSetRow(group, { title, subtitle, shortcuts, conflicts = [], rows = null }) {
        // Bindings displaced by a set, kept so they can be handed back. Backed
        // by our own settings rather than memory alone, so they survive the
        // preferences process exiting between enabling a set and disabling it.
        const displacedValues = this._getDisplacedMap();

        const expander = new Adw.ExpanderRow({ title, subtitle, show_enable_switch: true });
        group.add(expander);

        // Only the entries this system can actually take: a schema may be
        // absent, or present without the key.
        const usable = ([schemaId, key]) => {
            const settings = this._settingsForSchema(schemaId);
            return settings !== null && this._schemaHasKey(settings, key);
        };
        shortcuts = shortcuts.filter(usable);
        conflicts = conflicts.filter(usable);

        const isApplied = () => shortcuts.length > 0 && shortcuts.every(([schemaId, key, accel]) =>
            this._settingsForSchema(schemaId).get_strv(key).includes(accel));

        const detailRows = rows ?? shortcuts.map(([, , accel, description]) => ({
            title: this._describeAccelerator(accel),
            subtitle: description,
        }));
        for (const row of detailRows)
            expander.add_row(new Adw.ActionRow(row));

        for (const [, , , description] of conflicts) {
            expander.add_row(new Adw.ActionRow({
                title: 'Also changes',
                subtitle: description,
            }));
        }

        // The expansion state starts as whatever is already applied. GObject
        // notifies synchronously, so that programmatic write would reach the
        // handler below as if the user had toggled it on — merely OPENING
        // Preferences re-applied the set and stood down conflicting grabs.
        // Flag the initialisation off so the handler ignores exactly that one
        // invocation; the flag is cleared before returning because notify
        // handlers run inline, never later on a queue.
        this._initialisingExpansion = true;
        expander.set_enable_expansion(isApplied());
        this._initialisingExpansion = false;

        expander.connect('notify::enable-expansion', () => {
            // Set programmatically above when mirroring reality, not by the user.
            if (this._initialisingExpansion)
                return;

            const wanted = expander.enable_expansion;

            for (const [schemaId, key, accel] of shortcuts) {
                const settings = this._settingsForSchema(schemaId);
                const current = settings.get_strv(key);
                const has = current.includes(accel);
                if (wanted && !has)
                    settings.set_strv(key, [...current, accel]);
                else if (!wanted && has)
                    settings.set_strv(key, current.filter(existing => existing !== accel));
            }

            for (const [schemaId, key, valueWhenApplied] of conflicts) {
                const settings = this._settingsForSchema(schemaId);
                if (wanted) {
                    // Keep whatever was there so switching off restores the
                    // user's own binding rather than the schema default.
                    displacedValues.set(`${schemaId}:${key}`, settings.get_value(key));
                    settings.set_value(key, valueWhenApplied());
                } else {
                    const saved = displacedValues.get(`${schemaId}:${key}`);
                    if (saved)
                        settings.set_value(key, saved);
                    else
                        settings.reset(key);
                    displacedValues.delete(`${schemaId}:${key}`);
                }
            }

            // Persist the displacement bookkeeping so it outlives this process.
            this._saveDisplacedMap();
        });
    }

    // One switch that sets some GNOME settings to given values and, switched
    // off, puts each back as it was. `targets` are [schemaId, key, GLib.Variant].
    // It reads on when every key already holds its value, whoever put it there,
    // and follows the keys when they change elsewhere. A target this system
    // cannot take — schema or key absent, a value outside the key's range, a
    // key locked down — is left out, and the row with it when none is left.
    //
    // A target may take two more entries. The value can be a function, asked
    // each time it is written, for one that depends on something that can change
    // while the window is open. And a fourth, `reads(variant)`, says whether what
    // the key holds already amounts to the look: the switch then reads on for it
    // and takes it back off, while it still writes the value it was given. That is
    // for a switch with controls of its own beside it, such as a slider for the
    // brightness the switch sets: moving the slider is no reason to switch off.
    //
    // `unavailable` is the reason the switch cannot be turned on here, when
    // there is one. The row still shows it, and still turns off while it holds.
    _addDisplacingSwitchRow(group, { title, subtitle, targets, unavailable = null }) {
        const valueOf = ([, , value]) => typeof value === 'function' ? value() : value;
        targets = targets.filter(target => {
            const [schemaId, key] = target;
            const value = valueOf(target);
            const settings = this._settingsForSchema(schemaId);
            if (!this._schemaHasKey(settings, key) || !settings.is_writable(key))
                return false;
            const schemaKey = settings.settings_schema.get_key(key);
            return value.is_of_type(schemaKey.get_value_type()) && schemaKey.range_check(value);
        });
        if (targets.length === 0)
            return null;

        const displaced = this._getDisplacedMap(DISPLACED_SETTINGS);
        const idOf = ([schemaId, key]) => `${schemaId}:${key}`;
        const isSet = target => this._settingsForSchema(target[0]).get_value(target[1]).equal(valueOf(target));
        const holds = target => {
            const reads = target[3];
            return reads
                ? reads(this._settingsForSchema(target[0]).get_value(target[1]))
                : isSet(target);
        };

        const row = new Adw.SwitchRow({ title, subtitle });
        group.add(row);

        // The row is written from two directions: the keys, and the user. Each
        // key notifies as it lands, so while this row is writing them it must
        // not read half-written state back into itself, and showing the keys
        // must not count as the user turning it on.
        let busy = false;
        const refresh = () => {
            if (busy)
                return;
            busy = true;
            const on = targets.every(holds);
            const blocked = unavailable !== null && !on;
            row.set_active(on);
            row.set_sensitive(!blocked);
            row.set_subtitle(blocked ? unavailable : subtitle);
            busy = false;
        };
        refresh();

        const switchOn = () => {
            for (const target of targets) {
                const [schemaId, key] = target;
                const settings = this._settingsForSchema(schemaId);
                // Note what is there, once. A key that already holds our value
                // and has a note keeps it: that note is the older, truer one.
                // Anything else is noted as it stands — even a match, which may
                // be a user's own choice or only the key's default. The user
                // value is null while the key is at its default, and that is
                // what has to come back.
                if (!displaced.has(idOf(target)) || !holds(target))
                    displaced.set(idOf(target), settings.get_user_value(key));
                if (!isSet(target))
                    settings.set_value(key, valueOf(target));
            }
            this._saveDisplacedMap(DISPLACED_SETTINGS);
        };

        const switchOff = () => {
            for (const target of targets) {
                const [schemaId, key] = target;
                const settings = this._settingsForSchema(schemaId);
                // A key that has changed since is the user's newer choice and
                // stays. One that still holds our value gets its note back; with
                // no note it was set outside this window, so the only thing
                // known about what came before is the default.
                if (holds(target)) {
                    const before = displaced.get(idOf(target)) ?? null;
                    if (before)
                        settings.set_value(key, before);
                    else
                        settings.reset(key);
                }
                displaced.delete(idOf(target));
            }
            this._saveDisplacedMap(DISPLACED_SETTINGS);
        };

        row.connect('notify::active', () => {
            if (busy)
                return;
            busy = true;
            try {
                // Greyed out is not enough: whatever sets `active` gets here.
                if (!row.active)
                    switchOff();
                else if (unavailable === null)
                    switchOn();
            } finally {
                busy = false;
            }
            // Show what was stored, not what was asked for.
            refresh();
        });

        const watched = targets.map(([schemaId, key]) => {
            const settings = this._settingsForSchema(schemaId);
            return [settings, settings.connect(`changed::${key}`, refresh)];
        });
        row.connect('destroy', () => {
            for (const [settings, id] of watched)
                settings.disconnect(id);
        });

        return row;
    }

    // Label accelerators the way the keys are printed on an Apple keyboard,
    // since Super is Command there and that is who these are aimed at.
    _describeAccelerator(accel) {
        return accel
            .replace(/<Super>/g, 'Cmd+')
            .replace(/<Control>|<Ctrl>/g, 'Ctrl+')
            .replace(/<Shift>/g, 'Shift+')
            .replace(/<Alt>/g, 'Option+')
            .replace(/\bUp\b/g, '↑')
            .replace(/\bDown\b/g, '↓');
    }

    _currentDockVisibility(dock) {
        if (dock.get_boolean('dock-fixed'))
            return 0;
        return dock.get_boolean('intellihide') ? 1 : 2;
    }

    // Magnification is Pear Up's own setting, unlike everything else on this
    // page: the extension draws it over the dock and never writes to Dash to
    // Dock, so there is no foreign key to keep in step or to misreport. It is
    // still offered only here, because without Dash to Dock there are no icons
    // to magnify.
    _buildDockMagnificationGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Magnification',
            description: 'Pear Up draws this on top of Dash to Dock; Dash to Dock’s own settings are not changed',
        });
        page.add(group);

        const enabledRow = new Adw.SwitchRow({
            title: 'Magnification',
            subtitle: 'Magnify icons under the pointer',
        });
        group.add(enabledRow);
        settings.bind('dock-magnification', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // The bounds are the schema's. The ends are named rather than numbered
        // because 110 and 300 mean nothing to anyone choosing how strong the
        // effect should feel; the percentage above the thumb says what it is.
        const strengthRow = this._addScaleRow(group, 'Strength', {
            lower: 110, upper: 300, pageStep: 10,
            marks: [[110, 'Weak'], [300, 'Strong']], unit: '%',
            value: settings.get_int('dock-magnification-size'),
            onChange: value => settings.set_int('dock-magnification-size', value),
        });
        strengthRow.row.set_subtitle('How large the icon under the pointer grows');
        settings.connect('changed::dock-magnification-size',
            () => strengthRow.setValue(settings.get_int('dock-magnification-size')));

        // Follow the key rather than the switch, so a change made elsewhere
        // (dconf-editor, gsettings) greys the slider the same way.
        const syncStrengthSensitivity = () =>
            strengthRow.row.set_sensitive(settings.get_boolean('dock-magnification'));
        syncStrengthSensitivity();
        settings.connect('changed::dock-magnification', syncStrengthSensitivity);
    }

    // Whether the dock is dark glass or light glass when Frosted Glass is switched
    // on: Blur my Shell's dark tint with GNOME's dark colour scheme, its light one
    // otherwise, since a dark pill on a light desktop is not the macOS look.
    _glassStyle() {
        const interfaceSettings = this._settingsForSchema(INTERFACE_SCHEMA);
        const dark = this._schemaHasKey(interfaceSettings, 'color-scheme')
            ? interfaceSettings.get_string('color-scheme') === 'prefer-dark'
            : true;
        return dark ? 2 : 1;
    }

    // Blur my Shell blurs what is behind the dock. This group sets how: the blur
    // on, a glass tint over it and how bright it is, the three things that make
    // the dock a frosted pill, in that component's own keys. The panel, overview
    // and popup components have schemas of their own and are not touched, and
    // neither is how the dock is blurred. As on the Appearance and Windows pages
    // the keys are not Pear Up's, so the switch remembers what it replaced and
    // reads on whenever the look is there, whoever made it.
    _buildGlassGroup(page) {
        const group = new Adw.PreferencesGroup({ title: 'Glass' });
        page.add(group);

        if (!this._extensionInstalled(BLUR_MY_SHELL_UUID)) {
            group.set_description('A frosted-glass dock, as macOS has it');
            this._addExtensionMissingRow(group, {
                title: 'Blur my Shell is not installed',
                subtitle: 'It blurs and tints what is behind the dock. Install it from the GNOME ' +
                    'Extensions site and log out and back in: this page then makes the dock ' +
                    'frosted glass and sets its tint and brightness.',
                url: BLUR_MY_SHELL_URL,
            });
            return;
        }

        const blur = this._settingsForSchema(BLUR_DOCK_SCHEMA);
        const has = key => this._schemaHasKey(blur, key);
        if (!has('blur') || !has('style-dash-to-dock')) {
            group.set_description('A frosted-glass dock, as macOS has it');
            this._addExtensionMissingRow(group, {
                title: 'Blur my Shell has no dock settings Pear Up knows',
                subtitle: 'Its settings for the dock were not found. Update it from the GNOME ' +
                    'Extensions site and log out and back in.',
                url: BLUR_MY_SHELL_URL,
            });
            return;
        }

        // Blur my Shell does nothing while it is switched off, which is the one
        // thing here a user would not guess. The settings are still written.
        const shell = this._settingsForSchema(SHELL_SCHEMA);
        const describe = () => {
            group.set_description(this._extensionEnabled(BLUR_MY_SHELL_UUID)
                ? 'Blur my Shell blurs what is behind the dock; its blur of the panel, overview ' +
                    'and menus is left alone. Switching Frosted Glass off puts back what it replaced'
                : 'Blur my Shell is installed but switched off, so none of this shows until it is ' +
                    'switched on in the Extensions app');
        };
        describe();
        const watchedShell = ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions']
            .filter(key => this._schemaHasKey(shell, key))
            .map(key => shell.connect(`changed::${key}`, describe));
        group.connect('destroy', () => {
            for (const id of watchedShell)
                shell.disconnect(id);
        });

        // The switch is the preset: blur on, the dark or light tint, the
        // brightness of the macOS Dock. It reads on for any glass tint and any
        // brightness the slider can set, so that moving them leaves it on; it
        // writes the preset's own values. Blur my Shell only draws the tint
        // while it overrides the dock's background, so that is part of it too.
        this._addDisplacingSwitchRow(group, {
            title: 'Frosted Glass, Like macOS',
            subtitle: 'Blurs what is behind the dock and tints it, dark or light to match the colour scheme',
            targets: [
                [BLUR_DOCK_SCHEMA, 'blur', GLib.Variant.new_boolean(true)],
                [BLUR_DOCK_SCHEMA, 'override-background', GLib.Variant.new_boolean(true)],
                [BLUR_DOCK_SCHEMA, 'style-dash-to-dock', () => GLib.Variant.new_int32(this._glassStyle()),
                    current => current.get_int32() !== 0],
                [BLUR_DOCK_SCHEMA, 'brightness', GLib.Variant.new_double(GLASS_BRIGHTNESS),
                    current => current.get_double() >= GLASS_BRIGHTNESS_RANGE.lower / 100 &&
                        current.get_double() <= GLASS_BRIGHTNESS_RANGE.upper / 100],
            ],
        });

        const tints = Gtk.StringList.new(GLASS_TINTS.map(tint => tint.title));
        const tintRow = new Adw.ComboRow({
            title: 'Tint',
            subtitle: 'Light and Dark add a hairline border',
            model: tints,
        });
        group.add(tintRow);

        // A style Blur my Shell has and this list does not gets an entry of its
        // own, as the running indicator does, rather than reading as one of ours.
        // Changing the list can move the selection, which is not the user choosing.
        let syncingTint = false;
        const syncTint = () => {
            const index = GLASS_TINTS.findIndex(tint => tint.style === blur.get_int('style-dash-to-dock'));
            syncingTint = true;
            tints.splice(GLASS_TINTS.length, tints.get_n_items() - GLASS_TINTS.length,
                index < 0 ? [GLASS_TINT_OTHER] : []);
            tintRow.set_selected(index < 0 ? GLASS_TINTS.length : index);
            syncingTint = false;
        };
        syncTint();
        tintRow.connect('notify::selected', () => {
            const tint = GLASS_TINTS[tintRow.selected];
            if (!syncingTint && tint)
                blur.set_int('style-dash-to-dock', tint.style);
        });

        const brightnessOf = () => Math.round(Math.min(GLASS_BRIGHTNESS_RANGE.upper / 100,
            Math.max(GLASS_BRIGHTNESS_RANGE.lower / 100, blur.get_double('brightness'))) * 100);
        let brightness = null;
        if (has('brightness')) {
            brightness = this._addScaleRow(group, 'Brightness', {
                lower: GLASS_BRIGHTNESS_RANGE.lower, upper: GLASS_BRIGHTNESS_RANGE.upper,
                marks: [50, 60, 70, 80, 90, 100], unit: '%', pageStep: 10,
                value: brightnessOf(),
                onChange: value => blur.set_double('brightness', value / 100),
            });
        }

        // The brightness is the dynamic blur's own. Static blur, which is
        // Blur my Shell's default, takes its brightness from the pipeline it
        // draws with, which by default the popup menus use too, and ignores this
        // key: moving the slider would change nothing, so it says so instead.
        // Nothing is tinted or blurred at all while blur is off.
        const staticBlurSubtitle = 'Only dynamic blur uses this. Static blur’s brightness belongs to a ' +
            'pipeline that other parts of Blur my Shell share. Set the dock’s blur to dynamic there to use this.';
        const syncSensitivity = () => {
            const blurred = blur.get_boolean('blur');
            const dynamic = !has('static-blur') || !blur.get_boolean('static-blur');
            tintRow.set_sensitive(blurred);
            if (brightness) {
                brightness.row.set_sensitive(blurred && dynamic);
                brightness.row.set_subtitle(blurred && !dynamic ? staticBlurSubtitle : '');
            }
        };
        syncSensitivity();

        const watched = [
            ['blur', syncSensitivity], ['static-blur', syncSensitivity],
            ['style-dash-to-dock', syncTint],
            ['brightness', () => brightness?.setValue(brightnessOf())],
        ].filter(([key]) => has(key)).map(([key, handler]) => blur.connect(`changed::${key}`, handler));
        group.connect('destroy', () => {
            for (const id of watched)
                blur.disconnect(id);
        });
    }

    // Which of RUNNING_INDICATORS the stored keys amount to, or -1 for a style
    // chosen in Dash to Dock's own settings that none of them describes.
    _currentRunningIndicator(dock) {
        const style = dock.get_string('running-indicator-style');
        if (style === 'DEFAULT')
            return 1;
        if (style !== 'DOT' || !dock.get_boolean('custom-theme-customize-running-dots'))
            return -1;
        return dock.get_string('custom-theme-running-dots-color') === RUNNING_DOT_INVISIBLE ? 2 : 0;
    }

    _buildDockIndicatorRow(group, dock) {
        // The single dot is a newer style than the keys themselves, and writing
        // a value an enum does not list is as fatal as writing a missing key.
        if (!RUNNING_DOT_KEYS.every(key => this._schemaHasKey(dock, key)) ||
            !dock.settings_schema.get_key('running-indicator-style')
                .range_check(GLib.Variant.new_string('DOT')))
            return;

        // A style set elsewhere gets an entry of its own rather than reading as
        // one of ours, which would misreport what is actually saved.
        const labels = RUNNING_INDICATORS.map(indicator => indicator.title);
        let current = this._currentRunningIndicator(dock);
        if (current < 0) {
            labels.push('Set in Dash to Dock');
            current = labels.length - 1;
        }

        // The subtitle shares the row's width with the selected value, and a long
        // one leaves the value a few pixels: at the default window width it
        // squeezed "One Dot, Like macOS" down to an ellipsis. What the long one
        // said, that tray-only apps get none, is the group's to say.
        const subtitle = 'Only for apps that have an open window';
        const row = new Adw.ComboRow({
            title: 'Indicator',
            subtitle,
            model: Gtk.StringList.new(labels),
            selected: current,
        });
        group.add(row);
        group.set_description('Tray-only apps such as Steam have no window, so they get none');

        row.connect('notify::selected', () => {
            RUNNING_INDICATORS[row.selected]?.apply(dock);
        });

        // Dash to Dock's built-in theme forces its own dots and ignores all of
        // the above, so say so instead of offering a choice that does nothing.
        if (this._schemaHasKey(dock, 'apply-custom-theme')) {
            const syncThemeOverride = () => {
                const overridden = dock.get_boolean('apply-custom-theme');
                row.set_sensitive(!overridden);
                row.set_subtitle(overridden ? 'Overridden by Dash to Dock’s built-in theme' : subtitle);
                row.set_tooltip_text(overridden
                    ? 'Turn off Dash to Dock’s built-in theme to choose' : null);
            };
            syncThemeOverride();
            dock.connect('changed::apply-custom-theme', syncThemeOverride);
        }
    }

    // Pear Up's own setting, like magnification: the extension removes Dash to
    // Dock's backdrop with its stylesheet and writes nothing of Dash to Dock's,
    // so it is offered on every Dash to Dock, even one without the single dot.
    _buildDockFocusRow(group, settings) {
        const row = new Adw.SwitchRow({
            title: 'Highlight the Focused App',
            subtitle: 'The grey backdrop Dash to Dock draws behind the app in front; macOS has only the dot',
        });
        group.add(row);
        settings.bind('dock-focus-highlight', row, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    // Which display the dock lives on. Dash to Dock stores a connector name,
    // so offer the connectors actually attached right now plus "primary".
    _buildDockDisplayGroup(page, dock) {
        const group = new Adw.PreferencesGroup({ title: 'Display' });

        if (!this._schemaHasKey(dock, 'preferred-monitor-by-connector') ||
            !this._schemaHasKey(dock, 'multi-monitor'))
            return;

        page.add(group);

        const allRow = new Adw.SwitchRow({
            title: 'Show on Every Display',
            active: dock.get_boolean('multi-monitor'),
        });
        group.add(allRow);

        const connectors = [];
        const labels = ['Primary Display'];
        const monitors = Gdk.Display.get_default()?.get_monitors();
        for (let i = 0; i < (monitors?.get_n_items() ?? 0); i++) {
            const monitor = monitors.get_item(i);
            const connector = monitor.connector;
            if (!connector)
                continue;
            connectors.push(connector);
            const model = [monitor.manufacturer, monitor.model].filter(part => part).join(' ');
            labels.push(model ? `${connector} — ${model}` : connector);
        }

        const current = dock.get_string('preferred-monitor-by-connector');
        let currentIndex = current === 'primary' ? 0 : connectors.indexOf(current) + 1;

        // A connector that is stored but not attached right now would otherwise
        // fall back to index 0 and read as "Primary Display", misreporting what
        // is actually saved.
        if (currentIndex === 0 && current !== 'primary') {
            connectors.push(current);
            labels.push(`${current} — not connected`);
            currentIndex = connectors.length;
        }

        const displayRow = new Adw.ComboRow({
            title: 'Place the Dock On',
            model: Gtk.StringList.new(labels),
            selected: Math.max(0, currentIndex),
            sensitive: !allRow.active,
        });
        group.add(displayRow);

        displayRow.connect('notify::selected', () => {
            const index = displayRow.selected;
            dock.set_string('preferred-monitor-by-connector',
                index === 0 ? 'primary' : connectors[index - 1]);
        });

        allRow.connect('notify::active', () => {
            dock.set_boolean('multi-monitor', allRow.active);
            displayRow.set_sensitive(!allRow.active);
        });
    }

    _buildSearchGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Search',
            description: 'A search icon of this extension\u2019s own, where macOS keeps Spotlight',
        });
        page.add(group);

        const showRow = new Adw.SwitchRow({ title: 'Show Search Icon' });
        group.add(showRow);
        settings.bind('show-search-icon', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const opensRow = new Adw.ComboRow({
            title: 'Opens',
            model: Gtk.StringList.new(SEARCH_TARGETS.map(([, label]) => label)),
            selected: Math.max(0, SEARCH_TARGETS.findIndex(
                ([value]) => value === settings.get_string('search-opens'))),
        });
        group.add(opensRow);

        const commandRow = new Adw.EntryRow({ title: 'Command' });
        commandRow.set_text(settings.get_string('search-command'));
        this._onTextSettled(commandRow,
            () => settings.set_string('search-command', commandRow.get_text()));
        group.add(commandRow);

        const sync = () => {
            const [value, , subtitle] = SEARCH_TARGETS[opensRow.selected];
            opensRow.set_subtitle(subtitle);
            // Only worth showing for the one choice that needs it.
            commandRow.set_visible(value === 'command');
            opensRow.set_sensitive(showRow.active);
            commandRow.set_sensitive(showRow.active);
        };
        sync();

        opensRow.connect('notify::selected', () => {
            settings.set_string('search-opens', SEARCH_TARGETS[opensRow.selected][0]);
            sync();
        });
        showRow.connect('notify::active', sync);
    }

    // A labelled slider in a row, matching the System Menu icon size control.
    // A mark is a number, or [number, 'Label'] to name that point on the track.
    // A wide range wants a bigger pageStep, or PageUp and PageDown crawl.
    _addScaleRow(group, title, { lower, upper, marks, value, unit = '', pageStep = 4, onChange }) {
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({ lower, upper, step_increment: 1, page_increment: pageStep }),
            digits: 0,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        // The labels of the marks are drawn centred on them and run past the end
        // of the slider, so the end that has one, "Strong", reached the edge of
        // the row. The margin is what gives it room; the width is what it takes
        // from the minimum, so the title next to it has no less than before.
        scale.set_size_request(212, -1);
        scale.set_margin_end(8);
        for (const mark of marks) {
            const [at, label] = Array.isArray(mark) ? mark : [mark, null];
            // Mark labels are Pango markup, so a label is escaped, not trusted.
            scale.add_mark(at, Gtk.PositionType.BOTTOM,
                label === null ? null : GLib.markup_escape_text(label, -1));
        }
        if (unit)
            scale.set_format_value_func((_scale, displayed) => `${Math.round(displayed)}${unit}`);
        scale.set_value(value);

        const row = new Adw.ActionRow({ title });
        row.add_suffix(scale);
        group.add(row);

        let updating = false;
        scale.connect('value-changed', () => {
            if (updating)
                return;
            onChange(Math.round(scale.get_value()));
        });

        return {
            row,
            setValue: newValue => {
                updating = true;
                scale.set_value(newValue);
                updating = false;
            },
        };
    }

    _buildGeneralPage(settings, window) {
        const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'preferences-system-symbolic' });

        const mainGroup = new Adw.PreferencesGroup({ title: 'Global Menu' });
        page.add(mainGroup);

        const showRow = new Adw.SwitchRow({ title: 'Show Global Menu', subtitle: 'Master toggle for the whole menu bar' });
        mainGroup.add(showRow);
        settings.bind('show-indicator', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const hideOverviewRow = new Adw.SwitchRow({ title: 'Hide Activities Button', subtitle: 'An "Activities" item is then added to the System Menu instead' });
        mainGroup.add(hideOverviewRow);
        settings.bind('hide-overview-button', hideOverviewRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Empty follows the app, so File → New … Window says "Files" where the bar
        // does; a name typed here, such as Finder, is used as typed.
        const desktopNameRow = new Adw.ActionRow({
            title: 'File Manager Name',
            subtitle: 'In File \u2192 New \u2026 Window; empty uses the app\u2019s own',
        });
        const desktopNameEntry = new Gtk.Entry({
            text: settings.get_string('desktop-app-name'),
            placeholder_text: 'Automatic',
            width_chars: 14,
            valign: Gtk.Align.CENTER,
        });
        this._onTextSettled(desktopNameEntry,
            () => settings.set_string('desktop-app-name', desktopNameEntry.get_text().trim()));
        desktopNameRow.add_suffix(desktopNameEntry);
        desktopNameRow.set_activatable_widget(desktopNameEntry);
        mainGroup.add(desktopNameRow);

        const panelGroup = new Adw.PreferencesGroup({
            title: 'Top Bar',
            description: 'Rearrange the stock GNOME panel to match macOS',
        });
        page.add(panelGroup);

        const PANEL_TWEAKS = [
            ['clock-on-the-right', 'Clock on the Right',
                'GNOME centres it; macOS keeps it in the corner'],
            ['hide-power-button', 'Hide the Power Icon',
                'Only where there is no battery: a laptop keeps its battery icon'],
            ['hide-panel-spacers', 'Hide Inactive Indicators',
                'Screen recording, screen sharing, dwell click, accessibility and keyboard layout'],
            ['group-spotlight-with-quick-settings', 'Keep Search Light Beside Quick Settings',
                'Groups the Spotlight-style search icon with the status icons'],
        ];
        for (const [key, title, subtitle] of PANEL_TWEAKS) {
            const row = new Adw.SwitchRow({ title, subtitle });
            panelGroup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const spacingGroup = new Adw.PreferencesGroup({
            title: 'Status Area Spacing',
            description: 'Room between the groups on the right of the bar, and around each item in them',
        });
        page.add(spacingGroup);

        for (const [key, title, subtitle] of [
            ['gap-before-quick-settings', 'Before the Control Center Icons',
                'Gap between them and a search icon to their left'],
            ['gap-before-clock', 'Before the Clock',
                'Separates the date from the control center icons'],
        ]) {
            const row = this._addScaleRow(spacingGroup, title, {
                lower: 0, upper: 48, marks: [0, 8, 16, 24, 32, 48], unit: 'px',
                value: settings.get_int(key),
                onChange: value => settings.set_int(key, value),
            });
            row.row.set_subtitle(subtitle);
            settings.connect(`changed::${key}`,
                () => row.setValue(settings.get_int(key)));
        }

        const paddingRow = this._addScaleRow(spacingGroup, 'Padding Around Each Item', {
            lower: 0, upper: 12, marks: [0, 3, 6, 9, 12], unit: 'px',
            value: settings.get_int('status-icon-padding'),
            onChange: value => settings.set_int('status-icon-padding', value),
        });
        paddingRow.row.set_subtitle('Lower to pack the icons and clock closer together; zero leaves them touching');
        settings.connect('changed::status-icon-padding',
            () => paddingRow.setValue(settings.get_int('status-icon-padding')));

        this._buildDesktopGroup(page, settings);

        this._buildSearchGroup(page, settings);

        const logoGroup = new Adw.PreferencesGroup({
            title: 'System Menu',
            description: 'A button on the far left of the bar, similar to the Apple menu on macOS',
        });
        page.add(logoGroup);

        const showLogoRow = new Adw.SwitchRow({ title: 'Show System Menu Button' });
        logoGroup.add(showLogoRow);
        settings.bind('show-logo-menu', showLogoRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        this._buildIconPicker(logoGroup, settings, window);

        const itemsGroup = new Adw.PreferencesGroup({ title: 'System Menu Items' });
        page.add(itemsGroup);

        const systemSettingsRow = new Adw.SwitchRow({ title: 'System Settings' });
        itemsGroup.add(systemSettingsRow);
        settings.bind('show-system-settings', systemSettingsRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const appGridRow = new Adw.SwitchRow({ title: 'App Grid' });
        itemsGroup.add(appGridRow);
        settings.bind('show-app-grid', appGridRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        this._addCommandRow(itemsGroup, settings, 'Software Center', 'show-software-center', 'software-center-command',
            ['flatpak run io.github.kolunmi.Bazaar', 'gnome-software', 'plasma-discover', 'pamac-manager', 'snap-store']);
        this._addCommandRow(itemsGroup, settings, 'System Monitor', 'show-system-monitor', 'system-monitor-command',
            ['missioncenter-helper', 'gnome-system-monitor', 'resources', 'ksysguard', 'xfce4-taskmanager']);
        this._addCommandRow(itemsGroup, settings, 'Terminal', 'show-terminal', 'terminal-command',
            ['ptyxis', 'gnome-terminal', 'kgx', 'konsole', 'kitty', 'alacritty', 'tilix', 'terminator', 'xterm']);

        const extRow = new Adw.SwitchRow({ title: 'Extensions App' });
        itemsGroup.add(extRow);
        settings.bind('show-extensions-app', extRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const EXTENSIONS_APPS = [
            ['com.mattjakeman.ExtensionManager.desktop', 'Extension Manager'],
            ['org.gnome.Extensions.desktop', 'GNOME Extensions'],
        ];
        const extAppModel = Gtk.StringList.new(EXTENSIONS_APPS.map(([, label]) => label));
        const currentAppId = settings.get_string('extensions-app-id');
        const currentAppIndex = Math.max(0, EXTENSIONS_APPS.findIndex(([id]) => id === currentAppId));
        const extAppRow = new Adw.ComboRow({ title: 'Extensions App to Launch', model: extAppModel, selected: currentAppIndex });
        itemsGroup.add(extAppRow);
        extAppRow.connect('notify::selected', () => {
            settings.set_string('extensions-app-id', EXTENSIONS_APPS[extAppRow.selected][0]);
        });

        const forceQuitRow = new Adw.SwitchRow({
            title: 'Force Quit',
            subtitle: 'Then click the window to quit, like xkill. Esc cancels',
        });
        itemsGroup.add(forceQuitRow);
        settings.bind('show-force-quit', forceQuitRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const recentRow = new Adw.SwitchRow({
            title: 'Recent Items',
            subtitle: 'Applications, documents and the places you connected to',
        });
        itemsGroup.add(recentRow);
        settings.bind('show-recent-items', recentRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const recentLimit = this._addScaleRow(itemsGroup, 'Entries per Section', {
            lower: 1,
            upper: 20,
            marks: [1, 5, 10, 15, 20],
            value: settings.get_int('recent-items-limit'),
            onChange: value => settings.set_int('recent-items-limit', value),
        });
        settings.bind('show-recent-items', recentLimit.row, 'sensitive', Gio.SettingsBindFlags.GET);

        this._buildSystemMenuCustomItems(page, settings);

        const powerGroup = new Adw.PreferencesGroup({ title: 'Power' });
        page.add(powerGroup);

        const powerRow = new Adw.SwitchRow({ title: 'Sleep / Restart / Shut Down' });
        powerGroup.add(powerRow);
        settings.bind('show-power-options', powerRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const lockRow = new Adw.SwitchRow({ title: 'Lock Screen' });
        powerGroup.add(lockRow);
        settings.bind('show-lock-screen', lockRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const logoutRow = new Adw.SwitchRow({ title: 'Log Out' });
        powerGroup.add(logoutRow);
        settings.bind('show-log-out', logoutRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced',
            description: 'Off by default; turn on temporarily if you need to diagnose an issue',
        });
        page.add(advancedGroup);

        const debugRow = new Adw.SwitchRow({ title: 'Verbose Error Logging' });
        advancedGroup.add(debugRow);
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        return page;
    }

    // The shell's pieces that are not the bar, where macOS has them. Each
    // switch is applied by the shell side at once; the subtitles say what GNOME
    // does instead, since that is what switching one off brings back.
    _buildDesktopGroup(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Desktop',
            description: 'Where macOS puts the rest of the desktop. These used to need Just Perfection',
        });
        page.add(group);

        for (const [key, title, subtitle] of [
            ['notifications-top-right', 'Notifications at the Top Right',
                'Under the clock wherever it is; GNOME centres them under a centred clock'],
            ['osd-top-right', 'Volume and Brightness at the Top Right',
                'Under the bar; GNOME shows them at the bottom centre'],
            ['hide-workspace-popup', 'No Popup When Switching Desktops',
                'The desktop slides across, and nothing else shows'],
            ['always-show-workspace-thumbnails', 'Always Show the Desktops in the Overview',
                'Along the top, like Mission Control; GNOME hides them until two are in use'],
            ['start-on-desktop', 'Start on the Desktop',
                'Instead of the overview at login; takes effect at the next one'],
        ]) {
            const row = new Adw.SwitchRow({ title, subtitle });
            group.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        // Before GNOME 49 the brightness is gnome-settings-daemon's to set, and
        // there is nothing here to switch.
        if (shellSetsBrightness()) {
            const row = new Adw.SwitchRow({
                title: 'Smooth Automatic Brightness',
                subtitle: 'Fades to each new light level; only while Automatic Screen Brightness is on',
            });
            group.add(row);
            settings.bind('smooth-auto-brightness', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }
    }

    // A visual icon picker: a grid of the bundled distro icons plus a
    // "custom file" option, instead of typing an icon name or path by hand.
    // Clicking a tile immediately applies it (and clears the other icon
    // sources), so selection always visibly takes effect.
    _buildIconPicker(group, settings, window) {
        const iconsDir = GLib.build_filenamev([this.path, 'icons']);

        const previewRow = new Adw.ActionRow({ title: 'Current Icon' });
        const previewImage = new Gtk.Image({ pixel_size: 32, margin_top: 6, margin_bottom: 6 });
        previewRow.add_prefix(previewImage);
        group.add(previewRow);

        const symbolicRow = new Adw.SwitchRow({ title: 'Symbolic (single-color) Style' });
        group.add(symbolicRow);
        settings.bind('logo-distro-icon-symbolic', symbolicRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const sizeAdjustment = new Gtk.Adjustment({ lower: 12, upper: 48, step_increment: 1, page_increment: 4 });
        const sizeScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: sizeAdjustment,
            digits: 0,
            draw_value: true,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        sizeScale.set_size_request(220, -1);
        for (let mark of [12, 16, 22, 32, 48])
            sizeScale.add_mark(mark, Gtk.PositionType.BOTTOM, null);
        sizeScale.set_value(settings.get_int('logo-icon-size'));

        const sizeRow = new Adw.ActionRow({ title: 'Icon Size' });
        sizeRow.add_suffix(sizeScale);
        group.add(sizeRow);

        sizeScale.connect('value-changed', () => settings.set_int('logo-icon-size', Math.round(sizeScale.get_value())));
        settings.connect('changed::logo-icon-size', () => {
            sizeScale.set_value(settings.get_int('logo-icon-size'));
            updatePreview();
        });

        const fontRow = this._addScaleRow(group, 'Menu Text Size', {
            lower: 10,
            upper: 16,
            marks: [10, 11, 12, 13, 14, 16],
            value: settings.get_int('system-menu-font-size'),
            unit: 'px',
            onChange: value => settings.set_int('system-menu-font-size', value),
        });
        fontRow.row.set_subtitle('The pear menu only. File, Edit and the rest have their own size under Menus');
        settings.connect('changed::system-menu-font-size',
            () => fontRow.setValue(settings.get_int('system-menu-font-size')));

        const flowBox = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            max_children_per_line: 8,
            min_children_per_line: 4,
            row_spacing: 8,
            column_spacing: 8,
            homogeneous: true,
            margin_top: 6,
            margin_bottom: 6,
        });

        const resolveVariantPath = (stem, symbolic) => {
            let variant = symbolic ? 'symbolic' : 'color';
            let path = GLib.build_filenamev([iconsDir, `distro-${stem}-${variant}.svg`]);
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
            let otherVariant = symbolic ? 'color' : 'symbolic';
            let fallbackPath = GLib.build_filenamev([iconsDir, `distro-${stem}-${otherVariant}.svg`]);
            return GLib.file_test(fallbackPath, GLib.FileTest.EXISTS) ? fallbackPath : null;
        };

        const updatePreview = () => {
            previewImage.pixel_size = settings.get_int('logo-icon-size') || 32;
            let customPath = settings.get_string('logo-custom-icon-path');
            if (customPath && GLib.file_test(customPath, GLib.FileTest.EXISTS)) {
                previewImage.set_from_file(customPath);
                previewRow.set_subtitle('Custom file');
                return;
            }
            let distroStem = settings.get_string('logo-distro-icon');
            if (distroStem) {
                let path = resolveVariantPath(distroStem, settings.get_boolean('logo-distro-icon-symbolic'));
                if (path) {
                    previewImage.set_from_file(path);
                    previewRow.set_subtitle(DISTRO_ICONS.find(([s]) => s === distroStem)?.[1] || distroStem);
                    return;
                }
            }
            previewImage.set_from_icon_name('start-here-symbolic');
            previewRow.set_subtitle('System default');
        };

        let suppressSelectionEvent = false;

        const rebuildTiles = () => {
            let child;
            while ((child = flowBox.get_first_child()) !== null)
                flowBox.remove(child);

            let symbolic = settings.get_boolean('logo-distro-icon-symbolic');
            let currentStem = settings.get_string('logo-custom-icon-path') ? null : settings.get_string('logo-distro-icon');

            // "None" tile first, restores the plain system icon.
            let noneImage = new Gtk.Image({ icon_name: 'action-unavailable-symbolic', pixel_size: 28 });
            noneImage.set_tooltip_text('None');
            flowBox.append(noneImage);

            DISTRO_ICONS.forEach(([stem, label]) => {
                let path = resolveVariantPath(stem, symbolic);
                let image = path
                    ? Gtk.Image.new_from_file(path)
                    : new Gtk.Image({ icon_name: 'image-missing-symbolic' });
                image.pixel_size = 28;
                image.set_tooltip_text(label);
                flowBox.append(image);
            });

            // Restore selection to match current settings. This is a
            // programmatic selection reflecting existing state, not a user
            // click - it must not re-fire the mutation handler below, or
            // picking a custom file gets immediately undone (the "None"
            // tile gets auto-selected to show "no distro icon active",
            // which would otherwise clear the custom path we just set).
            suppressSelectionEvent = true;
            let selectIndex = currentStem ? DISTRO_ICONS.findIndex(([s]) => s === currentStem) + 1 : 0;
            let target = flowBox.get_child_at_index(selectIndex);
            if (target) flowBox.select_child(target);
            else flowBox.unselect_all();
            suppressSelectionEvent = false;
        };

        flowBox.connect('selected-children-changed', () => {
            if (suppressSelectionEvent) return;

            let selected = flowBox.get_selected_children();
            if (selected.length === 0) return;
            let index = selected[0].get_index();

            // Selecting any tile here always clears the custom file
            // override, so the choice actually takes visible effect.
            settings.set_string('logo-custom-icon-path', '');

            if (index === 0) {
                settings.set_string('logo-distro-icon', '');
            } else {
                settings.set_string('logo-distro-icon', DISTRO_ICONS[index - 1][0]);
            }
        });

        rebuildTiles();
        updatePreview();

        symbolicRow.connect('notify::active', () => {
            rebuildTiles();
            updatePreview();
        });

        settings.connect('changed::logo-distro-icon', () => { rebuildTiles(); updatePreview(); });
        settings.connect('changed::logo-custom-icon-path', () => { rebuildTiles(); updatePreview(); });

        let flowRow = new Adw.ActionRow();
        flowRow.set_child(flowBox);
        group.add(flowRow);

        const customRow = new Adw.ActionRow({
            title: 'Custom Icon File',
            subtitle: settings.get_string('logo-custom-icon-path') || 'None',
        });
        group.add(customRow);

        const chooseButton = new Gtk.Button({ label: 'Choose File\u2026', valign: Gtk.Align.CENTER });
        chooseButton.connect('clicked', () => {
            let dialog = new Gtk.FileDialog({ title: 'Select Icon Image' });

            // gdk-pixbuf (what St.Icon/Gtk.Image render through) natively
            // supports all of these; SVG is handled separately via
            // librsvg. "All files" is still offered as a fallback filter.
            let imageFilter = new Gtk.FileFilter({ name: 'Image files' });
            imageFilter.add_mime_type('image/svg+xml');
            imageFilter.add_mime_type('image/png');
            imageFilter.add_mime_type('image/jpeg');
            imageFilter.add_mime_type('image/webp');
            imageFilter.add_mime_type('image/bmp');
            imageFilter.add_mime_type('image/gif');
            imageFilter.add_pattern('*.svg');
            imageFilter.add_pattern('*.png');
            imageFilter.add_pattern('*.jpg');
            imageFilter.add_pattern('*.jpeg');
            imageFilter.add_pattern('*.webp');
            imageFilter.add_pattern('*.bmp');
            imageFilter.add_pattern('*.gif');

            let allFilter = new Gtk.FileFilter({ name: 'All files' });
            allFilter.add_pattern('*');

            let filterList = Gio.ListStore.new(Gtk.FileFilter);
            filterList.append(imageFilter);
            filterList.append(allFilter);
            dialog.set_filters(filterList);
            dialog.set_default_filter(imageFilter);

            dialog.open(window, null, (dlg, res) => {
                try {
                    let file = dlg.open_finish(res);
                    if (file) {
                        let path = file.get_path();
                        settings.set_string('logo-custom-icon-path', path);
                        customRow.set_subtitle(path);
                    }
                } catch {
                    // User cancelled, or the dialog failed; nothing to do.
                }
            });
        });
        customRow.add_suffix(chooseButton);

        const clearButton = new Gtk.Button({ icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        clearButton.connect('clicked', () => {
            settings.set_string('logo-custom-icon-path', '');
            customRow.set_subtitle('None');
        });
        customRow.add_suffix(clearButton);
    }

    _addCommandRow(group, settings, title, enabledKey, commandKey, presets = []) {
        const row = new Adw.SwitchRow({ title });
        group.add(row);
        settings.bind(enabledKey, row, 'active', Gio.SettingsBindFlags.DEFAULT);

        const commandRow = new Adw.EntryRow({ title: `${title} Command` });
        commandRow.set_text(settings.get_string(commandKey));
        this._onTextSettled(commandRow,
            () => settings.set_string(commandKey, commandRow.get_text()));
        group.add(commandRow);

        if (presets.length > 0) {
            const presetModel = Gtk.StringList.new(['Presets\u2026', ...presets]);
            const presetDropdown = new Gtk.DropDown({ model: presetModel, valign: Gtk.Align.CENTER, selected: 0 });
            presetDropdown.connect('notify::selected', () => {
                if (presetDropdown.selected === 0) return;
                commandRow.set_text(presets[presetDropdown.selected - 1]);
                presetDropdown.selected = 0;
            });
            commandRow.add_suffix(presetDropdown);
        }
    }

    // Flat list of {label, value} shell-command items appended as their
    // own section at the bottom of the System Menu (distinct from the
    // top-bar Custom Menus feature, which supports multiple named menus).
    _buildSystemMenuCustomItems(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'System Menu Custom Commands',
            description: 'Extra items added to the bottom of the System Menu, each running a shell command',
        });
        page.add(group);

        const addButton = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        group.set_header_suffix(addButton);

        const loadItems = () => {
            try {
                let items = JSON.parse(settings.get_string('system-menu-custom-items') || '[]');
                return Array.isArray(items) ? items : [];
            } catch {
                return [];
            }
        };
        const saveItems = (items) => settings.set_string('system-menu-custom-items', JSON.stringify(items));

        let rows = [];

        const rebuildRows = () => {
            for (let row of rows)
                group.remove(row);
            rows = [];

            let items = loadItems();
            items.forEach((item, index) => {
                let row = new Adw.ActionRow();

                let labelEntry = new Gtk.Entry({
                    text: item.label || '',
                    placeholder_text: 'Label',
                    valign: Gtk.Align.CENTER,
                    width_chars: 12,
                });
                let valueEntry = new Gtk.Entry({
                    text: item.value || '',
                    placeholder_text: 'command --flag',
                    valign: Gtk.Align.CENTER,
                    width_chars: 20,
                    hexpand: true,
                });
                let removeButton = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });

                const persist = () => {
                    let current = loadItems();
                    // The captured index can go stale if rows are removed or
                    // reordered between render and edit; drop the write rather
                    // than overwrite whatever moved into its place.
                    if (!Array.isArray(current) || index >= current.length)
                        return;
                    current[index] = { label: labelEntry.get_text(), value: valueEntry.get_text() };
                    saveItems(current);
                };

                this._onTextSettled(labelEntry, persist);
                this._onTextSettled(valueEntry, persist);
                removeButton.connect('clicked', () => {
                    let current = loadItems();
                    current.splice(index, 1);
                    saveItems(current);
                    rebuildRows();
                });

                row.add_suffix(labelEntry);
                row.add_suffix(valueEntry);
                row.add_suffix(removeButton);
                group.add(row);
                rows.push(row);
            });
        };

        addButton.connect('clicked', () => {
            let current = loadItems();
            current.push({ label: 'New Item', value: '' });
            saveItems(current);
            rebuildRows();
        });

        rebuildRows();
    }

    _buildMenusPage(settings) {
        const page = new Adw.PreferencesPage({ title: 'Menus', icon_name: 'view-list-symbolic' });
        const group = new Adw.PreferencesGroup({
            title: 'Built-in Menus',
            description: 'File and Go only include Nautilus-style items when a file manager is in front.',
        });
        page.add(group);

        const menus = [
            ['menu-app-enabled', 'App Menu'],
            ['menu-file-enabled', 'File Menu'],
            ['menu-edit-enabled', 'Edit Menu'],
            ['menu-view-enabled', 'View Menu'],
            ['menu-go-enabled', 'Go Menu'],
            ['menu-window-enabled', 'Window Menu'],
            ['menu-help-enabled', 'Help Menu'],
        ];

        for (let [key, title] of menus) {
            let row = new Adw.SwitchRow({ title });
            group.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        }

        const lookGroup = new Adw.PreferencesGroup({
            title: 'Menu Bar',
            description: 'Type size of File, Edit and the rest, and the space between those titles',
        });
        page.add(lookGroup);

        const barFontRow = this._addScaleRow(lookGroup, 'Title Size', {
            lower: 10,
            upper: 16,
            marks: [10, 11, 12, 13, 14, 16],
            value: settings.get_int('menu-bar-font-size'),
            unit: 'px',
            onChange: value => settings.set_int('menu-bar-font-size', value),
        });
        barFontRow.row.set_subtitle('The titles and the menus they open. The pear menu has its own size');
        settings.connect('changed::menu-bar-font-size',
            () => barFontRow.setValue(settings.get_int('menu-bar-font-size')));

        const barPadRow = this._addScaleRow(lookGroup, 'Title Padding', {
            lower: 0,
            upper: 20,
            marks: [0, 4, 6, 10, 16, 20],
            value: settings.get_int('menu-bar-padding'),
            unit: 'px',
            onChange: value => settings.set_int('menu-bar-padding', value),
        });
        barPadRow.row.set_subtitle('Room on each side of File, Edit, View. Zero packs them together');
        settings.connect('changed::menu-bar-padding',
            () => barPadRow.setValue(settings.get_int('menu-bar-padding')));

        return page;
    }

    // Multiple independent custom menu sections: each becomes its own
    // top-level menu button, with its own label, enable switch, and list
    // of command/shortcut items.
    _buildCustomMenuPage(settings) {
        const page = new Adw.PreferencesPage({ title: 'Custom Menus', icon_name: 'list-add-symbolic' });

        const group = new Adw.PreferencesGroup({
            title: 'Custom Menus',
            // Adw group descriptions are parsed as Pango markup, so the angle
            // brackets in an accelerator have to be escaped.
            description: 'Add any number of custom top-level menus, each running shell commands ' +
                'or sending keyboard shortcuts (GTK accelerator syntax, e.g. ' +
                '&lt;Control&gt;&lt;Alt&gt;t)',
        });
        page.add(group);

        const addSectionButton = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
        group.set_header_suffix(addSectionButton);

        const loadSections = () => {
            try {
                // Valid JSON that is not an array would otherwise throw later,
                // at sections.forEach; mirror loadItems() and fall back to [].
                const sections = JSON.parse(settings.get_string('custom-menus') || '[]');
                return Array.isArray(sections) ? sections : [];
            } catch {
                return [];
            }
        };
        const saveSections = (sections) => settings.set_string('custom-menus', JSON.stringify(sections));

        let sectionRows = [];

        const rebuildSections = () => {
            for (let row of sectionRows)
                group.remove(row);
            sectionRows = [];

            let sections = loadSections();
            sections.forEach((section, sectionIndex) => {
                let expander = new Adw.ExpanderRow({
                    title: section.label || 'Untitled Menu',
                    subtitle: `${(section.items || []).length} item(s)`,
                });

                let enableSwitch = new Gtk.Switch({ active: section.enabled !== false, valign: Gtk.Align.CENTER });
                enableSwitch.connect('notify::active', () => {
                    let current = loadSections();
                    current[sectionIndex].enabled = enableSwitch.get_active();
                    saveSections(current);
                });
                expander.add_suffix(enableSwitch);

                let removeSectionButton = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
                removeSectionButton.connect('clicked', () => {
                    let current = loadSections();
                    current.splice(sectionIndex, 1);
                    saveSections(current);
                    rebuildSections();
                });
                expander.add_suffix(removeSectionButton);

                let labelRow = new Adw.EntryRow({ title: 'Menu Label' });
                labelRow.set_text(section.label || '');
                labelRow.connect('notify::text',
                    () => expander.set_title(labelRow.get_text() || 'Untitled Menu'));
                this._onTextSettled(labelRow, () => {
                    let current = loadSections();
                    current[sectionIndex].label = labelRow.get_text();
                    saveSections(current);
                });
                expander.add_row(labelRow);

                let items = section.items || [];
                items.forEach((item, itemIndex) => {
                    let itemRow = new Adw.ActionRow();

                    let labelEntry = new Gtk.Entry({ text: item.label || '', placeholder_text: 'Label', valign: Gtk.Align.CENTER, width_chars: 10 });
                    let kindDropdown = new Gtk.DropDown({
                        model: Gtk.StringList.new(['Shell Command', 'Keyboard Shortcut']),
                        selected: item.kind === 'shortcut' ? 1 : 0,
                        valign: Gtk.Align.CENTER,
                    });
                    let valueEntry = new Gtk.Entry({
                        text: item.value || '',
                        placeholder_text: item.kind === 'shortcut' ? '<Control><Alt>t' : 'command --flag',
                        valign: Gtk.Align.CENTER,
                        width_chars: 16,
                    });
                    let removeItemButton = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });

                    const persistItem = () => {
                        let current = loadSections();
                        // The captured indices can go stale if rows are removed
                        // or reordered between render and edit; drop the write
                        // rather than overwrite the wrong section or item.
                        const section = Array.isArray(current)
                            ? current[sectionIndex] : undefined;
                        if (!section || !Array.isArray(section.items) ||
                            itemIndex >= section.items.length)
                            return;
                        section.items[itemIndex] = {
                            label: labelEntry.get_text(),
                            kind: kindDropdown.selected === 1 ? 'shortcut' : 'command',
                            value: valueEntry.get_text(),
                        };
                        saveSections(current);
                    };

                    this._onTextSettled(labelEntry, persistItem);
                    kindDropdown.connect('notify::selected', () => {
                        valueEntry.set_placeholder_text(kindDropdown.selected === 1 ? '<Control><Alt>t' : 'command --flag');
                        persistItem();
                    });
                    this._onTextSettled(valueEntry, persistItem);
                    removeItemButton.connect('clicked', () => {
                        let current = loadSections();
                        current[sectionIndex].items.splice(itemIndex, 1);
                        saveSections(current);
                        rebuildSections();
                    });

                    itemRow.add_suffix(labelEntry);
                    itemRow.add_suffix(kindDropdown);
                    itemRow.add_suffix(valueEntry);
                    itemRow.add_suffix(removeItemButton);
                    expander.add_row(itemRow);
                });

                let addItemRow = new Adw.ActionRow({ title: 'Add Item' });
                let addItemButton = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
                addItemButton.connect('clicked', () => {
                    let current = loadSections();
                    if (!current[sectionIndex].items) current[sectionIndex].items = [];
                    current[sectionIndex].items.push({ label: 'New Item', kind: 'command', value: '' });
                    saveSections(current);
                    rebuildSections();
                });
                addItemRow.add_suffix(addItemButton);
                addItemRow.set_activatable_widget(addItemButton);
                expander.add_row(addItemRow);

                group.add(expander);
                sectionRows.push(expander);
            });
        };

        addSectionButton.connect('clicked', () => {
            let current = loadSections();
            current.push({ label: `Custom ${current.length + 1}`, enabled: true, items: [] });
            saveSections(current);
            rebuildSections();
        });

        rebuildSections();

        return page;
    }

    _buildAboutPage() {
        const page = new Adw.PreferencesPage({ title: 'About', icon_name: 'help-about-symbolic' });
        const meta = this.metadata;

        const group = new Adw.PreferencesGroup();
        page.add(group);

        group.add(new Adw.ActionRow({ title: meta.name || 'Pear Up' }));
        // The release as people name it. `version` is the integer GNOME compares,
        // which reads as "2" for 0.2.0; it is what is left where there is no name.
        group.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: String(meta['version-name'] ?? meta.version ?? ''),
        }));

        const descRow = new Adw.ActionRow({ title: 'Description', subtitle: meta.description || '' });
        descRow.set_subtitle_lines(0);
        group.add(descRow);

        if (meta.url) {
            const urlRow = new Adw.ActionRow({ title: 'Homepage', subtitle: meta.url, activatable: true });
            urlRow.connect('activated', () => {
                Gio.AppInfo.launch_default_for_uri(meta.url, null);
            });
            group.add(urlRow);

            const issuesUrl = meta.url.replace(/\/$/, '') + '/issues';
            const bugRow = new Adw.ActionRow({ title: 'Report a Bug', subtitle: issuesUrl, activatable: true });
            bugRow.connect('activated', () => {
                Gio.AppInfo.launch_default_for_uri(issuesUrl, null);
            });
            group.add(bugRow);
        }

        const noteGroup = new Adw.PreferencesGroup({ title: 'Notes' });
        page.add(noteGroup);

        const iconsNote = new Adw.ActionRow({
            title: 'Distro icons',
            subtitle: 'Bundled distro logos are trademarks of their respective owners, included ' +
                'only to represent each distribution/project in the icon picker.',
        });
        iconsNote.set_subtitle_lines(0);
        noteGroup.add(iconsNote);

        return page;
    }
}

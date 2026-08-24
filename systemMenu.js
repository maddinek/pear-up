// Pear Up carries parts of this System Menu from Global Menu for GNOME by
// ShiroOSL (https://github.com/ShiroOSL/global-menu-for-gnome),
// GPL-3.0-or-later. Heavily modified here; see the project README's Credits
// for what remains theirs and what changed.
import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import { spawnCommandLine } from './util.js';
import { recentSections, clearRecent } from './recentItems.js';
import { ForceQuitPicker } from './forceQuit.js';

// The panel role this button is registered under. Shared, because the menu bar
// has to know where it sits in order to line up beside it.
export const LOGO_ROLE = 'pearup-logo';

// Returns the first command (configured choice first, then fallbacks) whose
// target actually exists on this system, or null if none do.
function findAvailableCommand(preferred, fallbacks) {
    let candidates = [preferred, ...fallbacks].filter(Boolean);
    for (let cmd of candidates) {
        try {
            let [, argv] = GLib.shell_parse_argv(cmd);
            if (!argv || !argv[0])
                continue;

            // "flatpak run <app-id>" passes the argv[0] check whenever the
            // flatpak binary exists, whether or not the app is installed.
            // Look the app up through its desktop file instead; a pattern this
            // cannot verify keeps the plain argv[0] check.
            let appId = flatpakRunAppId(argv);
            if (appId) {
                // The shell's app database is the one source of "is this
                // installed" that exists on every supported release —
                // DesktopAppInfo's statics were split off to GioUnix.
                try {
                    if (!Shell.AppSystem.get_default().lookup_app(`${appId}.desktop`))
                        continue;
                } catch {
                    // App database unavailable; assume it is there.
                }
            } else if (!GLib.find_program_in_path(argv[0])) {
                continue;
            }

            return cmd;
        } catch {
            // Malformed command string; skip it.
        }
    }
    return null;
}

// Matches "flatpak run <app-id>" and "flatpak-spawn --host run <app-id>",
// returning the app id, or null for anything else.
function flatpakRunAppId(argv) {
    let i = 0;
    if (argv[0] === 'flatpak-spawn') {
        i = 1;
        while (i < argv.length && argv[i].startsWith('--'))
            i++;
    }

    if (argv[i] === 'flatpak' && argv[i + 1] === 'run' && argv[i + 2])
        return argv[i + 2];
    return null;
}

const TERMINAL_FALLBACKS = ['ptyxis', 'gnome-terminal', 'kgx', 'konsole', 'kitty', 'alacritty', 'tilix', 'terminator', 'xterm'];
const SOFTWARE_CENTER_FALLBACKS = ['flatpak run io.github.kolunmi.Bazaar', 'gnome-software', 'plasma-discover', 'pamac-manager', 'snap-store'];
const SYSTEM_MONITOR_FALLBACKS = ['missioncenter-helper', 'gnome-system-monitor', 'resources', 'ksysguard', 'xfce4-taskmanager'];

// Icon names in preference order. Adwaita has dropped and renamed a great many
// legacy names across these releases, and a name that is not in the theme draws
// as a missing-image glyph, so every item names alternatives and the first one
// actually present wins.
const ICONS = {
    about: ['computer-symbolic', 'help-about-symbolic'],
    settings: ['preferences-system-symbolic', 'emblem-system-symbolic'],
    software: ['system-software-install-symbolic', 'shop-symbolic', 'org.gnome.Software-symbolic'],
    extensions: ['application-x-addon-symbolic', 'org.gnome.Extensions-symbolic', 'preferences-desktop-apps-symbolic'],
    activities: ['view-grid-symbolic', 'focus-windows-symbolic'],
    appGrid: ['view-app-grid-symbolic', 'view-grid-symbolic'],
    monitor: ['utilities-system-monitor-symbolic', 'speedometer-symbolic'],
    terminal: ['utilities-terminal-symbolic', 'terminal-symbolic'],
    recent: ['document-open-recent-symbolic', 'clock-symbolic'],
    clear: ['user-trash-symbolic', 'edit-clear-symbolic'],
    forceQuit: ['process-stop-symbolic', 'window-close-symbolic'],
    sleep: ['weather-clear-night-symbolic', 'night-light-symbolic', 'system-suspend-symbolic'],
    restart: ['system-reboot-symbolic', 'view-refresh-symbolic'],
    shutDown: ['system-shutdown-symbolic'],
    lock: ['system-lock-screen-symbolic', 'changes-prevent-symbolic'],
    logOut: ['system-log-out-symbolic', 'go-previous-symbolic'],
    custom: ['application-x-executable-symbolic', 'system-run-symbolic'],
};

// Where GNOME keeps the bindings macOS prints beside these same items. Read
// rather than hardcoded, so the menu shows the shortcut this system has.
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';

const MODIFIER_LABELS = [
    [/<(Control|Primary|Ctrl)>/g, 'Ctrl+'],
    [/<Shift>/g, 'Shift+'],
    [/<Alt>/g, 'Alt+'],
    [/<Super>/g, 'Super+'],
];

const KEY_LABELS = {
    Delete: 'Del',
    Escape: 'Esc',
    Return: 'Enter',
    space: 'Space',
};

// "<Super>l" is what the setting holds; "Super+L" is what a menu should say.
function formatAccelerator(accel) {
    if (!accel)
        return null;

    let text = accel;
    for (const [pattern, label] of MODIFIER_LABELS)
        text = text.replace(pattern, label);

    // Anything left in angle brackets is a modifier this does not know; drop
    // the brackets rather than printing them.
    text = text.replace(/<([^>]*)>/g, '$1+');

    const key = text.split('+').pop();
    const shown = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    return text.slice(0, text.length - key.length) + shown;
}

function schemaExists(id) {
    return !!Gio.SettingsSchemaSource.get_default()?.lookup(id, true);
}

export const SystemMenuButton = GObject.registerClass(
  class SystemMenuButton extends PanelMenu.Button {
    _init(settings, extensionPath) {
        super._init(0.5, 'System Menu');

        this.add_style_class_name('pearup-system-menu');
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._systemActions = SystemActions.getDefault();

        this._icon = new St.Icon({
            style_class: 'pearup-logo-icon system-status-icon',
        });
        this.add_child(this._icon);

        this._picker = new ForceQuitPicker();

        this._syncIcon();
        this._rebuildMenu();

        this._settings.connectObject('changed', (_settings, key) => {
            if (['logo-icon-name', 'logo-custom-icon-path', 'logo-distro-icon',
                 'logo-distro-icon-symbolic', 'logo-icon-size'].includes(key)) {
                this._syncIcon();
            } else if (['hide-overview-button', 'show-system-settings', 'show-app-grid',
                        'show-software-center', 'show-system-monitor', 'show-terminal',
                        'show-extensions-app', 'show-force-quit', 'show-power-options',
                        'show-lock-screen', 'show-log-out', 'show-recent-items',
                        'system-menu-custom-items', 'system-menu-font-size'].includes(key)) {
                this._rebuildMenu();
            }
        }, this);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _syncIcon() {
        let size = this._settings.get_int('logo-icon-size');
        if (size > 0) this._icon.icon_size = size;

        let customPath = this._settings.get_string('logo-custom-icon-path');
        if (customPath) {
            let file = Gio.File.new_for_path(customPath);
            if (file.query_exists(null)) {
                this._icon.gicon = Gio.icon_new_for_string(customPath);
                return;
            }
        }

        let distroIcon = this._settings.get_string('logo-distro-icon');
        if (distroIcon) {
            let variant = this._settings.get_boolean('logo-distro-icon-symbolic') ? 'symbolic' : 'color';
            let bundledPath = GLib.build_filenamev([this._extensionPath, 'icons', `distro-${distroIcon}-${variant}.svg`]);
            let file = Gio.File.new_for_path(bundledPath);
            if (!file.query_exists(null)) {
                // Fall back to the other variant if this distro doesn't
                // ship the requested one (e.g. GNOME has color only).
                let otherVariant = variant === 'symbolic' ? 'color' : 'symbolic';
                bundledPath = GLib.build_filenamev([this._extensionPath, 'icons', `distro-${distroIcon}-${otherVariant}.svg`]);
                file = Gio.File.new_for_path(bundledPath);
            }
            if (file.query_exists(null)) {
                this._icon.gicon = Gio.icon_new_for_string(bundledPath);
                return;
            }
        }

        let iconName = this._settings.get_string('logo-icon-name') || 'start-here-symbolic';
        this._icon.icon_name = iconName;
    }

    // The macOS Apple menu, group for group: what the system is, where it is
    // configured, what was open recently, how to abandon a hung application,
    // the power actions, and the two ways to leave the session.
    //
    // Groups are collected before anything is added so the separators fall
    // between the groups that survived. Building them inline instead is how a
    // menu ends up opening with a separator on top, or two in a row, whenever
    // a setting is turned off.
    _rebuildMenu() {
        this.menu.removeAll();
        this._iconTheme = this._newIconTheme();

        const setting = key => this._settings.get_boolean(key);

        const settingsGroup = [];
        // This extension's own preferences are deliberately not listed here.
        // They belong in GNOME Settings beside Appearance, but nothing can put
        // them there: gnome-control-center compiles every panel in and has no
        // plugin interface. The Extensions item is where GNOME expects
        // extension preferences to be reached, so it is the entry point.
        if (setting('show-system-settings'))
            settingsGroup.push(() => this._addItem('System Settings…', ICONS.settings, () => this._openSystemSettings()));
        if (setting('show-software-center'))
            settingsGroup.push(() => this._addItem('Software Center', ICONS.software, () => this._launchOrNotify('software-center-command', SOFTWARE_CENTER_FALLBACKS, 'Software Center')));
        if (setting('show-extensions-app'))
            settingsGroup.push(() => this._addItem('Extensions', ICONS.extensions, () => this._openExtensionsApp()));
        // Only offer an "Activities" entry when the real panel button is
        // hidden, so overview access is never lost entirely.
        if (setting('hide-overview-button'))
            settingsGroup.push(() => this._addItem('Activities', ICONS.activities, () => Main.overview.toggle()));
        if (setting('show-app-grid'))
            settingsGroup.push(() => this._addItem('App Grid', ICONS.appGrid, () => this._showAppGrid()));
        if (setting('show-system-monitor'))
            settingsGroup.push(() => this._addItem('System Monitor', ICONS.monitor, () => this._launchOrNotify('system-monitor-command', SYSTEM_MONITOR_FALLBACKS, 'System Monitor')));
        if (setting('show-terminal'))
            settingsGroup.push(() => this._addItem('Terminal', ICONS.terminal, () => this._launchOrNotify('terminal-command', TERMINAL_FALLBACKS, 'Terminal')));

        const recentGroup = setting('show-recent-items')
            ? [() => this._addRecentItems()]
            : [];

        const forceQuitGroup = setting('show-force-quit')
            ? [() => this._addItem('Force Quit…', ICONS.forceQuit, () => this._forceQuit())]
            : [];

        const customGroup = this._loadCustomItems().map(item =>
            () => this._addItem(item.label || '(untitled)', ICONS.custom, () => spawnCommandLine(item.value)));

        // These throw outright when the action is unavailable — restricted by
        // lockdown, or no suspend support — so ask first and grey the item out
        // rather than offering something that fails on click.
        const powerGroup = setting('show-power-options') ? [
            () => this._addSystemAction('Sleep', ICONS.sleep, 'canSuspend', 'activateSuspend'),
            () => this._addSystemAction('Restart…', ICONS.restart, 'canRestart', 'activateRestart'),
            () => this._addSystemAction('Shut Down…', ICONS.shutDown, 'canPowerOff', 'activatePowerOff'),
        ] : [];

        const sessionGroup = [];
        if (setting('show-lock-screen')) {
            sessionGroup.push(() => this._addSystemAction(
                'Lock Screen', ICONS.lock, 'canLockScreen', 'activateLockScreen',
                this._acceleratorFor('screensaver')));
        }
        if (setting('show-log-out')) {
            const name = this._userName();
            sessionGroup.push(() => this._addSystemAction(
                name ? `Log Out ${name}…` : 'Log Out…',
                ICONS.logOut, 'canLogout', 'activateLogout',
                this._acceleratorFor('logout')));
        }

        const groups = [
            [() => this._addItem('About This System', ICONS.about, () => this._aboutThisSystem())],
            settingsGroup,
            recentGroup,
            forceQuitGroup,
            customGroup,
            powerGroup,
            sessionGroup,
        ].filter(group => group.length > 0);

        groups.forEach((group, index) => {
            if (index > 0)
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            group.forEach(add => add());
        });

        this._applyMenuSize();
    }

    // The pear menu's type size is a setting; File/Edit stay at the shell's.
    // Applied as inline style because the amount has to change without a
    // stylesheet reload, and because a class per size is eight classes for a
    // slider.
    _applyMenuSize() {
        const px = this._settings.get_int('system-menu-font-size');
        this.menu.box.set_style(`font-size: ${px}px;`);
    }

    // GNOME's popup-menu-icon is 16px at the default 13px type. Keep that
    // ratio so a smaller menu does not leave oversized glyphs next to the text.
    _menuIconSize() {
        const px = this._settings.get_int('system-menu-font-size');
        return Math.max(12, Math.min(20, Math.round(px * 16 / 13)));
    }

    // Built by hand rather than with PopupImageMenuItem, because these items
    // carry a third child — the shortcut, right-aligned — and because an item
    // with no icon still needs the icon's width, or its label would not line up
    // with the ones above it.
    _makeItem(label, iconNames, onActivate, accelerator = null) {
        const item = new PopupMenu.PopupBaseMenuItem();

        const icon = new St.Icon({
            style_class: 'popup-menu-icon',
            icon_size: this._menuIconSize(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        const iconName = this._resolveIcon(iconNames);
        if (iconName)
            icon.icon_name = iconName;
        else if (iconNames instanceof Gio.Icon)
            icon.gicon = iconNames;
        item.add_child(icon);

        const text = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(text);
        item.label_actor = text;

        if (accelerator) {
            item.add_child(new St.Label({
                text: accelerator,
                style_class: 'pearup-menu-accel',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        if (onActivate)
            item.connect('activate', onActivate);

        return item;
    }

    _addItem(label, iconNames, activateFunction, accelerator = null) {
        const item = this._makeItem(label, iconNames, activateFunction, accelerator);
        this.menu.addMenuItem(item);
        return item;
    }

    // A theme handle per rebuild: checking icon names one at a time against a
    // freshly constructed theme would re-read the icon caches for every item.
    _newIconTheme() {
        try {
            return St.IconTheme ? new St.IconTheme() : null;
        } catch {
            return null;
        }
    }

    _resolveIcon(iconNames) {
        if (!Array.isArray(iconNames))
            return null;
        if (!this._iconTheme)
            return iconNames[0] ?? null;

        return iconNames.find(name => this._iconTheme.has_icon(name)) ?? null;
    }

    // The list changes with every file opened anywhere on the system, so it is
    // rebuilt each time the menu around it opens.
    //
    // Not when the submenu itself opens, which is the obvious place for it:
    // PopupSubMenu.open() returns early for an empty menu, so a submenu that
    // fills itself on the way open stays empty and therefore never opens.
    _addRecentItems() {
        const submenu = new PopupMenu.PopupSubMenuMenuItem('Recent Items', true);
        const iconName = this._resolveIcon(ICONS.recent);
        if (iconName)
            submenu.icon.icon_name = iconName;

        if (submenu.icon)
            submenu.icon.icon_size = this._menuIconSize();

        this._fillRecentItems(submenu.menu);
        this.menu.connectObject('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._fillRecentItems(submenu.menu);
        }, submenu);

        this.menu.addMenuItem(submenu);
        return submenu;
    }

    _fillRecentItems(menu) {
        menu.removeAll();

        const limit = this._settings.get_int('recent-items-limit');
        const sections = recentSections(limit);

        if (sections.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No Recent Items', { activate: false });
            empty.setSensitive(false);
            menu.addMenuItem(empty);
            return;
        }

        for (const section of sections) {
            const heading = new PopupMenu.PopupMenuItem(section.heading, { activate: false });
            heading.setSensitive(false);
            heading.label.add_style_class_name('pearup-menu-heading');
            menu.addMenuItem(heading);

            for (const entry of section.items) {
                menu.addMenuItem(this._makeItem(
                    entry.label,
                    entry.gicon ?? [entry.iconName],
                    entry.activate));
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addMenuItem(this._makeItem('Clear Menu', ICONS.clear, () => clearRecent()));
    }

    // `available` is the SystemActions property that says whether the action can
    // run; when it cannot, show the item disabled instead of letting the call
    // throw out of the click handler.
    _addSystemAction(label, iconNames, available, method, accelerator = null) {
        let actions = this._systemActions;
        let usable = actions?.[available] !== false;

        let item = this._addItem(label, iconNames, () => {
            try {
                actions[method]();
            } catch (e) {
                Main.notify('Pear Up', `${label.replace(/…$/, '')} is not available.`);
                console.warn(`[pear-up] ${method} failed: ${e}`);
            }
        }, accelerator);

        if (!usable)
            item.setSensitive(false);

        return item;
    }

    // macOS names the account in the item — "Log Out Martin…" — which is also
    // the only way to tell which session you are ending on a shared machine.
    _userName() {
        const real = GLib.get_real_name();
        if (real && real !== 'Unknown')
            return real;

        // No full name recorded, so the account name has to do — capitalised,
        // because "Log Out martin…" reads like a typo.
        const account = GLib.get_user_name() ?? '';
        return account ? account[0].toUpperCase() + account.slice(1) : '';
    }

    // The bindings for these live in GNOME's media-keys settings, as string
    // lists that are empty when nothing is bound.
    //
    // The settings object is kept rather than built per lookup: every menu
    // rebuild asks for several accelerators, and each fresh Gio.Settings
    // re-reads the schema source.
    _mediaKeysSettings() {
        if (!this._mediaKeys) {
            if (!schemaExists(MEDIA_KEYS_SCHEMA))
                return null;

            try {
                this._mediaKeys = new Gio.Settings({ schema_id: MEDIA_KEYS_SCHEMA });
            } catch {
                return null;
            }
        }
        return this._mediaKeys;
    }

    _acceleratorFor(key) {
        const settings = this._mediaKeysSettings();
        if (!settings)
            return null;

        try {
            if (!settings.settings_schema.has_key(key))
                return null;

            return formatAccelerator(settings.get_strv(key).find(Boolean));
        } catch {
            return null;
        }
    }

    _loadCustomItems() {
        try {
            let items = JSON.parse(this._settings.get_string('system-menu-custom-items') || '[]');
            return Array.isArray(items) ? items.filter(item => item && item.value) : [];
        } catch {
            return [];
        }
    }

    _launchOrNotify(settingKey, fallbacks, label) {
        let configured = this._settings.get_string(settingKey);
        let resolved = findAvailableCommand(configured, fallbacks);
        if (!resolved) {
            Main.notify('Pear Up', `No ${label} application found. Set one in Preferences.`);
            return;
        }

        // The command exists but refused to run; say so rather than fail
        // silently behind a click.
        if (!spawnCommandLine(resolved))
            Main.notify('Pear Up', `Could not launch ${label}.`);
    }

    _aboutThisSystem() {
        spawnCommandLine('gnome-control-center system about');
    }

    _openSystemSettings() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('org.gnome.Settings.desktop') ||
                  appSys.lookup_app('gnome-control-center.desktop');
        if (app) {
            try {
                app.activate();
                return;
            } catch {
                // Desktop file present but unusable; fall through to the binary.
            }
        }
        spawnCommandLine('gnome-control-center');
    }

    // The dash and its button are private-ish and a dock replacement may not
    // expose them, so fall back to simply opening the overview.
    _showAppGrid() {
        let showAppsButton = Main.overview?.dash?.showAppsButton;
        if (showAppsButton) {
            showAppsButton.checked = true;
            Main.overview.show();
            return;
        }
        Main.overview?.toggle();
    }

    _openExtensionsApp() {
        let appSys = Shell.AppSystem.get_default();
        let preferredId = this._settings.get_string('extensions-app-id') || 'org.gnome.Extensions.desktop';
        let app = appSys.lookup_app(preferredId) ||
                  appSys.lookup_app('org.gnome.Extensions.desktop') ||
                  appSys.lookup_app('com.mattjakeman.ExtensionManager.desktop');
        if (app) {
            try {
                app.activate();
            } catch {
                spawnCommandLine('gnome-extensions-app');
            }
        } else {
            spawnCommandLine('gnome-extensions-app');
        }
    }

    _forceQuit() {
        // Close first: the picker needs the pointer, and the menu is still
        // holding it until this activate handler returns.
        this.menu.close();
        this._picker.begin();
    }

    _onDestroy() {
        this._picker?.destroy();
        this._picker = null;
        this._settings = null;
        this._systemActions = null;
        this._extensionPath = null;
        this._mediaKeys = null;
        this._icon = null;
        this._iconTheme = null;
    }
  }
);

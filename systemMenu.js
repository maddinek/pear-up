import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

function spawnCommandLine(commandLine) {
    try {
        let [, argv] = GLib.shell_parse_argv(commandLine);
        GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    } catch (e) {
        console.error(`[pear-up] Failed to launch '${commandLine}': ${e}`);
    }
}

// Returns the first command (configured choice first, then fallbacks) whose
// executable actually exists on this system, or null if none do.
function findAvailableCommand(preferred, fallbacks) {
    let candidates = [preferred, ...fallbacks].filter(Boolean);
    for (let cmd of candidates) {
        try {
            let [, argv] = GLib.shell_parse_argv(cmd);
            if (argv && argv[0] && GLib.find_program_in_path(argv[0]))
                return cmd;
        } catch (e) {
            // Malformed command string; skip it.
        }
    }
    return null;
}

const TERMINAL_FALLBACKS = ['ptyxis', 'gnome-terminal', 'kgx', 'konsole', 'kitty', 'alacritty', 'tilix', 'terminator', 'xterm'];
const SOFTWARE_CENTER_FALLBACKS = ['flatpak run io.github.kolunmi.Bazaar', 'gnome-software', 'plasma-discover', 'pamac-manager', 'snap-store'];
const SYSTEM_MONITOR_FALLBACKS = ['missioncenter-helper', 'gnome-system-monitor', 'resources', 'ksysguard', 'xfce4-taskmanager'];

export const SystemMenuButton = GObject.registerClass(
  class SystemMenuButton extends PanelMenu.Button {
    // `extension` supplies the display name and a way to open this extension's
    // own preferences, so the menu does not have to know how either works.
    _init(settings, extensionPath, extension = null) {
        super._init(0.5, 'System Menu');

        this.add_style_class_name('pearup-system-menu');
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._extension = extension;
        this._systemActions = SystemActions.getDefault();

        this._icon = new St.Icon({
            style_class: 'pearup-logo-icon system-status-icon',
        });
        this.add_child(this._icon);

        this._syncIcon();
        this._rebuildMenu();

        this._settings.connectObject('changed', (_settings, key) => {
            if (['logo-icon-name', 'logo-custom-icon-path', 'logo-distro-icon',
                 'logo-distro-icon-symbolic', 'logo-icon-size'].includes(key)) {
                this._syncIcon();
            } else if (['hide-overview-button', 'show-system-settings',
                        'show-extension-settings', 'show-app-grid',
                        'show-software-center', 'show-system-monitor', 'show-terminal',
                        'show-extensions-app', 'show-force-quit', 'show-power-options',
                        'show-lock-screen', 'show-log-out', 'system-menu-custom-items'].includes(key)) {
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

    _rebuildMenu() {
        this.menu.removeAll();

        const hideOverview = this._settings.get_boolean('hide-overview-button');
        const showSystemSettings = this._settings.get_boolean('show-system-settings');
        const showExtensionSettings = this._settings.get_boolean('show-extension-settings');
        const showAppGrid = this._settings.get_boolean('show-app-grid');
        const showSoftwareCenter = this._settings.get_boolean('show-software-center');
        const showSystemMonitor = this._settings.get_boolean('show-system-monitor');
        const showTerminal = this._settings.get_boolean('show-terminal');
        const showExtensionsApp = this._settings.get_boolean('show-extensions-app');
        const showForceQuit = this._settings.get_boolean('show-force-quit');
        const showPowerOptions = this._settings.get_boolean('show-power-options');
        const showLockScreen = this._settings.get_boolean('show-lock-screen');
        const showLogOut = this._settings.get_boolean('show-log-out');

        this._addItem('About This System', () => this._aboutThisSystem());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Settings sits directly below About, where macOS keeps it, with this
        // extension's own preferences alongside — otherwise the only way to
        // reach them is to know which extension this menu belongs to.
        if (showSystemSettings)
            this._addItem('System Settings', () => this._openSystemSettings());

        if (showExtensionSettings && this._extension) {
            let name = this._extension.metadata?.name ?? 'Extension';
            this._addItem(`${name} Settings...`, () => this._openExtensionSettings());
        }

        // Only offer an "Activities" menu entry when the real panel button
        // is hidden, so overview access is never lost entirely.
        if (hideOverview)
            this._addItem('Activities', () => Main.overview.toggle());

        if (showAppGrid)
            this._addItem('App Grid', () => this._showAppGrid());

        if (showSystemSettings || showExtensionSettings || hideOverview || showAppGrid)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (showSoftwareCenter)
            this._addItem('Software Center', () => this._launchOrNotify('software-center-command', SOFTWARE_CENTER_FALLBACKS, 'Software Center'));
        if (showSystemMonitor)
            this._addItem('System Monitor', () => this._launchOrNotify('system-monitor-command', SYSTEM_MONITOR_FALLBACKS, 'System Monitor'));
        if (showTerminal)
            this._addItem('Terminal', () => this._launchOrNotify('terminal-command', TERMINAL_FALLBACKS, 'Terminal'));
        if (showExtensionsApp)
            this._addItem('Extensions', () => this._openExtensionsApp());

        if (showForceQuit) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addItem('Force Quit App', () => this._forceQuit());
        }

        let customItems = this._loadCustomItems();
        if (customItems.length > 0) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            customItems.forEach(item => {
                this._addItem(item.label || '(untitled)', () => spawnCommandLine(item.value));
            });
        }

        if (showPowerOptions || showLockScreen || showLogOut)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // These throw outright when the action is unavailable — restricted by
        // lockdown, or no suspend support — so check first and grey the item
        // out rather than offering something that fails on click.
        if (showPowerOptions) {
            this._addSystemAction('Sleep', 'canSuspend', 'activateSuspend');
            this._addSystemAction('Restart...', 'canRestart', 'activateRestart');
            this._addSystemAction('Shut Down...', 'canPowerOff', 'activatePowerOff');
        }

        if (showLockScreen)
            this._addSystemAction('Lock Screen', 'canLockScreen', 'activateLockScreen');

        if (showLogOut)
            this._addSystemAction('Log Out...', 'canLogout', 'activateLogout');
    }

    _addItem(label, activateFunction) {
        let item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', activateFunction);
        this.menu.addMenuItem(item);
        return item;
    }

    // `available` is the SystemActions property that says whether the action can
    // run; when it cannot, show the item disabled instead of letting the call
    // throw out of the click handler.
    _addSystemAction(label, available, method) {
        let actions = this._systemActions;
        let usable = actions?.[available] !== false;

        let item = this._addItem(label, () => {
            try {
                actions[method]();
            } catch (e) {
                Main.notify('Pear Up', `${label.replace(/\.\.\.$/, '')} is not available.`);
                console.warn(`[pear-up] ${method} failed: ${e}`);
            }
        });

        if (!usable)
            item.setSensitive(false);

        return item;
    }

    _loadCustomItems() {
        try {
            let items = JSON.parse(this._settings.get_string('system-menu-custom-items') || '[]');
            return Array.isArray(items) ? items.filter(item => item && item.value) : [];
        } catch (e) {
            return [];
        }
    }

    _launchOrNotify(settingKey, fallbacks, label) {
        let configured = this._settings.get_string(settingKey);
        let resolved = findAvailableCommand(configured, fallbacks);
        if (resolved) {
            spawnCommandLine(resolved);
        } else {
            Main.notify('System Menu', `No ${label} application found. Set one in Preferences.`);
        }
    }

    _aboutThisSystem() {
        spawnCommandLine('gnome-control-center system about');
    }

    _openExtensionSettings() {
        try {
            this._extension.openPreferences();
        } catch (e) {
            Main.notify('Pear Up', 'Could not open the preferences window.');
            console.warn(`[pear-up] openPreferences failed: ${e}`);
        }
    }

    _openSystemSettings() {
        let appSys = Shell.AppSystem.get_default();
        let app = appSys.lookup_app('org.gnome.Settings.desktop') ||
                  appSys.lookup_app('gnome-control-center.desktop');
        if (app) {
            try {
                app.activate();
                return;
            } catch (e) {
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
            } catch (e) {
                spawnCommandLine('gnome-extensions-app');
            }
        } else {
            spawnCommandLine('gnome-extensions-app');
        }
    }

    _forceQuit() {
        let window = global.display.get_focus_window();
        if (!window) {
            Main.notify('Force Quit', 'No focused window to quit.');
            return;
        }
        try {
            window.kill();
        } catch (e) {
            console.error(`[pear-up] Force Quit failed: ${e}`);
        }
    }

    _onDestroy() {
        this._settings = null;
        this._systemActions = null;
        this._extensionPath = null;
        this._extension = null;
        this._icon = null;
    }
  }
);

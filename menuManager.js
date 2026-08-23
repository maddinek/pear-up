import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { LOGO_ROLE } from './systemMenu.js';
import {
    isFileManager,
    compactMenuItems,
    fileMenu,
    editMenu,
    viewMenu,
    goMenu,
    windowMenu,
    helpMenu,
} from './menuTemplates.js';

// Error logging is gated behind the "debug-logging" setting (off by
// default) so the extension doesn't spam the journal in normal use.
// MenuManager keeps this in sync with the setting; toggled live.
let debugLoggingEnabled = false;

function logError(message) {
    if (debugLoggingEnabled) console.error(message);
}

// Spawn a command safely using an argv array so no shell parsing/injection
// can occur, and so arguments with spaces or special characters are passed
// through intact.
// Menu entries that work by sending the shortcut the focused application
// already listens for. Written as accelerators rather than scan codes so they
// follow the user's keyboard layout.
const SYNTHESISED_SHORTCUTS = {
    'copy': '<Control>c',
    'paste': '<Control>v',
    'cut': '<Control>x',
    'undo': '<Control>z',
    'redo': '<Control>y',
    'select-all': '<Control>a',
    'new-tab': '<Control>t',
    'print': '<Control>p',
    'emoji-picker': '<Control>period',
    'toggle-fullscreen': 'F11',
    'go-back': '<Alt>Left',
    'go-forward': '<Alt>Right',
    'delete-item': 'Delete',
    'virtual-open': 'Return',
    'properties': '<Alt>Return',
    'native-open-with': '<Shift>F10',
};

// Chosen from the context menu opened by Shift+F10 above. This assumes an
// English menu, so it will miss in other languages.
const OPEN_WITH_MNEMONIC = 'h';

function spawnCommand(argv) {
    try {
        GLib.spawn_async(
            null,
            argv,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );
    } catch (e) {
        logError(`[pear-up] Failed to spawn '${argv.join(' ')}': ${e}`);
    }
}

const TopLevelMenuButton = GObject.registerClass(
  class TopLevelMenuButton extends PanelMenu.Button {
    _init(label, children, appInstance = null, isAppMenu = false, refreshChildren = null) {
      super._init(0.5, label);
      this._appInstance = appInstance;
      this._refreshChildren = refreshChildren;
      this._timeoutIds = [];
      this._virtualDevice = null;

      this.add_style_class_name('pearup-menu-button');
      if (isAppMenu)
          this.add_style_class_name('pearup-app-menu');

      // GNOME 50 PanelMenu.Button has no `.label` at all. Keep a local
      // handle so we never touch `.clutter_text` on undefined.
      const titleLabel = this.label ?? new St.Label({
          text: label,
          y_align: Clutter.ActorAlign.CENTER,
          style_class: 'panel-button-label',
      });
      if (!this.label) {
          this.label = titleLabel;
          this.add_child(titleLabel);
      }
      if (titleLabel.clutter_text)
          titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
      titleLabel.add_style_class_name('panel-button-label');
      titleLabel.set_style('max-width: none;');
      this.x_expand = false;

      this._buildSubMenu(children, this.menu);

      if (this.menu) {
          this.menu.connectObject('open-state-changed', (menu, isOpen) => {
              // The menu bar is rebuilt when the focused app changes, so items
              // derived from window state — the list of open windows and their
              // titles — are otherwise a snapshot from whenever that happened.
              // Titles change constantly, so refresh them on the way open.
              if (isOpen && this._refreshChildren) {
                  menu.removeAll();
                  this._buildSubMenu(this._refreshChildren(), menu);
              }
              this._alignMenuToLeft();
          }, this);
      }

      // Cleanup has to hang off the signal, not an overridden destroy():
      // actors are also destroyed from the C side, when a parent goes away or
      // the shell shuts down, and that path never calls the JS method. A timer
      // outliving the button would type into whatever has focus by then.
      this.connect('destroy', () => {
          for (const id of this._timeoutIds)
              GLib.source_remove(id);
          this._timeoutIds = [];
          this._virtualDevice = null;
      });
    }

    _alignMenuToLeft() {
        if (!this.menu || !this.menu.actor) return;
        try {
            let buttonWidth = Math.round(this.get_width() || 0);
            let menuWidth = Math.round(this.menu.actor.get_width() || 0);
            if (buttonWidth <= 0 || menuWidth <= 0) return;

            // GNOME centres the menu under the button; macOS aligns its left
            // edge with the button's, which this offset undoes.
            let offset = Math.round((menuWidth - buttonWidth) / 2);

            // Clamp so the menu never gets pushed off-screen near a
            // monitor edge (matters most on smaller/secondary displays).
            let [buttonX] = this.get_transformed_position();
            let monitor = Main.layoutManager.findMonitorForActor(this) ||
                          Main.layoutManager.primaryMonitor;
            if (monitor) {
                // Measure from where the menu will actually sit once the offset
                // is applied, which for a left-aligned menu is the button's own
                // left edge.
                let menuLeft = buttonX;
                let menuRight = menuLeft + menuWidth;
                if (menuLeft < monitor.x)
                    offset -= (monitor.x - menuLeft);
                else if (menuRight > monitor.x + monitor.width)
                    offset += (menuRight - (monitor.x + monitor.width));
            }

            this.menu.actor.translation_x = offset;
        } catch (e) {
            logError(`[pear-up] Error aligning menu: ${e}`);
        }
    }

    _executeNativeAction(action) {
        let display = global.display;
        let window = display.get_focus_window();

        if (action === "close") {
            // File → Close Window and Window → Close. One window, the focused
            // one. Quit is a different action; it used to share this id, which
            // took every window of the app with it.
            if (window)
                window.delete(global.get_current_time());
            return true;
        } else if (action === "quit") {
            if (this._appInstance) {
                for (const win of this._appInstance.get_windows()) {
                    try {
                        win.delete(global.get_current_time());
                    } catch (e) {
                        logError(`[pear-up] Failed to close window: ${e}`);
                    }
                }
            } else if (window) {
                window.delete(global.get_current_time());
            }
            return true;
        } else if (action === "minimize") {
            if (window) window.minimize();
            return true;
        } else if (action === "maximize") {
            if (window) this._toggleMaximized(window);
            return true;
        }

        if (action.startsWith("custom-command:")) {
            let cmd = action.slice("custom-command:".length);
            try {
                let [, argv] = GLib.shell_parse_argv(cmd);
                spawnCommand(argv);
            } catch (e) {
                logError(`[pear-up] Invalid custom command '${cmd}': ${e}`);
            }
            return true;
        }

        if (action.startsWith("custom-shortcut:")) {
            let accel = action.slice("custom-shortcut:".length);
            this._sendAccelerator(accel);
            return true;
        }

        if (action.startsWith("activate-window:")) {
            let winId = action.split(":")[1];
            if (this._appInstance) {
                let appWindows = this._appInstance.get_windows();
                let targetWin = appWindows.find(w => w.get_id().toString() === winId);
                if (targetWin) {
                    targetWin.activate(global.get_current_time());
                    return true;
                }
            }
            return false;
        }

        if (action === "new-app-window") {
            if (this._appInstance) {
                this._appInstance.open_new_window(-1);
                return true;
            }
            return false;
        }

        if (action.startsWith("app-details:")) {
            let appId = action.split(":")[1];
            // The shell's app database is the one source of "is this
            // installed" that exists on every supported release —
            // DesktopAppInfo's statics were split off to GioUnix.
            if (appId && Shell.AppSystem.get_default().lookup_app(appId)) {
                spawnCommand(['gnome-software', `--details=${appId}`]);
                return true;
            }
            if (appId) {
                // A desktop id guessed from wm_class usually resolves to
                // nothing, and gnome-software would open into a void.
                Main.notify('Pear Up', `Could not identify “${appId}” as an installed application.`);
                return true;
            }
        }

        if (action === "new-file-manager-win") {
            // Opening the home folder raises whichever window already shows it
            // rather than adding one, so ask the app for a window and only fall
            // back to the folder when there is no app to ask.
            if (this._appInstance) {
                this._appInstance.open_new_window(-1);
                return true;
            }
            spawnCommand(['xdg-open', GLib.get_home_dir()]);
            return true;
        }

        try {
            if (action === "open-file-manager" || action === "go-home") {
                spawnCommand(['xdg-open', GLib.get_home_dir()]);
                return true;
            } else if (action === "new-folder") {
                this._createNewFolder();
                return true;
            } else if (action === "open-settings") {
                spawnCommand(['gnome-control-center']);
                return true;
            } else if (action === "empty-bin") {
                spawnCommand(['gio', 'trash', '--empty']);
                return true;
            } else if (action === "open-system-help") {
                spawnCommand(['yelp']);
                return true;
            } else if (action === "go-recents") {
                spawnCommand(['xdg-open', 'recent:///']);
                return true;
            } else if (action === "go-documents") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || `${GLib.get_home_dir()}/Documents`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-desktop") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) || `${GLib.get_home_dir()}/Desktop`;
                spawnCommand(['xdg-open', path]);
                return true;
            } else if (action === "go-downloads") {
                let path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || `${GLib.get_home_dir()}/Downloads`;
                spawnCommand(['xdg-open', path]);
                return true;
            }
        } catch (e) {
            logError(`[pear-up] Process execution error: ${e}`);
        }

        // Everything below is "press the shortcut the focused app already
        // has", since there is no portable way to invoke an app's menu item
        // directly. Accelerators are given as text and sent as keyvals, so
        // they land on the right key whatever the keyboard layout — sending
        // raw scan codes would trigger whatever sits in that physical position
        // on AZERTY or Dvorak.
        const accel = SYNTHESISED_SHORTCUTS[action];
        if (!accel)
            return false;

        if (action === 'native-open-with') {
            // Open the context menu, then pick its "Open With" entry once it
            // has had a moment to appear.
            this._sendAccelerator(accel);
            let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._timeoutIds = this._timeoutIds.filter(id => id !== timeoutId);
                this._sendAccelerator(OPEN_WITH_MNEMONIC);
                return GLib.SOURCE_REMOVE;
            });
            this._timeoutIds.push(timeoutId);
            return true;
        }

        this._sendAccelerator(accel);
        return true;
    }

    // is_maximized() and the argument-less maximize()/unmaximize() arrived in
    // mutter 49. On older shells the state is a flags getter and the calls take
    // a direction, so pick whichever this one provides.
    _toggleMaximized(window) {
        const maximized = typeof window.is_maximized === 'function'
            ? window.is_maximized()
            : window.get_maximized() !== 0;

        if (maximized) {
            if (window.unmaximize.length > 0)
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            else
                window.unmaximize();
        } else if (window.maximize.length > 0) {
            window.maximize(Meta.MaximizeFlags.BOTH);
        } else {
            window.maximize();
        }
    }

    // One device per button, created on first use and released with it.
    _virtualKeyboard() {
        if (this._virtualDevice)
            return this._virtualDevice;

        try {
            let seat = Clutter.get_default_backend().get_default_seat();
            this._virtualDevice = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
        } catch (e) {
            logError(`[pear-up] Could not create a virtual keyboard: ${e}`);
            this._virtualDevice = null;
        }

        return this._virtualDevice;
    }

    // Turns a GTK-style accelerator ("<Control><Alt>t") into a keyval and a
    // list of modifier keyvals. Clutter has no accelerator parser — only
    // keyval_name in the opposite direction — and Gdk is not available inside
    // the shell, so do it here. Returns null when the key cannot be resolved.
    _parseAccelerator(accel) {
        const modifiers = {
            control: Clutter.KEY_Control_L,
            primary: Clutter.KEY_Control_L,
            ctrl: Clutter.KEY_Control_L,
            shift: Clutter.KEY_Shift_L,
            alt: Clutter.KEY_Alt_L,
            mod1: Clutter.KEY_Alt_L,
            super: Clutter.KEY_Super_L,
            meta: Clutter.KEY_Super_L,
        };

        let rest = accel.trim();
        let modKeyvals = [];
        let match;
        while ((match = /^<([A-Za-z0-9]+)>/.exec(rest)) !== null) {
            const keyval = modifiers[match[1].toLowerCase()];
            if (keyval === undefined) {
                logError(`[pear-up] Unknown modifier '<${match[1]}>' in '${accel}'`);
                return null;
            }
            if (!modKeyvals.includes(keyval))
                modKeyvals.push(keyval);
            rest = rest.slice(match[0].length);
        }

        if (rest.length === 0)
            return null;

        // Single printable characters are their own keyval; anything longer is
        // a key name as spelled in Clutter's KEY_ constants.
        let keyval = rest.length === 1
            ? rest.toLowerCase().charCodeAt(0)
            : Clutter[`KEY_${rest}`];

        if (typeof keyval !== 'number') {
            logError(`[pear-up] Unknown key '${rest}' in '${accel}'`);
            return null;
        }

        return { keyval, modKeyvals };
    }

    // Sends an arbitrary GTK-style accelerator as a real key event, for
    // user-defined custom shortcuts.
    _sendAccelerator(accel) {
        const parsed = this._parseAccelerator(accel);
        if (!parsed) {
            Main.notify('Pear Up', `Could not understand the shortcut “${accel}”.`);
            return;
        }

        const { keyval, modKeyvals } = parsed;
        const device = this._virtualKeyboard();
        if (!device)
            return;

        // notify_keyval wants millisecond event stamps comparable to
        // global.get_current_time(), not the microseconds get_monotonic_time().
        let time = global.get_current_time();
        const press = k => {
            device.notify_keyval(time, k, Clutter.KeyState.PRESSED);
            time += 5;
        };
        const release = k => {
            device.notify_keyval(time, k, Clutter.KeyState.RELEASED);
            time += 5;
        };

        try {
            modKeyvals.forEach(press);
            press(keyval);
            release(keyval);
        } catch (e) {
            logError(`[pear-up] Failed to send accelerator '${accel}': ${e}`);
        } finally {
            // Always let the modifiers go: leaving one pressed would wedge the
            // keyboard for the rest of the session.
            for (const k of modKeyvals.slice().reverse()) {
                try {
                    release(k);
                } catch {
                    // Nothing more can be done for this one.
                }
            }
        }
    }

    _createNewFolder() {
        try {
            let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP)
                || `${GLib.get_home_dir()}/Desktop`;
            let baseName = "Untitled Folder";
            let folderName = baseName;
            let counter = 2;
            let file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));

            while (file.query_exists(null)) {
                folderName = `${baseName} ${counter}`;
                file = Gio.File.new_for_path(GLib.build_filenamev([desktopPath, folderName]));
                counter++;
            }

            file.make_directory(null);
        } catch (e) {
            logError(`[pear-up] Failed to create new folder: ${e}`);
        }
    }

    _buildSubMenu(menuItems, parentMenu) {
      for (const item of compactMenuItems(menuItems)) {
        if (item.type === "separator") {
          parentMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        } else if (item.type === "section-header") {
          let headerItem = new PopupMenu.PopupMenuItem(item.label, { activate: false });
          headerItem.setSensitive(false);
          headerItem.label.add_style_class_name('pearup-menu-heading');
          parentMenu.addMenuItem(headerItem);
        } else if (item.type === "submenu") {
          const subMenu = new PopupMenu.PopupSubMenuMenuItem(item.label);
          this._buildSubMenu(item.children, subMenu.menu);
          parentMenu.addMenuItem(subMenu);
        } else {
          const menuItem = new PopupMenu.PopupMenuItem(item.label);
          if (item.enabled === false) {
            menuItem.setSensitive(false);
          } else if (item.action) {
            menuItem.connect("activate", () => {
              this._executeNativeAction(item.action);
            });
          }
          parentMenu.addMenuItem(menuItem);
        }
      }
    }

  }
);

export class MenuManager {
    constructor(uuid, settings) {
        this.uuid = uuid;
        this._settings = settings;
        this._buttons = [];
        // Shell chrome only — not the file manager. A visible Nautilus
        // window should still get File/Edit/View like any other app.
        this._blacklist = ['gjs', 'org.gnome.gjs', 'gnome-shell', 'mutter'];

        debugLoggingEnabled = settings.get_boolean('debug-logging');
        this._debugLoggingChangedId = settings.connect('changed::debug-logging', () => {
            debugLoggingEnabled = settings.get_boolean('debug-logging');
        });
        this._barChromeIds = [
            settings.connect('changed::menu-bar-font-size', () => this._applyBarChrome()),
            settings.connect('changed::menu-bar-padding', () => this._applyBarChrome()),
        ];
    }

    // True when a normal window is actually in front, not minimized to
    // the dock / another workspace. GNOME often keeps the last window as
    // focus-window after minimize-all, which used to leave "Nautilus" stuck
    // on the bar.
    _isFrontmostWindow(window) {
        if (!window)
            return false;
        try {
            if (window.minimized)
                return false;
            if (typeof window.showing_on_its_workspace === 'function' &&
                !window.showing_on_its_workspace())
                return false;
            if (window.get_window_type() !== Meta.WindowType.NORMAL)
                return false;
        } catch {
            return false;
        }
        return true;
    }

    updateMenuForWindow(window) {
        let appName = this._settings.get_string('desktop-app-name') || 'Nautilus';
        let isAppFocused = false;
        let desktopId = "";
        let detectedApp = null;
        let wmClass = "";

        if (this._isFrontmostWindow(window)) {
            let windowType = window.get_window_type();

            if (windowType === Meta.WindowType.NORMAL) {
                let tracker = Shell.WindowTracker.get_default();
                detectedApp = tracker.get_window_app(window);

                let checkId = detectedApp ? (detectedApp.get_id() || "") : "";
                let checkName = detectedApp ? (detectedApp.get_name() || "") : "";
                wmClass = window.get_wm_class() || "";
                // Blacklist entries match identity fields only — id, name,
                // wm_class. A window title like "Debugging gjs" must not trip
                // a blacklist entry of "gjs".
                let combinedIdentifiers = `${checkId} ${checkName} ${wmClass}`.toLowerCase();

                let isBlacklisted = this._blacklist.some(item =>
                    combinedIdentifiers.includes(item.toLowerCase())
                );

                if (!isBlacklisted && (detectedApp || wmClass)) {
                    if (detectedApp) {
                        appName = detectedApp.get_name();
                        desktopId = detectedApp.get_id();
                        isAppFocused = true;
                    } else if (wmClass) {
                        appName = wmClass.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        desktopId = wmClass.toLowerCase() + ".desktop";
                        isAppFocused = true;
                    }
                } else {
                    detectedApp = null;
                }
            }
        }

        let fileManagerName = this._settings.get_string('desktop-app-name') || 'Nautilus';
        let isFiles = isFileManager(desktopId, wmClass);

        // Nothing in front: keep the System Menu (pear) and any custom
        // menus, but do not pretend Nautilus/Finder is the focused app.
        if (!isAppFocused) {
            this.clear();
            this._buildCustomMenus().forEach((item, index) => {
                let btn = new TopLevelMenuButton(item.label, item.children, null, false);
                Main.panel.addToStatusArea(`${this.uuid}-${index}`, btn, this._slotFor(index), 'left');
                this._buttons.push(btn);
            });
            this._applyBarChrome();
            return;
        }

        const appMenuChildren = () =>
            this._appMenuChildren(detectedApp, appName, desktopId);
        let firstMenuChildren = appMenuChildren();

        let menuData = [];

        if (this._settings.get_boolean('menu-app-enabled')) {
            menuData.push({ type: "submenu", label: appName, children: firstMenuChildren });
        }

        if (this._settings.get_boolean('menu-file-enabled'))
            menuData.push(fileMenu(isFiles, fileManagerName));
        if (this._settings.get_boolean('menu-edit-enabled'))
            menuData.push(editMenu());
        if (this._settings.get_boolean('menu-view-enabled'))
            menuData.push(viewMenu());
        if (this._settings.get_boolean('menu-go-enabled'))
            menuData.push(goMenu(isFiles));
        if (this._settings.get_boolean('menu-window-enabled'))
            menuData.push(windowMenu());
        if (this._settings.get_boolean('menu-help-enabled'))
            menuData.push(helpMenu());

        menuData.push(...this._buildCustomMenus());

        this.clear();

        menuData.forEach((item, index) => {
            let isAppMenu = this._settings.get_boolean('menu-app-enabled') && index === 0;
            let refresh = isAppMenu ? appMenuChildren : null;
            let btn = new TopLevelMenuButton(item.label, item.children, detectedApp, isAppMenu, refresh);
            Main.panel.addToStatusArea(`${this.uuid}-${index}`, btn, this._slotFor(index), 'left');
            this._buttons.push(btn);
        });
        this._applyBarChrome();
    }

    // Type size and title padding are settings. Applied as inline style
    // because they have to change with the slider, not on a stylesheet reload.
    _applyBarChrome() {
        const px = this._settings.get_int('menu-bar-font-size');
        const pad = this._settings.get_int('menu-bar-padding');
        for (const btn of this._buttons) {
            btn.set_style(
                `padding: 0 ${pad}px; -natural-hpadding: 0px; -minimum-hpadding: 0px;`);
            btn.label?.set_style(`font-size: ${px}px;`);
            if (btn.menu?.box)
                btn.menu.box.set_style(`font-size: ${px}px;`);
        }
    }

    // Where the nth menu goes: immediately after the System Menu button,
    // wherever the panel has actually put it.
    //
    // This used to be `index + 1`, which assumed our own button owned slot 0.
    // It does not: any extension that claims the left edge first takes that
    // slot, and then every menu inserted at a fixed index pushes our button one
    // place further right. On Bazzite, whose distro logo menu does exactly that,
    // the System Menu ended up ninth — behind the whole menu bar.
    _slotFor(index) {
        const box = Main.panel._leftBox;
        const logo = Main.panel.statusArea[LOGO_ROLE]?.container;
        if (!box || !logo)
            return index;

        const after = box.get_children().indexOf(logo) + 1;
        return (after > 0 ? after : 0) + index;
    }

    // The application menu, rebuilt from live window state each time it opens.
    _appMenuChildren(detectedApp, appName, desktopId) {
        const children = [];

        const openWindows = detectedApp?.get_windows() ?? [];
        if (openWindows.length > 0) {
            children.push({ type: "section-header", label: "Open Windows" });
            for (const win of openWindows) {
                children.push({
                    label: win.get_title() || appName,
                    action: `activate-window:${win.get_id()}`,
                });
            }
            children.push({ type: "separator" });
        }

        children.push(
            { label: "New Window", action: "new-app-window" },
            { type: "separator" },
            { label: "App Details", action: `app-details:${desktopId}` },
            { type: "separator" },
            { label: `Quit ${appName}`, action: "quit" }
        );

        return children;
    }

    _buildCustomMenus() {
        let raw = this._settings.get_string('custom-menus') || '[]';
        let sections;
        try {
            sections = JSON.parse(raw);
        } catch {
            // Hand-edited JSON, or a setting written by an older version.
            sections = [];
        }

        return sections
            .filter(section => section && section.enabled !== false)
            .map(section => {
                let items = Array.isArray(section.items) ? section.items : [];
                let children = items
                    .filter(entry => entry && entry.value)
                    .map(entry => ({
                        label: entry.label || '(untitled)',
                        action: entry.kind === 'shortcut'
                            ? `custom-shortcut:${entry.value}`
                            : `custom-command:${entry.value}`,
                    }));

                if (children.length === 0) {
                    children.push({
                        label: 'No items configured',
                        enabled: false,
                        placeholder: true,
                    });
                }

                return { type: "submenu", label: section.label || 'Custom', children };
            });
    }

    // Panel roles we claimed but no longer track. If an earlier manager
    // instance was dropped without clearing — a disable/enable race, or an
    // enable() that threw part-way through building the bar — its buttons stay
    // parented to the panel while our _buttons array is empty. Those actors
    // can then never be removed, and the role name stays taken so the next
    // addToStatusArea() for it throws. Sweeping by role keeps clear() the
    // single source of truth.
    _sweepOrphanedRoles() {
        let prefix = `${this.uuid}-`;
        for (let role of Object.keys(Main.panel.statusArea)) {
            if (!role.startsWith(prefix))
                continue;

            let indicator = Main.panel.statusArea[role];
            if (this._buttons.includes(indicator))
                continue;

            try {
                // The panel's own destroy handler frees the role name, so only
                // clear it by hand if the actor refused to go — otherwise an
                // undestroyed button would be left parented with nothing
                // tracking it.
                indicator.destroy();
            } catch (e) {
                logError(`Failed to destroy orphaned menu button ${role}: ${e}`);
                continue;
            }
            delete Main.panel.statusArea[role];
        }
    }

    clear() {
        // One button throwing must not strand the rest on the panel.
        this._buttons.forEach(btn => {
            try {
                btn.destroy();
            } catch (e) {
                logError(`Failed to destroy menu button: ${e}`);
            }
        });
        this._buttons = [];
        this._sweepOrphanedRoles();
    }

    destroy() {
        if (this._settings && this._debugLoggingChangedId) {
            this._settings.disconnect(this._debugLoggingChangedId);
            this._debugLoggingChangedId = null;
        }
        if (this._settings && this._barChromeIds) {
            for (const id of this._barChromeIds)
                this._settings.disconnect(id);
            this._barChromeIds = [];
        }
        this.clear();
    }
}

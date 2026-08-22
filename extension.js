import Gio from 'gi://Gio';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { MenuManager } from './menuManager.js';
import { SystemMenuButton } from './systemMenu.js';

// Panel layout differs from macOS in a few fixed ways; each of these is a
// separate toggle so nothing about the stock top bar is changed silently.
const PANEL_TWEAK_KEYS = [
    'clock-on-the-right',
    'hide-power-button',
    'hide-panel-spacers',
    'group-spotlight-with-quick-settings',
];

// GNOME reserves room in the right cluster for indicators that are inactive
// most of the time. macOS has no equivalent, and they leave a visible gap.
const SPACER_ROLES = [
    'screenRecording',
    'screenSharing',
    'dwellClick',
    'a11y',
    'keyboard',
];

export default class GlobalMenuExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._menuManager = null;
        this._settings = null;
        this._settingsChangedId = null;
        this._logoButton = null;
        this._overviewHidden = false;
        this._stylesheet = null;
        this._clockMoved = false;
        this._clockSessionBackup = null;
        this._powerHidden = null;
        this._powerVisibleId = 0;
        this._hiddenSpacers = [];
        this._spotlightMoved = null;
        this._minimizedWindow = null;
        this._minimizedId = 0;
        this._minimizedGoneId = 0;
    }

    // Everything that reaches into GNOME's private panel internals goes
    // through here. Those members can be renamed or removed between shell
    // versions, and a throw escaping enable() would leave the panel half
    // rearranged with no way to put it back.
    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[${this.metadata.uuid}] ${what} failed: ${e}`);
        }
    }

    enable() {
        console.log(`[${this.metadata.uuid}] Enabling extension.`);

        this._settings = this.getSettings();

        this._menuManager = new MenuManager(this.metadata.uuid, this._settings);

        const ICON_ONLY_KEYS = ['logo-icon-name', 'logo-custom-icon-path', 'logo-distro-icon', 'logo-distro-icon-symbolic', 'logo-icon-size'];

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'hide-overview-button') {
                this._syncOverviewButton();
            } else if (key === 'show-logo-menu') {
                this._syncLogoButton();
            } else if (PANEL_TWEAK_KEYS.includes(key)) {
                this._syncPanelTweaks();
            } else if (!ICON_ONLY_KEYS.includes(key)) {
                // Any other key (menu toggles, custom menus, indicator,
                // logo-menu item toggles) affects what the bar should show
                // right now. Icon-only keys are handled internally by
                // SystemMenuButton itself.
                this._syncMenuVisibility();
            }
        });

        global.display.connectObject('notify::focus-window', () => {
            this._syncMenuVisibility();
        }, this);
        global.window_manager.connectObject(
            'minimize', () => this._syncMenuVisibility(),
            'unminimize', () => this._syncMenuVisibility(),
            this
        );
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._syncMenuVisibility();
        }, this);

        this._loadStylesheet();
        Main.panel.add_style_class_name('pearup-panel');
        this._syncPanelTweaks();

        this._syncLogoButton();
        this._syncOverviewButton();
        this._syncMenuVisibility();
    }

    // Apply or undo each panel tweak to match its setting. Safe to call again
    // at any time, so a toggle in preferences takes effect immediately.
    _syncPanelTweaks() {
        // A queued signal can still arrive after disable() has run.
        if (!this._settings)
            return;

        const clockOnRight = this._settings.get_boolean('clock-on-the-right');
        const clockWasMoved = this._clockMoved;
        if (clockOnRight && !this._clockMoved)
            this._guard('moving the clock', () => this._moveClockToRight());
        else if (!clockOnRight && this._clockMoved)
            this._guard('restoring the clock', () => this._restoreClock());

        if (this._settings.get_boolean('hide-power-button'))
            this._guard('hiding the power icon', () => this._hidePowerButton());
        else
            this._guard('showing the power icon', () => this._showPowerButton());

        if (this._settings.get_boolean('hide-panel-spacers'))
            this._guard('hiding panel indicators', () => this._hideSpacers());
        else
            this._guard('showing panel indicators', () => this._showSpacers());

        // Spotlight has to be repositioned after the clock, because moving the
        // clock rebuilds the panel boxes.
        if (this._settings.get_boolean('group-spotlight-with-quick-settings'))
            this._guard('grouping Spotlight', () => this._groupSpotlightWithQuickSettings());
        else
            this._guard('restoring Spotlight', () => this._restoreSpotlightPosition());

        // Rebuilding the panel drops buttons this extension added, so put the
        // System Menu and the app menus back.
        if (clockWasMoved !== this._clockMoved && this._menuManager) {
            if (this._logoButton) {
                this._logoButton.destroy();
                this._logoButton = null;
            }
            this._syncLogoButton();
            this._syncMenuVisibility();
        }
    }

    // Rebuilding the panel replaces the actors we were holding, so anything
    // remembered from before is stale: without this, re-applying a tweak would
    // see a non-empty cache, skip the work, and let the new power glyph or
    // indicators stay visible.
    _forgetPanelActors() {
        if (this._powerHidden && this._powerVisibleId) {
            try {
                this._powerHidden.disconnect(this._powerVisibleId);
            } catch (e) {
                // Already destroyed along with the old panel.
            }
        }
        this._powerVisibleId = 0;
        this._powerHidden = null;
        this._hiddenSpacers = [];
        this._spotlightMoved = null;
    }

    _rebuildPanel() {
        if (typeof Main.panel._updatePanel !== 'function')
            return false;
        Main.panel._updatePanel();
        this._forgetPanelActors();
        return true;
    }

    _hideSpacers() {
        if (this._hiddenSpacers.length > 0)
            return;

        for (const role of SPACER_ROLES) {
            const item = Main.panel.statusArea[role];
            const actor = item?.container ?? item;
            if (actor?.hide) {
                actor.hide();
                this._hiddenSpacers.push(actor);
            }
        }
    }

    _showSpacers() {
        for (const actor of this._hiddenSpacers) {
            try {
                actor.show();
            } catch (e) {
                // Destroyed with a panel rebuild; nothing left to reveal.
            }
        }
        this._hiddenSpacers = [];
    }

    // macOS keeps Spotlight immediately beside the Control Center icons.
    _groupSpotlightWithQuickSettings() {
        if (this._spotlightMoved)
            return;

        const rightBox = Main.panel._rightBox;
        const quickSettings = Main.panel.statusArea.quickSettings?.container;
        const spotlight = this._findSpotlightIndicator(rightBox);
        if (!rightBox || !quickSettings || !spotlight || spotlight === quickSettings)
            return;

        const parent = spotlight.get_parent();
        if (!parent)
            return;

        this._spotlightMoved = {
            actor: spotlight,
            parent,
            index: parent.get_children().indexOf(spotlight),
        };

        parent.remove_child(spotlight);
        const quickSettingsIndex = rightBox.get_children().indexOf(quickSettings);
        if (quickSettingsIndex >= 0)
            rightBox.insert_child_at_index(spotlight, quickSettingsIndex);
        else
            rightBox.add_child(spotlight);
    }

    _restoreSpotlightPosition() {
        if (!this._spotlightMoved)
            return;

        const { actor, parent, index } = this._spotlightMoved;
        this._spotlightMoved = null;
        if (!actor || !parent)
            return;

        try {
            const current = actor.get_parent();
            if (current)
                current.remove_child(actor);

            if (index >= 0 && index < parent.get_children().length)
                parent.insert_child_at_index(actor, index);
            else
                parent.add_child(actor);
        } catch (e) {
            // Either actor or its old parent is gone; Search Light will place
            // its own button again when it is next enabled.
        }
    }

    // Search Light adds a bare St.Button rather than registering a status area
    // role, so it is the one child of the right box we cannot name.
    _findSpotlightIndicator(rightBox) {
        if (!rightBox?.get_children)
            return null;

        const claimed = new Set();
        const statusArea = Main.panel.statusArea ?? {};
        for (const role of Object.keys(statusArea)) {
            const container = statusArea[role]?.container;
            if (container)
                claimed.add(container);
        }

        for (const child of rightBox.get_children()) {
            if (!claimed.has(child))
                return child;
        }
        return null;
    }

    // GNOME 42+ puts the clock in the center. macOS has it on the far
    // right, with speaker/network/etc immediately to its left.
    // Must update sessionMode.panel then _updatePanel(), otherwise Shell
    // restores the centered dateMenu on the next layout pass.
    _moveClockToRight() {
        let layout = Main.sessionMode?.panel;
        if (!layout) {
            this._moveClockFallback();
            return;
        }

        this._clockSessionBackup = {
            left: layout.left.slice(),
            center: layout.center.slice(),
            right: layout.right.slice(),
        };

        layout.center = layout.center.filter(item => item !== 'dateMenu');
        layout.right = layout.right.filter(item => item !== 'dateMenu');
        layout.right.push('dateMenu');
        if (!this._rebuildPanel()) {
            // Without a rebuild the shell keeps drawing the old layout, so fall
            // back to reparenting the clock by hand.
            this._clockSessionBackup = null;
            this._moveClockFallback();
            return;
        }
        this._clockMoved = true;
    }

    // The power glyph is the indicator icon inside the Quick Settings system
    // item. Hiding the whole item would take the battery readout with it, and
    // collapsing it in CSS only stops it reserving space — it still paints,
    // over the clock. So hide that one actor, and keep it hidden: GNOME re-runs
    // its own visibility sync whenever the battery or recording state changes.
    _hidePowerButton() {
        if (this._powerHidden)
            return;

        let system = Main.panel.statusArea.quickSettings?._system;
        let indicator = system?._indicator ?? system;
        if (!indicator?.hide)
            return;

        indicator.hide();
        this._powerVisibleId = indicator.connect('notify::visible', () => {
            if (indicator.visible)
                indicator.hide();
        });
        this._powerHidden = indicator;
    }

    _showPowerButton() {
        if (!this._powerHidden)
            return;

        try {
            if (this._powerVisibleId)
                this._powerHidden.disconnect(this._powerVisibleId);
            this._powerHidden.show();
        } catch (e) {
            // Destroyed with a panel rebuild; nothing to restore.
        }

        this._powerVisibleId = 0;
        this._powerHidden = null;
    }

    _moveClockFallback() {
        let container = Main.panel.statusArea.dateMenu?.container;
        let target = Main.panel._rightBox;
        if (!container || !target)
            return;

        let parent = container.get_parent();
        if (!parent)
            return;

        parent.remove_child(container);
        target.add_child(container);
        this._clockMoved = true;
    }

    _restoreClock() {
        if (!this._clockMoved)
            return;

        let layout = Main.sessionMode?.panel;
        if (layout && this._clockSessionBackup) {
            layout.left = this._clockSessionBackup.left.slice();
            layout.center = this._clockSessionBackup.center.slice();
            layout.right = this._clockSessionBackup.right.slice();
            this._rebuildPanel();
        } else {
            let container = Main.panel.statusArea.dateMenu?.container;
            let target = Main.panel._centerBox;
            if (container && target) {
                let parent = container.get_parent();
                if (parent)
                    parent.remove_child(container);
                target.add_child(container);
            }
        }

        this._clockMoved = false;
        this._clockSessionBackup = null;
    }

    _loadStylesheet() {
        let cssFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
        if (!cssFile.query_exists(null))
            return;

        // A stylesheet the current shell cannot parse must not stop the rest of
        // the extension from starting.
        this._guard('loading the stylesheet', () => {
            let themeContext = St.ThemeContext.get_for_stage(global.stage);
            themeContext.get_theme().load_stylesheet(cssFile);
            this._stylesheet = cssFile;
        });
    }

    _unloadStylesheet() {
        if (!this._stylesheet)
            return;

        this._guard('unloading the stylesheet', () => {
            let themeContext = St.ThemeContext.get_for_stage(global.stage);
            themeContext.get_theme().unload_stylesheet(this._stylesheet);
        });
        this._stylesheet = null;
    }

    _syncLogoButton() {
        if (!this._settings)
            return;

        let shouldShow = this._settings.get_boolean('show-logo-menu');

        if (shouldShow && !this._logoButton) {
            // A previous failed enable() can leave this role occupied.
            let existing = Main.panel.statusArea['pearup-logo'];
            if (existing)
                existing.destroy();
            this._logoButton = new SystemMenuButton(this._settings, this.path);
            Main.panel.addToStatusArea('pearup-logo', this._logoButton, 0, 'left');
        } else if (!shouldShow && this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }
    }

    _syncOverviewButton() {
        let activities = Main.panel.statusArea['activities'];
        if (!activities || !this._settings) return;

        let shouldHide = this._settings.get_boolean('hide-overview-button');
        if (shouldHide && !this._overviewHidden) {
            activities.hide();
            this._overviewHidden = true;
        } else if (!shouldHide && this._overviewHidden) {
            activities.show();
            this._overviewHidden = false;
        }
    }

    _syncMenuVisibility() {
        if (!this._menuManager || !this._settings) return;

        this._unwatchMinimized();

        if (this._settings.get_boolean('show-indicator')) {
            let activeWindow = global.display.get_focus_window();
            this._watchMinimized(activeWindow);
            this._menuManager.updateMenuForWindow(activeWindow);
        } else {
            this._menuManager.clear();
        }
    }

    // Catches a window being minimized programmatically, which the window
    // manager's own minimize signal does not always cover. Meta.Window is not
    // one of the types the shell auto-disconnects for, so drop the reference
    // when the window goes away rather than holding a dead object.
    _watchMinimized(window) {
        this._minimizedWindow = window;
        if (!window)
            return;

        this._minimizedId = window.connect('notify::minimized',
            () => this._syncMenuVisibility());
        this._minimizedGoneId = window.connect('unmanaged',
            () => this._unwatchMinimized());
    }

    _unwatchMinimized() {
        let window = this._minimizedWindow;
        this._minimizedWindow = null;

        for (const id of [this._minimizedId, this._minimizedGoneId]) {
            if (!window || !id)
                continue;
            try {
                window.disconnect(id);
            } catch (e) {
                // Window already gone; its handlers went with it.
            }
        }

        this._minimizedId = 0;
        this._minimizedGoneId = 0;
    }

    disable() {
        console.log(`[${this.metadata.uuid}] Disabling extension.`);

        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._unwatchMinimized();

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._menuManager) {
            this._menuManager.destroy();
            this._menuManager = null;
        }

        if (this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }

        if (this._overviewHidden) {
            let activities = Main.panel.statusArea['activities'];
            if (activities) activities.show();
            this._overviewHidden = false;
        }

        this._restoreSpotlightPosition();
        this._showSpacers();
        this._restoreClock();
        this._showPowerButton();
        Main.panel.remove_style_class_name('pearup-panel');
        this._unloadStylesheet();

        this._settings = null;
    }
}

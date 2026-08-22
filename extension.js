import GLib from 'gi://GLib';
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
// Roughly ten seconds of waiting for Quick Settings to finish building.
const POWER_RETRY_LIMIT = 20;

// Only these change what the menu bar contains. Anything else — an icon, a
// command string, a System Menu item — is handled where it is used, so the bar
// is not torn down and rebuilt for it.
const MENU_CONTENT_KEYS = [
    'show-indicator',
    'desktop-app-name',
    'menu-app-enabled',
    'menu-file-enabled',
    'menu-edit-enabled',
    'menu-view-enabled',
    'menu-go-enabled',
    'menu-window-enabled',
    'menu-help-enabled',
    'custom-menus',
];

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
        this._clockMoved = false;
        this._clockSessionBackup = null;
        this._clockLayout = null;
        this._powerHidden = null;
        this._powerVisibleId = 0;
        this._powerDestroyId = 0;
        this._powerRetryId = 0;
        this._powerRetries = 0;
        this._sessionModeId = 0;
        this._resyncId = 0;
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
        // GNOME does not call disable() when enable() throws: it just logs and
        // marks the extension broken, leaving whatever was already applied in
        // place until the next logout. Undo it here instead.
        try {
            this._enable();
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    _enable() {
        console.log(`[${this.metadata.uuid}] Enabling extension.`);

        this._settings = this.getSettings();
        this._powerRetries = 0;
        this._hiddenSpacers = [];
        this._spotlightMoved = null;
        this._overviewHidden = false;

        this._menuManager = new MenuManager(this.metadata.uuid, this._settings);

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'hide-overview-button')
                this._syncOverviewButton();
            else if (key === 'show-logo-menu')
                this._syncLogoButton();
            else if (PANEL_TWEAK_KEYS.includes(key))
                this._syncPanelTweaks();
            else if (MENU_CONTENT_KEYS.includes(key))
                this._syncMenuVisibility();
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

        // The shell rebuilds the panel whenever the session mode changes —
        // during startup, and on unlock — which discards our arrangement.
        this._sessionModeId = Main.sessionMode.connect('updated',
            () => this._queuePanelResync());

        // stylesheet.css is loaded by the shell itself for every enabled
        // extension, so there is nothing to do here but claim the class it
        // keys off.
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

        // A rebuild also re-shows the Activities button.
        this._guard('syncing the Activities button', () => this._syncOverviewButton());

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
        this._releasePowerButton();
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

    // Per-actor rather than "have we run", so a rebuilt panel gets its new
    // indicators hidden too instead of being skipped.
    _hideSpacers() {
        for (const role of SPACER_ROLES) {
            const item = Main.panel.statusArea[role];
            const actor = item?.container ?? item;
            if (!actor?.hide || this._hiddenSpacers.includes(actor))
                continue;
            actor.hide();
            this._hiddenSpacers.push(actor);
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
    // role, so it cannot be looked up by name. Match on its own styling, and
    // give up rather than grab whatever else is unaccounted for — moving
    // another extension's actor would be worse than doing nothing.
    _findSpotlightIndicator(rightBox) {
        if (!rightBox?.get_children)
            return null;

        const looksLikeSearch = actor => {
            const names = [actor.name, actor.style_class, ...(actor.get_style_class_name?.() ?? '').split(' ')];
            return names.some(name => typeof name === 'string' && name.toLowerCase().includes('search'));
        };

        for (const child of rightBox.get_children()) {
            if (looksLikeSearch(child))
                return child;
            // Search Light's button is wrapped, so check one level in too.
            const inner = child.get_first_child?.();
            if (inner && looksLikeSearch(inner))
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

        // Keep the object we edit, not just its contents. Session modes are
        // separate objects, and locking the screen switches to a mode this
        // extension does not run in — so by the time disable() arrives,
        // sessionMode.panel is the lock screen's layout. Writing our backup
        // into that one would give the lock screen an Activities button and a
        // clock, and leave the real layout still modified.
        this._clockLayout = layout;
        this._clockSessionBackup = {
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
        let system = Main.panel.statusArea.quickSettings?._system;
        let indicator = system?._indicator ?? system;
        if (!indicator?.hide) {
            // Quick Settings exists before its system item does, so during
            // login there is nothing to hide yet. Come back for it.
            this._retryHidePowerButton();
            return;
        }

        // Compare against the actor rather than just "have we run", because a
        // panel rebuild replaces it and leaves us holding a destroyed one.
        if (this._powerHidden === indicator)
            return;

        this._releasePowerButton();

        indicator.hide();
        this._powerVisibleId = indicator.connect('notify::visible', () => {
            if (indicator.visible)
                indicator.hide();
        });
        // The shell rebuilds the panel more than once while starting up, so the
        // icon hidden during enable() is often not the one left on screen.
        this._powerDestroyId = indicator.connect('destroy',
            () => this._queuePanelResync());
        this._powerHidden = indicator;
    }

    // The system item is built asynchronously while the shell starts, and
    // nothing announces its arrival, so poll briefly rather than give up.
    _retryHidePowerButton() {
        if (this._powerRetryId || this._powerRetries >= POWER_RETRY_LIMIT)
            return;

        this._powerRetries++;
        this._powerRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._powerRetryId = 0;
            if (this._settings?.get_boolean('hide-power-button'))
                this._guard('hiding the power icon', () => this._hidePowerButton());
            return GLib.SOURCE_REMOVE;
        });
    }

    // Forget the icon without revealing it: used when swapping to a newer one.
    _releasePowerButton() {
        if (!this._powerHidden)
            return;

        for (const id of [this._powerVisibleId, this._powerDestroyId]) {
            if (!id)
                continue;
            try {
                this._powerHidden.disconnect(id);
            } catch (e) {
                // Destroyed with the old panel.
            }
        }

        this._powerVisibleId = 0;
        this._powerDestroyId = 0;
        this._powerHidden = null;
    }

    // Re-apply the tweaks once the current batch of panel changes has settled.
    _queuePanelResync() {
        if (this._resyncId)
            return;

        this._resyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._resyncId = 0;
            this._guard('re-applying panel tweaks', () => this._syncPanelTweaks());
            return GLib.SOURCE_REMOVE;
        });
    }

    _showPowerButton() {
        let indicator = this._powerHidden;
        this._releasePowerButton();

        try {
            indicator?.show();
        } catch (e) {
            // Destroyed with a panel rebuild; nothing to restore.
        }
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

        let layout = this._clockLayout;
        if (layout && this._clockSessionBackup) {
            // Only the two lists that were edited, so a layout change made by
            // something else meanwhile is left alone.
            layout.center = this._clockSessionBackup.center.slice();
            layout.right = this._clockSessionBackup.right.slice();

            // Rebuilding only makes sense while that layout is the live one.
            if (layout === Main.sessionMode?.panel)
                this._rebuildPanel();
            else
                this._forgetPanelActors();
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
        this._clockLayout = null;
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

    // Driven by what is actually on screen rather than by a remembered flag,
    // because a panel rebuild shows every indicator again and a flag-based
    // check would decide there was nothing to do.
    _syncOverviewButton() {
        if (!this._settings)
            return;

        let activities = Main.panel.statusArea['activities'];
        let actor = activities?.container ?? activities;
        if (!actor)
            return;

        if (this._settings.get_boolean('hide-overview-button')) {
            actor.hide();
            this._overviewHidden = true;
        } else if (this._overviewHidden) {
            actor.show();
            this._overviewHidden = false;
        }
    }

    _showOverviewButton() {
        if (!this._overviewHidden)
            return;

        let activities = Main.panel.statusArea['activities'];
        let actor = activities?.container ?? activities;
        actor?.show();
        this._overviewHidden = false;
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

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        for (const source of ['_resyncId', '_powerRetryId']) {
            if (this[source]) {
                GLib.source_remove(this[source]);
                this[source] = 0;
            }
        }

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

        // Each step is guarded separately: these touch actors this extension
        // does not own, and extensions are torn down in reverse order, so one
        // of them may already be gone. A throw here would abandon the rest of
        // the cleanup and leave the panel rearranged.
        this._guard('restoring Spotlight', () => this._restoreSpotlightPosition());
        this._guard('showing panel indicators', () => this._showSpacers());
        this._guard('showing the Activities button', () => this._showOverviewButton());
        this._guard('restoring the clock', () => this._restoreClock());
        this._guard('showing the power icon', () => this._showPowerButton());
        this._guard('dropping the panel style', () =>
            Main.panel.remove_style_class_name('pearup-panel'));

        this._settings = null;
    }
}

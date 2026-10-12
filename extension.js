import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { MenuManager } from './menuManager.js';
import { SystemMenuButton, LOGO_ROLE } from './systemMenu.js';
import { SearchButton } from './searchButton.js';
import { DockMagnifier } from './dockMagnifier.js';
import { ShellTweaks, SHELL_TWEAK_KEYS } from './shellTweaks.js';
import { SmoothBrightness, SMOOTH_BRIGHTNESS_KEY } from './smoothBrightness.js';
import { WindowAnimations, WINDOW_ANIMATIONS_KEY } from './windowAnimations.js';
import { childSignals, quitApp } from './util.js';

// Panel layout differs from macOS in a few fixed ways; each of these is a
// separate toggle so nothing about the stock top bar is changed silently.
const PANEL_TWEAK_KEYS = [
    'clock-on-the-right',
    'hide-power-button',
    'hide-panel-spacers',
    'group-spotlight-with-quick-settings',
    'gap-before-quick-settings',
    'gap-before-clock',
    'status-icon-padding',
];

// Which panel item each spacing setting sits in front of. Applied as a margin
// on the item itself rather than through the stylesheet, because the amount
// comes from a setting and has to change without reloading anything.
const PANEL_GAPS = [
    ['gap-before-quick-settings', 'quickSettings'],
    ['gap-before-clock', 'dateMenu'],
];

// Some panel items are built after extensions are enabled, so hiding one during
// enable() can find nothing there to hide. Roughly ten seconds of coming back
// for it, which covers the power icon and the Activities button both.
const PANEL_RETRY_LIMIT = 20;

// How often the clock is taken back from another extension before that one is
// left to have it: five times in ten seconds is a fight, not a change of mind.
// See _holdClock().
const CLOCK_RETURN_LIMIT = 5;
const CLOCK_RETURN_WINDOW_US = 10 * GLib.USEC_PER_SEC;

// Nothing here reports state for tests. The suite loads a separate extension
// that inspects the panel from outside, so this one carries no test surface and
// no way in for anything else.

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

// Both are read live: the magnifier is built or torn down by the first, and
// picks up a new size from the second on its next frame.
const DOCK_MAGNIFICATION_KEYS = [
    'dock-magnification',
    'dock-magnification-size',
];

// What the Quick Settings system indicator shows where there is no battery.
// With one, the same icon is the battery, and that is not for hiding.
const POWER_GLYPH = 'system-shutdown-symbolic';

// Claimed on the UI group to switch on the stylesheet rule that drops Dash to
// Dock's backdrop behind the focused app (see stylesheet.css).
const DOCK_PLAIN_FOCUS_CLASS = 'pearup-dock-plain-focus';

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
        this._searchButton = null;
        this._dockMagnifier = null;
        this._shellTweaks = null;
        this._smoothBrightness = null;
        this._windowAnimations = null;
        this._overviewHidden = false;
        this._clockMoved = false;
        this._clockSessionBackup = null;
        this._clockLayout = null;
        this._clockWatched = null;
        this._clockHoldId = 0;
        this._clockReturns = [];
        this._clockLetGo = false;
        this._powerIndicator = null;
        this._powerVisibleId = 0;
        this._powerIconId = 0;
        this._powerDestroyId = 0;
        this._powerRetryId = 0;
        this._powerRetries = 0;
        this._overviewActor = null;
        this._overviewVisibleId = 0;
        this._overviewRetryId = 0;
        this._overviewRetries = 0;
        this._sessionModeId = 0;
        this._resyncId = 0;
        this._indicatorPaddingId = 0;
        this._menuSyncId = 0;
        this._hiddenSpacers = [];
        this._gapped = new Set();
        this._padded = new Set();
        this._spotlightMoved = null;
        this._minimizedWindow = null;
        this._minimizedId = 0;
        this._minimizedGoneId = 0;
        this._quitBound = false;
    }

    // Everything that reaches into GNOME's private panel internals goes
    // through here. Those members can be renamed or removed between shell
    // versions, and a throw escaping enable() would leave the panel half
    // rearranged with no way to put it back.
    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            // Pass the error itself: console prints the stack for Error objects,
            // which `${e}` throws away.
            console.warn(`[${this.metadata.uuid}] ${what} failed:`, e);
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
        this._overviewRetries = 0;
        this._hiddenSpacers = [];
        this._spotlightMoved = null;
        this._overviewHidden = false;

        this._menuManager = new MenuManager(this.metadata.uuid, this._settings);

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'hide-overview-button')
                this._syncOverviewButton();
            else if (key === 'show-logo-menu')
                this._syncLogoButton();
            else if (key === 'show-search-icon')
                this._syncSearchButton();
            else if (PANEL_TWEAK_KEYS.includes(key))
                this._syncPanelTweaks();
            else if (MENU_CONTENT_KEYS.includes(key))
                this._queueMenuSync();
            else if (DOCK_MAGNIFICATION_KEYS.includes(key))
                this._guard('updating dock magnification', () => this._syncDockMagnifier());
            else if (key === 'dock-focus-highlight')
                this._guard('updating the dock highlight', () => this._syncDockFocusHighlight());
            else if (SHELL_TWEAK_KEYS.includes(key))
                this._shellTweaks?.sync();
            else if (key === SMOOTH_BRIGHTNESS_KEY)
                this._smoothBrightness?.sync();
            else if (key === WINDOW_ANIMATIONS_KEY)
                this._windowAnimations?.sync();
        });

        global.display.connectObject('notify::focus-window', () => {
            this._queueMenuSync();
        }, this);
        global.window_manager.connectObject(
            'minimize', () => this._queueMenuSync(),
            'unminimize', () => this._queueMenuSync(),
            this
        );
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._queueMenuSync();
        }, this);

        // The shell rebuilds the panel whenever the session mode changes —
        // during startup, and on unlock — which discards our arrangement.
        this._sessionModeId = Main.sessionMode.connect('updated',
            () => this._queuePanelResync());

        // A rebuild is not the only way an indicator reaches the panel: others
        // arrive on their own, long after it. Connected before the first pass
        // below, so none can slip in between.
        this._guard('watching for late indicators', () => this._watchRightBox());

        // stylesheet.css is loaded by the shell itself for every enabled
        // extension, so there is nothing to do here but claim the class it
        // keys off.
        Main.panel.add_style_class_name('pearup-panel');
        this._syncPanelTweaks();

        this._syncLogoButton();
        this._syncSearchButton();
        this._syncOverviewButton();
        this._syncMenuVisibility();

        // Dash to Dock is someone else's code, reached through its private
        // members; a failure there must not take the menu bar down with it.
        this._guard('setting up dock magnification', () => this._syncDockMagnifier());
        this._guard('styling the dock highlight', () => this._syncDockFocusHighlight());

        // Notifications, the volume bubble and the rest of what is not the bar.
        // Each tweak guards itself, so one the shell has changed under it is
        // left out on its own.
        this._guard('applying the shell tweaks', () => {
            this._shellTweaks = new ShellTweaks(this.metadata.uuid, this._settings);
        });

        // Automatic brightness that fades rather than jumps, where the shell
        // sets the brightness itself (GNOME 49 on).
        this._guard('smoothing automatic brightness', () => {
            this._smoothBrightness = new SmoothBrightness(this.metadata.uuid, this._settings);
        });

        // Windows that open and close as they do on macOS, off by default.
        this._guard('restyling window animations', () => {
            this._windowAnimations = new WindowAnimations(this.metadata.uuid, this._settings);
        });

        // GNOME can close a window from the keyboard but has nothing that
        // quits an app, so Cmd+Q is a binding of our own. The shell rebinds it
        // whenever the setting changes.
        this._guard('moving Cmd+Q to quit', () => this._migrateQuitShortcut());
        Main.wm.addKeybinding('quit-app', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL, () => this._quitFocusedApp());
        this._quitBound = true;
    }

    _quitFocusedApp() {
        const window = global.display.get_focus_window();
        // Surfaces kept off the taskbar, such as desktop icons, are not apps
        // anyone would mean to quit, and quitting one takes the desktop with it.
        if (!window || window.is_skip_taskbar())
            return;
        quitApp(Shell.WindowTracker.get_default().get_window_app(window), window);
    }

    // Earlier versions put Cmd+Q on GNOME's close binding, which closes one
    // window. Move it over, but only where Cmd+W is there too: that pair is
    // what the macOS Window Shortcuts switch wrote, so the Cmd+Q is ours.
    _migrateQuitShortcut() {
        const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        const close = wm.get_strv('close');
        if (!close.includes('<Super>q') || !close.includes('<Super>w'))
            return;
        wm.set_strv('close', close.filter(accel => accel !== '<Super>q'));
        const quit = this._settings.get_strv('quit-app');
        if (!quit.includes('<Super>q'))
            this._settings.set_strv('quit-app', [...quit, '<Super>q']);
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
        this._guard('watching the clock', () => this._watchClock());

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

        this._guard('spacing the status area', () => this._applyPanelGaps());
        this._guard('padding the status area', () => this._applyIconPadding());

        // A rebuild also re-shows the Activities button.
        this._guard('syncing the Activities button', () => this._syncOverviewButton());

        // Rebuilding the panel drops buttons this extension added, so put the
        // System Menu and the app menus back.
        if (clockWasMoved !== this._clockMoved && this._menuManager) {
            if (this._logoButton) {
                this._logoButton.destroy();
                this._logoButton = null;
            }
            if (this._searchButton) {
                this._searchButton.destroy();
                this._searchButton = null;
            }
            this._syncLogoButton();
            this._syncSearchButton();
            this._syncMenuVisibility();
        }
    }

    // Rebuilding the panel replaces the actors we were holding, so anything
    // remembered from before is stale: without this, re-applying a tweak would
    // see a non-empty cache, skip the work, and let the new power glyph or
    // indicators stay visible.
    _forgetPanelActors() {
        this._releasePowerButton();
        this._releaseOverviewButton();
        this._hiddenSpacers = [];
        this._gapped.clear();
        this._releasePadded();
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
    // Set as an inline margin on the panel item, since the size comes from a
    // setting. Re-applied after a rebuild, which replaces these actors.
    _applyPanelGaps() {
        for (const [key, role] of PANEL_GAPS) {
            const container = Main.panel.statusArea[role]?.container;
            if (!container)
                continue;

            // Clamped: see the schema for why there is nothing below zero.
            const gap = Math.max(0, this._settings.get_int(key));
            container.set_style(gap > 0 ? `margin-left: ${gap}px;` : null);
            if (gap > 0)
                this._gapped.add(container);
        }
    }

    _clearPanelGaps() {
        for (const container of this._gapped) {
            try {
                container.set_style(null);
            } catch {
                // Went away with a panel rebuild.
            }
        }
        this._gapped.clear();
    }

    // Each status item reserves horizontal padding on both sides, which
    // PanelMenu.ButtonBox reads off its own theme node when it reports a
    // preferred width — so this goes on the button, not on the container the
    // gaps use, and the two never overwrite each other's inline style.
    //
    // The minimum goes along for the ride: it is the floor the panel falls back
    // to when space runs short, and leaving it above the natural value makes
    // Clutter complain about a minimum wider than the natural width.
    _applyIconPadding() {
        const padding = this._settings.get_int('status-icon-padding');
        const style = `-natural-hpadding: ${padding}px; -minimum-hpadding: 0px;`;

        for (const button of this._statusAreaButtons()) {
            this._restyle(button, style);
            this._remember(button);

            // Quick Settings puts several icons in a single button, so the room
            // between those comes from the box holding them, not from the
            // padding above — without this they stay glued together whatever the
            // setting says. Doubled, because the gap between two buttons is the
            // padding each of them contributes.
            const box = this._indicatorsBox(button);
            if (box) {
                this._restyle(box, `spacing: ${padding * 2}px;`);
                this._remember(box);
            }
        }
    }

    // Kept so disable() can put it back. An actor leaves the set as it is
    // destroyed: tray icons are destroyed when their app quits and made again
    // when it starts, so a set that kept every one would grow as long as the
    // session lasts — and undoing one the shell has finished with is a call on
    // a disposed object, which gjs reports as a critical rather than a throw.
    _remember(actor) {
        if (this._padded.has(actor))
            return;

        this._padded.add(actor);
        actor.connectObject('destroy', () => this._padded.delete(actor), this);
    }

    // Stops remembering without undoing, for actors the panel is being rebuilt
    // around.
    _releasePadded() {
        for (const actor of this._padded) {
            try {
                actor.disconnectObject(this);
            } catch {
                // Went away with a panel rebuild.
            }
        }
        this._padded.clear();
    }

    _indicatorsBox(button) {
        for (const child of [button, ...this._childrenOf(button)]) {
            const box = this._childrenOf(child).find(actor =>
                actor.has_style_class_name?.('panel-status-indicators-box'));
            if (box)
                return box;
        }
        return null;
    }

    // A session mode change during logout runs a resync while the shell is
    // already disposing the panel, and touching an actor it has finished with
    // throws "has been already disposed" — which would abandon the rest of the
    // step. There is no way to ask an actor whether it is still alive, so the
    // question gets asked by trying.
    _childrenOf(actor) {
        try {
            return actor?.get_children?.() ?? [];
        } catch {
            return [];
        }
    }

    _clearIconPadding() {
        for (const actor of this._padded) {
            try {
                this._restyle(actor, null);
                actor.disconnectObject(this);
            } catch {
                // Went away with a panel rebuild.
            }
        }
        this._padded.clear();
    }

    // ButtonBox caches the two padding lengths in a style-changed handler and
    // adds them in vfunc_get_preferred_width, so Clutter has no idea the width
    // it already cached depends on them: restyling alone updates the numbers and
    // changes nothing on screen. Asking for the relayout is what applies it.
    //
    // A button that already has the style is left alone: each late indicator
    // runs this over the whole cluster again, and a relayout of all of it for
    // buttons that are already right would be for nothing.
    _restyle(button, style) {
        if ((button.get_style() ?? null) === style)
            return;
        button.set_style(style);
        button.queue_relayout();
        button.get_parent()?.queue_relayout();
    }

    // The buttons in the right-hand cluster. Read from the panel box rather than
    // a list of roles, so an indicator belonging to another extension is spaced
    // like the rest instead of standing out. The box holds each button inside a
    // container, but not every child is one — hence the check rather than a cast.
    _statusAreaButtons() {
        const isButton = actor => {
            try {
                return !!actor?.has_style_class_name?.('panel-button');
            } catch {
                return false;
            }
        };

        return this._childrenOf(Main.panel._rightBox)
            .map(child => {
                try {
                    return isButton(child) ? child : child.get_first_child();
                } catch {
                    return null;
                }
            })
            .filter(isButton);
    }

    // The padding above goes on once per pass over the panel, and the panel gets
    // a pass at start-up and after each rebuild. An indicator that arrives
    // between those is left with the theme's padding rather than the setting's,
    // so it sits at the wrong distance from its neighbours until the next lock
    // and unlock. Vitals is enabled after this extension, a tray icon appears
    // whenever its app starts (AppIndicator adds them to this box), and an
    // extension that makes its indicator again hands the panel a new one.
    _watchRightBox() {
        const rightBox = Main.panel._rightBox;
        if (!rightBox)
            return;

        const [added] = childSignals(rightBox);
        rightBox.connectObject(added, () => this._queueIndicatorPadding(), this);
    }

    // Nothing is touched from the signal itself: the box is part-way through
    // taking the child, and on GNOME 50 changing actors while Clutter is
    // delivering a signal can abort the shell. An indicator is also not finished
    // when it arrives — its extension keeps building it for a moment longer — so
    // waiting for idle lets it settle, and one pass covers a burst of them.
    _queueIndicatorPadding() {
        if (this._indicatorPaddingId)
            return;

        this._indicatorPaddingId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._indicatorPaddingId = 0;
            // A queued signal can still arrive after disable() has run.
            if (this._settings)
                this._guard('padding a late indicator', () => this._applyIconPadding());
            return GLib.SOURCE_REMOVE;
        });
    }

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
            } catch {
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
        } catch {
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
            try {
                const names = [actor.name, actor.style_class, ...(actor.get_style_class_name?.() ?? '').split(' ')];
                return names.some(name => typeof name === 'string' && name.toLowerCase().includes('search'));
            } catch {
                // Disposed while the shell tears the panel down.
                return false;
            }
        };

        for (const child of this._childrenOf(rightBox)) {
            if (child === this._searchButton?.container)
                continue;
            if (looksLikeSearch(child))
                return child;
            // Search Light's button is wrapped, so check one level in too.
            const inner = this._childrenOf(child)[0];
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
        // Placed anew, so whatever was let go of in a fight is ours again.
        this._clockReturns = [];
        this._clockLetGo = false;

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
    // over the clock. So hide that one actor, and keep it hidden.
    //
    // It is only the power glyph on a machine without a battery, though. With
    // one, the shell draws the battery in that same icon — starting from the
    // glyph at login and switching once UPower answers — so it is watched rather
    // than hidden once, and shown whenever it is a battery.
    _hidePowerButton() {
        let system = Main.panel.statusArea.quickSettings?._system;
        // On shells where `_system` exists but `_indicator` does not — usually
        // a rename — hiding the whole item would take the battery readout with
        // it, so retry instead of guessing. Only older shells without `_system`
        // at all fall back to using the item itself.
        let indicator = system ? system._indicator : system;
        if (!indicator?.hide) {
            // Quick Settings exists before its system item does, so during
            // login there is nothing to hide yet. Come back for it.
            this._retryHidePowerButton();
            return;
        }

        // Compare against the actor rather than just "have we run", because a
        // panel rebuild replaces it and leaves us holding a destroyed one.
        if (this._powerIndicator === indicator)
            return;

        // Found it, so clear the poll budget: a later rebuild in the same
        // session should still get the full window of retries.
        this._powerRetries = 0;

        this._releasePowerButton();

        this._powerIndicator = indicator;
        this._powerVisibleId = indicator.connect('notify::visible',
            () => this._syncPowerIcon(indicator));
        this._powerIconId = indicator.connect('notify::gicon',
            () => this._syncPowerIcon(indicator));
        // The shell rebuilds the panel more than once while starting up, so the
        // icon hidden during enable() is often not the one left on screen.
        this._powerDestroyId = indicator.connect('destroy',
            () => this._queuePanelResync());
        this._syncPowerIcon(indicator);
    }

    // Hidden while it is the power glyph, shown while it is anything else. The
    // shell's status/system.js only ever swaps what this icon shows and never
    // hides it, so showing it overrules nothing the shell decided. Each change
    // comes back through notify::visible and finds nothing left to do.
    _syncPowerIcon(indicator) {
        const isPowerGlyph = indicator.icon_name === POWER_GLYPH;
        if (indicator.visible === isPowerGlyph)
            indicator.visible = !isPowerGlyph;
    }

    // The system item is built asynchronously while the shell starts, and
    // nothing announces its arrival, so poll briefly rather than give up.
    _retryHidePowerButton() {
        if (this._powerRetryId || this._powerRetries >= PANEL_RETRY_LIMIT)
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
        if (!this._powerIndicator)
            return;

        for (const id of [this._powerVisibleId, this._powerIconId, this._powerDestroyId]) {
            if (!id)
                continue;
            try {
                this._powerIndicator.disconnect(id);
            } catch {
                // Destroyed with the old panel.
            }
        }

        this._powerVisibleId = 0;
        this._powerIconId = 0;
        this._powerDestroyId = 0;
        this._powerIndicator = null;
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
        let indicator = this._powerIndicator;
        this._releasePowerButton();

        try {
            indicator?.show();
        } catch {
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

    // The clock is put in the corner once, by the layout above, and another
    // extension can take it away again afterwards: Just Perfection, at its
    // defaults, moves it back to the centre whenever it is enabled — at login,
    // at every unlock, and when it is installed mid-session — and the layout
    // still says right, so nothing would ever put it back. So the clock is
    // watched for being moved, by anyone.
    //
    // The clock is one actor for the life of the shell, but it is asked for
    // again on every pass rather than remembered, in case a rebuild ever makes
    // a new one.
    _watchClock() {
        const container = Main.panel.statusArea.dateMenu?.container ?? null;
        if (container === this._clockWatched)
            return;

        this._unwatchClock();
        if (!container)
            return;

        container.connectObject('parent-set', () => this._queueClockHold(), this);
        this._clockWatched = container;
    }

    _unwatchClock() {
        try {
            this._clockWatched?.disconnectObject(this);
        } catch {
            // Disposed with the panel at logout.
        }
        this._clockWatched = null;
    }

    // Nothing moves from the signal itself: it arrives while the other side is
    // half-way through reparenting the clock, and on GNOME 50 changing the
    // actor tree during a signal can abort the shell. Our own rebuilds move it
    // too, and the check on idle finds it where it belongs and does nothing.
    _queueClockHold() {
        if (this._clockHoldId)
            return;

        this._clockHoldId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._clockHoldId = 0;
            this._guard('keeping the clock on the right', () => this._holdClock());
            return GLib.SOURCE_REMOVE;
        });
    }

    // Puts the clock back at the end of the right box if something has moved
    // it to the centre or the left. Only from those two: anywhere else is a
    // panel someone else has built, and a clock moved within the right box was
    // placed there on purpose. And only while the layout that says right is
    // the live one — the lock screen's has the clock in the centre, rightly.
    //
    // An extension that holds the clock where it wants it, by moving it back
    // each time it is moved, would have the two at it for as long as the
    // session lasts. So after a few returns in quick succession the clock is
    // left where the other one put it, until it is next placed from scratch.
    _holdClock() {
        if (!this._settings?.get_boolean('clock-on-the-right') || !this._clockMoved || this._clockLetGo)
            return;
        if (this._clockLayout && this._clockLayout !== Main.sessionMode?.panel)
            return;

        const container = Main.panel.statusArea.dateMenu?.container;
        const rightBox = Main.panel._rightBox;
        const parent = container?.get_parent();
        if (!parent || !rightBox || parent === rightBox)
            return;
        if (parent !== Main.panel._centerBox && parent !== Main.panel._leftBox)
            return;

        const now = GLib.get_monotonic_time();
        this._clockReturns = this._clockReturns.filter(time => now - time < CLOCK_RETURN_WINDOW_US);
        if (this._clockReturns.length >= CLOCK_RETURN_LIMIT) {
            this._clockLetGo = true;
            console.warn(`[${this.metadata.uuid}] Something keeps moving the clock out of the corner; ` +
                'leaving it there until the next unlock, or until Clock on the Right is switched off and on.');
            return;
        }
        this._clockReturns.push(now);

        parent.remove_child(container);
        rightBox.add_child(container);
    }

    _syncLogoButton() {
        if (!this._settings)
            return;

        let shouldShow = this._settings.get_boolean('show-logo-menu');

        if (shouldShow && !this._logoButton) {
            // A previous failed enable() can leave this role occupied.
            let existing = Main.panel.statusArea[LOGO_ROLE];
            if (existing)
                existing.destroy();
            this._logoButton = new SystemMenuButton(this._settings, this.path);
            Main.panel.addToStatusArea(LOGO_ROLE, this._logoButton, 0, 'left');
        } else if (!shouldShow && this._logoButton) {
            this._logoButton.destroy();
            this._logoButton = null;
        }
    }

    // Index 0 of the right box puts it left of the status icons, which is where
    // macOS keeps Spotlight and where Search Light puts its own button.
    _syncSearchButton() {
        if (!this._settings)
            return;

        let shouldShow = this._settings.get_boolean('show-search-icon');

        if (shouldShow && !this._searchButton) {
            let existing = Main.panel.statusArea['pearup-search'];
            if (existing)
                existing.destroy();
            this._searchButton = new SearchButton(this._settings);
            Main.panel.addToStatusArea('pearup-search', this._searchButton, 0, 'right');
        } else if (!shouldShow && this._searchButton) {
            this._searchButton.destroy();
            this._searchButton = null;
        }
    }

    // The magnifier copes with Dash to Dock coming and going by itself, so this
    // only has to follow the switch, and hand on the size.
    _syncDockMagnifier() {
        if (!this._settings)
            return;

        if (!this._settings.get_boolean('dock-magnification')) {
            this._dropDockMagnifier();
            return;
        }

        const size = this._settings.get_int('dock-magnification-size');
        if (this._dockMagnifier)
            this._dockMagnifier.setSize(size);
        else
            this._dockMagnifier = new DockMagnifier(size);
    }

    _dropDockMagnifier() {
        const magnifier = this._dockMagnifier;
        this._dockMagnifier = null;
        magnifier?.destroy();
    }

    // Dash to Dock's own stylesheet puts a grey backdrop behind the focused
    // app's icon; the macOS Dock marks it with the running dot alone. The rule
    // that removes it is in stylesheet.css, keyed off a class on the UI group:
    // that is the docks' parent, and it outlives every dock Dash to Dock builds
    // and throws away, so no dock actor is touched and nothing has to follow
    // them. A style class is not a change to the actor tree, so this needs no
    // idle of its own — it runs where the panel's class is claimed.
    _syncDockFocusHighlight() {
        if (!this._settings)
            return;

        const uiGroup = Main.layoutManager.uiGroup;
        if (this._settings.get_boolean('dock-focus-highlight'))
            uiGroup.remove_style_class_name(DOCK_PLAIN_FOCUS_CLASS);
        else
            uiGroup.add_style_class_name(DOCK_PLAIN_FOCUS_CLASS);
    }

    // Driven by what is actually on screen rather than by a remembered flag,
    // because a panel rebuild shows every indicator again and a flag-based
    // check would decide there was nothing to do.
    _syncOverviewButton() {
        if (!this._settings)
            return;

        const hide = this._settings.get_boolean('hide-overview-button');
        const activities = Main.panel.statusArea['activities'];
        const actor = activities?.container ?? activities;

        if (!actor) {
            // On GNOME 50 this button is built after extensions are enabled, so
            // during startup there is nothing here to hide yet — the same trap
            // the power icon falls into. Come back for it.
            if (hide)
                this._retryHideOverviewButton();
            return;
        }

        if (!hide) {
            this._releaseOverviewButton();
            if (this._overviewHidden) {
                actor.show();
                this._overviewHidden = false;
            }
            return;
        }

        // Compare against the actor, not "have we run": a rebuild replaces it
        // and leaves us holding a destroyed one.
        if (this._overviewActor === actor)
            return;

        // Found it, so clear the poll budget: a later rebuild in the same
        // session should still get the full window of retries.
        this._overviewRetries = 0;

        this._releaseOverviewButton();
        actor.hide();
        // What it holds on GNOME 50 is the workspace indicators, which re-show
        // the button as workspaces come and go, so hiding it once is not enough.
        this._overviewVisibleId = actor.connect('notify::visible', () => {
            if (actor.visible)
                actor.hide();
        });
        this._overviewActor = actor;
        this._overviewHidden = true;
    }

    // Roughly ten seconds of waiting for the button to turn up.
    _retryHideOverviewButton() {
        if (this._overviewRetryId || this._overviewRetries >= PANEL_RETRY_LIMIT)
            return;

        this._overviewRetries++;
        this._overviewRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._overviewRetryId = 0;
            this._guard('hiding the Activities button', () => this._syncOverviewButton());
            return GLib.SOURCE_REMOVE;
        });
    }

    // Stop keeping it hidden, without revealing it: for swapping to a newer
    // actor after a rebuild.
    _releaseOverviewButton() {
        if (this._overviewVisibleId) {
            try {
                this._overviewActor?.disconnect(this._overviewVisibleId);
            } catch {
                // Went away with a panel rebuild.
            }
        }
        this._overviewVisibleId = 0;
        this._overviewActor = null;
    }

    _showOverviewButton() {
        this._releaseOverviewButton();

        if (!this._overviewHidden)
            return;

        let activities = Main.panel.statusArea['activities'];
        let actor = activities?.container ?? activities;
        actor?.show();
        this._overviewHidden = false;
    }

    // Focus, minimize and workspace signals arrive in bursts, and each one
    // used to rebuild the menu synchronously. Coalesce them onto an idle so
    // the work happens once per burst instead of once per signal.
    _queueMenuSync() {
        if (this._menuSyncId)
            return;

        this._menuSyncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._menuSyncId = 0;
            this._guard('syncing menu visibility', () => this._syncMenuVisibility());
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncMenuVisibility() {
        if (!this._menuManager || !this._settings) return;

        if (this._settings.get_boolean('show-indicator')) {
            let activeWindow = global.display.get_focus_window();
            this._watchMinimized(activeWindow);
            this._menuManager.updateMenuForWindow(activeWindow);
        } else {
            this._unwatchMinimized();
            this._menuManager.clear();
        }
    }

    // Catches a window being minimized programmatically, which the window
    // manager's own minimize signal does not always cover. Meta.Window is not
    // one of the types the shell auto-disconnects for, so drop the reference
    // when the window goes away rather than holding a dead object.
    //
    // Unwatches any previous window first, so a caller that forgets cannot
    // leave handlers connected to two windows at once.
    _watchMinimized(window) {
        this._unwatchMinimized();
        this._minimizedWindow = window;
        if (!window)
            return;

        this._minimizedId = window.connect('notify::minimized',
            () => this._queueMenuSync());
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
            } catch {
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
        this._guard('unwatching the right box', () => Main.panel._rightBox?.disconnectObject(this));
        this._unwatchClock();
        this._unwatchMinimized();

        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        for (const source of ['_resyncId', '_indicatorPaddingId', '_menuSyncId', '_powerRetryId', '_overviewRetryId',
            '_clockHoldId']) {
            if (this[source]) {
                GLib.source_remove(this[source]);
                this[source] = 0;
            }
        }

        if (this._quitBound) {
            Main.wm.removeKeybinding('quit-app');
            this._quitBound = false;
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

        if (this._searchButton) {
            this._searchButton.destroy();
            this._searchButton = null;
        }

        // Gives Dash to Dock's icons their opacity back and removes the overlay
        // drawn above them, whether or not the pointer is on the dock.
        this._guard('removing dock magnification', () => this._dropDockMagnifier());

        this._guard('restoring the shell tweaks', () => this._shellTweaks?.destroy());
        this._shellTweaks = null;

        // Stops the fade and applies where it was heading.
        this._guard('restoring automatic brightness', () => this._smoothBrightness?.destroy());
        this._smoothBrightness = null;

        // Animations already running finish as they began.
        this._guard('restoring window animations', () => this._windowAnimations?.destroy());
        this._windowAnimations = null;

        // Each step is guarded separately: these touch actors this extension
        // does not own, and extensions are torn down in reverse order, so one
        // of them may already be gone. A throw here would abandon the rest of
        // the cleanup and leave the panel rearranged.
        this._guard('restoring Spotlight', () => this._restoreSpotlightPosition());
        this._guard('removing status area spacing', () => this._clearPanelGaps());
        this._guard('removing status area padding', () => this._clearIconPadding());
        this._guard('showing panel indicators', () => this._showSpacers());
        this._guard('showing the Activities button', () => this._showOverviewButton());
        this._guard('restoring the clock', () => this._restoreClock());
        this._guard('showing the power icon', () => this._showPowerButton());
        this._guard('dropping the panel style', () =>
            Main.panel.remove_style_class_name('pearup-panel'));
        this._guard('restoring the dock highlight', () =>
            Main.layoutManager.uiGroup.remove_style_class_name(DOCK_PLAIN_FOCUS_CLASS));

        this._settings = null;
    }
}

// Pieces of the shell that macOS arranges differently, set the way it has them:
// notifications and the volume and brightness bubble in the top right corner,
// under the bar; no popup when switching desktops; and the desktops always
// along the top of the overview, as Mission Control shows its Spaces.
//
// Each is a switch of its own, and each puts back exactly what it changed. These
// used to need Just Perfection; with them here it can go, and where it is still
// installed nothing fights at its defaults (see each tweak).
//
// Everything reached here is a private member of the shell, so each tweak checks
// for what it needs first and, missing it, says so once in the journal and leaves
// that one tweak out. GNOME 45 to 50 have all of it.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.messageTray.bannerAlignment, the x-align of its _bannerBin
//   - Main.osdWindowManager._osdWindows, each window held to its monitor by a
//     Layout.MonitorConstraint, whose work-area keeps it off the bar
//   - WorkspaceSwitcherPopup.prototype.display, called by the window manager's
//     keybinding handler on a popup it has just made
//   - ThumbnailsBox.prototype._updateShouldShow and its _shouldShow, and the
//     overview's own strip at Main.overview._overview.controls._thumbnailsBox
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

export const SHELL_TWEAK_KEYS = [
    'notifications-top-right',
    'osd-top-right',
    'hide-workspace-popup',
    'always-show-workspace-thumbnails',
];

// Claimed on the UI group while the bubble is in the corner, for the margins in
// stylesheet.css. The bubble's windows are children of the UI group.
const OSD_CLASS = 'pearup-osd-top-right';

// Something else that sets what one of these tweaks sets, and sets it again
// every time this one does, would have the two of them at it on every idle tick
// for as long as the session lasts. So a tweak puts its value back a few times
// and then lets the other one have it, with a line in the journal: that many
// in this little time is a fight, not someone changing their mind.
const FIGHT_LIMIT = 5;
const FIGHT_WINDOW_US = 10 * GLib.USEC_PER_SEC;

// One warning per tweak per shell session, not one per unlock: the shell
// disables and enables the extension again at every lock.
const warned = new Set();

// Replaces one method of a class the shell keeps for its whole life. The patch
// lives at module level, not per enable(), because the shell disables and
// enables the extension at every lock and unlock, and the patch made by the
// first enable() has to be recognised by the next rather than wrapped again.
//
// The replacement runs only while the patch is on; off, the wrapper hands every
// call to the method it replaced. That matters when another extension wraps
// the same method after this one — Just Perfection does, for both methods
// patched here, when its own options for them are set. This wrapper is then no
// longer the installed one, and putting back the method it replaced would
// throw away theirs. So it stays in their chain, passing calls through, and is
// taken out only while it is the one installed. Turned on again in that state,
// a fresh wrapper goes on top; the one left in the chain still passes through.
class MethodPatch {
    constructor(owner, name, replacement) {
        // A function, so that a class this shell does not have is found missing
        // when the tweak is applied rather than when this module is loaded.
        this._owner = owner;
        this._name = name;
        this._replacement = replacement;
        this._installed = null;
    }

    // False when there is no such method here to patch.
    enable() {
        const installed = this._installed;
        if (installed?.state.on)
            return true;

        const proto = this._owner();
        if (installed && proto?.[this._name] === installed.wrapper) {
            installed.state.on = true;
            return true;
        }

        const original = proto?.[this._name];
        if (typeof original !== 'function')
            return false;

        const state = { on: true };
        const replacement = this._replacement;
        const wrapper = function (...args) {
            return state.on
                ? replacement.call(this, original, ...args)
                : original.apply(this, args);
        };
        proto[this._name] = wrapper;
        this._installed = { proto, wrapper, original, state };
        return true;
    }

    // Whether it was on.
    disable() {
        const installed = this._installed;
        if (!installed?.state.on)
            return false;

        installed.state.on = false;
        if (installed.proto[this._name] === installed.wrapper) {
            installed.proto[this._name] = installed.original;
            this._installed = null;
        }
        return true;
    }
}

// The shell makes the popup in its keybinding handler, hidden, and calls this to
// show it. Destroying it there is what the shell itself does when a window
// switcher opens over one, and its destroy signal is how the window manager
// forgets it and lets workspaces update again.
const popupPatch = new MethodPatch(
    () => WorkspaceSwitcherPopup.WorkspaceSwitcherPopup?.prototype, 'display',
    function () {
        this.destroy();
    });

// GNOME hides the strip of desktops while there are too few to be worth
// showing: with dynamic workspaces, until there are three, which is to say
// until two are in use. Mission Control shows its Spaces whatever their number.
const thumbnailsPatch = new MethodPatch(
    () => WorkspaceThumbnail.ThumbnailsBox?.prototype, '_updateShouldShow',
    function () {
        if (this._shouldShow === true)
            return;
        this._shouldShow = true;
        this.notify('should-show');
    });

export class ShellTweaks {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._banner = null;
        this._osd = null;
        this._osdMonitorsId = 0;
        this._sources = new Map();
        this._returns = new Map();
        this._givenUp = new Set();
        this.sync();
    }

    // Apply or undo each tweak to match its switch. Safe to call at any time,
    // so a switch in the preferences takes effect at once.
    sync() {
        if (!this._settings)
            return;

        this._toggle('notifications-top-right', 'moving notifications',
            () => this._moveBanners(), () => this._restoreBanners());
        this._toggle('osd-top-right', 'moving the volume and brightness bubble',
            () => this._moveOsd(), () => this._restoreOsd());
        this._toggle('hide-workspace-popup', 'hiding the desktop switch popup',
            () => this._hidePopup(), () => popupPatch.disable());
        this._toggle('always-show-workspace-thumbnails', 'showing the desktops in the overview',
            () => this._showThumbnails(), () => this._restoreThumbnails());
    }

    // Puts back everything, whatever the switches say.
    destroy() {
        for (const id of this._sources.values())
            GLib.source_remove(id);
        this._sources.clear();

        this._guard('restoring notifications', () => this._restoreBanners());
        this._guard('restoring the volume and brightness bubble', () => this._restoreOsd());
        this._guard('restoring the desktop switch popup', () => popupPatch.disable());
        this._guard('restoring the desktops in the overview', () => this._restoreThumbnails());
        this._settings = null;
    }

    _toggle(key, what, apply, restore) {
        // Switched back on, a tweak gets its full allowance of returns again.
        if (!this._settings.get_boolean(key)) {
            this._returns.delete(key);
            this._givenUp.delete(key);
            this._guard(`undoing ${what}`, restore);
        } else {
            this._guard(what, apply);
        }
    }

    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[${this._uuid}] ${what} failed:`, e);
        }
    }

    _warnOnce(tweak, message) {
        if (warned.has(tweak))
            return;
        warned.add(tweak);
        console.warn(`[${this._uuid}] ${message}`);
    }

    // Runs `fn` once the current dispatch is over. Changing what the shell lays
    // out from inside one of its own signals is how GNOME 50 gets aborted.
    _queue(name, fn) {
        if (this._sources.has(name))
            return;

        this._sources.set(name, GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._sources.delete(name);
            if (this._settings)
                this._guard(name, fn);
            return GLib.SOURCE_REMOVE;
        }));
    }

    // Whether a tweak may put its value back once more; see FIGHT_LIMIT.
    _mayReturn(key, what) {
        if (this._givenUp.has(key))
            return false;

        const now = GLib.get_monotonic_time();
        const recent = (this._returns.get(key) ?? []).filter(time => now - time < FIGHT_WINDOW_US);
        if (recent.length >= FIGHT_LIMIT) {
            this._givenUp.add(key);
            this._returns.delete(key);
            console.warn(`[${this._uuid}] Something else keeps changing ${what} back; ` +
                'leaving it to that until the switch is turned off and on again.');
            return false;
        }
        recent.push(now);
        this._returns.set(key, recent);
        return true;
    }

    // ------------------------------------------------------- notifications
    // GNOME shows a banner under the clock: centred while the clock is in the
    // middle, on the right once it is in the corner. It sets that itself every
    // time it builds the panel, at login and at every unlock, and Just
    // Perfection sets its own position — top centre, at its defaults — whenever
    // it is enabled. Neither watches for anyone else, so this sets the right
    // and puts it back after each of them, which they never answer.
    _moveBanners() {
        if (this._banner)
            return;

        const tray = Main.messageTray;
        const bin = tray?._bannerBin;
        if (!bin?.get_x_align || !('bannerAlignment' in tray)) {
            this._warnOnce('banner',
                'This shell places notifications in a way Pear Up does not know; leaving them where they are.');
            return;
        }

        // What to give back: the shell's own choice, or whatever someone else
        // chose since — that is the latest anyone asked for.
        this._banner = { tray, bin, previous: tray.bannerAlignment };
        bin.connectObject('notify::x-align', () => this._onBannerMoved(), this);
        tray.bannerAlignment = Clutter.ActorAlign.END;
    }

    _onBannerMoved() {
        const align = this._banner?.bin.get_x_align();
        if (align === undefined || align === Clutter.ActorAlign.END)
            return;

        this._banner.previous = align;
        if (this._mayReturn('notifications-top-right', 'where notifications appear'))
            this._queue('putting notifications back on the right', () => {
                if (this._banner)
                    this._banner.tray.bannerAlignment = Clutter.ActorAlign.END;
            });
    }

    _restoreBanners() {
        const banner = this._banner;
        if (!banner)
            return;

        this._banner = null;
        this._unqueue('putting notifications back on the right');
        try {
            banner.bin.disconnectObject(this);
        } catch {
            // Gone with the shell, at logout.
        }
        banner.tray.bannerAlignment = banner.previous;
    }

    _unqueue(name) {
        const id = this._sources.get(name);
        if (id) {
            GLib.source_remove(id);
            this._sources.delete(name);
        }
    }

    // ----------------------------------------- the volume and brightness bubble
    // GNOME puts it at the bottom centre of each monitor; macOS has it in the top
    // right corner, under the bar. One bubble window per monitor, each spanning
    // its monitor and aligned within it, so the corner is its alignment — and the
    // work area, which starts below the bar, keeps it off the bar whatever the
    // bar's height. The windows are set one by one rather than by patching their
    // class, which Just Perfection does: two extensions wrapping the same method
    // can only be undone in the right order, and no order is promised.
    _moveOsd() {
        if (this._osd) {
            this._placeOsdWindows();
            return;
        }

        // Empty is fine: during login there can be no monitor yet, and the
        // windows come with the first one.
        const windows = Main.osdWindowManager?._osdWindows;
        if (!Array.isArray(windows) || windows.some(window => window && !this._monitorConstraint(window))) {
            this._warnOnce('osd',
                'This shell builds the volume and brightness bubble in a way Pear Up does not know; ' +
                'leaving it where it is.');
            return;
        }

        this._osd = new Map();
        // Monitors that come later get windows of their own. The shell makes
        // them in its own handler for this, which was connected first.
        this._osdMonitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._queue('placing the volume and brightness bubble', () => this._placeOsdWindows()));
        Main.layoutManager.uiGroup.add_style_class_name(OSD_CLASS);
        this._placeOsdWindows();
    }

    _monitorConstraint(window) {
        try {
            return window?.get_constraints?.()
                .find(constraint => constraint instanceof Layout.MonitorConstraint) ?? null;
        } catch {
            return null;
        }
    }

    _placeOsdWindows() {
        if (!this._osd)
            return;

        for (const window of Main.osdWindowManager?._osdWindows ?? []) {
            if (!window || this._osd.has(window))
                continue;
            const constraint = this._monitorConstraint(window);
            if (!constraint)
                continue;

            this._osd.set(window, {
                xAlign: window.x_align,
                yAlign: window.y_align,
                constraint,
                workArea: constraint.work_area,
            });
            // A monitor that goes away takes its window with it.
            window.connectObject('destroy', () => this._osd?.delete(window), this);
            window.x_align = Clutter.ActorAlign.END;
            window.y_align = Clutter.ActorAlign.START;
            constraint.work_area = true;
        }
    }

    _restoreOsd() {
        if (this._osdMonitorsId) {
            Main.layoutManager.disconnect(this._osdMonitorsId);
            this._osdMonitorsId = 0;
        }
        this._unqueue('placing the volume and brightness bubble');

        const osd = this._osd;
        if (!osd)
            return;

        this._osd = null;
        for (const [window, saved] of osd) {
            try {
                window.disconnectObject(this);
                window.x_align = saved.xAlign;
                window.y_align = saved.yAlign;
                saved.constraint.work_area = saved.workArea;
            } catch {
                // Destroyed with its monitor, or with the shell at logout.
            }
        }
        Main.layoutManager.uiGroup.remove_style_class_name(OSD_CLASS);
    }

    // -------------------------------------------------- switching desktops
    // The popup the shell shows for a moment whenever a shortcut switches
    // desktop, or moves a window to another. macOS slides the desktop across
    // and shows nothing else; the slide is the shell's own, and stays.
    _hidePopup() {
        if (!popupPatch.enable())
            this._warnOnce('popup',
                'This shell shows the desktop switch popup in a way Pear Up does not know; leaving it.');
    }

    // ------------------------------------------ the desktops in the overview
    _showThumbnails() {
        if (!thumbnailsPatch.enable()) {
            this._warnOnce('thumbnails',
                'This shell decides when to show the desktops in the overview in a way Pear Up does ' +
                'not know; leaving it to decide.');
            return;
        }
        this._refreshThumbnails();
    }

    _restoreThumbnails() {
        if (thumbnailsPatch.disable())
            this._refreshThumbnails();
    }

    // The patch reaches strips as they are made, and asks the one that already
    // exists again. That is the overview's own, which lives as long as the
    // shell; other monitors get strips of their own each time the overview
    // opens, and those pick up whichever method is in place then.
    _refreshThumbnails() {
        Main.overview._overview?.controls?._thumbnailsBox?._updateShouldShow?.();
    }
}

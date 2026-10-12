// Pieces of the shell that macOS arranges differently, set the way it has them:
// notifications and the volume and brightness bubble in the top right corner,
// under the bar, with banners that slide in from the right edge; no popup when switching desktops; the desktops always along
// the top of the overview, as Mission Control shows its Spaces; and the desktop,
// not the overview, at login.
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
//   - MessageTray.prototype._updateShowingNotification and _hideNotification,
//     which ease the _bannerBin in and out
//   - Main.osdWindowManager._osdWindows, each window held to its monitor by a
//     Layout.MonitorConstraint, whose work-area keeps it off the bar
//   - WorkspaceSwitcherPopup.prototype.display, called by the window manager's
//     keybinding handler on a popup it has just made
//   - ThumbnailsBox.prototype._updateShouldShow and its _shouldShow, and the
//     overview's own strip at Main.overview._overview.controls._thumbnailsBox
//   - Main.layoutManager._startingUp, and Main.overview.runStartupAnimation,
//     which the shell calls once as it starts and nowhere else; the overview's
//     state at Main.overview._overview.controls._stateAdjustment
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

export const SHELL_TWEAK_KEYS = [
    'notifications-top-right',
    'banners-slide-from-right',
    'osd-top-right',
    'hide-workspace-popup',
    'always-show-workspace-thumbnails',
    'start-on-desktop',
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
export class MethodPatch {
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

// A banner on macOS comes in from beyond the right edge of the screen and, when
// its time is up or it is dismissed, goes back out the same way; GNOME drops it
// from the top with a bounce and pulls it back up. The shell does each with two
// calls to its banner bin's ease(): one for the opacity, one for y (and, from
// GNOME 49, a scale). These wrappers hand that bin, for the length of the
// shell's own call and no longer, an ease() that turns the y into a slide along
// translation_x — keeping the shell's own onComplete and onStopped, which move
// the tray from state to state, and its duration of 0 when it hides a banner at
// once. Everything else those methods do is the shell's.
//
// Durations are before the shell's slow-down factor, which ease() applies, as
// it does the switch for animations: off, the banner is simply there and gone.
const SLIDE_IN_MS = 340;
const SLIDE_OUT_MS = 280;

// The bin while it is in the corner, and nobody else has given it an ease() of
// its own; null for the shell to do as it does.
function slidingBin(tray) {
    const bin = tray?._bannerBin;
    if (!bin || Object.hasOwn(bin, 'ease') || bin.get_x_align?.() !== Clutter.ActorAlign.END)
        return null;
    return bin;
}

// The tray spans the work area and clips to it, so with the dock on the right
// its edge is the dock's, not the screen's, and a banner would be cut off there
// on its way. While one slides, the tray clips to its monitor instead; the
// tray's own clip is back once the slide is over, whichever way it ends.
let trayClip = null;

function clipToMonitor(tray) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor)
        return;
    if (!trayClip)
        trayClip = { tray, clipToAllocation: tray.clip_to_allocation };
    const [x, y] = tray.get_transformed_position();
    tray.clip_to_allocation = false;
    tray.set_clip(monitor.x - x, monitor.y - y, monitor.width, monitor.height);
}

function restoreTrayClip() {
    const clip = trayClip;
    if (!clip)
        return;
    trayClip = null;
    try {
        clip.tray.remove_clip();
        clip.tray.clip_to_allocation = clip.clipToAllocation;
    } catch {
        // Gone with the shell, at logout.
    }
}

// From where the bin sits to just past the right edge of the monitor. A new
// banner is not laid out yet, and neither is the tray it was hidden with; the
// bin's width is then the one it asks for, and it will sit against the right
// edge of the work area, which is the tray's.
function slideDistance(bin) {
    const layout = Main.layoutManager;
    const monitor = layout.primaryMonitor;
    let gap = 0;
    if (monitor) {
        const area = layout.getWorkAreaForMonitor(layout.primaryIndex);
        gap = monitor.x + monitor.width - (area.x + area.width);
    }
    return Math.ceil(bin.width + Math.max(gap, 0));
}

// The shell's own callbacks, run once the tray has its clip back and, after a
// slide out, the bin is back where the next banner expects it.
function afterSlide(params, out, bin) {
    for (const name of ['onComplete', 'onStopped']) {
        const callback = params[name];
        if (typeof callback === 'function') {
            params[name] = (...args) => {
                if (out)
                    bin.translation_x = 0;
                restoreTrayClip();
                return callback(...args);
            };
        }
    }
    return params;
}

function slideParams(tray, bin, showing, params) {
    // The opacity half. A banner going out slides, as on macOS, rather than
    // fading as it goes.
    if (!('y' in params))
        return showing ? params : { ...params, opacity: 255 };

    // eslint-disable-next-line no-unused-vars
    const { y, scale_x, scale_y, ...rest } = params;
    const animate = rest.duration !== 0;

    if (showing) {
        // _showNotification puts a new banner above the screen, out of sight,
        // before it calls this. Asked again for a banner already in place — the
        // notification was updated — the shell's own nudge stays.
        const fresh = bin.y < 0;
        if (!fresh && bin.translation_x === 0)
            return params;
        bin.y = 0;
        bin.scale_x = 1;
        bin.scale_y = 1;
        if (fresh)
            bin.translation_x = slideDistance(bin);
        if (animate)
            clipToMonitor(tray);
        return afterSlide({
            ...rest,
            translation_x: 0,
            duration: animate ? SLIDE_IN_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        }, false, bin);
    }

    if (animate)
        clipToMonitor(tray);
    return afterSlide({
        ...rest,
        translation_x: slideDistance(bin),
        duration: animate ? SLIDE_OUT_MS : 0,
        mode: Clutter.AnimationMode.EASE_IN_CUBIC,
    }, true, bin);
}

function slideWith(showing) {
    return function (original, ...args) {
        const tray = this;
        const bin = slidingBin(tray);
        if (!bin)
            return original.apply(this, args);

        const ease = bin.ease;
        bin.ease = function (params) {
            return ease.call(this, slideParams(tray, this, showing, params));
        };
        try {
            return original.apply(this, args);
        } finally {
            delete bin.ease;
        }
    };
}

const bannerShowPatch = new MethodPatch(
    () => MessageTray.MessageTray?.prototype, '_updateShowingNotification', slideWith(true));
const bannerHidePatch = new MethodPatch(
    () => MessageTray.MessageTray?.prototype, '_hideNotification', slideWith(false));

export class ShellTweaks {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._banner = null;
        this._osd = null;
        this._osdMonitorsId = 0;
        this._startup = null;
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
        this._toggle('banners-slide-from-right', 'sliding notifications in from the right',
            () => this._slideBanners(), () => this._restoreBannerSlide());
        this._toggle('osd-top-right', 'moving the volume and brightness bubble',
            () => this._moveOsd(), () => this._restoreOsd());
        this._toggle('hide-workspace-popup', 'hiding the desktop switch popup',
            () => this._hidePopup(), () => popupPatch.disable());
        this._toggle('always-show-workspace-thumbnails', 'showing the desktops in the overview',
            () => this._showThumbnails(), () => this._restoreThumbnails());
        this._toggle('start-on-desktop', 'starting on the desktop',
            () => this._skipStartupOverview(), () => this._restoreStartup());
    }

    // Puts back everything, whatever the switches say.
    destroy() {
        for (const id of this._sources.values())
            GLib.source_remove(id);
        this._sources.clear();

        this._guard('restoring notifications', () => this._restoreBanners());
        this._guard('restoring how notifications come and go', () => this._restoreBannerSlide());
        this._guard('restoring the volume and brightness bubble', () => this._restoreOsd());
        this._guard('restoring the desktop switch popup', () => popupPatch.disable());
        this._guard('restoring the desktops in the overview', () => this._restoreThumbnails());
        this._guard('restoring the startup overview', () => this._restoreStartup());
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

    // Only with the banners in the corner: from the top centre, a slide in from
    // the side would come from nowhere. The wrappers check the corner again on
    // every banner, for another extension that has taken it since.
    _slideBanners() {
        if (!this._settings.get_boolean('notifications-top-right')) {
            this._restoreBannerSlide();
            return;
        }
        if (!Main.messageTray?._bannerBin || !bannerShowPatch.enable() || !bannerHidePatch.enable()) {
            this._restoreBannerSlide();
            this._warnOnce('banner-slide',
                'This shell shows notifications in a way Pear Up does not know; leaving them to drop from the top.');
        }
    }

    // A banner on its way in or out finishes the way it started, and puts the
    // tray's clip back as it ends; a hidden one is left where the shell's own
    // animation expects it.
    _restoreBannerSlide() {
        bannerShowPatch.disable();
        bannerHidePatch.disable();
        if (!trayClip?.tray._bannerBin?.get_transition?.('translation-x'))
            restoreTrayClip();
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

    // ------------------------------------------------------- the first view
    // A login lands in the overview, which the shell opens as its startup
    // animation; macOS shows the desktop. While the shell starts, its overview's
    // startup animation is stood in for by one that does nothing, so the shell
    // finishes starting with the overview closed and the desktop as it is. Only
    // then: enabled later — at an unlock, or by hand — there is no start to
    // change, and nothing is done.
    //
    // Just Perfection and Dash to Dock do this instead by having
    // Main.sessionMode.hasOverview read false while the shell starts, which
    // takes the shell down its other path, a zoom from the centre, and by
    // setting it back once it has started. Each sets back what it read first,
    // though, and the one that comes second reads the other's false, which can
    // leave it false after the start — and with it Super+1…9, which the shell
    // offers only while there is an overview — until the next lock. Nothing
    // here touches hasOverview; with either of them doing its own, the shell
    // takes that path and never calls the animation stood in for here.
    _skipStartupOverview() {
        if (this._startup || !Main.layoutManager._startingUp)
            return;

        const overview = Main.overview;
        if (typeof overview?.runStartupAnimation !== 'function') {
            this._warnOnce('startup',
                'This shell opens the overview at login in a way Pear Up does not know; leaving it as it is.');
            return;
        }

        this._startup = {
            skip: null,
            completeId: Main.layoutManager.connect('startup-complete',
                () => this._onStartupComplete()),
        };

        // Extensions are enabled while the shell starts, and the two race: with
        // a wallpaper quick to load, the shell can have begun its animation
        // already. Then it is too late to stand in for it, and the overview is
        // closed at once instead, on idle — the shell copes with that part-way
        // through the animation, and the sooner, the less of it shows.
        if (overview.visible) {
            this._queue('leaving the overview after starting', () => this._leaveStartupOverview());
            return;
        }

        // Somebody else's stand-in is already there, and is theirs to remove.
        if (Object.hasOwn(overview, 'runStartupAnimation'))
            return;

        // GNOME 45 passes a callback and carries on starting once it is called;
        // later releases await what this returns. The callback finishes the
        // shell's start, so it is not cancelled with the rest on disable.
        const skip = callback => {
            if (typeof callback === 'function') {
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    callback();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Promise.resolve();
        };
        overview.runStartupAnimation = skip;
        this._startup.skip = skip;
    }

    _onStartupComplete() {
        this._restoreStartup();
        this._queue('leaving the overview after starting', () => this._leaveStartupOverview());
    }

    // Closes the overview if it opened; asked again while it is closing, hide()
    // does nothing. If it never opened, its state is still the window picker it
    // is made with, which is where a swipe up on the touchpad would start from;
    // it goes to hidden, where closing the overview leaves it.
    _leaveStartupOverview() {
        if (Main.overview.visible) {
            Main.overview.hide();
            return;
        }
        const state = Main.overview._overview?.controls?._stateAdjustment;
        const hidden = OverviewControls.ControlsState?.HIDDEN;
        if (state && hidden !== undefined && state.value !== hidden)
            state.value = hidden;
    }

    _restoreStartup() {
        const startup = this._startup;
        if (!startup)
            return;

        this._startup = null;
        Main.layoutManager.disconnect(startup.completeId);
        if (startup.skip && Main.overview.runStartupAnimation === startup.skip)
            delete Main.overview.runStartupAnimation;
    }
}

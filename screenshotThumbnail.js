// The floating thumbnail macOS shows after a screenshot: the picture shrinks
// from where it was taken into the bottom right corner, stays there for a few
// seconds and slides away to the right. Clicking it opens the file; dragging or
// swiping it to the right puts it away at once, and while the pointer rests on
// it, it stays.
//
// The shell takes every screenshot through one function in screenshot.js,
// whatever started it — Print, Cmd+Shift+3, the screenshot UI, a window shot —
// and that function ends by posting the "Screenshot captured" notification with
// the picture as its icon. Neither function is reachable from an extension (an
// ES module's own bindings cannot be replaced from outside), so the
// notification is what is watched: its source announces it, and its icon is an
// St.ImageContent of the shot, already decoded. Screencasts post through the
// same source, or one beside it, with no picture, and are left alone.
//
// The file is the one the shell has just written. Its name is the shell's own
// pattern with the notification's time in it; the screenshot UI also says which
// file it was, a moment later, and that wins when it comes.
//
// With "hide the banner" on, the notification is marked as seen as it arrives,
// which is how the tray itself decides not to show a banner (GNOME 46 on; 45
// shows its banner regardless). It stays in the notification list until the
// thumbnail goes, and then goes too, as a transient notification does when its
// banner closes.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.messageTray's source-added signal and getSources(); a source's
//     notification-added signal and its themed icon ('screenshooter-symbolic'
//     from GNOME 49, 'screenshot-recorded-symbolic' before)
//   - the notification's gicon (an St.ImageContent for a screenshot), datetime
//     and acknowledged, and MessageTray.NotificationDestroyedReason
//   - Main.screenshotUI: its screenshot-taken signal (GNOME 46 on), and, while
//     it is still open as the notification arrives, _getSelectedGeometry(),
//     _windowButton and _windowSelectors, to start the thumbnail from what was
//     selected
//   - Dash to Dock's docks, found as dockMagnifier.js finds them (uiGroup
//     children named 'dashtodockContainer', their _position and
//     dash._background), so the card sits beside the dock rather than under it
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export const SCREENSHOT_THUMBNAIL_KEY = 'screenshot-thumbnail';
export const SCREENSHOT_THUMBNAIL_KEYS = [
    SCREENSHOT_THUMBNAIL_KEY,
    'screenshot-thumbnail-hide-banner',
];

// Named so the test suite and Looking Glass can find it.
const THUMBNAIL_NAME = 'pearup-screenshot-thumbnail';

const SOURCE_ICONS = ['screenshooter-symbolic', 'screenshot-recorded-symbolic'];

// The card's longer side, its shorter side at least, and its distance from the
// edges of the work area and from the dock. macOS's is about 200 points wide.
const CARD_LONG_SIDE = 220;
const CARD_SHORT_SIDE_MIN = 72;
const MARGIN = 18;
const RADIUS = 10;

// How long the card takes to arrive and leave, how long it stays, and how far
// it has to be dragged to be put away. ease() scales the first two with the
// shell's slow-down factor and skips them with animations off.
const ARRIVE_MS = 300;
const LEAVE_MS = 250;
const SNAP_BACK_MS = 200;
const HOLD_MS = 5000;
const DISMISS_DISTANCE = 60;
const CLICK_SLOP = 6;

// A scroll swipe to the right this long, in scroll units, puts it away too.
const SWIPE_DISTANCE = 30;

// How long after the card arrives the screenshot UI's own word on the file is
// still taken as being about this shot.
const FILE_REPORT_US = 3 * GLib.USEC_PER_SEC;

// Clips the picture to the card's rounded corners. St rounds a widget's
// background but not what is drawn inside it.
const RoundedClip = GObject.registerClass(
class PearUpRoundedClip extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        const hook = (Cogl.SnippetHook ?? Shell.SnippetHook).FRAGMENT;
        this.add_glsl_snippet(hook,
            'uniform vec2 pearup_size;\nuniform float pearup_radius;\n',
            `vec2 p = cogl_tex_coord0_in.xy * pearup_size;
             vec2 q = min(p, pearup_size - p);
             if (q.x < pearup_radius && q.y < pearup_radius) {
                 float d = length(vec2(pearup_radius) - q);
                 cogl_color_out *= clamp(pearup_radius - d + 0.5, 0.0, 1.0);
             }`,
            false);
    }

    setShape(width, height, radius) {
        this.set_uniform_float(this.get_uniform_location('pearup_size'), 2, [width, height]);
        this.set_uniform_float(this.get_uniform_location('pearup_radius'), 1, [radius]);
    }
});

// A source's themed icon. Read from the icon itself: GNOME 50's iconName getter
// looks at a property sources do not have, and always says null.
function iconNameOf(source) {
    const icon = source.icon ?? source.gicon;
    if (icon instanceof Gio.ThemedIcon)
        return icon.get_names()[0] ?? null;
    return typeof source.iconName === 'string' ? source.iconName : null;
}

const contains = (rect, x, y) =>
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;

function extentsOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return { x, y, width, height };
}

// Where the shell has just saved the shot: ~/Pictures/Screenshots, in the
// shell's language, named after the notification's time, with -1, -2 … added
// when that name was taken. The last of those that exists is this one.
function savedFile(notification) {
    const time = notification.datetime;
    if (!time)
        return null;
    const dir = GLib.build_filenamev([
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(),
        Gettext.dgettext('gnome-shell', 'Screenshots'),
    ]);
    const stamp = time.format('%Y-%m-%d %H-%M-%S');
    // GNOME 47 capitalised the From.
    for (const pattern of ['Screenshot From %s', 'Screenshot from %s']) {
        const name = Gettext.dgettext('gnome-shell', pattern).replace('%s', stamp);
        let found = null;
        for (let i = 0; i < 100; i++) {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([dir, `${name}${i ? `-${i}` : ''}.png`]));
            if (!file.query_exists(null))
                break;
            found = file;
        }
        if (found)
            return found;
    }
    return null;
}

// Where the shot was on the screen, to start the thumbnail from.
function startRect(width, height) {
    const ui = Main.screenshotUI;
    if (ui?.visible) {
        if (ui._windowButton?.checked) {
            const selected = (ui._windowSelectors ?? [])
                .flatMap(selector => selector.windows?.() ?? [])
                .find(window => window.checked);
            if (selected)
                return extentsOf(selected);
        } else if (typeof ui._getSelectedGeometry === 'function') {
            const [x, y, w, h] = ui._getSelectedGeometry(false);
            if (w > 0 && h > 0)
                return { x, y, width: w, height: h };
        }
    }

    // A window shot from the keyboard is of the focused window; anything else
    // from the keyboard is of the whole screen.
    const actor = global.display.focus_window?.get_compositor_private();
    const stage = { x: 0, y: 0, width: global.stage.width, height: global.stage.height };
    if (actor && Math.abs(width / height - stage.width / stage.height) > 0.01) {
        const rect = extentsOf(actor);
        if (rect.width > 0 && Math.abs(width / height - rect.width / rect.height) < 0.05)
            return rect;
    }
    return stage;
}

function monitorFor(rect) {
    const { monitors, primaryIndex } = Main.layoutManager;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const index = monitors.findIndex(monitor => contains(monitor, cx, cy));
    return index >= 0 ? index : primaryIndex;
}

// The bottom right corner of the work area, short of any Dash to Dock that
// sits on the right or along the bottom of that monitor and would be under the
// card: a dock set to hide does not take its room from the work area.
function cornerFor(monitorIndex, width, height) {
    const work = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
    const monitor = Main.layoutManager.monitors[monitorIndex];
    let right = work.x + work.width - MARGIN;
    let bottom = work.y + work.height - MARGIN;

    for (const dock of Main.layoutManager.uiGroup.get_children()) {
        if (dock.name !== 'dashtodockContainer' || !dock.visible || typeof dock._position !== 'number')
            continue;
        const shelf = dock.dash?._background ?? dock;
        const rect = extentsOf(shelf);
        if (rect.width <= 0 || !contains(monitor, rect.x + rect.width / 2, rect.y + rect.height / 2))
            continue;
        if (dock._position === St.Side.RIGHT &&
            rect.y < bottom && rect.y + rect.height > bottom - height)
            right = Math.min(right, rect.x - MARGIN);
        else if (dock._position === St.Side.BOTTOM &&
            rect.x < right && rect.x + rect.width > right - width)
            bottom = Math.min(bottom, rect.y - MARGIN);
    }
    return [Math.round(right - width), Math.round(bottom - height)];
}

class Thumbnail {
    constructor(owner, notification, image, file) {
        this._owner = owner;
        this._notification = notification;
        this._file = file;
        this._born = GLib.get_monotonic_time();
        this._holdId = 0;
        this._grab = null;
        this._press = null;
        this._swipe = 0;
        this._leaving = false;

        let [, imageWidth, imageHeight] = image.get_preferred_size?.() ?? [false, 0, 0];
        if (!(imageWidth > 0 && imageHeight > 0))
            [imageWidth, imageHeight] = [16, 10];
        const aspect = imageWidth / imageHeight;
        const width = Math.round(aspect >= 1 ? CARD_LONG_SIDE
            : Math.max(CARD_SHORT_SIDE_MIN, CARD_LONG_SIDE * aspect));
        const height = Math.round(aspect >= 1
            ? Math.max(CARD_SHORT_SIDE_MIN, CARD_LONG_SIDE / aspect) : CARD_LONG_SIDE);

        const start = startRect(imageWidth, imageHeight);
        const monitorIndex = monitorFor(start);
        this._monitor = Main.layoutManager.monitors[monitorIndex];
        const [x, y] = cornerFor(monitorIndex, width, height);

        this.actor = new St.Widget({
            name: THUMBNAIL_NAME,
            style_class: 'pearup-screenshot-thumbnail',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x, y, width, height,
        });
        this.actor._pearUpFile = file?.get_path() ?? null;

        const picture = new Clutter.Actor({
            content: image,
            content_gravity: Clutter.ContentGravity.RESIZE_FILL,
            x_expand: true,
            y_expand: true,
        });
        picture.set_content_scaling_filters(
            Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        try {
            const clip = new RoundedClip();
            clip.setShape(width, height, RADIUS);
            picture.add_effect(clip);
        } catch (e) {
            // Square corners inside the rounded frame, then.
            owner.warnOnce('rounding the screenshot thumbnail', e);
        }
        this.actor.add_child(picture);
        this.actor.add_child(new St.Widget({
            style_class: 'pearup-screenshot-thumbnail-edge',
            x_expand: true,
            y_expand: true,
        }));

        Main.layoutManager.addTopChrome(this.actor);
        this.actor.connect('destroy', () => this._onDestroy());
        this.actor.connect('notify::hover', () => this._syncHold());
        this.actor.connect('event', (_actor, event) => this._onEvent(event));

        // From where the shot was, shrunk into the corner.
        this.actor.set_pivot_point(0, 0);
        this.actor.set({
            translation_x: start.x - x,
            translation_y: start.y - y,
            scale_x: start.width / width,
            scale_y: start.height / height,
        });
        this.actor.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            duration: ARRIVE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._syncHold(),
        });
    }

    get notification() {
        return this._notification;
    }

    // The screenshot UI's own word on which file it saved.
    reportFile(file) {
        if (!file || GLib.get_monotonic_time() - this._born > FILE_REPORT_US)
            return;
        this._file = file;
        if (this.actor)
            this.actor._pearUpFile = file.get_path();
    }

    _syncHold() {
        if (!this.actor || this._leaving)
            return;
        const hold = !this.actor.hover && !this._press;
        if (hold && !this._holdId) {
            this._holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
                this._holdId = 0;
                this.dismiss();
                return GLib.SOURCE_REMOVE;
            });
        } else if (!hold && this._holdId) {
            GLib.source_remove(this._holdId);
            this._holdId = 0;
        }
    }

    _onEvent(event) {
        if (this._leaving)
            return Clutter.EVENT_STOP;
        switch (event.type()) {
        case Clutter.EventType.BUTTON_PRESS:
        case Clutter.EventType.TOUCH_BEGIN:
            if (event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() !== 1)
                return Clutter.EVENT_PROPAGATE;
            this._beginPress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.MOTION:
        case Clutter.EventType.TOUCH_UPDATE:
            if (!this._press)
                return Clutter.EVENT_PROPAGATE;
            this._movePress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.BUTTON_RELEASE:
        case Clutter.EventType.TOUCH_END:
        case Clutter.EventType.TOUCH_CANCEL:
            if (!this._press)
                return Clutter.EVENT_PROPAGATE;
            this._endPress(event.type() !== Clutter.EventType.TOUCH_CANCEL);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.SCROLL:
            return this._onScroll(event);
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _beginPress(event) {
        const [x] = event.get_coords();
        this._press = { x, moved: false };
        this.actor.remove_transition('translation-x');
        this._grab = global.stage.grab?.(this.actor) ?? null;
        this._syncHold();
    }

    _movePress(event) {
        const [x] = event.get_coords();
        const dx = x - this._press.x;
        if (Math.abs(dx) > CLICK_SLOP)
            this._press.moved = true;
        // Freely to the right, where it goes away; reluctantly to the left.
        this.actor.translation_x = dx > 0 ? dx : dx / 4;
    }

    _endPress(complete) {
        const { moved } = this._press;
        this._press = null;
        this._grab?.dismiss();
        this._grab = null;

        if (complete && !moved) {
            this._open();
            this.dismiss();
        } else if (complete && this.actor.translation_x > DISMISS_DISTANCE) {
            this.dismiss();
        } else {
            this.actor.ease({
                translation_x: 0,
                duration: SNAP_BACK_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._syncHold();
        }
    }

    // A two-finger swipe to the right on a touchpad, or a sideways wheel.
    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.RIGHT) {
            this.dismiss();
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx] = event.get_scroll_delta();
            // Natural scrolling or not, the card follows the fingers.
            const natural = (event.get_scroll_flags?.() ?? 0) &
                (Clutter.ScrollFlags?.INVERTED ?? 0);
            this._swipe = Math.max(0, this._swipe + (natural ? -dx : dx));
            if (this._swipe > SWIPE_DISTANCE)
                this.dismiss();
        }
        return Clutter.EVENT_STOP;
    }

    // As the shell's own notification does: the file in its default app, or,
    // with nothing saved to disk, whatever the notification itself does.
    _open() {
        try {
            if (this._file) {
                Gio.app_info_launch_default_for_uri(this._file.get_uri(),
                    global.create_app_launch_context(0, -1));
                Main.overview.hide();
            } else if (this._owner.isAlive(this._notification)) {
                this._notification.activate();
            }
        } catch (e) {
            console.warn(`[${this._owner.uuid}] opening the screenshot failed:`, e);
        }
    }

    // Off to the right, past the edge of the screen.
    dismiss() {
        if (!this.actor || this._leaving)
            return;
        this._leaving = true;
        this._syncHoldOff();
        this.actor.reactive = false;
        const [x] = this.actor.get_transformed_position();
        const distance = this._monitor.x + this._monitor.width - x + MARGIN;
        this.actor.ease({
            translation_x: Math.max(distance, this.actor.translation_x),
            opacity: 0,
            duration: LEAVE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    _syncHoldOff() {
        if (this._holdId) {
            GLib.source_remove(this._holdId);
            this._holdId = 0;
        }
    }

    destroy() {
        this.actor?.destroy();
    }

    _onDestroy() {
        this._syncHoldOff();
        this._grab?.dismiss();
        this._grab = null;
        this.actor = null;
        this._owner.thumbnailGone(this);
    }
}

export class ScreenshotThumbnail {
    constructor(uuid, settings) {
        this.uuid = uuid;
        this._settings = settings;
        this._on = false;
        this._thumbnail = null;
        this._leaving = new Set();
        this._hidden = new Set();
        this._gone = new WeakSet();
        this._warned = new Set();
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        const want = this._settings?.get_boolean(SCREENSHOT_THUMBNAIL_KEY) ?? false;
        if (want && !this._on)
            this._enable();
        else if (!want && this._on)
            this._disable();
    }

    destroy() {
        if (this._on)
            this._disable();
        this._settings = null;
    }

    warnOnce(what, error) {
        if (this._warned.has(what))
            return;
        this._warned.add(what);
        console.warn(`[${this.uuid}] ${what} failed:`, error);
    }

    _enable() {
        this._on = true;
        const tray = Main.messageTray;
        tray.connectObject('source-added', (_tray, source) => this._watchSource(source), this);
        for (const source of tray.getSources?.() ?? [])
            this._watchSource(source);
        // GNOME 46 on; 45's screenshot UI does not say which file it saved.
        const ui = Main.screenshotUI;
        if (ui && GObject.signal_lookup('screenshot-taken', ui.constructor.$gtype)) {
            ui.connectObject('screenshot-taken',
                (_ui, file) => this._thumbnail?.reportFile(file), this);
        }
    }

    _disable() {
        this._on = false;
        Main.messageTray.disconnectObject(this);
        Main.screenshotUI?.disconnectObject(this);
        for (const source of Main.messageTray.getSources?.() ?? [])
            source.disconnectObject?.(this);
        this._thumbnail?.destroy();
        this._thumbnail = null;
        for (const thumbnail of [...this._leaving])
            thumbnail.destroy();
        // Banners held back for a thumbnail that is gone now.
        for (const notification of this._hidden)
            this._expire(notification);
        this._hidden.clear();
    }

    _watchSource(source) {
        if (!SOURCE_ICONS.includes(iconNameOf(source)))
            return;
        source.connectObject('notification-added',
            (_source, notification) => this._onNotification(notification), this);
    }

    _onNotification(notification) {
        const image = notification.gicon;
        if (!(image instanceof St.ImageContent))
            return; // A screencast.

        try {
            this._showThumbnail(notification, image);
        } catch (e) {
            this.warnOnce('showing the screenshot thumbnail', e);
        }
    }

    _showThumbnail(notification, image) {
        // The one before goes on its way, as on macOS.
        if (this._thumbnail) {
            this._leaving.add(this._thumbnail);
            this._thumbnail.dismiss();
            this._thumbnail = null;
        }

        notification.connectObject('destroy', () => {
            this._gone.add(notification);
            this._hidden.delete(notification);
        }, this);

        // GNOME 45 shows the banner however the notification is marked; from
        // 46 the tray asks for a banner through this signal, after the
        // notification has been announced, and skips one that has been seen.
        const source = notification.source;
        if (this._settings.get_boolean('screenshot-thumbnail-hide-banner') && source &&
            GObject.signal_lookup('notification-request-banner', source.constructor.$gtype)) {
            notification.acknowledged = true;
            this._hidden.add(notification);
        }

        let file = null;
        try {
            file = savedFile(notification);
        } catch (e) {
            this.warnOnce('finding the saved screenshot', e);
        }
        this._thumbnail = new Thumbnail(this, notification, image, file);
    }

    isAlive(notification) {
        return !this._gone.has(notification);
    }

    thumbnailGone(thumbnail) {
        if (this._thumbnail === thumbnail)
            this._thumbnail = null;
        this._leaving.delete(thumbnail);
        const notification = thumbnail.notification;
        if (this._hidden.delete(notification))
            this._expire(notification);
        else if (!this._gone.has(notification))
            notification.disconnectObject(this);
    }

    // What the tray does with a transient notification once its banner closes.
    _expire(notification) {
        notification.disconnectObject(this);
        try {
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
        } catch (e) {
            this.warnOnce('clearing the screenshot notification', e);
        }
    }
}

// macOS-style bouncing for Dash to Dock: an app's icon hops away from the
// screen edge while the app is starting, until its first window appears, and a
// few times when one of its windows asks for attention.
//
// Like magnification (dockMagnifier.js), nothing of Dash to Dock's is moved.
// Dash to Dock clips its dash to the dock's own box, so an icon translated half
// its size away from the edge would be cut off where the dock ends. Instead the
// hop is drawn in an overlay placed above the dock in the shell's UI group: a
// Clutter.Clone of the icon, moved, while the icon itself is made transparent
// underneath. The clone draws the icon's own texture at its own size, so it is
// exact; only the icon image hops, the running dot stays on the shelf, as on
// macOS. The reactive button is never touched, so a click lands on Dash to
// Dock as always.
//
// While the dock is magnified the magnifier already draws every icon in its own
// overlay and hides the dock's. It asks bounceRise() how high an app's icon is
// and lifts its magnified copy by that much, so the two never draw the same
// icon twice: this module's clone is drawn at the opacity the icon would have
// had, which is zero while the magnifier has hidden it.
//
// Dash to Dock internals used, beyond those listed in dockMagnifier.js:
//   - an app item's `child.app`, the Shell.App it stands for;
//   - dock._slider.slideX, 1 when the dock is fully shown. A dock sliding in or
//     out, or hidden, is not bounced on: the clone would be drawn outside it.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { childSignals } from './util.js';

const DOCK_ACTOR_NAME = 'dashtodockContainer';
const OVERLAY_NAME = 'pearup-dock-bounce';
const MAGNIFIER_OVERLAY_NAME = 'pearup-dock-magnifier';

// One hop, up and down. macOS takes a little over half a second.
const HOP_MS = 600;

// The top of a hop: one icon's size, as the macOS Dock hops (a 64 pt icon
// clears about its own height), but never less than HOP_MIN_PX logical pixels.
// Half a size was tried first and is too little at small sizes: Dash to Dock
// goes down to 16 px icons, where it is an 8 px hop, which the eye reads as a
// twitch rather than a bounce. 16 px is the floor because it is what a full
// size gives at the smallest icon Dash to Dock offers, so the floor only takes
// over below that (Dash to Dock shrinks its icons when many apps crowd the
// dock) and a hop is never smaller than the smallest dock's.
const HOP_HEIGHT = 1.0;
const HOP_MIN_PX = 16;

// An app that never shows a window stops bouncing after this. Its startup
// notification may run on for longer (mutter gives it 15 s), but by then the
// bouncing says nothing more.
const LAUNCH_LIMIT_MS = 10000;

// A window asking for attention gets this many hops, about what macOS gives an
// informational request, unless the app is brought to the front first.
const ATTENTION_HOPS = 3;

const LAUNCH = 'launch';
const ATTENTION = 'attention';

// The instance currently switched on, for bounceRise(). There is at most one.
let active = null;

// How high the top of a hop is for an icon drawn `size` logical pixels across.
export function hopPeak(size) {
    return Math.max(HOP_HEIGHT * size, HOP_MIN_PX);
}

// How far an app's dock icon, drawn `size` logical pixels across, is lifted off
// the shelf right now: 0 for an app that is not bouncing. Worked out from the
// clock rather than remembered per frame, so the magnifier and the bounce
// overlay agree on the same frame whichever of them draws first; each passes
// the size it draws the icon at, so a magnified copy hops by its own size.
export function bounceRise(app, size) {
    const lift = active && app ? active.lift(app, GLib.get_monotonic_time()) : 0;
    return lift > 0 ? lift * hopPeak(size) : 0;
}

// The same test as dockMagnifier.js, kept here so neither module imports the
// other's internals: the magnifier only needs bounceRise() from this one.
function isDock(actor) {
    try {
        return actor.name === DOCK_ACTOR_NAME &&
            actor.dash?._box instanceof Clutter.Actor &&
            typeof actor._position === 'number';
    } catch {
        // Disposed while the shell or Dash to Dock tears down.
        return false;
    }
}

// A hop is a parabola: rising with ease-out-quad, falling with ease-in-quad,
// which is how something thrown up and pulled back by gravity moves.
// As a share of the hop's peak, 0 on the shelf and 1 at the top.
function hopHeight(phase) {
    const t = phase - Math.floor(phase);
    return 4 * t * (1 - t);
}

export class DockBounce {
    constructor({ onLaunch, onAttention }) {
        this._onLaunch = false;
        this._onAttention = false;
        // Shell.App → { kind, start, hop, endHop }, times in µs.
        this._bounces = new Map();
        this._docks = new Map();
        this._scanId = 0;

        try {
            const { uiGroup } = Main.layoutManager;
            const [added, removed] = childSignals(uiGroup);
            uiGroup.connectObject(
                added, (_group, child) => this._onUiGroupChanged(child),
                removed, (_group, child) => this._onUiGroupChanged(child),
                this);
            this.setModes({ onLaunch, onAttention });
            active = this;
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    // Each kind is followed only while it is switched on; one switched off
    // mid-bounce lands at once.
    setModes({ onLaunch, onAttention }) {
        if (onLaunch !== this._onLaunch) {
            this._onLaunch = onLaunch;
            if (onLaunch) {
                Shell.AppSystem.get_default().connectObject('app-state-changed',
                    (_system, app) => this._onAppStateChanged(app), this);
            } else {
                Shell.AppSystem.get_default().disconnectObject(this);
                this._dropKind(LAUNCH);
            }
        }

        if (onAttention !== this._onAttention) {
            this._onAttention = onAttention;
            if (onAttention) {
                global.display.connectObject(
                    'window-demands-attention', (_display, window) => this._onAttentionWanted(window),
                    'window-marked-urgent', (_display, window) => this._onAttentionWanted(window),
                    'notify::focus-window', () => this._onFocusChanged(),
                    this);
            } else {
                global.display.disconnectObject(this);
                this._dropKind(ATTENTION);
            }
        }
    }

    // ------------------------------------------------------------ bounces
    _onAppStateChanged(app) {
        if (app.state === Shell.AppState.STARTING)
            this._start(app, LAUNCH, Infinity);
        else if (this._bounces.get(app)?.kind === LAUNCH)
            this._land(app);
    }

    _onAttentionWanted(window) {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        if (!app || window.has_focus() || tracker.focus_app === app)
            return;

        // Still bouncing from its launch, or from an earlier request: that
        // bounce already says it.
        if (this._bounces.has(app))
            return;
        this._start(app, ATTENTION, ATTENTION_HOPS);
    }

    _onFocusChanged() {
        const app = Shell.WindowTracker.get_default().focus_app;
        if (app && this._bounces.get(app)?.kind === ATTENTION)
            this._land(app);
    }

    _start(app, kind, hops) {
        // As the shell does with its own transitions: with animations off in
        // Accessibility nothing moves, and here there is nothing else to show.
        const settings = St.Settings.get();
        if (!settings.enable_animations)
            return;

        // Only where Dash to Dock is showing a dock.
        this._scan();
        if (this._docks.size === 0)
            return;

        // Already in the air: carried on from where it is, rather than started
        // again from the shelf.
        const now = GLib.get_monotonic_time();
        const existing = this._bounces.get(app);
        const phase = existing ? (now - existing.start) / existing.hop : 0;
        if (existing && phase < existing.endHop) {
            existing.kind = kind;
            existing.endHop = Math.floor(phase) + hops;
            return;
        }

        const factor = settings.slow_down_factor > 0 ? settings.slow_down_factor : 1;
        this._bounces.set(app, {
            kind,
            start: now,
            hop: HOP_MS * 1000 * factor,
            endHop: hops,
        });

        for (const dock of this._docks.values())
            dock.wake();
    }

    // The hop in the air comes down; none starts after it.
    _land(app) {
        const bounce = this._bounces.get(app);
        if (!bounce)
            return;
        const phase = (GLib.get_monotonic_time() - bounce.start) / bounce.hop;
        bounce.endHop = Math.min(bounce.endHop, Math.floor(phase) + 1);
    }

    _dropKind(kind) {
        for (const [app, bounce] of this._bounces) {
            if (bounce.kind === kind)
                this._bounces.delete(app);
        }
    }

    get bouncing() {
        return this._bounces.size > 0;
    }

    // Every app currently bouncing, with bounces that have landed let go of.
    prune(now) {
        for (const [app, bounce] of this._bounces) {
            const phase = (now - bounce.start) / bounce.hop;
            if (bounce.kind === LAUNCH && bounce.endHop === Infinity &&
                now - bounce.start >= LAUNCH_LIMIT_MS * 1000)
                bounce.endHop = Math.floor(phase) + 1;
            if (phase >= bounce.endHop)
                this._bounces.delete(app);
        }
        return this._bounces;
    }

    lift(app, now) {
        const bounce = this._bounces.get(app);
        if (!bounce)
            return 0;
        const phase = (now - bounce.start) / bounce.hop;
        return phase >= bounce.endHop || phase < 0 ? 0 : hopHeight(phase);
    }

    // -------------------------------------------------------------- docks
    _onUiGroupChanged(child) {
        if (!child?.name?.startsWith('pearup-dock-'))
            this._queueScan();
    }

    _queueScan() {
        if (this._scanId)
            return;

        this._scanId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scanId = 0;
            try {
                this._scan();
                if (this.bouncing) {
                    for (const dock of this._docks.values())
                        dock.wake();
                }
            } catch (e) {
                console.warn('[pear-up] Looking for Dash to Dock failed:', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const found = Main.layoutManager.uiGroup.get_children().filter(isDock);

        for (const dock of [...this._docks.keys()]) {
            if (!found.includes(dock))
                this._forget(dock, true);
        }

        for (const dock of found) {
            if (this._docks.has(dock))
                continue;
            this._docks.set(dock, new DockBounceOverlay(dock, this));
            dock.connectObject('destroy', () => this._forget(dock, false), this);
        }
    }

    _forget(dock, alive) {
        const overlay = this._docks.get(dock);
        if (!overlay)
            return;

        this._docks.delete(dock);
        try {
            overlay.destroy();
        } catch (e) {
            console.warn('[pear-up] Restoring a bounced dock failed:', e);
        }
        if (alive) {
            try {
                dock.disconnectObject(this);
            } catch {
                // Disposed in the same teardown.
            }
        }
    }

    destroy() {
        if (active === this)
            active = null;

        if (this._scanId) {
            GLib.source_remove(this._scanId);
            this._scanId = 0;
        }

        Main.layoutManager.uiGroup.disconnectObject(this);
        if (this._onLaunch)
            Shell.AppSystem.get_default().disconnectObject(this);
        if (this._onAttention)
            global.display.disconnectObject(this);
        this._onLaunch = this._onAttention = false;
        this._bounces.clear();

        for (const dock of [...this._docks.keys()])
            this._forget(dock, true);
    }
}

// One dock's bouncing icons. Idle until something bounces; then a per-frame
// update on the dock's own frame clock draws each hop, and once everything
// has landed it removes the overlay and gives every icon its opacity back.
class DockBounceOverlay {
    constructor(dock, owner) {
        this._dock = dock;
        this._owner = owner;
        this._side = dock._position;
        this._vertical = this._side === St.Side.LEFT || this._side === St.Side.RIGHT;

        this._overlay = null;
        this._timeline = null;
        this._broken = false;
        this._frame = 0;
        // St.Icon → { view, rest, destroyId, dead, seen }
        this._records = new Map();
    }

    wake() {
        if (this._timeline || this._broken)
            return;

        this._timeline = new Clutter.Timeline({
            actor: this._dock,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => {
            try {
                this._onFrame();
            } catch (e) {
                this._fail(e);
            }
        });
        this._timeline.start();
    }

    _fail(e) {
        console.warn('[pear-up] Dock bounce failed, leaving this dock still:', e);
        this._broken = true;
        try {
            this._stop();
        } catch (stopError) {
            console.warn('[pear-up] Restoring the dock failed:', stopError);
        }
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const bounces = this._owner.prune(now);
        if (bounces.size === 0 || !this._dock.dash) {
            this._stop();
            return;
        }

        this._frame++;
        if (this._shown()) {
            for (const slot of this._dock.dash._box.get_children()) {
                const app = slot.child?.app;
                if (!app || !bounces.has(app))
                    continue;
                const lift = this._owner.lift(app, now);
                if (lift > 0)
                    this._place(slot, lift);
            }
        }
        this._dropUnseen();
    }

    // Fully slid in, on screen, and not behind the lock screen.
    _shown() {
        const dock = this._dock;
        return dock.mapped && dock.get_paint_opacity() > 0 &&
            (dock._slider?.slideX ?? 1) >= 1 && !Main.sessionMode.isLocked;
    }

    _ensureOverlay() {
        const uiGroup = Main.layoutManager.uiGroup;
        if (!this._overlay) {
            this._overlay = new Clutter.Actor({ name: OVERLAY_NAME, reactive: false });
            uiGroup.insert_child_above(this._overlay, this._dock);
        }

        // Above the dock, and above the magnifier's overlay when there is one,
        // which keeps itself directly above the dock: each settles where the
        // other expects it, so neither moves the other again.
        const next = this._dock.get_next_sibling();
        const below = next?.name === MAGNIFIER_OVERLAY_NAME && next !== this._overlay
            ? next : this._dock;
        if (this._overlay.get_previous_sibling() !== below)
            uiGroup.set_child_above_sibling(this._overlay, below);
        return this._overlay;
    }

    _place(slot, lift) {
        if (!slot.visible || !slot.mapped)
            return;
        const base = slot.child?.icon;
        const icon = base?.icon;
        if (!(icon instanceof St.Icon) || !icon.mapped || !this._inView(slot))
            return;

        const width = icon.width;
        const height = icon.height;
        if (!(width > 0 && height > 0))
            return;

        // Where the icon is on the stage, whatever its ancestors do to it:
        // Dash to Dock scales an item in as it is added. Measured on the
        // icon's parent, the bin Dash to Dock turns about its centre for its
        // urgent wiggle, whose centre that turn leaves in place; the clone is
        // drawn upright, as on macOS, where a bouncing icon does not wiggle.
        // Two points give the centre and the scale.
        const anchor = icon.get_parent() ?? icon;
        const anchorWidth = anchor.width;
        const anchorHeight = anchor.height;
        if (!(anchorWidth > 0 && anchorHeight > 0))
            return;
        const point = (x, y) => anchor.apply_transform_to_point(new Graphene.Point3D({ x, y, z: 0 }));
        const middle = point(anchorWidth / 2, anchorHeight / 2);
        const origin = point(0, anchorHeight / 2);
        const end = point(anchorWidth, anchorHeight / 2);
        const scale = Math.hypot(end.x - origin.x, end.y - origin.y) / anchorWidth;
        if (!Number.isFinite(scale) || scale <= 0)
            return;

        // The icon is centred in its bin, but measured rather than assumed.
        const box = anchor === icon ? null : icon.get_allocation_box();
        const center = {
            x: middle.x + (box ? (box.x1 + box.x2 - anchorWidth) / 2 * scale : 0),
            y: middle.y + (box ? (box.y1 + box.y2 - anchorHeight) / 2 * scale : 0),
        };

        const record = this._record(icon);
        const { view } = record;
        if (record.width !== width || record.height !== height) {
            view.set_size(width, height);
            record.width = width;
            record.height = height;
        }

        // Away from the edge the dock sits on.
        const rise = lift * hopPeak((this._vertical ? width : height) * scale);
        let x = center.x, y = center.y;
        if (this._side === St.Side.RIGHT)
            x -= rise;
        else if (this._side === St.Side.LEFT)
            x += rise;
        else if (this._side === St.Side.BOTTOM)
            y -= rise;
        else
            y += rise;

        view.translation_x = x - width / 2;
        view.translation_y = y - height / 2;
        view.set_scale(scale, scale);

        if (icon.opacity !== 0) {
            record.rest = icon.opacity;
            icon.opacity = 0;
        }
        // What the icon would have been drawn with: its own opacity, times
        // that of everything above it — zero while the magnifier draws it.
        const parentOpacity = icon.get_parent()?.get_paint_opacity() ?? 255;
        view.opacity = Math.round(record.rest * parentOpacity / 255);
    }

    // An overflowing dash scrolls; an icon scrolled out of sight is clipped
    // away by Dash to Dock and stays that way.
    _inView(slot) {
        const view = this._dock.dash._scrollView;
        if (!view?.mapped)
            return true;
        const [x, y] = view.get_transformed_position();
        const [width, height] = view.get_transformed_size();
        const [slotX, slotY] = slot.get_transformed_position();
        const [slotWidth, slotHeight] = slot.get_transformed_size();
        const center = this._vertical ? slotY + slotHeight / 2 : slotX + slotWidth / 2;
        return this._vertical
            ? center >= y && center <= y + height
            : center >= x && center <= x + width;
    }

    _record(icon) {
        let record = this._records.get(icon);
        if (!record) {
            const view = new Clutter.Clone({ source: icon, reactive: false });
            view.set_pivot_point(0.5, 0.5);
            record = { icon, view, rest: icon.opacity, dead: false, width: -1, height: -1, seen: 0 };
            record.destroyId = icon.connect('destroy', () => {
                record.dead = true;
                this._drop(record);
            });
            this._ensureOverlay().add_child(view);
            this._records.set(icon, record);
        } else {
            this._ensureOverlay();
        }
        record.seen = this._frame;
        return record;
    }

    _drop(record) {
        if (this._records.get(record.icon) === record)
            this._records.delete(record.icon);

        if (!record.dead) {
            try {
                record.icon.disconnect(record.destroyId);
                if (record.icon.opacity === 0)
                    record.icon.opacity = record.rest;
            } catch {
                // Disposed in the same teardown; there is nothing to restore.
            }
        }
        record.view.destroy();
    }

    // Landed this frame, or gone from the dash.
    _dropUnseen() {
        for (const record of [...this._records.values()]) {
            if (record.seen !== this._frame)
                this._drop(record);
        }
    }

    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

        for (const record of [...this._records.values()])
            this._drop(record);

        this._overlay?.destroy();
        this._overlay = null;
    }

    destroy() {
        this._stop();
    }
}

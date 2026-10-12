// macOS-style magnification for Dash to Dock: the icon under the pointer grows,
// its neighbours grow less and are pushed apart, and the whole swell eases in on
// entry and back out on leave.
//
// Nothing of Dash to Dock's is resized or moved. Scaling its icons in place is
// not an option: DashSlideContainer clips its child to its own allocation on
// every allocate, and the dash's scroll view clips again, so anything grown
// past the dock's edge would be cut off. Instead each dock gets an overlay
// placed directly above it in the shell's UI group, and while the pointer is
// over the dock that overlay draws the magnified picture — the real icons are
// only made transparent underneath it. The reactive buttons are never touched,
// so clicks, drags, right-click menus and hover all land on Dash to Dock exactly
// as they would without this.
//
// The icons in the overlay are fresh St.Icons rather than Clutter.Clones of the
// originals. A clone can only scale up the texture the dock already loaded for
// its own size, and at the 16 px a dock is often set to, doubling that is a
// visible blur. A copy is loaded once at the largest size it can reach and
// scaled down, which stays sharp. Everything that is not the icon image — the
// running dots, badges, the separator — is a Clutter.Clone instead: those are
// drawn at their own size, only moved, so a clone is exact. The dock's
// background is cloned too, and stretched to take in the grown icons.
//
// Dash to Dock internals this depends on. None of them are GNOME APIs, so they
// are listed here rather than in tests/api-manifest.json. Any of them missing
// means a dock is not recognised, or its first frame throws, is caught, and
// magnification is switched off for that dock: the dock simply stays as it is.
//   - Docks are direct children of Main.layoutManager.uiGroup named
//     'dashtodockContainer' (the DockedDash class in docking.js).
//   - dock._position: the St.Side the dock sits on.
//   - dock._box: the track_hover actor Dash to Dock's own autohide follows;
//     its `hover` is what says the pointer is on the dock.
//   - dock.dash: the DockDash, with `_box` holding the dash items in order,
//     `_showAppsIcon` for the Show Apps item, `_scrollView` for the visible
//     part of an overflowing dash, `_background` for the shelf behind the
//     icons, and the 'menu-opened'/'menu-closed' signals. Without a scroll view
//     every item counts as visible; without a background the shelf stays as is.
//   - An item's icon is item.child.icon (Show Apps: item.icon), a GNOME BaseIcon
//     whose own `icon` is the St.Icon drawn; everything else beside the BaseIcon
//     in its parent is an indicator. item.label is the hover label.
// Ubuntu Dock is Dash to Dock under another name and is covered the same way.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { childSignals } from './util.js';
import { bounceLift } from './dockBounce.js';

const DOCK_ACTOR_NAME = 'dashtodockContainer';

// Named so it can be found from outside — in Looking Glass, or by the test
// suite — without anything reaching into this module.
const OVERLAY_NAME = 'pearup-dock-magnifier';

// How far the swell reaches either side of the pointer, in icon slots. At 3 the
// icon under the pointer gets the full size, the next one three quarters of the
// extra and the one after that a quarter, which is about what macOS does.
const FALLOFF_SLOTS = 3;

// Growing a little quicker than shrinking reads as responsive on the way in and
// unhurried on the way out.
const EASE_IN_MS = 150;
const EASE_OUT_MS = 180;

// A copy loads its texture asynchronously, and its real icon stays visible
// until it has. Should that never be reported — a change inside St, say — the
// swap happens anyway after this many frames, so the cost of being wrong is a
// one-frame blink rather than an icon that never magnifies.
const READY_FRAME_LIMIT = 12;

// Raised cosine: 1 at the pointer, 0 at the radius and beyond, smooth at both
// ends so nothing kinks as the pointer moves.
function falloff(distance, radius) {
    if (distance >= radius)
        return 0;
    return (1 + Math.cos(Math.PI * distance / radius)) / 2;
}

// How much further from the pointer something at `distance` ends up. This is
// the integral of the magnification between the pointer and that point, so
// every icon is pushed out by exactly the extra size of everything between it
// and the pointer: neighbours never overlap, and the point under the pointer
// stays where it is.
function extraOffset(distance, radius, gain) {
    const reach = Math.min(distance, radius);
    return gain * (reach / 2 + radius / (2 * Math.PI) * Math.sin(Math.PI * reach / radius));
}

function smoothstep(t) {
    return t * t * (3 - 2 * t);
}

function isDock(actor) {
    try {
        return actor.name === DOCK_ACTOR_NAME &&
            actor.dash?._box instanceof Clutter.Actor &&
            actor._box instanceof St.Widget &&
            typeof actor._position === 'number';
    } catch {
        // Disposed while the shell or Dash to Dock tears down.
        return false;
    }
}

export class DockMagnifier {
    constructor(sizePercent) {
        this._maxScale = sizePercent / 100;
        this._docks = new Map();
        this._scanId = 0;
        this._dragging = false;

        // A throw halfway through would leave whatever was connected so far
        // connected, with nothing holding the object to disconnect it.
        try {
            this._connect();
            this._scan();
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _connect() {
        // Dash to Dock builds its docks after it is enabled, rebuilds them
        // whenever its own edge, size or monitor settings change, and throws
        // them away when it is disabled or the screen locks. Each of those adds
        // or removes a child of the UI group, so watching that catches every
        // case without knowing which one happened.
        const { uiGroup } = Main.layoutManager;
        const [added, removed] = childSignals(uiGroup);
        uiGroup.connectObject(
            added, (_group, child) => this._onUiGroupChanged(child),
            removed, (_group, child) => this._onUiGroupChanged(child),
            this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._queueScan(), this);
        Main.extensionManager.connectObject('extension-state-changed',
            () => this._queueScan(), this);
        Main.sessionMode.connectObject('updated', () => this._queueScan(), this);

        // Reordering the dock is a drag, and a swell moving under it would make
        // the drop target jump about. Window drags in the overview and files
        // dragged in from an application count as well.
        Main.overview.connectObject(
            'item-drag-begin', () => this._setDragging(true),
            'item-drag-end', () => this._setDragging(false),
            'item-drag-cancelled', () => this._setDragging(false),
            'window-drag-begin', () => this._setDragging(true),
            'window-drag-end', () => this._setDragging(false),
            'window-drag-cancelled', () => this._setDragging(false),
            this);
        Main.xdndHandler?.connectObject?.(
            'drag-begin', () => this._setDragging(true),
            'drag-end', () => this._setDragging(false),
            this);
    }

    get maxScale() {
        return this._maxScale;
    }

    // The lock screen tears the docks down anyway, and Pear Up is not enabled
    // there, but a dock that lingered for a frame must not magnify behind it.
    get paused() {
        return this._dragging || Main.sessionMode.isLocked;
    }

    setSize(sizePercent) {
        this._maxScale = sizePercent / 100;
    }

    guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[pear-up] ${what} failed:`, e);
        }
    }

    _setDragging(dragging) {
        this._dragging = dragging;
        // A dock that was hovered all through the drag gets no new hover
        // notification when it ends, so ask each one to look again.
        if (!dragging) {
            for (const dock of this._docks.values())
                dock.wake();
        }
    }

    // The overlay itself comes and goes as a child of the UI group too, and is
    // not a reason to look for docks; nor is the bounce overlay (dockBounce.js).
    _onUiGroupChanged(child) {
        if (!child?.name?.startsWith('pearup-dock-'))
            this._queueScan();
    }

    // These signals fire in bursts, and some of them while the shell is still
    // delivering an event; looking for docks is left to an idle callback.
    _queueScan() {
        if (this._scanId)
            return;

        this._scanId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scanId = 0;
            this.guard('looking for Dash to Dock', () => this._scan());
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
            if (!this._docks.has(dock))
                this._track(dock);
        }
    }

    _track(dock) {
        this._docks.set(dock, new DockMagnification(dock, this));
        // Run before Dash to Dock destroys the dock's children, so everything
        // made transparent can still be given its opacity back.
        dock.connectObject('destroy', () => this._forget(dock, false), this);
    }

    _forget(dock, alive) {
        const magnification = this._docks.get(dock);
        if (!magnification)
            return;

        this._docks.delete(dock);
        this.guard('restoring a dock', () => magnification.destroy());
        // A destroyed dock's handlers went with it; only a live one has any
        // left to disconnect.
        if (alive)
            this.guard('releasing a dock', () => dock.disconnectObject(this));
    }

    destroy() {
        if (this._scanId) {
            GLib.source_remove(this._scanId);
            this._scanId = 0;
        }

        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.xdndHandler?.disconnectObject?.(this);

        for (const dock of [...this._docks.keys()])
            this._forget(dock, true);
    }
}

// One dock's magnification. Idle until its dock is hovered; while hovered or
// easing back out it runs a per-frame update, and once fully out it removes
// everything it made and gives every icon its opacity back.
class DockMagnification {
    constructor(dock, magnifier) {
        this._dock = dock;
        this._magnifier = magnifier;
        this._dash = dock.dash;
        this._hoverActor = dock._box;
        this._side = dock._position;
        this._vertical = this._side === St.Side.LEFT || this._side === St.Side.RIGHT;

        this._overlay = null;
        this._timeline = null;
        this._wakeId = 0;
        this._broken = false;
        this._menuOpen = false;

        this._progress = 0;
        this._lastFrame = 0;
        this._frame = 0;
        this._anchor = null;
        this._range = null;

        // Source actor (or key) → what stands in for it in the overlay.
        this._records = new Map();
        // Source actor → the opacity it had before it was made transparent.
        this._hidden = new Map();
        // Hover label → the translation it had before it was pushed out.
        this._labels = new Map();

        // Dash to Dock destroys the dash first when a dock goes, before the
        // dock's own destroy handlers run, so each of these is let go of as it
        // dies rather than disconnected from afterwards.
        this._hoverActor.connectObject(
            'notify::hover', () => this.wake(),
            'destroy', () => {
                this._hoverActor = null;
            },
            this);
        // A menu points at the icon it belongs to, which is drawn unmagnified
        // underneath; the swell steps aside while one is open. Dash to Dock
        // re-syncs its hover when the menu closes, which may leave it unchanged,
        // so that is a reason to look again as well.
        this._dash.connectObject(
            'menu-opened', () => {
                this._menuOpen = true;
            },
            'menu-closed', () => {
                this._menuOpen = false;
                this.wake();
            },
            'destroy', () => {
                this._dash = null;
            },
            this);

        // Switched on, or the dock rebuilt, with the pointer already on it: no
        // hover change is coming to start things.
        this.wake();
    }

    // Hover changes arrive during event delivery, where creating actors and
    // adding them to the stage is the kind of work that has aborted GNOME 50
    // before (see searchButton.js). Starting is left to an idle callback, a
    // frame later at most, which the ease-in hides completely.
    wake() {
        if (this._wakeId || this._broken || this._timeline)
            return;

        this._wakeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._wakeId = 0;
            try {
                this._start();
            } catch (e) {
                this._fail(e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _target() {
        if (!this._hoverActor?.hover || this._menuOpen || this._magnifier.paused)
            return 0;
        return 1;
    }

    _start() {
        if (this._timeline || this._target() === 0 || !this._dash || !this._dock.mapped)
            return;

        const uiGroup = Main.layoutManager.uiGroup;
        this._overlay = new Clutter.Actor({ name: OVERLAY_NAME, reactive: false });
        uiGroup.insert_child_above(this._overlay, this._dock);

        // Magnified icons near the ends of a long dock would otherwise be
        // pushed past the edge of the screen, or under the top bar.
        const index = Main.layoutManager.findIndexForActor(this._dock);
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        this._range = this._vertical
            ? [area.y, area.y + area.height]
            : [area.x, area.x + area.width];

        // Driven by the dock's own frame clock, so on a multi-monitor setup the
        // update runs at the rate of the monitor the dock is on, and stops when
        // it does.
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

        this._lastFrame = GLib.get_monotonic_time();
        this._timeline.start();
    }

    // Logged once, then this dock is left alone: a frame that throws would
    // otherwise throw again sixty times a second.
    _fail(e) {
        console.warn('[pear-up] Dock magnification failed, leaving this dock unmagnified:', e);
        this._broken = true;
        try {
            this._stop();
        } catch (stopError) {
            console.warn('[pear-up] Restoring the dock failed:', stopError);
        }
    }

    _onFrame() {
        if (!this._dash || !this._dock.mapped) {
            this._stop();
            return;
        }

        const now = GLib.get_monotonic_time();
        const elapsed = (now - this._lastFrame) / 1000;
        this._lastFrame = now;

        const target = this._target();
        if (target) {
            const [x, y] = global.get_pointer();
            this._anchor = this._vertical ? y : x;
        }

        // With animations turned off in Accessibility the swell appears and
        // disappears at once, the way the shell's own transitions do then. It
        // still follows the pointer: that is the feature, and it was asked for.
        if (!St.Settings.get().enable_animations) {
            this._progress = target;
        } else if (target > this._progress) {
            this._progress = Math.min(1, this._progress + elapsed / EASE_IN_MS);
        } else if (target < this._progress) {
            this._progress = Math.max(0, this._progress - elapsed / EASE_OUT_MS);
        }

        if ((this._progress === 0 && target === 0) || this._anchor === null) {
            this._stop();
            return;
        }

        // Dash to Dock re-adds its dock to the chrome when some of its settings
        // change, which stacks it above the overlay again.
        if (this._dock.get_next_sibling() !== this._overlay)
            Main.layoutManager.uiGroup.set_child_above_sibling(this._overlay, this._dock);

        this._layout(smoothstep(this._progress));
    }

    // Re-read every frame rather than remembered: apps open and close while the
    // pointer is on the dock, and Dash to Dock replaces icons when their size
    // changes.
    _items() {
        const items = [];
        const visible = this._visibleRange();

        for (const slot of this._dash._box.get_children())
            this._addItem(items, slot, visible);

        // The Show Apps icon sits outside the scroll view, so it is never
        // scrolled out of sight.
        const showApps = this._dash._showAppsIcon;
        if (showApps)
            this._addItem(items, showApps, null);

        return items;
    }

    // An overflowing dash scrolls, and the icons scrolled out of view are
    // clipped away. The overlay does not clip, so those are left out.
    _visibleRange() {
        const view = this._dash._scrollView;
        if (!view?.mapped)
            return null;

        const [x, y] = view.get_transformed_position();
        const [width, height] = view.get_transformed_size();
        return this._vertical ? [y, y + height] : [x, x + width];
    }

    _addItem(items, slot, visible) {
        if (!slot.visible || !slot.mapped)
            return;

        const [x, y] = slot.get_transformed_position();
        const [width, height] = slot.get_transformed_size();
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
            return;

        const center = this._vertical ? y + height / 2 : x + width / 2;
        if (visible && (center < visible[0] || center > visible[1]))
            return;

        const base = slot.child?.icon ?? slot.icon;
        items.push({
            slot,
            center,
            length: this._vertical ? height : width,
            base: base?.icon instanceof St.Icon ? base : null,
        });
    }

    _layout(strength) {
        this._frame++;

        const items = this._items();
        const icons = items.filter(item => item.base);
        if (icons.length === 0) {
            this._dropUnseen();
            return;
        }

        // One slot is an icon plus its padding. The largest is used so an icon
        // still animating in does not shrink the swell.
        const slot = Math.max(...icons.map(item => item.length));
        const radius = FALLOFF_SLOTS * slot;
        const gain = (this._magnifier.maxScale - 1) * strength;
        const anchor = this._anchor;

        let first = Infinity, last = -Infinity, restFirst = Infinity, restLast = -Infinity;
        for (const item of items) {
            const distance = Math.abs(item.center - anchor);
            item.scale = item.base ? 1 + gain * falloff(distance, radius) : 1;
            item.offset = Math.sign(item.center - anchor) * extraOffset(distance, radius, gain);

            const half = item.length * item.scale / 2;
            first = Math.min(first, item.center + item.offset - half);
            last = Math.max(last, item.center + item.offset + half);
            restFirst = Math.min(restFirst, item.center - item.length / 2);
            restLast = Math.max(restLast, item.center + item.length / 2);
        }

        const [low, high] = this._range;

        // Only what magnification added is pulled back in: a dock that already
        // reaches past the work area — one drawn under the top bar, say — is
        // not shoved about for it.
        let nudge = 0;
        if (first < Math.min(low, restFirst))
            nudge = Math.min(low, restFirst) - first;
        else if (last > Math.max(high, restLast))
            nudge = Math.max(high, restLast) - last;

        for (const item of items) {
            if (item.base)
                this._placeIcon(item, item.offset + nudge);
            else
                this._placeClone(this._record(item.slot, () => this._makeClone(item.slot)),
                    item.offset + nudge);
        }

        this._placeBackground(
            Math.max(0, restFirst - (first + nudge)),
            Math.max(0, last + nudge - restLast));

        this._dropUnseen();
    }

    // The shelf widens along with the icons, as on macOS. Dash to Dock's
    // background is drawn in three pieces: both rounded ends as they are, and
    // the straight middle stretched between them, so the corners keep their
    // shape however far the dock grows.
    _placeBackground(before, after) {
        const background = this._dash._background;
        if (!(background instanceof St.Widget) || !background.mapped)
            return;

        const [x, y] = background.get_transformed_position();
        const [width, height] = background.get_transformed_size();
        const along = this._vertical ? height : width;
        const across = this._vertical ? width : height;
        const restStart = this._vertical ? y : x;
        if (along <= 0 || across <= 0)
            return;

        // Never past the edge of the work area, nor shrunk where Dash to Dock
        // already draws further — a dock stretched along the whole edge, say.
        const [low, high] = this._range;
        const start = Math.round(Math.max(restStart - before, Math.min(restStart, low)));
        const end = Math.round(Math.min(restStart + along + after,
            Math.max(restStart + along, high)));

        // Half the width covers any corner radius the dock can have. Integer
        // seams, so the pieces meet without a hairline between them.
        const cap = Math.min(Math.floor(across / 2), Math.floor(along / 2));
        const middle = along - 2 * cap;
        const stretch = middle > 0 ? (end - start - 2 * cap) / middle : 1;

        // Generous across the dock, so a shadow drawn outside the background's
        // own box is kept.
        const margin = 64;
        const pieces = [
            ['background-start', -margin, cap, start, 1],
            ['background-middle', cap, along - cap, start + cap - cap * stretch, stretch],
            ['background-end', along - cap, along + margin, end - along, 1],
        ];

        for (const [key, from, to, origin, scale] of pieces) {
            const record = this._record(background, () => this._makeClone(background), key, true);
            this._placeClone(record, 0);

            const { view } = record;
            view.set_pivot_point(0, 0);
            if (this._vertical) {
                view.translation_y = origin;
                view.set_scale(1, scale);
                view.set_clip(-margin, from, across + 2 * margin, to - from);
            } else {
                view.translation_x = origin;
                view.set_scale(scale, 1);
                view.set_clip(from, -margin, to - from, across + 2 * margin);
            }
        }
    }

    _placeIcon(item, offset) {
        const { base } = item;
        const source = base.icon;
        const record = this._record(base, () => this._makeCopy());
        const copy = record.view;
        this._syncCopy(record, source);

        const [x, y] = source.get_transformed_position();
        const [width, height] = source.get_transformed_size();
        const scale = item.scale;

        // Along the dock the icon follows its slot; across it, the side facing
        // the screen edge stays put and the icon grows away from the edge, so
        // it never runs into the running dot or off the screen.
        let centerX, centerY;
        if (this._vertical) {
            centerY = y + height / 2 + offset;
            centerX = this._side === St.Side.RIGHT
                ? x + width - width * scale / 2
                : x + width * scale / 2;
        } else {
            centerX = x + width / 2 + offset;
            centerY = this._side === St.Side.BOTTOM
                ? y + height - height * scale / 2
                : y + height * scale / 2;
        }

        // An app that is launching or asking for attention hops away from the
        // edge (dockBounce.js); its magnified copy hops with it, by the same
        // share of its now larger size.
        const lift = bounceLift(item.slot.child?.app) *
            (this._vertical ? width : height) * scale;
        if (lift > 0) {
            if (this._vertical)
                centerX += this._side === St.Side.RIGHT ? -lift : lift;
            else
                centerY += this._side === St.Side.BOTTOM ? -lift : lift;
        }

        // Placed by translation rather than position throughout: a transform
        // only needs a redraw, where moving an actor every frame would have the
        // whole UI group laid out again sixty times a second.
        const [, naturalWidth] = copy.get_preferred_width(-1);
        const [, naturalHeight] = copy.get_preferred_height(-1);
        if (naturalWidth > 0 && naturalHeight > 0) {
            copy.translation_x = centerX - naturalWidth / 2;
            copy.translation_y = centerY - naturalHeight / 2;
            copy.set_scale(width * scale / naturalWidth, height * scale / naturalHeight);
        }

        // Swap only once the copy has something to show, so an icon never
        // blinks out while its larger texture is still loading.
        if (!record.ready) {
            record.frames++;
            const texture = copy.get_first_child();
            record.ready = (texture && texture.opacity > 0) || record.frames > READY_FRAME_LIMIT;
        }
        if (record.ready) {
            this._hideSource(record);
            copy.opacity = this._paintOpacity(record);
        }

        // The running dots and badges move with their icon but keep their size,
        // as on macOS.
        const parent = base.get_parent();
        for (const sibling of parent?.get_children() ?? []) {
            if (sibling !== base)
                this._placeClone(this._record(sibling, () => this._makeClone(sibling)), offset);
        }

        const across = this._vertical ? width : height;
        this._pushLabel(item.slot.label, offset, across * (scale - 1));
    }

    // Unscaled: the clone draws its source at the source's own size, moved
    // along the dock by `offset`.
    _placeClone(record, offset) {
        const { actor, view } = record;
        const parent = actor.get_parent();
        if (!parent) {
            view.hide();
            return;
        }

        // A clone paints its source without the source's own transform, so
        // that is copied across: Dash to Dock turns its dot indicator with a
        // rotation to face the dock's edge.
        const [parentX, parentY] = parent.get_transformed_position();
        const box = actor.get_allocation_box();
        const width = box.x2 - box.x1;
        const height = box.y2 - box.y1;
        if (record.width !== width || record.height !== height) {
            view.set_size(width, height);
            record.width = width;
            record.height = height;
        }

        view.translation_x = parentX + box.x1 + actor.translation_x +
            (this._vertical ? 0 : offset);
        view.translation_y = parentY + box.y1 + actor.translation_y +
            (this._vertical ? offset : 0);
        const [pivotX, pivotY] = actor.get_pivot_point();
        view.set_pivot_point(pivotX, pivotY);
        view.rotation_angle_z = actor.rotation_angle_z;
        view.set_scale(actor.scale_x, actor.scale_y);
        view.visible = actor.visible;

        this._hideSource(record);
        view.opacity = this._paintOpacity(record);
    }

    // The label sits beside the item, where the magnified icon now is. Moved
    // out past it, and along with its item, until the swell is gone.
    _pushLabel(label, offset, growth) {
        if (!(label instanceof St.Widget) || !label.visible)
            return;

        let rest = this._labels.get(label);
        if (!rest) {
            rest = {
                x: label.translation_x,
                y: label.translation_y,
                destroyId: label.connect('destroy', () => this._labels.delete(label)),
            };
            this._labels.set(label, rest);
        }

        const away = this._side === St.Side.RIGHT || this._side === St.Side.BOTTOM
            ? -growth : growth;
        if (this._vertical) {
            label.translation_x = rest.x + away;
            label.translation_y = rest.y + offset;
        } else {
            label.translation_x = rest.x + offset;
            label.translation_y = rest.y + away;
        }
    }

    _makeCopy() {
        const copy = new St.Icon({ reactive: false, opacity: 0 });
        copy.set_pivot_point(0.5, 0.5);
        return copy;
    }

    _makeClone(source) {
        return new Clutter.Clone({ source, reactive: false });
    }

    // Loaded at the largest size this icon can reach, and only scaled down
    // from there. Follows the source if Dash to Dock swaps its icon or the
    // size setting changes mid-hover.
    _syncCopy(record, source) {
        const copy = record.view;
        const size = Math.ceil((source.icon_size > 0 ? source.icon_size : source.width) *
            Math.max(1, this._magnifier.maxScale));

        if (record.source !== source) {
            record.source = source;
            copy.style_class = source.style_class;
            copy.fallback_gicon = source.fallback_gicon;
            // A symbolic icon takes its colour from the stylesheet, and the
            // overlay sits outside the dock's styling: carry the colour over.
            try {
                const color = source.get_theme_node().get_foreground_color();
                copy.set_style(`color: rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha / 255});`);
            } catch {
                copy.set_style(null);
            }
        }

        if (copy.gicon !== source.gicon)
            copy.gicon = source.gicon;
        if (copy.icon_size !== size)
            copy.icon_size = size;
    }

    // One stand-in per key. The key is the source actor itself, except for the
    // dock background, which is drawn in three pieces from one source.
    _record(actor, make, key = actor, bottom = false) {
        let record = this._records.get(key);
        if (!record) {
            record = {
                actor,
                key,
                view: make(),
                dead: false,
                ready: false,
                frames: 0,
                source: null,
                width: -1,
                height: -1,
                seen: 0,
            };
            record.destroyId = actor.connect('destroy', () => {
                record.dead = true;
                this._drop(record);
            });
            if (bottom)
                this._overlay.insert_child_below(record.view, null);
            else
                this._overlay.add_child(record.view);
            this._records.set(key, record);
        }

        record.seen = this._frame;
        return record;
    }

    // Kept transparent for as long as anything stands in for it. Dash to Dock
    // sets some of these opacities itself — half for an app that is updating,
    // zero for the stock dot it replaces — so a value it sets meanwhile becomes
    // the one to put back, and to draw the stand-in with. Kept per source, not
    // per stand-in: the background has three, and the second must not take the
    // zero the first one left as the opacity to restore.
    _hideSource(record) {
        const { actor } = record;
        let hidden = this._hidden.get(actor);
        if (!hidden) {
            hidden = { rest: actor.opacity, records: new Set() };
            this._hidden.set(actor, hidden);
        }
        hidden.records.add(record);

        if (actor.opacity !== 0) {
            hidden.rest = actor.opacity;
            actor.opacity = 0;
        }
    }

    // What the source would have been drawn with: its own opacity, times that
    // of everything above it — an item fading in, a dock fading out.
    _paintOpacity(record) {
        const rest = this._hidden.get(record.actor)?.rest ?? record.actor.opacity;
        const parentOpacity = record.actor.get_parent()?.get_paint_opacity() ?? 255;
        return Math.round(rest * parentOpacity / 255);
    }

    // Given its opacity back once nothing stands in for it any more.
    _unhideSource(record) {
        const { actor } = record;
        const hidden = this._hidden.get(actor);
        if (!hidden?.records.delete(record) || hidden.records.size > 0)
            return;

        this._hidden.delete(actor);
        if (!record.dead && actor.opacity === 0)
            actor.opacity = hidden.rest;
    }

    _drop(record) {
        if (this._records.get(record.key) === record)
            this._records.delete(record.key);

        try {
            this._unhideSource(record);
            if (!record.dead)
                record.actor.disconnect(record.destroyId);
        } catch {
            // Disposed in the same teardown; there is nothing to restore.
        }

        record.view.destroy();
    }

    // Items that left the dash since the last frame.
    _dropUnseen() {
        for (const record of [...this._records.values()]) {
            if (record.seen !== this._frame)
                this._drop(record);
        }
    }

    _restoreLabels() {
        for (const [label, rest] of this._labels) {
            try {
                label.disconnect(rest.destroyId);
                label.translation_x = rest.x;
                label.translation_y = rest.y;
            } catch {
                // Went with its item.
            }
        }
        this._labels.clear();
    }

    _stop() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline = null;
        }

        for (const record of [...this._records.values()])
            this._drop(record);
        // Empty by now, unless a stand-in was lost track of; whatever is left
        // still gets its opacity back.
        for (const [actor, hidden] of this._hidden) {
            try {
                if (actor.opacity === 0)
                    actor.opacity = hidden.rest;
            } catch {
                // Disposed along with its dock.
            }
        }
        this._hidden.clear();
        this._restoreLabels();

        this._overlay?.destroy();
        this._overlay = null;
        this._progress = 0;
        this._anchor = null;
    }

    destroy() {
        if (this._wakeId) {
            GLib.source_remove(this._wakeId);
            this._wakeId = 0;
        }

        this._stop();

        this._hoverActor?.disconnectObject(this);
        this._dash?.disconnectObject(this);
        this._hoverActor = null;
        this._dash = null;
    }
}

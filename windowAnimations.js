// Windows that open and close the way macOS has them: a new window fades in
// while it grows a little from its own centre, a closing one fades while it
// shrinks a little towards it. GNOME 45 to 50 pop a new window up from the
// bottom edge instead, starting from almost nothing, and unfold a dialog
// vertically.
//
// The shell starts these animations in its window manager's handlers for the
// compositor's map and destroy signals. Those handlers were bound when the
// shell started, so patching them would change nothing; what they call on the
// way is looked up afresh each time, though. Main.wm._shouldAnimateActor() is asked
// whether to animate just before each animation is set up, and when it says
// yes for an opening or a closing window, the window's next ease() — the one
// that animation is — is given other start values, a centred pivot, another
// duration and curve. Everything else stays the shell's: it still decides
// whether to animate at all (not in the overview, not during a workspace
// gesture, not without a texture), it still keeps the window in its own books
// while it moves, and the onStopped it passes, which tells mutter the window is
// done, is passed on untouched. So a window that goes away mid-animation, which
// mutter answers with kill-window-effects, is finished by the shell exactly as
// without Pear Up. Burn My Windows reaches the shell the same way; while it has
// an effect for a window it answers for it and this never sees the window.
//
// It is the window manager's own method that is wrapped, not its class's:
// Magic Lamp keeps the method it found on Main.wm when it was enabled and calls
// that, so a patch of the class made later would never be reached. Wrapped on
// the instance, this sits in the same chain as Magic Lamp's, whichever of the
// two came first.
//
// Only normal windows and dialogs of their own. A dialog attached to its
// parent keeps the shell's unfold, which is close to how a macOS sheet comes
// down from the title bar. Menus, tooltips, popups and override-redirect
// windows are never animated by the shell, and are left alone here too, as is
// minimizing, which is Magic Lamp's when it is installed.
//
// Durations are the shell's own ease(), which stretches them by the slow-down
// factor and makes them instant when animations are off; with animations off
// nothing is changed at all.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.wm._shouldAnimateActor(actor, types), called from _mapWindow and
//     _destroyWindow right before they set up the animation
//   - the window actor's ease(), installed on Clutter.Actor by the shell, and
//     its onStopped, which the shell uses to finish the map or destroy
//   - _getAnimationWindowType (GNOME 46 on) or the actor's _windowType (45)
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WindowManager from 'resource:///org/gnome/shell/ui/windowManager.js';
import { MethodPatch } from './shellTweaks.js';

export const WINDOW_ANIMATIONS_KEY = 'macos-window-animations';

// macOS grows a window from about nine tenths of its size and fades it in over
// a fifth of a second or so, decelerating; closing is a touch quicker.
export const OPEN = { scale: 0.9, duration: 230, mode: Clutter.AnimationMode.EASE_OUT_CUBIC };
export const CLOSE = { scale: 0.9, duration: 190, mode: Clutter.AnimationMode.EASE_OUT_QUAD };

const TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
];

// Which of the shell's handlers is asking, read from the stack as Burn My
// Windows does: _shouldAnimateActor is asked for minimizing and resizing too,
// with the same window types.
const OPENING = /^_mapWindow@/m;
const CLOSING = /^_destroyWindow@/m;

// The instance whose switch is on, if any. The patch lives at module level for
// the reason given at MethodPatch.
let active = null;

const patch = new MethodPatch(
    () => Main.wm, '_shouldAnimateActor',
    function (original, actor, types) {
        const animate = original.call(this, actor, types);
        if (animate && active) {
            try {
                active._claim(this, actor);
            } catch (e) {
                console.warn(`[${active._uuid}] restyling a window animation failed:`, e);
            }
        }
        return animate;
    });

export class WindowAnimations {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        // Window actors whose next ease() is ours to restyle, and how.
        this._armed = new Map();
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        if (!this._settings)
            return;
        if (this._settings.get_boolean(WINDOW_ANIMATIONS_KEY))
            this._enable();
        else
            this._disable();
    }

    // Puts everything back, whatever the switch says.
    destroy() {
        this._disable();
        this._settings = null;
    }

    // How many windows are waiting for their animation to start; for the tests.
    get pending() {
        return this._armed.size;
    }

    _enable() {
        if (active === this)
            return;
        if (!patch.enable()) {
            console.warn(`[${this._uuid}] This shell animates windows in a way Pear Up does not know; ` +
                'leaving them to it.');
            return;
        }
        active = this;
    }

    _disable() {
        if (active === this) {
            active = null;
            patch.disable();
            // Put back as it was found, the class's method showing through,
            // rather than as a copy of it standing on the instance.
            const wm = Main.wm;
            if (wm && Object.hasOwn(wm, '_shouldAnimateActor') &&
                wm._shouldAnimateActor === WindowManager.WindowManager?.prototype._shouldAnimateActor)
                delete wm._shouldAnimateActor;
        }
        // Animations already running finish as they began; the shell
        // finishes the window either way.
        for (const actor of [...this._armed.keys()])
            this._disarm(actor);
    }

    // Called from inside the shell's _shouldAnimateActor, once it has said yes.
    _claim(wm, actor) {
        const stack = new Error().stack ?? '';
        const kind = OPENING.test(stack) ? 'open' : CLOSING.test(stack) ? 'close' : null;
        if (!kind || !St.Settings.get().enable_animations)
            return;

        const window = actor.meta_window;
        if (!window || window.is_attached_dialog())
            return;
        const type = typeof wm._getAnimationWindowType === 'function'
            ? wm._getAnimationWindowType(actor)
            : actor._windowType ?? window.get_window_type();
        if (!TYPES.includes(type))
            return;

        // A window closed before its opening began: the closing is what is
        // wanted now.
        const armed = this._armed.get(actor);
        if (armed) {
            armed.kind = kind;
            return;
        }

        // Somebody else is already standing in for this window's ease().
        if (Object.hasOwn(actor, 'ease'))
            return;

        const self = this;
        const base = actor.ease;
        const entry = { kind };
        entry.ease = function (params = {}, ...rest) {
            // The opening animation is set up after an await, and a window can
            // be resized before it, which the shell animates with ease() too.
            // That one goes through as it is, and the stand-in stays.
            const stack = new Error().stack ?? '';
            if (!(entry.kind === 'open' ? OPENING : CLOSING).test(stack))
                return base.call(this, params, ...rest);
            self._disarm(this);
            return self._restyle(this, entry.kind, params, rest);
        };
        actor.ease = entry.ease;
        this._armed.set(actor, entry);
        actor.connectObject('destroy', () => this._disarm(actor), this);
    }

    _disarm(actor) {
        const entry = this._armed.get(actor);
        if (!entry)
            return;
        this._armed.delete(actor);
        if (actor.ease === entry.ease)
            delete actor.ease;
        try {
            actor.disconnectObject(this);
        } catch {
            // Already gone.
        }
    }

    _restyle(actor, kind, params, rest) {
        const look = kind === 'open' ? OPEN : CLOSE;
        actor.set_pivot_point(0.5, 0.5);
        if (kind === 'open') {
            // The shell has just set it up as a sliver at the bottom edge,
            // transparent; it opens from nine tenths, transparent.
            actor.scale_x = look.scale;
            actor.scale_y = look.scale;
            actor.opacity = 0;
        }
        const target = kind === 'open'
            ? { opacity: 255, scale_x: 1, scale_y: 1 }
            : { opacity: 0, scale_x: look.scale, scale_y: look.scale };
        return actor.ease({
            ...params,
            ...target,
            duration: look.duration,
            mode: look.mode,
        }, ...rest);
    }
}

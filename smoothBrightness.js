// Automatic brightness that fades from one light level to the next, as it does
// on macOS, instead of jumping.
//
// From GNOME 49 the shell sets the backlight itself. With Automatic Screen
// Brightness on, gnome-settings-daemon reads the light sensor and sends the
// shell a target level, at most ten times a second, and the shell applies each
// one the moment it arrives. The daemon smooths the readings first, but by the
// time since the last change: the first change after a quiet spell gets almost
// no smoothing, so turning on a lamp, or walking out of the sun, is one step.
// Here the level moves to each target over a few seconds instead, quicker
// brightening than darkening — macOS fades slowly into the dark — and only the
// automatic level moves that way: the brightness slider and keys still act at
// once, and so does the dimming when the screen goes idle.
//
// The shell also mistakes its own writes for someone else's (gnome-shell MR
// !4467, open). Each write reaches the backlight a moment later, and while one
// is on its way mutter can report the one before it as a change made by the
// system. The shell then takes that level, which has the automatic level in it,
// for the slider's, so the automatic level counts twice from then on, and it
// stops dimming, since a change from outside is meant to win over that. A fade
// writes many levels in a row, which makes this far more likely, so while it is
// on, a level read back that is one of the last few written is let pass, and
// a real change from outside has the automatic level taken off before it goes
// to the slider, as that MR does.
//
// GNOME 45 to 48 have none of this: gnome-settings-daemon sets the brightness
// there, out of the shell's reach, and the preferences leave the switch out.
// Pear Up is off on the lock screen, as it has no session modes of its own, so
// there the shell's own steps are back until the unlock.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.brightnessManager: the autoBrightnessTarget accessor of its class,
//     which the org.gnome.Shell.Brightness D-Bus method sets; _abTarget, the
//     level it applies, and _sync(), which applies it; the scales and
//     globalScale getters, and its changed signal
//   - the class of its monitor scales, which is not exported and is reached
//     through one of them: setBacklight(), syncWithBacklight(), and the
//     _getBacklights(), _getRelativeBrightness() and
//     _currentBacklightBrightness these use
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MethodPatch } from './shellTweaks.js';

export const SMOOTH_BRIGHTNESS_KEY = 'smooth-auto-brightness';

// How the level moves: by a share of the way left on each tick, which is a
// curve with these time constants — 63% of the way after one of them, 95%
// after three — and by at least a small step, so the end of the curve is not
// drawn out. A tick that comes late moves no further than two would, so a busy
// moment in the shell does not turn into a jump.
const TICK_MS = 40;
const BRIGHTEN_SECONDS = 1.5;
const DARKEN_SECONDS = 3;
const MIN_STEP = 0.002;
const LONGEST_TICK_SECONDS = 2 * TICK_MS / 1000;

// A level read back is one of ours if it was among the last of these written,
// and recently: a write is never more than one behind the one on its way, but
// a fade writes 25 a second, and a slow write can let several go by.
const OWN_WRITES = 16;
const OWN_WRITE_US = 2 * GLib.USEC_PER_SEC;

// The level at which the slider adds nothing to the automatic level, and its
// position at GNOME's defaults.
const NEUTRAL = 0.5;

// One line per shell session, not one per unlock.
const told = new Set();

// The monitor scales' class, once one has been seen. The patches below are made
// once per shell session for the reason given at MethodPatch.
let scaleClass = null;

// What each monitor scale wrote last, in the backlight's own units, and when.
const ownWrites = new WeakMap();

const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

function rememberWrite(scale) {
    const value = scale._currentBacklightBrightness;
    if (!Number.isInteger(value))
        return;

    const now = GLib.get_monotonic_time();
    const writes = (ownWrites.get(scale) ?? [])
        .filter(write => write.value !== value && now - write.time < OWN_WRITE_US);
    writes.push({ value, time: now });
    ownWrites.set(scale, writes.slice(-OWN_WRITES));
}

function isOwnWrite(scale, value) {
    const now = GLib.get_monotonic_time();
    return (ownWrites.get(scale) ?? [])
        .some(write => write.value === value && now - write.time < OWN_WRITE_US);
}

const setBacklightPatch = new MethodPatch(() => scaleClass, 'setBacklight',
    function (original, ...args) {
        const result = original.apply(this, args);
        rememberWrite(this);
        return result;
    });

// The shell asks this of every monitor scale each time it applies a level, and
// takes a true answer for a change from outside: the slider moves to it and
// dimming stops.
const syncWithBacklightPatch = new MethodPatch(() => scaleClass, 'syncWithBacklight',
    function (original, ...args) {
        const brightness = this._getBacklights?.()[0]?.brightness;
        if (brightness !== this._currentBacklightBrightness && isOwnWrite(this, brightness))
            return false;

        const changed = original.apply(this, args);
        // The backlight is the automatic level plus the slider's share, so the
        // slider's share is what is left once the level is taken off. A shell
        // that passes the share in takes it off itself.
        const level = Main.brightnessManager?._abTarget;
        if (changed && args.length === 0 && typeof level === 'number' && level >= 0)
            this.value = clamp(this.value - (level - NEUTRAL), 0, 1);
        return changed;
    });

// The class's own accessor, wherever on the prototype chain it is.
function findAccessor(object, name) {
    for (let proto = Object.getPrototypeOf(object); proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor)
            return descriptor.get && descriptor.set ? descriptor : null;
    }
    return null;
}

export class SmoothBrightness {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._manager = null;
        this._accessor = null;
        this._shadow = null;
        this._goal = -1;
        this._tickId = 0;
        this._lastTick = 0;
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        if (!this._settings)
            return;

        if (this._settings.get_boolean(SMOOTH_BRIGHTNESS_KEY))
            this._guard('smoothing automatic brightness', () => this._enable());
        else
            this._guard('undoing smooth automatic brightness', () => this._disable());
    }

    // Puts everything back, whatever the switch says.
    destroy() {
        this._guard('restoring automatic brightness', () => this._disable());
        this._settings = null;
    }

    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[${this._uuid}] ${what} failed:`, e);
        }
    }

    _tellOnce(what, message, warn = true) {
        if (told.has(what))
            return;
        told.add(what);
        if (warn)
            console.warn(`[${this._uuid}] ${message}`);
        else
            console.log(`[${this._uuid}] ${message}`);
    }

    _enable() {
        if (this._manager)
            return;

        const manager = Main.brightnessManager;
        if (!manager) {
            this._tellOnce('manager', 'This shell leaves automatic brightness to ' +
                'gnome-settings-daemon; there is nothing for Pear Up to smooth.', false);
            return;
        }

        // Somebody else's stand-in for the accessor is theirs, and is left alone.
        const accessor = findAccessor(manager, 'autoBrightnessTarget');
        if (!accessor || Object.hasOwn(manager, 'autoBrightnessTarget') ||
            typeof manager._abTarget !== 'number' || typeof manager._sync !== 'function' ||
            !('globalScale' in manager) || !('scales' in manager)) {
            this._tellOnce('internals', 'This shell sets automatic brightness in a way Pear Up ' +
                'does not know; leaving it to jump.');
            return;
        }

        // Where the shell is now is where the fade is heading.
        this._manager = manager;
        this._accessor = accessor;
        this._goal = manager._abTarget;

        // An own accessor on the shell's one manager, over its class's. Left
        // behind by anything that kept hold of it, it hands everything on.
        const self = this;
        this._shadow = {
            configurable: true,
            enumerable: accessor.enumerable,
            get() {
                return self._manager === manager ? self._goal : accessor.get.call(manager);
            },
            set(target) {
                if (self._manager !== manager) {
                    accessor.set.call(manager, target);
                    return;
                }
                try {
                    self._setGoal(target);
                } catch (e) {
                    console.warn(`[${self._uuid}] fading to a new brightness failed:`, e);
                    self._stop();
                    accessor.set.call(manager, target);
                }
            },
        };
        Object.defineProperty(manager, 'autoBrightnessTarget', this._shadow);

        // The monitor scales are made again whenever the monitors change, and
        // there may be none yet: a laptop that starts with its lid shut.
        manager.connectObject('changed',
            () => this._guard('watching the backlight', () => this._patchScales()), this);
        this._patchScales();
    }

    _patchScales() {
        if (!this._manager)
            return;

        if (!scaleClass) {
            const scale = this._manager.scales?.[0];
            if (!scale)
                return;
            const proto = Object.getPrototypeOf(scale);
            const known = ['setBacklight', 'syncWithBacklight']
                .every(name => Object.hasOwn(proto, name) && typeof proto[name] === 'function') &&
                typeof proto._getBacklights === 'function' &&
                typeof scale._currentBacklightBrightness === 'number';
            if (!known) {
                this._tellOnce('scales', 'This shell reads the backlight back in a way Pear Up ' +
                    'does not know; leaving that as it is.');
                return;
            }
            scaleClass = proto;
        }

        if (!setBacklightPatch.enable() || !syncWithBacklightPatch.enable()) {
            setBacklightPatch.disable();
            syncWithBacklightPatch.disable();
        }
    }

    _setGoal(target) {
        const manager = this._manager;
        this._goal = target;

        // Off, or the screen blanked, at once and as the shell does it, and the
        // fade stops there. A shell with no backlight to set has nothing to fade.
        if (!(target >= 0) || !manager.globalScale) {
            this._stop();
            this._accessor.set.call(manager, target);
            return;
        }

        // Switched on, or back after the screen blanked: the fade starts from
        // where the screen is.
        if (!(manager._abTarget >= 0))
            manager._abTarget = this._currentLevel();
        this._start();
    }

    // The automatic level that leaves the screen as it is: the backlight's level
    // less the slider's share. Automatic brightness off, the backlight is the
    // slider, so that is the neutral level, unless the screen is dimmed or
    // something else has moved it.
    _currentLevel() {
        const scale = this._manager.scales?.[0];
        if (!scale)
            return NEUTRAL;

        let level = scale.value;
        try {
            const [backlight] = scale._getBacklights();
            level = scale._getRelativeBrightness(backlight);
        } catch {
            // The slider's value, then, which is what the backlight would be.
        }
        return Number.isFinite(level) ? clamp(level - (scale.value - NEUTRAL), 0, 1) : NEUTRAL;
    }

    _start() {
        if (this._tickId)
            return;

        this._lastTick = GLib.get_monotonic_time();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => this._tick());
        GLib.Source.set_name_by_id(this._tickId, '[pear-up] smooth automatic brightness');
    }

    _stop() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        let arrived = true;
        try {
            arrived = this._step();
        } catch (e) {
            console.warn(`[${this._uuid}] fading the brightness failed:`, e);
            // Where it was heading, then, all at once.
            if (this._manager)
                this._guard('setting the brightness', () => this._accessor.set.call(this._manager, this._goal));
        }
        if (!arrived)
            return GLib.SOURCE_CONTINUE;

        this._tickId = 0;
        return GLib.SOURCE_REMOVE;
    }

    // Moves the level one tick nearer the goal and applies it; whether it is
    // there. Values only: the shell writes the backlight, and draws nothing.
    _step() {
        const manager = this._manager;
        if (!manager)
            return true;

        const now = GLib.get_monotonic_time();
        const seconds = Math.min((now - this._lastTick) / GLib.USEC_PER_SEC, LONGEST_TICK_SECONDS);
        this._lastTick = now;

        const goal = this._goal;
        const level = manager._abTarget;
        if (!(goal >= 0) || !(level >= 0))
            return true;

        const distance = goal - level;
        const time = distance > 0 ? BRIGHTEN_SECONDS : DARKEN_SECONDS;
        let step = distance * (1 - Math.exp(-seconds / time));
        if (Math.abs(step) < MIN_STEP)
            step = Math.sign(distance) * MIN_STEP;

        const arrived = Math.abs(distance) <= Math.abs(step);
        manager._abTarget = arrived ? goal : level + step;
        manager._sync();
        return arrived;
    }

    _disable() {
        setBacklightPatch.disable();
        syncWithBacklightPatch.disable();

        const manager = this._manager;
        if (!manager)
            return;

        this._manager = null;
        this._stop();
        try {
            manager.disconnectObject(this);
        } catch {
            // Gone with the shell, at logout.
        }

        const own = Object.getOwnPropertyDescriptor(manager, 'autoBrightnessTarget');
        if (own?.get === this._shadow.get && own?.set === this._shadow.set)
            delete manager.autoBrightnessTarget;
        this._shadow = null;

        // Where the fade was heading, at once and through the shell's own
        // accessor, which applies it.
        this._accessor.set.call(manager, this._goal);
    }
}

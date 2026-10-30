// Switching desktops the way macOS moves between Spaces: on a spring, and with
// a rubber band at both ends.
//
// GNOME slides the desktops across in 250 ms on an ease-out curve, and stops the
// fingers dead at the first and last desktop. macOS does three things that this
// puts in:
//   - a keyboard switch, and the slide after the fingers let go, settle on a
//     critically damped spring: quick off the mark, as fast as the fingers were
//     going when they let go, and a soft landing, in about 0.4 s;
//   - pulled past the first or last desktop, the desktops follow with growing
//     resistance — d' = c(1 - 1/(d/c + 1)), c a sixth or so of the screen — and
//     spring back when the fingers let go;
//   - the switch shortcut on the last desktop (or the first) gives a small bump
//     the way it points, instead of nothing.
//
// The end of the row is the end GNOME has: with dynamic workspaces that is the
// empty desktop it keeps on the right, which the shortcut and the overview reach
// too, so a swipe still does as well. With a single desktop both ends are there.
//
// Only the desktop switcher's own swipe tracker is touched, as own properties on
// that one instance; the overview's and the app grid's trackers are other
// instances of the same class and keep the shell's methods. The overview itself
// is not touched at all.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.wm._workspaceAnimation, the WorkspaceAnimationController: its
//     animateSwitch(), which the window manager calls through the instance, its
//     _switchData.monitors (the MonitorGroups of a switch) and _swipeTracker
//   - a MonitorGroup's 'progress' transition, made by the controller with
//     ease_property(), its _container (what slides) and baseDistance
//   - the SwipeTracker instance's confirmSwipe(), _reset(), _getBounds(),
//     _snapPoints, _initialProgress and _progress; from GNOME 49 also
//     _updateGesture(delta, distance) and _endGesture(velocity, distance, …),
//     which the shell reaches through the instance. Before 49 the tracker binds
//     them when it is made, so 45 to 48 get the spring and the bump but no
//     rubber band under the fingers
//   - Main.wm.setCustomKeybindingHandler() and _showWorkspaceSwitcher(), the
//     handler the shell gives the switch-to-workspace-* bindings, and
//     _allowedKeybindings, the action modes each binding was given
//   - WorkspaceAnimation.MonitorGroup, built for the bump as a switch builds it
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import { InstancePatch } from './shellTweaks.js';

export const SPACES_SPRING_KEY = 'spaces-spring';

// The spring. A critically damped one, released towards its rest point with
// some speed: x(u) = 1 - (1 + (W - s)u)e^(-Wu) over the animation's time u in
// [0, 1], where s is how fast it starts, in distances per duration. W sets how
// far it has settled when the time is up: e^-8.6 leaves a fraction of a pixel.
// A start faster than W overshoots a little, as a hard flick does on macOS, so
// the start is held where that stays under half a percent.
const SETTLE = 8.6;
const FASTEST_START = 1.3 * SETTLE;
const SLOWEST_START = -0.5 * SETTLE;

// A keyboard switch starts as fast as GNOME's ease-out does and takes longer to
// land: 91% of the way after 150 ms, still settling at 380.
const SWITCH_MS = 380;
const SWITCH_START = 0.5 * SETTLE;

// After the fingers let go. GNOME picks its duration so that its curve starts
// at the fingers' speed: an ease-out cubic starts at three distances per
// duration. The spring is given the same speed over its own duration.
const RELEASE_MS = 420;
const EASE_OUT_CUBIC_START = 3;

// How far the desktops can be pulled past the end, as a share of the distance
// from one desktop to the next. Half of it is reached by pulling that far.
const STRETCH = 0.15;

// The bump: out by this share of the screen's width (or height) and back, the
// way a spring answers a knock — out in about 50 ms, then a long soft return.
const BUMP_MS = 420;
const BUMP_SHARE = 0.035;
const BUMP_PEAK = 0.12;

const BINDINGS = {
    'switch-to-workspace-left': Meta.MotionDirection.LEFT,
    'switch-to-workspace-right': Meta.MotionDirection.RIGHT,
    'switch-to-workspace-up': Meta.MotionDirection.UP,
    'switch-to-workspace-down': Meta.MotionDirection.DOWN,
};
const BINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// One line per shell session, not one per unlock.
const told = new Set();

const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

// The spring's position at u, for a start speed s; exactly 1 at u = 1.
export function springCurve(start) {
    const s = clamp(start, SLOWEST_START, FASTEST_START);
    const at = u => 1 - (1 + (SETTLE - s) * u) * Math.exp(-SETTLE * u);
    const rest = 1 - at(1);
    return u => at(u) + u * rest;
}

// A knock's answer at u: up to 1 at BUMP_PEAK and back to nothing.
function bumpCurve(u) {
    const t = u / BUMP_PEAK;
    return t * Math.exp(1 - t);
}

// How far the desktops follow a pull of `pull` pixels past the end, and back.
export function rubber(pull, limit) {
    return limit * (1 - 1 / (pull / limit + 1));
}

function unrubber(shown, limit) {
    return shown >= limit ? Infinity : limit * shown / (limit - shown);
}

function animationsOn() {
    return St.Settings.get().enable_animations;
}

function slowDown() {
    return St.Settings.get().slow_down_factor;
}

function vertical() {
    return global.workspace_manager.layout_rows === -1;
}

// How a group's container moves as progress grows: the sign of the step in x
// (or y) for one more desktop. MonitorGroup's own progress setter, read back.
function containerSign(group) {
    if (vertical())
        return -1;
    return group.get_text_direction() === Clutter.TextDirection.RTL ? 1 : -1;
}

function translationProp() {
    return vertical() ? 'translation_y' : 'translation_x';
}

// The transitions already on the spring: each is put on it once.
const sprung = new WeakSet();

// Puts a progress transition the controller has just started on the spring.
// GJS cannot hand a timeline a progress function (the value a JavaScript one
// returns is lost), so the transition runs linearly, and before it works out
// its value for each frame its end point is moved to where a straight line
// from its start, that far along, meets the spring: from + (to - from) * c(u)
// at u is from + (to' - from) * u for to' = from + (to - from) * c(u) / u. The
// shell's transition then sets the spring's value itself, once a frame; at the
// last frame its end point goes back on `to` exactly, so it still ends
// where it would, on the same frame, and its completion is still the shell's.
// The shell reads where the desktops are from the group, never from the
// transition's end point. Each transition's handlers go when it stops; turned
// off in the middle, a slide finishes on the spring, as it began.
function springTransition(transition, ms, start) {
    if (sprung.has(transition))
        return;
    const interval = transition.get_interval();
    const from = interval?.peek_initial_value();
    const to = interval?.peek_final_value();
    if (typeof from !== 'number' || typeof to !== 'number')
        return;
    sprung.add(transition);

    const curve = springCurve(start);
    transition.set_duration(Math.max(1, Math.round(ms)));
    transition.set_progress_mode(Clutter.AnimationMode.LINEAR);
    // Before the transition's own handler, which runs last.
    const frameId = transition.connect('new-frame', () => {
        const u = clamp(transition.get_progress(), 0, 1);
        if (u >= 1)
            transition.set_to(to);
        else if (u > 0)
            transition.set_to(from + (to - from) * curve(u) / u);
    });
    const stoppedId = transition.connect('stopped', () => {
        transition.disconnect(frameId);
        transition.disconnect(stoppedId);
    });
}

export class SpacesSpring {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._controller = null;
        this._tracker = null;
        this._own = [];
        this._prepare = null;
        this._bindings = null;
        this._swipe = null;
        this._release = null;
        this._springBack = null;
        this._bump = null;
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        if (!this._settings)
            return;

        if (this._settings.get_boolean(SPACES_SPRING_KEY))
            this._guard('putting desktop switching on a spring', () => this._enable());
        else
            this._guard('taking desktop switching off its spring', () => this._disable());
    }

    // Puts everything back, whatever the switch says.
    destroy() {
        this._guard('taking desktop switching off its spring', () => this._disable());
        this._settings = null;
    }

    // For the tests and the preview: what is in place.
    get state() {
        return {
            on: !!this._controller,
            keyboard: this._own.some(o => o.name === 'animateSwitch'),
            rubberBand: this._own.some(o => o.name === '_updateGesture'),
            bump: !!this._bindings,
            stretch: this._swipe?.excess ?? 0,
            bumping: !!this._bump,
            springingBack: !!this._springBack,
        };
    }

    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[${this._uuid}] ${what} failed:`, e);
        }
    }

    _tellOnce(what, message) {
        if (told.has(what))
            return;
        told.add(what);
        console.warn(`[${this._uuid}] ${message}`);
    }

    // An own property over the class's method, on the one object, called as
    // replacement(original, ...args); see InstancePatch for what is beneath
    // it and how it comes off.
    _override(object, name, replacement) {
        const patch = new InstancePatch(object, name);
        if (!patch.enable(replacement))
            return null;
        this._own.push({ name, patch });
        return patch;
    }

    _enable() {
        if (this._controller)
            return;

        const controller = Main.wm?._workspaceAnimation;
        const tracker = controller?._swipeTracker;
        if (typeof controller?.animateSwitch !== 'function' || !('_switchData' in controller) ||
            typeof tracker?.confirmSwipe !== 'function' || typeof tracker._reset !== 'function') {
            this._tellOnce('controller', 'This shell switches desktops in a way Pear Up does ' +
                'not know; leaving the switch as it is.');
            return;
        }
        this._controller = controller;
        this._tracker = tracker;

        const self = this;

        // The keyboard switch, and any switch the shell animates itself.
        this._override(controller, 'animateSwitch', function (original, ...args) {
            self._stopBump();
            const result = original.apply(this, args);
            self._guard('springing the switch', () =>
                self._retime(SWITCH_MS * slowDown(), () => SWITCH_START));
            return result;
        });

        // A swipe begun during a bump: the bump makes way first, so the swipe
        // gets a switch of its own with every desktop in it.
        this._prepare = this._override(controller, '_prepareWorkspaceSwitch', function (original, ...args) {
            self._stopBump();
            return original.apply(this, args);
        });

        // The release, on every release: the shell has started its slide by
        // the time the tracker's end signal reaches this, the next handler.
        tracker.connectObject(
            'begin', () => this._stopBump(),
            'end', (_tracker, duration) =>
                this._guard('springing the release', () => this._onRelease(duration)),
            this);

        Main.overview.connectObject('showing', () => {
            this._stopBump();
            this._stopSpringBack(true);
        }, this);

        this._addRubberBand(tracker);
        this._addBump();
    }

    _addRubberBand(tracker) {
        const proto = Object.getPrototypeOf(tracker);
        const known = typeof proto._updateTouchpadGesture === 'function' &&
            typeof proto._updateGesture === 'function' && proto._updateGesture.length === 2 &&
            typeof proto._endGesture === 'function' && typeof proto._getBounds === 'function' &&
            Array.isArray(tracker._snapPoints) && typeof tracker._progress === 'number' &&
            typeof tracker._initialProgress === 'number';
        if (!known) {
            this._tellOnce('rubber', 'This shell tracks the fingers in a way Pear Up cannot ' +
                'stretch; the desktops stop at the ends as before.');
            return;
        }

        const self = this;

        // A swipe starts here, from the shell's begin handler; if it starts on a
        // desktop still springing back from a pull, it starts from that pull.
        this._override(tracker, 'confirmSwipe', function (original, ...args) {
            const result = original.apply(this, args);
            self._guard('starting a swipe', () => {
                self._swipe = { excess: self._takeOverSpringBack() };
            });
            return result;
        });

        this._override(tracker, '_reset', function (original, ...args) {
            self._swipe = null;
            return original.apply(this, args);
        });

        // The shell's update, with the clamp at either end of the row of
        // desktops let go, the pull past it kept apart from the progress the
        // shell sees, so its sums, snap points and the overview's adjustment
        // stay as they were. Clamps inside the row, one desktop per swipe, stay.
        this._override(tracker, '_updateGesture', function (original, delta, distance) {
            const swipe = self._swipe;
            if (!swipe)
                return original.call(this, delta, distance);

            const [lower, upper] = this._getBounds(this._initialProgress);
            const points = this._snapPoints;
            const raw = this._progress + swipe.excess + delta / distance;
            const progress = clamp(raw, lower, upper);

            let excess = 0;
            if (animationsOn()) {
                if (raw > upper && upper === points[points.length - 1])
                    excess = raw - upper;
                else if (raw < lower && lower === points[0])
                    excess = raw - lower;
            }

            swipe.excess = excess;
            this._progress = progress;
            this.emit('update', progress);
            self._guard('stretching the desktops', () => self._stretch(excess));
            return undefined;
        });

        // Let go while pulled past the end: the shell is told where the fingers
        // really are, so it lands on the end desktop and takes time over it,
        // rather than finishing at once and dropping the stretched desktops.
        this._override(tracker, '_endGesture', function (original, velocity, distance, ...rest) {
            const swipe = self._swipe;
            if (swipe && swipe.excess !== 0 && distance > 0) {
                self._release = { excess: swipe.excess, velocity: velocity / distance };
                this._progress += swipe.excess;
            }
            return original.call(this, velocity, distance, ...rest);
        });
    }

    _addBump() {
        const wm = Main.wm;
        if (typeof wm?.setCustomKeybindingHandler !== 'function' ||
            typeof wm._showWorkspaceSwitcher !== 'function' ||
            typeof WorkspaceAnimation.MonitorGroup !== 'function') {
            this._tellOnce('bump', 'This shell binds the desktop keys in a way Pear Up does not ' +
                'know; there is no bump at the ends.');
            return;
        }

        // Another handler set for one of them after this one is its owner's
        // from then on, and stays when this goes; so the keys are taken only
        // where that can be seen.
        const bindings = { owner: this, handler: null, modes: {}, claimed: new Set(), patch: null };
        const patch = new InstancePatch(wm, 'setCustomKeybindingHandler');
        if (!patch.enable(function (original, name, ...args) {
            if (name in BINDINGS && args[args.length - 1] !== bindings.handler)
                bindings.claimed.add(name);
            return original.call(this, name, ...args);
        })) {
            this._tellOnce('bump-setter', 'Something else holds the shell\'s keybinding setter; there is no ' +
                'bump at the ends.');
            return;
        }
        bindings.patch = patch;

        // The binding comes last: GNOME 45 passes no event before it. Off, the
        // handler is the shell's alone and holds nothing of this, for anything
        // that kept it.
        bindings.handler = (...args) => {
            const binding = args[args.length - 1];
            const owner = bindings.owner;
            owner?._guard('bumping at the end', () => owner._maybeBump(binding?.get_name?.()));
            wm._showWorkspaceSwitcher(...args);
        };
        this._bindings = bindings;
        for (const name of Object.keys(BINDINGS)) {
            bindings.modes[name] = wm._allowedKeybindings?.[name] ?? BINDING_MODES;
            wm.setCustomKeybindingHandler(name, BINDING_MODES, bindings.handler);
        }
    }

    _disable() {
        this._stopBump();
        this._stopSpringBack(true);
        this._guard('putting the stretch back', () => this._stretch(0));

        // Back to the shell's handler, with the modes each had, unless
        // something else has taken it since. Meta cannot say whose handler a
        // binding had before this one took it, so one set by another extension
        // before Pear Up came on goes back to the shell's.
        const bindings = this._bindings;
        if (bindings) {
            this._bindings = null;
            bindings.owner = null;
            bindings.patch?.disable();
            const wm = Main.wm;
            for (const name of Object.keys(BINDINGS)) {
                if (bindings.claimed.has(name))
                    continue;
                this._guard(`giving ${name} back to the shell`, () =>
                    wm.setCustomKeybindingHandler(name, bindings.modes[name],
                        wm._showWorkspaceSwitcher.bind(wm)));
            }
        }

        for (const { patch } of this._own.splice(0))
            patch.disable();
        this._prepare = null;

        for (const target of [this._tracker, Main.overview]) {
            try {
                target?.disconnectObject(this);
            } catch {
                // Gone with the shell, at logout.
            }
        }

        this._swipe = null;
        this._release = null;
        this._controller = null;
        this._tracker = null;
    }

    _groups() {
        return this._controller?._switchData?.monitors ?? [];
    }

    // The progress transitions the controller has just started, on the spring.
    _retime(ms, startFor) {
        for (const group of this._groups()) {
            const transition = group.get_transition('progress');
            if (transition && !sprung.has(transition))
                springTransition(transition, ms, startFor(transition));
        }
    }

    _onRelease(duration) {
        const release = this._release;
        this._release = null;
        if (!this._controller)
            return;

        const ms = RELEASE_MS * slowDown();
        // Both durations are in the same slowed-down time, so the ratio is the
        // fingers' speed whatever the slow-down factor.
        this._retime(ms, transition => {
            const shells = transition.get_duration();
            return shells > 0 ? EASE_OUT_CUBIC_START * ms / shells : SWITCH_START;
        });

        if (release)
            this._springBackFrom(release, duration > 0 ? ms : 0);
    }

    // Moves every group's desktops `excess` desktops' worth of pull past the end.
    _stretch(excess) {
        const prop = translationProp();
        for (const group of this._groups()) {
            const container = group._container;
            if (!container)
                continue;
            const base = group.baseDistance;
            const shown = rubber(Math.abs(excess) * base, STRETCH * base);
            container[prop] = containerSign(group) * Math.sign(excess) * shown;
        }
    }

    // Back from the stretch to the end desktop, on the spring, starting at the
    // speed the fingers left it with. Its own timeline, in step with the
    // shell's slide; the groups go when the slide finishes, and it with them.
    _springBackFrom(release, ms) {
        this._stopSpringBack(false);
        const groups = this._groups().filter(g => g._container);
        if (!groups.length)
            return;
        if (ms <= 0) {
            this._stretch(0);
            return;
        }

        const prop = translationProp();
        const from = groups.map(g => g._container[prop]);
        const group = groups[0];
        const base = group.baseDistance;
        const limit = STRETCH * base;
        const pulled = Math.abs(release.excess) * base;
        // Speed of the shown stretch, by the rubber's slope where it was let go,
        // and towards rest when positive.
        const slope = 1 / (pulled / limit + 1) ** 2;
        const shown = rubber(pulled, limit);
        const towards = -Math.sign(release.excess) * release.velocity * base * slope;
        const curve = springCurve(shown > 0 ? towards * ms / shown : SWITCH_START);

        const timeline = new Clutter.Timeline({ actor: group, duration: Math.round(ms) });
        const apply = u => {
            const left = 1 - curve(u);
            groups.forEach((g, i) => {
                g._container[prop] = from[i] * left;
            });
        };
        timeline.connect('new-frame', () => apply(timeline.get_progress()));
        timeline.connect('stopped', (_t, finished) => {
            if (finished)
                apply(1);
            if (this._springBack?.timeline === timeline)
                this._stopSpringBack(false);
        });
        const destroyIds = groups.map(g => [g, g.connect('destroy', () => this._stopSpringBack(false))]);
        this._springBack = { timeline, groups, destroyIds };
        timeline.start();
    }

    // A swipe begun during the spring back takes over the stretch where it is.
    _takeOverSpringBack() {
        const springBack = this._springBack;
        this._stopSpringBack(false);
        const group = springBack?.groups[0] ?? this._groups()[0];
        const container = group?._container;
        if (!container)
            return 0;
        const shown = container[translationProp()];
        if (!shown)
            return 0;
        const base = group.baseDistance;
        const pulled = unrubber(Math.abs(shown), STRETCH * base);
        if (!Number.isFinite(pulled))
            return 0;
        return Math.sign(shown * containerSign(group)) * pulled / base;
    }

    _stopSpringBack(reset) {
        const springBack = this._springBack;
        if (!springBack)
            return;
        this._springBack = null;
        for (const [group, id] of springBack.destroyIds) {
            try {
                group.disconnect(id);
            } catch {
                // Already destroyed.
            }
        }
        springBack.timeline.stop();
        if (reset) {
            const prop = translationProp();
            for (const group of springBack.groups) {
                if (group._container)
                    group._container[prop] = 0;
            }
        }
    }

    // The shortcut pointed past the end: the desktop gives a little and comes
    // back. Only where the shell would slide the desktops for this binding, and
    // not over a switch or a swipe already moving them; again and again, if the
    // key is held.
    _maybeBump(name) {
        const direction = BINDINGS[name];
        const controller = this._controller;
        if (direction === undefined || !controller || Main.overview.visible ||
            !animationsOn() || !Main.sessionMode.hasWorkspaces)
            return;
        if (controller._switchData && controller._switchData !== this._bump?.switchData)
            return;

        const manager = global.workspace_manager;
        const upDown = direction === Meta.MotionDirection.UP ||
            direction === Meta.MotionDirection.DOWN;
        if (manager.layout_rows === -1 && !upDown)
            return;
        if (manager.layout_columns === -1 && upDown)
            return;

        const active = manager.get_active_workspace();
        if (active.get_neighbor(direction) !== active)
            return;

        this._startBump(direction, active.index());
    }

    // Made as the shell makes a switch, with the one desktop in it, so it looks
    // like one — and whatever else hooks the switch (Blur my Shell puts its
    // background behind it) does so for this too.
    _startBump(direction, index) {
        this._stopBump();

        // Past this one's own wrapper, which would stop the bump, to whatever
        // is beneath it: the shell's, or another extension's.
        const controller = this._controller;
        const prepare = this._prepare?.original ?? controller._prepareWorkspaceSwitch;
        prepare.call(controller, [index]);
        const switchData = controller._switchData;
        const groups = switchData?.monitors ?? [];
        if (!groups.length || !groups.every(g => g._container)) {
            if (switchData)
                controller._finishWorkspaceSwitch(switchData);
            return;
        }

        // Pressing right shows a little of what would be to the right: the
        // desktop moves left. Down likewise moves it up.
        const upDown = direction === Meta.MotionDirection.UP ||
            direction === Meta.MotionDirection.DOWN;
        const prop = upDown ? 'translation_y' : 'translation_x';
        const sign = direction === Meta.MotionDirection.RIGHT ||
            direction === Meta.MotionDirection.DOWN ? -1 : 1;
        const sizes = groups.map(g => {
            const monitor = Main.layoutManager.monitors[g.index];
            return upDown ? monitor.height : monitor.width;
        });

        const timeline = new Clutter.Timeline({
            actor: groups[0],
            duration: Math.max(1, Math.round(BUMP_MS * slowDown())),
        });
        const bump = { timeline, groups, switchData };
        timeline.connect('new-frame', () => {
            const shift = sign * BUMP_SHARE * bumpCurve(timeline.get_progress());
            groups.forEach((group, i) => {
                group._container[prop] = shift * sizes[i];
            });
        });
        timeline.connect('stopped', () => {
            if (this._bump === bump)
                this._stopBump();
        });
        // Ended under it by the shell (the overview opening, say).
        bump.destroyId = groups[0].connect('destroy', () => {
            bump.destroyId = 0;
            if (this._bump === bump)
                this._stopBump();
        });
        this._bump = bump;
        timeline.start();
    }

    _stopBump() {
        const bump = this._bump;
        if (!bump)
            return;
        this._bump = null;
        if (bump.destroyId)
            bump.groups[0].disconnect(bump.destroyId);
        bump.timeline.stop();
        const controller = this._controller;
        if (controller && controller._switchData === bump.switchData)
            controller._finishWorkspaceSwitch(bump.switchData);
    }
}

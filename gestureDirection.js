// The shell's three-finger swipes, the way macOS has them whatever the
// scrolling direction: the desktops move with the fingers.
//
// GNOME ties its swipes to Natural Scrolling. With it on, as GNOME ships, the
// desktops follow the fingers as on a Mac: a swipe to the left brings in the
// desktop on the right, a swipe up opens the overview and, again, the app grid.
// With it off, as many keep two-finger scrolling, every swipe turns round: a swipe to the left goes to the desktop on the left,
// and the overview opens with a swipe down. macOS keeps the two apart: its
// scrolling direction is for content, and Spaces and Mission Control always
// follow the fingers.
//
// Each of the shell's swipe trackers reads that setting through its touchpad
// gesture's own _touchpadSettings, at every update, to decide whether to turn
// the fingers' movement round. While this is on, that one member of the
// gestures named below answers Natural Scrolling with on and passes everything
// else to the real settings. The setting itself is not touched, so content
// scrolling, the overview's two-finger scroll and every app keep it. Off, each
// gesture gets its own settings back.
//
// The swipes covered: the desktop switcher's, the overview's (up and down), the
// overview's desktops, the app grid's pages and its folders' pages. Folders are
// made and remade with the app grid, so the trackers are looked for again each
// time the overview opens. The on-screen keyboard's and the lock screen's
// swipes are left as they are.
//
// Springy Desktop Switching (spacesSpring.js) wraps methods of the desktop
// switcher's tracker; this sits beneath it, in the gesture that feeds that
// tracker, so the two never touch the same thing and either can go first.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - SwipeTracker's _touchpadGesture, a TouchpadSwipeGesture, and that
//     gesture's _touchpadSettings, read with get_boolean('natural-scroll') in
//     its event handler on GNOME 45 to 50
//   - the trackers at Main.wm._workspaceAnimation._swipeTracker,
//     Main.overview._swipeTracker, and on Main.overview._overview.controls its
//     _workspacesDisplay._swipeTracker, _appDisplay._swipeTracker and each of
//     _appDisplay._folderIcons' view._swipeTracker
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const GESTURE_DIRECTION_KEY = 'macos-gesture-direction';

const NATURAL = 'natural-scroll';

// One line per shell session, not one per unlock.
const told = new Set();

// The real settings, with Natural Scrolling always on. Everything else is the
// real object's, called on it.
function followingFingers(real) {
    return new Proxy(real, {
        get(target, name) {
            if (name === 'get_boolean')
                return key => key === NATURAL || target.get_boolean(key);
            const value = target[name];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

export class GestureDirection {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._patched = new Map();
        this._on = false;
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        if (!this._settings)
            return;

        if (this._settings.get_boolean(GESTURE_DIRECTION_KEY))
            this._guard('turning the swipes the macOS way', () => this._enable());
        else
            this._guard('giving the swipes back their direction', () => this._disable());
    }

    // Puts everything back, whatever the switch says.
    destroy() {
        this._guard('giving the swipes back their direction', () => this._disable());
        this._settings = null;
    }

    // For the tests: which swipes follow the fingers.
    get state() {
        return {
            on: this._on,
            gestures: [...this._patched.values()].map(p => p.name),
        };
    }

    _guard(what, fn) {
        try {
            fn();
        } catch (e) {
            console.warn(`[${this._uuid}] ${what} failed:`, e);
        }
    }

    _trackers() {
        const controls = Main.overview?._overview?.controls;
        const appDisplay = controls?._appDisplay;
        const found = [
            ['desktops', Main.wm?._workspaceAnimation?._swipeTracker],
            ['overview', Main.overview?._swipeTracker],
            ['overview desktops', controls?._workspacesDisplay?._swipeTracker],
            ['app grid', appDisplay?._swipeTracker],
        ];
        for (const icon of appDisplay?._folderIcons ?? [])
            found.push(['folder', icon?.view?._swipeTracker]);
        return found;
    }

    _enable() {
        if (!this._on) {
            this._on = true;
            // Folders come and go with the app grid; the overview opening is
            // the earliest a new one can be swiped.
            Main.overview.connectObject('showing', () =>
                this._guard('turning the swipes the macOS way', () => this._patchAll()), this);
        }
        this._patchAll();
    }

    _patchAll() {
        let missing = 0;
        const current = new Set();
        for (const [name, tracker] of this._trackers()) {
            const gesture = tracker?._touchpadGesture;
            if (gesture)
                current.add(gesture);
            const real = gesture?._touchpadSettings;
            if (!gesture || typeof real?.get_boolean !== 'function') {
                if (name !== 'folder')
                    missing++;
                continue;
            }
            if (this._patched.has(gesture))
                continue;
            const shim = followingFingers(real);
            gesture._touchpadSettings = shim;
            this._patched.set(gesture, { name, real, shim });
        }

        // Folders the app grid has let go of since: not held on to.
        for (const gesture of [...this._patched.keys()]) {
            if (!current.has(gesture))
                this._restore(gesture);
        }

        if (missing && !told.has('missing')) {
            told.add('missing');
            console.warn(`[${this._uuid}] ${missing} of the shell's swipes are not where Pear Up ` +
                'looks for them; those keep following the scrolling direction.');
        }
    }

    _disable() {
        if (this._on) {
            this._on = false;
            try {
                Main.overview.disconnectObject(this);
            } catch {
                // Gone with the shell, at logout.
            }
        }

        // Only what is still ours: a gesture whose settings someone else has
        // replaced since keeps theirs.
        for (const gesture of [...this._patched.keys()])
            this._restore(gesture);
    }

    _restore(gesture) {
        const { real, shim } = this._patched.get(gesture);
        this._patched.delete(gesture);
        if (gesture._touchpadSettings === shim)
            gesture._touchpadSettings = real;
    }
}

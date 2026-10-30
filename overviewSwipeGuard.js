// A three-finger swipe on the desktop that goes the overview's closing way, and
// so never moves it, ends without an error and without the overview left half
// made behind the desktop.
//
// This is a fix for a GNOME bug, not a macOS behaviour, so it has no switch of
// its own: it is on whenever Pear Up is, and does nothing a user would see but
// keep the shell out of a broken state. From GNOME 49 the overview ignores a
// swipe's updates while their progress is 0 (overview.js _gestureUpdate), so it
// never begins to show; when the fingers lift, its end handler asks to go from
// hidden to hiding, which is not allowed, and throws ("Invalid overview shown
// transition from HIDDEN to HIDING") before it has told the overview's controls
// the gesture is over. Their gesture stays in progress, and the desktops'
// views, made for the overview when the swipe began, stay built, hooked to the
// stage's key presses and the overview's signals, until the overview next
// opens for real. Which way is the closing way depends on Natural Scrolling and
// Swipe Between Desktops Like macOS: up with both off, as on framy; down
// otherwise. GNOME 48 and earlier show the overview at progress 0 instead, and
// throw only for a swipe that ends with no update at all.
//
// The overview's handler is bound to its tracker when the shell makes it, so
// it cannot be wrapped. The tracker's emit() can, as an own property on that one
// tracker. An end emitted while the overview is still hidden, from wherever in
// the tracker it comes (a swipe let go, cancelled, or interrupted when the shell
// changes mode or turns the tracker off), never reaches that handler; instead
// the controls are told the gesture ended where it began, as the handler would
// have told them, and the desktops' views go as they go when the overview hides.
// The tracker's own reset runs as it would. Every other signal, and every end
// once the overview has begun to show, is the shell's.
//
// GNOME internals this depends on, listed in tests/api-manifest.json too:
//   - Main.overview._swipeTracker, the overview's SwipeTracker, which emits
//     'end' through this.emit(); Main.overview._shownState, 'HIDDEN' while it is
//     hidden
//   - Main.overview._overview.controls, the ControlsManager: gestureEnd(state,
//     duration, onComplete), _stateAdjustment.gestureInProgress, mapped, and
//     _workspacesDisplay, whose hide() destroys its views (vfunc_hide), as
//     ControlsManager.vfunc_unmap does when the overview hides
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ControlsState } from 'resource:///org/gnome/shell/ui/overviewControls.js';
import { InstancePatch } from './shellTweaks.js';

const HIDDEN = 'HIDDEN';

// One line per shell session, not one per unlock.
const told = new Set();

export class OverviewSwipeGuard {
    constructor(uuid) {
        this._uuid = uuid;
        this._patch = null;
        this._caught = 0;

        const overview = Main.overview;
        const tracker = overview?._swipeTracker;
        const controls = overview?._overview?.controls;
        if (typeof tracker?.emit !== 'function' || overview._shownState === undefined ||
            typeof controls?.gestureEnd !== 'function' || !controls._stateAdjustment ||
            ControlsState?.HIDDEN === undefined) {
            if (!told.has('missing')) {
                told.add('missing');
                console.warn(`[${uuid}] This shell's overview swipe is not what Pear Up knows; ` +
                    'leaving it as it is.');
            }
            return;
        }

        const patch = new InstancePatch(tracker, 'emit');
        const self = this;
        if (patch.enable(function (original, name, ...args) {
            if (name === 'end' && Main.overview._shownState === HIDDEN) {
                self._unwind();
                return undefined;
            }
            return original.call(this, name, ...args);
        }))
            this._patch = patch;
    }

    destroy() {
        this._patch?.disable();
        this._patch = null;
    }

    // For the tests: whether it is in place, and how many ends it has caught.
    get state() {
        return { on: !!this._patch, caught: this._caught };
    }

    // What the overview's end handler would have done for a swipe that ended
    // where it began, had it not thrown, and what hiding the overview does.
    // Never throws: the tracker resets itself after this returns.
    _unwind() {
        this._caught++;
        try {
            const controls = Main.overview._overview?.controls;
            if (!controls)
                return;
            if (controls._stateAdjustment.gestureInProgress)
                controls.gestureEnd(ControlsState.HIDDEN, 0, () => {});
            if (!controls.mapped)
                controls._workspacesDisplay?.hide();
        } catch (e) {
            console.warn(`[${this._uuid}] ending a swipe that never opened the overview failed:`, e);
        }
    }
}

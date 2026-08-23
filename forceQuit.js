// Click a window to kill it, the way xkill does. macOS's Force Quit opens a
// list; that is a worse fit here, where the thing you want to abandon is
// almost always the one that is not responding and so cannot be picked from a
// menu of names.
//
// The pointer grab has to start after the System Menu has finished closing.
// Doing it from the click that chose Force Quit would nest a grab inside the
// menu's, which Clutter 18 treats as an assertion and ends the session for.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function killableTypes() {
    const type = Meta.WindowType;
    return new Set(
        [type.NORMAL, type.DIALOG, type.MODAL_DIALOG, type.UTILITY]
            .filter(value => value !== undefined));
}

export class ForceQuitPicker {
    constructor() {
        this._timeoutId = 0;
        this._eventId = 0;
        this._modal = null;
        this._actor = null;
        this._types = killableTypes();
    }

    // The menu that launched this has to unwind first. A short delay is enough
    // for its grab to drop; an idle tick is not, on the shells that close the
    // menu on the same frame as the activate.
    begin() {
        this.cancel();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._timeoutId = 0;
            this._grab();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._ungrab();
    }

    destroy() {
        this.cancel();
    }

    _grab() {
        this._setCursor('CROSSHAIR');

        // Own actor, not the stage: a modal on global.stage has been refused
        // on some shells, and when it is accepted it is hard to unwind cleanly.
        this._actor = new Clutter.Actor({
            name: 'pear-up-force-quit',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.layoutManager.uiGroup.add_child(this._actor);

        this._modal = Main.pushModal(this._actor);
        if (!this._modal) {
            this._destroyActor();
            this._setCursor('DEFAULT');
            Main.notify('Force Quit', 'Could not start picking a window.');
            return;
        }

        this._eventId = this._actor.connect('captured-event', (_actor, event) =>
            this._onEvent(event));

        Main.notify('Force Quit', 'Click a window to quit it. Esc cancels.');
    }

    _ungrab() {
        if (this._eventId && this._actor) {
            this._actor.disconnect(this._eventId);
            this._eventId = 0;
        }

        if (this._modal) {
            try {
                Main.popModal(this._modal);
            } catch {
                try {
                    Main.popModal(this._actor);
                } catch {
                    // Already popped, or this shell takes the actor not the grab.
                }
            }
            this._modal = null;
        }

        this._destroyActor();
        this._setCursor('DEFAULT');
    }

    _destroyActor() {
        if (!this._actor)
            return;
        this._actor.destroy();
        this._actor = null;
    }

    _onEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS) {
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this.cancel();
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_PRESS) {
            // Right-click is cancel, matching xkill's "I changed my mind".
            if (event.get_button() === 3) {
                this.cancel();
                return Clutter.EVENT_STOP;
            }

            const [x, y] = event.get_coords();
            const window = this._windowAt(x, y);
            this._ungrab();
            if (window) {
                try {
                    window.kill();
                } catch (e) {
                    console.error(`[pear-up] Force Quit failed: ${e}`);
                }
            }
            return Clutter.EVENT_STOP;
        }

        // Swallow the rest so a click cannot fall through into the window we
        // are about to kill, or into whatever is behind it.
        return Clutter.EVENT_STOP;
    }

    _windowAt(x, y) {
        const actors = global.get_window_actors();
        // Last in the list is topmost, so walk it backwards to hit what the
        // user actually sees rather than the window underneath it.
        for (let i = actors.length - 1; i >= 0; i--) {
            const actor = actors[i];
            const window = actor.meta_window ?? actor.metaWindow;
            if (!window || !this._isKillable(window))
                continue;

            const rect = window.get_frame_rect();
            if (x >= rect.x && x < rect.x + rect.width &&
                y >= rect.y && y < rect.y + rect.height)
                return window;
        }
        return null;
    }

    _isKillable(window) {
        if (window.minimized)
            return false;
        if (!this._types.has(window.get_window_type()))
            return false;

        // The shell's own actors are in the list too. Killing gnome-shell is
        // a logout, which is not what Force Quit means.
        const wmClass = window.get_wm_class?.() ?? '';
        if (wmClass.toLowerCase() === 'gnome-shell')
            return false;

        return true;
    }

    _setCursor(name) {
        // GNOME 50 dropped Meta.Cursor; the shell sets Clutter.CursorType on
        // the stage instead. Earlier releases still use the display.
        const clutterType = Clutter.CursorType?.[name]
            ?? (name === 'DEFAULT' ? Clutter.CursorType?.INHERIT : undefined);
        if (clutterType !== undefined && global.stage?.set_cursor_type) {
            try {
                global.stage.set_cursor_type(clutterType);
                return;
            } catch {
                // Fall through to the older API.
            }
        }

        const cursor = Meta.Cursor?.[name];
        if (cursor === undefined)
            return;
        try {
            global.display.set_cursor(cursor);
        } catch {
            // Cursor names moved between mutter releases; missing one is not
            // worth aborting the pick over.
        }
    }
}

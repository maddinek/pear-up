// A search button belonging to this extension, rather than borrowing one from
// whichever search extension happens to be installed. What it opens is a
// setting, so the icon in the panel stays put even if that choice changes.
import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { spawnCommandLine } from './util.js';

const SEARCH_LIGHT_UUID = 'search-light@icedman.github.com';

export const SearchButton = GObject.registerClass(
class SearchButton extends PanelMenu.Button {
    _init(settings) {
        // The third argument is dontCreateMenu: this button runs an action
        // instead of opening a menu. It also disables the shell's own click
        // gesture, which would otherwise toggle a menu that isn't there.
        super._init(0.5, 'Search', true);

        this._settings = settings;
        this._idleId = 0;

        this._icon = new St.Icon({
            icon_name: 'system-search-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // However this shell delivers a click to its own panel buttons, take the
        // same route — asking the base class rather than the version, since the
        // class existing says nothing about presses arriving that way. GNOME 50
        // fits PanelMenu.Button with a ClickGesture (disabled for a button with
        // no menu, as here); before that the press came through as an event.
        //
        // One route only. A press handler answering EVENT_STOP alongside a live
        // gesture takes the event out from under it mid-recognition, which aborts
        // the shell on the very assertion this button was written to avoid.
        if (this._shellDeliversClicksByGesture()) {
            const gesture = new Clutter.ClickGesture();
            gesture.connect('recognize', () => this._activate());
            this.add_action(gesture);
        } else {
            this.connect('button-press-event', () => this._activate());
        }

        this.connect('destroy', () => this._cancelPending());
    }

    // Everything this can open either reparents actors or grabs key focus, and
    // doing that while the press is still being delivered corrupts Clutter's
    // gesture state and aborts the shell — which is exactly how Search Light's
    // own icon killed the session on GNOME 50. Handing the work to an idle
    // callback lets the press finish first; one tick is imperceptible.
    _activate() {
        if (!this._idleId) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._idleId = 0;
                this._open();
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_STOP;
    }

    // PanelMenu.Button attaches its own click gesture where the shell works that
    // way, so its presence on this very actor is the answer, whatever the
    // version happens to be.
    _shellDeliversClicksByGesture() {
        if (!Clutter.ClickGesture)
            return false;

        return (this.get_actions?.() ?? [])
            .some(action => action instanceof Clutter.ClickGesture);
    }

    _cancelPending() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
    }

    _open() {
        switch (this._settings.get_string('search-opens')) {
        case 'command':
            this._openCommand();
            break;
        case 'search-light':
            this._openSearchLight();
            break;
        default:
            this._openOverviewSearch();
            break;
        }
    }

    // GNOME's own search, which needs nothing installed and cannot be broken by
    // a third party. Also the fallback whenever another choice is unavailable,
    // so the button always does something.
    _openOverviewSearch() {
        Main.overview.show();

        const entry = Main.overview.searchEntry;
        const target = entry?.clutter_text ?? entry;
        target?.grab_key_focus();
    }

    // Reaches into Search Light's own extension object: it offers no D-Bus
    // interface and no other way in, so this is a private method being called
    // by name. Treated as something that may simply not be there.
    _openSearchLight() {
        const stateObj = Main.extensionManager?.lookup?.(SEARCH_LIGHT_UUID)?.stateObj;
        const toggle = stateObj?._toggle_search_light;

        if (typeof toggle !== 'function') {
            console.warn('[pear-up] Search Light is not available; opening GNOME search instead.');
            this._openOverviewSearch();
            return;
        }

        toggle.call(stateObj);
    }

    _openCommand() {
        const command = this._settings.get_string('search-command').trim();
        if (!command) {
            this._openOverviewSearch();
            return;
        }
        spawnCommandLine(command);
    }
});

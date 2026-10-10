import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export function spawnCommandLine(commandLine) {
    try {
        let [, argv] = GLib.shell_parse_argv(commandLine);
        GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        return true;
    } catch (e) {
        console.error(`[pear-up] Failed to launch '${commandLine}': ${e}`);
        return false;
    }
}

// Quit as macOS does: the whole app, not the one window in front. The shell
// asks the app to quit through its own quit action when it has one, or closes
// each window otherwise, so an app can still stop to ask about unsaved work.
// A window the shell cannot pin to an app is closed on its own.
export function quitApp(app, window = null) {
    if (app?.request_quit())
        return;
    window?.delete(global.get_current_time());
}

// The two signals an actor announces its children with. GNOME 45 still has them
// from ClutterContainer, as actor-added and actor-removed; later releases call
// them child-added and child-removed. Asked of the actor rather than decided by
// shell version, so nothing here has to know which release made the change.
export function childSignals(actor) {
    return GObject.signal_lookup('child-added', actor.constructor.$gtype)
        ? ['child-added', 'child-removed']
        : ['actor-added', 'actor-removed'];
}

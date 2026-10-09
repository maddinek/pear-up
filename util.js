import GLib from 'gi://GLib';

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

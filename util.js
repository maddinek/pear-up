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

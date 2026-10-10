// Stands in for the shell's misc/config.js while the preferences code is built
// outside a session, for the reason tests/prefs-stub.js gives: it lives in the
// Extensions app's resource bundle, which a bare container does not load. The
// preferences read only the version from it, and the runner says which release
// the container carries, from its gnome-shell package.
import GLib from 'gi://GLib';

export const PACKAGE_NAME = 'gnome-shell';
export const PACKAGE_VERSION = GLib.getenv('PREFS_SMOKE_SHELL_VERSION') ?? '0';

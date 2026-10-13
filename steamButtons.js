// Steam's window buttons on the side GNOME puts everyone else's.
//
// Steam's client is a web page in Valve's own Chromium (CEF). It draws its own
// title bar, and on Linux its close, maximize and minimize buttons are always on
// the right: it never reads GNOME's button layout, and has no setting or launch
// option for a system title bar. What it does read is its stylesheets, from
// steamui/css in its installation, served to every window it opens. So this
// puts one line in front of two of them that imports the original and then a
// small stylesheet of Pear Up's, which moves the buttons. That is how Adwaita
// for Steam has themed the client for years, and the reason for its two rules
// kept here as well: the patched file is padded with spaces to the size of the
// original, because at start Steam checks the files that are not programs by
// size only (its bootstrap log says "Verifying file sizes only"), and a file of
// the right size is left alone.
//
// Everything is undone exactly: the original of each file is kept beside it,
// byte for byte, and put back when the switch goes off. A Steam update writes
// the files afresh, which drops the patch; the extension watches the directory
// and patches the new files again, keeping each new original. Steam reads its
// stylesheets when it starts, so a change shows the next time it does.
//
// Adwaita for Steam patches the same two files. Where it already has, nothing
// is touched: it has a window-buttons option of its own (its installer's
// --windowcontrols-layout, which by default reads GNOME's layout). Where it
// patches over Pear Up's patch later, its original is Pear Up's patch, so Pear
// Up's original stays in place for as long as that chain needs it.
//
// No shell imports: the preferences use this too, and so do the tests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const STEAM_BUTTONS_KEY = 'steam-buttons-left';

export const PATCH_HEADER = '/* Pear Up: Steam window buttons */';

// library.css is the one the client's shared page links, which the windows it
// opens copy their styles from; gamerecording.css is loaded into the main
// window. These are the two Adwaita for Steam patches for the same reach.
const TARGETS = ['library.css', 'gamerecording.css'];
const ADWAITA_HEADERS = ['/* Adwaita-for-Steam */', '/*patched*/'];

const OWN_DIR = 'pear-up';
const OWN_CSS = 'window-buttons.css';

const BUTTON_ORDER_CLASSES = {
    close: ['closeButton'],
    minimize: ['minimizeButton'],
    maximize: ['maximizeButton', 'restoreButton'],
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const backupName = name => name.replace(/\.css$/, '.pear-up-original.css');
const cssDir = root => GLib.build_filenamev([root, 'steamui', 'css']);
const ownCssPath = root => GLib.build_filenamev([root, 'steamui', OWN_DIR, OWN_CSS]);

function readBytes(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return bytes;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

function writeBytes(path, bytes) {
    Gio.File.new_for_path(path).replace_contents(bytes, null, false,
        Gio.FileCreateFlags.NONE, null);
}

function removeFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
}

function firstLine(bytes) {
    const head = decoder.decode(bytes.subarray(0, 200));
    return head.split('\n', 1)[0].trim();
}

function kindOf(bytes) {
    if (bytes === null)
        return 'missing';
    const line = firstLine(bytes);
    if (line === PATCH_HEADER)
        return 'ours';
    if (ADWAITA_HEADERS.some(header => line.startsWith(header)))
        return 'adwaita';
    return 'steam';
}

// The Steam installations of this user that have the client's stylesheets: the
// native one, which ~/.steam/steam links to, and the Flatpak's.
export function steamRoots(dataDir = GLib.get_user_data_dir(), home = GLib.get_home_dir()) {
    const candidates = [
        GLib.build_filenamev([dataDir, 'Steam']),
        GLib.build_filenamev([home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam']),
    ];
    return [...new Set(candidates)].filter(root =>
        GLib.file_test(GLib.build_filenamev([cssDir(root), TARGETS[0]]), GLib.FileTest.IS_REGULAR));
}

// What each of the two files is now: Pear Up's patch, Adwaita for Steam's,
// Steam's own, or not there. `on` is every file that is there patched by Pear
// Up; `stale` is a file Steam has written afresh since.
export function steamState(root) {
    const files = TARGETS.map(name => ({
        name,
        kind: kindOf(readBytes(GLib.build_filenamev([cssDir(root), name]))),
    }));
    const present = files.filter(file => file.kind !== 'missing');
    return {
        files,
        on: present.some(file => file.kind === 'ours') &&
            present.every(file => file.kind === 'ours'),
        adwaita: present.some(file => file.kind === 'adwaita'),
        stale: present.some(file => file.kind === 'ours') &&
            present.some(file => file.kind === 'steam'),
    };
}

// The class names Steam's main window gives its title bar row and the box its
// buttons sit in. They are CSS-module hashes, in the client's script as
// `TitleBarControls:"…",TitleBar:"…"` beside the rest of that module's map.
// They have stayed the same for years, but are read rather than written down.
const TITLE_BAR_MAP = /TopBar:"([\w-]+)",OSX:"[\w-]+",WindowControls:"([\w-]+)",DragArea:"[\w-]+",TitleBarControls:"[\w-]+",TitleBar:"([\w-]+)"/;

export function titleBarClassesIn(text) {
    const match = TITLE_BAR_MAP.exec(text);
    return match ? { topBar: match[1], windowControls: match[2], titleBar: match[3] } : null;
}

// The scripts to look in: the client's shared chunks, largest last.
export function steamScripts(root) {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([root, 'steamui']));
    const names = [];
    let children;
    try {
        children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return names;
    }
    let info;
    while ((info = children.next_file(null)) !== null) {
        const name = info.get_name();
        if (/^chunk~.*\.js$/.test(name))
            names.push(GLib.build_filenamev([root, 'steamui', name]));
    }
    children.close(null);
    return names.sort();
}

// The class names as the stylesheet was last written with them, so that they
// are read from the client's script — fourteen megabytes — only once per
// Steam update. undefined when there is no stylesheet to say.
const CLASSES_NOTE = 'Steam title bar classes:';
const CLASSES_WRITTEN = /Steam title bar classes: (?:([\w-]+) ([\w-]+) ([\w-]+)|not found) \*\//;

function classesWrittenIn(bytes) {
    if (bytes === null)
        return undefined;
    const match = CLASSES_WRITTEN.exec(decoder.decode(bytes));
    if (!match)
        return undefined;
    return match[1] ? { topBar: match[1], windowControls: match[2], titleBar: match[3] } : null;
}

export function titleBarClasses(root) {
    for (const path of steamScripts(root)) {
        const bytes = readBytes(path);
        const classes = bytes && titleBarClassesIn(decoder.decode(bytes));
        if (classes)
            return classes;
    }
    return null;
}

// The stylesheet for a GNOME button layout such as 'close,minimize,maximize:appmenu'.
// Steam keeps its three buttons in one box, so they move together: to the
// left, in the layout's order, when the layout puts any of them there, and
// any it leaves out entirely are hidden, as GNOME hides them. With all of them
// on the right there is nothing to change and the rules are left out.
export function buttonsCss(layout, classes = null) {
    const [left = '', right = ''] = (layout ?? '').split(':');
    const names = side => side.split(',').map(name => name.trim()).filter(name => name in BUTTON_ORDER_CLASSES);
    const leftNames = names(left);
    const order = [...new Set([...leftNames, ...names(right)])];

    const lines = [
        '/* Written by Pear Up (Preferences, Windows, Steam: Buttons on the Left)',
        `   from GNOME's button layout '${layout}'. Switching it off removes this`,
        '   file and puts Steam\'s own stylesheets back. */',
        classes
            ? `/* ${CLASSES_NOTE} ${classes.topBar} ${classes.windowControls} ${classes.titleBar} */`
            : `/* ${CLASSES_NOTE} not found */`,
    ];
    if (leftNames.length === 0) {
        lines.push('/* The layout keeps the buttons on the right, where Steam has them. */');
        return `${lines.join('\n')}\n`;
    }

    const controls = '.title-area > .title-bar-actions.window-controls';
    lines.push(
        `${controls} {`,
        '    order: -1 !important;',
        '    flex-direction: row !important;',
        '    margin-inline-start: 4px !important;',
        '    margin-inline-end: auto !important;',
        '}');
    order.forEach((name, index) => {
        const selector = BUTTON_ORDER_CLASSES[name].map(cls => `${controls} > .${cls}`).join(',\n');
        lines.push(`${selector} {`, `    order: ${index + 1} !important;`, '}');
    });
    const hidden = Object.keys(BUTTON_ORDER_CLASSES).filter(name => !order.includes(name));
    if (hidden.length > 0) {
        const selector = hidden.flatMap(name => BUTTON_ORDER_CLASSES[name])
            .map(cls => `${controls} > .${cls}`).join(',\n');
        lines.push(`${selector} {`, '    display: none !important;', '}');
    }

    // The main window keeps the buttons in a box at the end of its title bar
    // row, after the menus; that box goes first. Without the class names, it is
    // the box that follows the row's empty drag area.
    const box = classes
        ? `.${classes.titleBar} > .${classes.windowControls}`
        : 'div:empty ~ div:has(> .title-area > .title-bar-actions.window-controls)';
    lines.push(`${box} {`, '    order: -1 !important;', '    margin-inline-end: 8px !important;', '}');
    return `${lines.join('\n')}\n`;
}

function patchBytes(name, size) {
    const text = [
        PATCH_HEADER,
        `@import url("${backupName(name)}");`,
        `@import url("../${OWN_DIR}/${OWN_CSS}");`,
        '',
    ].join('\n');
    const bytes = encoder.encode(text);
    if (bytes.length > size)
        return null;
    const padded = new Uint8Array(size).fill(0x20);
    padded.set(bytes);
    return padded;
}

// Patches the installation at `root` for `layout`, or brings an earlier patch
// up to date: Steam's files patched again after an update, the stylesheet
// written for the layout now. Returns whether anything was written. Throws,
// touching nothing, where Adwaita for Steam has patched the files.
export function applySteamButtons(root, layout, classes = undefined) {
    const state = steamState(root);
    if (state.adwaita)
        throw new Error('Adwaita for Steam has patched Steam’s stylesheets: use its own window-buttons option');

    let changed = false;
    const cssPath = ownCssPath(root);
    const current = readBytes(cssPath);
    if (classes === undefined && !state.stale && state.on)
        classes = classesWrittenIn(current);
    if (classes === undefined)
        classes = titleBarClasses(root);
    const css = encoder.encode(buttonsCss(layout, classes));
    if (current === null || current.length !== css.length || current.some((byte, i) => byte !== css[i])) {
        GLib.mkdir_with_parents(GLib.path_get_dirname(cssPath), 0o755);
        writeBytes(cssPath, css);
        changed = true;
    }

    for (const name of TARGETS) {
        const path = GLib.build_filenamev([cssDir(root), name]);
        const original = readBytes(path);
        if (kindOf(original) !== 'steam')
            continue;
        const patched = patchBytes(name, original.length);
        if (!patched)
            continue;
        // The original first: stopped half way, Steam still has its own file.
        writeBytes(GLib.build_filenamev([cssDir(root), backupName(name)]), original);
        writeBytes(path, patched);
        changed = true;
    }
    return changed;
}

// Puts Steam's own files back where Pear Up's patch is still in them, and
// removes Pear Up's stylesheet. An original left over from before a Steam
// update goes too. One Adwaita for Steam has patched over is still imported by
// it, so it stays; with Pear Up's stylesheet gone it has nothing to move.
export function restoreSteamButtons(root) {
    let changed = false;
    for (const name of TARGETS) {
        const path = GLib.build_filenamev([cssDir(root), name]);
        const backup = GLib.build_filenamev([cssDir(root), backupName(name)]);
        const kind = kindOf(readBytes(path));
        const original = readBytes(backup);
        if (original === null || kind === 'adwaita')
            continue;
        if (kind === 'ours')
            writeBytes(path, original);
        removeFile(backup);
        changed = true;
    }

    const cssPath = ownCssPath(root);
    if (readBytes(cssPath) !== null) {
        removeFile(cssPath);
        changed = true;
    }
    try {
        Gio.File.new_for_path(GLib.path_get_dirname(cssPath)).delete(null);
    } catch {
        // Not there, or not empty: someone else's files are in it.
    }
    return changed;
}

// The extension's half: while the switch is on, a Steam update that writes the
// files afresh is patched again, and a change of GNOME's button layout is
// written into the stylesheet. Reading the files and the client's script for
// the class names is a moment's work, done only when something changed. It
// never removes the patch when the extension is disabled — that happens at
// every screen lock — only when the switch goes off.
const SETTLE_MS = 3000;

export class SteamButtonsKeeper {
    constructor(uuid, settings) {
        this._uuid = uuid;
        this._settings = settings;
        this._wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
        this._monitors = [];
        this._settleId = 0;
        this._layoutId = this._wm.connect('changed::button-layout', () => this._queue());
        this.sync();
    }

    // Called when the switch changes, and at enable.
    sync() {
        const on = this._settings.get_boolean(STEAM_BUTTONS_KEY);
        this._unwatch();
        if (on) {
            this._watch();
            this._run(true);
        } else {
            this._run(false);
        }
    }

    _watch() {
        for (const root of steamRoots()) {
            const monitor = Gio.File.new_for_path(cssDir(root))
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (_monitor, file) => {
                const name = file?.get_basename();
                if (TARGETS.includes(name))
                    this._queue();
            });
            this._monitors.push(monitor);
        }
    }

    _unwatch() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        if (this._settleId) {
            GLib.source_remove(this._settleId);
            this._settleId = 0;
        }
    }

    // An update writes many files; wait until Steam has finished.
    _queue() {
        if (!this._settings?.get_boolean(STEAM_BUTTONS_KEY))
            return;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, SETTLE_MS, () => {
            this._settleId = 0;
            if (this._settings?.get_boolean(STEAM_BUTTONS_KEY))
                this._run(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _run(on) {
        for (const root of steamRoots()) {
            try {
                if (on && !steamState(root).adwaita)
                    applySteamButtons(root, this._wm.get_string('button-layout'));
                else if (!on)
                    restoreSteamButtons(root);
            } catch (e) {
                console.warn(`[${this._uuid}] ${on ? 'patching' : 'restoring'} Steam's window buttons in ${root} failed:`, e);
            }
        }
    }

    destroy() {
        this._unwatch();
        if (this._layoutId) {
            this._wm.disconnect(this._layoutId);
            this._layoutId = 0;
        }
        this._wm = null;
        this._settings = null;
    }
}

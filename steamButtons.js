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
//
// The file work is written once, as generators that yield each read or write
// they need (see IO below), and run two ways: at once, for the preferences and
// the tests, and asynchronously in the shell, where a read of the client's
// fourteen-megabyte script, or a stalled disk, must not hold up a frame.
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

// What the generators below ask for, and two ways of answering: at once, and
// asynchronously. A file that is not there reads as null.
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const isNotFound = e => e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);

const SYNC_IO = {
    read({ path }) {
        try {
            return Gio.File.new_for_path(path).load_contents(null)[1];
        } catch (e) {
            if (isNotFound(e))
                return null;
            throw e;
        }
    },
    write({ path, bytes }) {
        Gio.File.new_for_path(path).replace_contents(bytes, null, false, Gio.FileCreateFlags.NONE, null);
    },
    remove({ path }) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            if (!isNotFound(e))
                throw e;
        }
    },
    isFile({ path }) {
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
    },
    list({ path }) {
        const names = [];
        let children;
        try {
            children = Gio.File.new_for_path(path).enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return names;
        }
        let info;
        while ((info = children.next_file(null)) !== null)
            names.push(info.get_name());
        children.close(null);
        return names;
    },
    // An original, then the patch that imports it, with nothing between, and
    // only while the file still is that original: it was read a moment ago,
    // asynchronously in the shell, and the preferences may have patched it,
    // or patched and restored it, since. Returns whether it patched.
    patch({ backup, original, path, patched }) {
        const now = SYNC_IO.read({ path });
        if (now === null || !sameBytes(now, original))
            return false;
        SYNC_IO.write({ path: backup, bytes: original });
        SYNC_IO.write({ path, bytes: patched });
        return true;
    },
    mkdir({ path }) {
        GLib.mkdir_with_parents(path, 0o755);
    },
    // Not there, or not empty (someone else's files are in it): left as it is.
    rmdir({ path }) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch {
            // As above.
        }
    },
};

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT_IDLE;

const ASYNC_IO = {
    async read({ path }) {
        try {
            // [contents, etag]; older GJS kept the success flag in front.
            const result = await Gio.File.new_for_path(path).load_contents_async(null);
            return result.find(item => item instanceof Uint8Array) ?? null;
        } catch (e) {
            if (isNotFound(e))
                return null;
            throw e;
        }
    },
    // Writes stay synchronous, the way they were: each is a small file, and
    // an original and the patch that imports it must land together. Written
    // asynchronously, a patch could land after the preferences had put
    // Steam's file back and deleted its original, leaving it importing
    // nothing.
    write: SYNC_IO.write,
    patch: SYNC_IO.patch,
    remove: SYNC_IO.remove,
    async isFile({ path }) {
        try {
            const info = await Gio.File.new_for_path(path).query_info_async('standard::type',
                Gio.FileQueryInfoFlags.NONE, PRIORITY, null);
            return info.get_file_type() === Gio.FileType.REGULAR;
        } catch {
            return false;
        }
    },
    async list({ path }) {
        const names = [];
        let children;
        try {
            children = await Gio.File.new_for_path(path).enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NONE, PRIORITY, null);
        } catch {
            return names;
        }
        for (;;) {
            const infos = await children.next_files_async(64, PRIORITY, null);
            if (infos.length === 0)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
        await children.close_async(PRIORITY, null);
        return names;
    },
    mkdir: SYNC_IO.mkdir,
    rmdir: SYNC_IO.rmdir,
};

// Runs a generator's file work at once, and returns what it returns. A failed
// step is thrown back into the generator, as a call would throw.
function runSync(steps) {
    let step = steps.next();
    while (!step.done) {
        let answer, failure = null;
        try {
            answer = SYNC_IO[step.value.op](step.value);
        } catch (e) {
            failure = e;
        }
        step = failure ? steps.throw(failure) : steps.next(answer);
    }
    return step.value;
}

// The same, reading on the main loop rather than in one go (see ASYNC_IO).
// `stillWanted()` is asked before each step; once it says no, the rest is
// dropped. Stopping between two steps is safe: each original is written with
// the patch that needs it, and a patch before the stylesheet it imports goes.
export async function runAsync(steps, stillWanted = () => true) {
    let step = steps.next();
    while (!step.done) {
        if (!stillWanted()) {
            steps.return();
            return undefined;
        }
        let answer, failure = null;
        try {
            answer = await ASYNC_IO[step.value.op](step.value);
        } catch (e) {
            failure = e;
        }
        step = failure ? steps.throw(failure) : steps.next(answer);
    }
    return step.value;
}

const read = path => ({ op: 'read', path });
const write = (path, bytes) => ({ op: 'write', path, bytes });
const remove = path => ({ op: 'remove', path });

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
export function* steamRootsSteps(dataDir = GLib.get_user_data_dir(), home = GLib.get_home_dir()) {
    const candidates = [...new Set([
        GLib.build_filenamev([dataDir, 'Steam']),
        GLib.build_filenamev([home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam']),
    ])];
    const roots = [];
    for (const root of candidates) {
        if (yield { op: 'isFile', path: GLib.build_filenamev([cssDir(root), TARGETS[0]]) })
            roots.push(root);
    }
    return roots;
}

export function steamRoots(dataDir, home) {
    return runSync(steamRootsSteps(dataDir, home));
}

// What each of the two files is now: Pear Up's patch, Adwaita for Steam's,
// Steam's own, or not there. `on` is every file that is there patched by Pear
// Up; `stale` is a file Steam has written afresh since.
function* stateSteps(root) {
    const files = [];
    for (const name of TARGETS)
        files.push({ name, kind: kindOf(yield read(GLib.build_filenamev([cssDir(root), name]))) });
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

export function steamState(root) {
    return runSync(stateSteps(root));
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
function* scriptsSteps(root) {
    const names = yield { op: 'list', path: GLib.build_filenamev([root, 'steamui']) };
    return names.filter(name => /^chunk~.*\.js$/.test(name))
        .map(name => GLib.build_filenamev([root, 'steamui', name])).sort();
}

export function steamScripts(root) {
    return runSync(scriptsSteps(root));
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

function* titleBarClassesSteps(root) {
    for (const path of yield* scriptsSteps(root)) {
        const bytes = yield read(path);
        const classes = bytes && titleBarClassesIn(decoder.decode(bytes));
        if (classes)
            return classes;
    }
    return null;
}

export function titleBarClasses(root) {
    return runSync(titleBarClassesSteps(root));
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
function* applySteps(root, layout, classes = undefined) {
    const state = yield* stateSteps(root);
    if (state.adwaita)
        throw new Error('Adwaita for Steam has patched Steam’s stylesheets: use its own window-buttons option');

    let changed = false;
    const cssPath = ownCssPath(root);
    const current = yield read(cssPath);
    if (classes === undefined && !state.stale && state.on)
        classes = classesWrittenIn(current);
    if (classes === undefined)
        classes = yield* titleBarClassesSteps(root);
    const css = encoder.encode(buttonsCss(layout, classes));
    if (current === null || !sameBytes(current, css)) {
        yield { op: 'mkdir', path: GLib.path_get_dirname(cssPath) };
        yield write(cssPath, css);
        changed = true;
    }

    for (const name of TARGETS) {
        const path = GLib.build_filenamev([cssDir(root), name]);
        const original = yield read(path);
        if (kindOf(original) !== 'steam')
            continue;
        const patched = patchBytes(name, original.length);
        if (!patched)
            continue;
        // The original first: stopped half way, Steam still has its own file.
        if (yield { op: 'patch', backup: GLib.build_filenamev([cssDir(root), backupName(name)]), original, path, patched })
            changed = true;
    }
    return changed;
}

// The steps alone, to run with runAsync(); for the tests.
export const applySteamButtonsSteps = applySteps;

export function applySteamButtons(root, layout, classes = undefined) {
    return runSync(applySteps(root, layout, classes));
}

// Puts Steam's own files back where Pear Up's patch is still in them, and
// removes Pear Up's stylesheet. An original left over from before a Steam
// update goes too. One Adwaita for Steam has patched over is still imported by
// it, so it stays; with Pear Up's stylesheet gone it has nothing to move.
function* restoreSteps(root) {
    let changed = false;
    for (const name of TARGETS) {
        const path = GLib.build_filenamev([cssDir(root), name]);
        const backup = GLib.build_filenamev([cssDir(root), backupName(name)]);
        const current = yield read(path);
        const kind = kindOf(current);
        const original = yield read(backup);
        if (original === null || kind === 'adwaita')
            continue;
        // Steam's own file with a copy of itself beside it is a patch about
        // to be made, by the other process (the shell and the preferences
        // both patch): taking that copy away now would leave the patch with
        // nothing to import. It is left for the restore that follows. A copy
        // that differs is an original from before a Steam update, and goes.
        if (kind === 'steam' && sameBytes(current, original))
            continue;
        if (kind === 'ours')
            yield write(path, original);
        yield remove(backup);
        changed = true;
    }

    const cssPath = ownCssPath(root);
    if ((yield read(cssPath)) !== null) {
        yield remove(cssPath);
        changed = true;
    }
    yield { op: 'rmdir', path: GLib.path_get_dirname(cssPath) };
    return changed;
}

export function restoreSteamButtons(root) {
    return runSync(restoreSteps(root));
}

// The extension's half: while the switch is on, a Steam update that writes the
// files afresh is patched again, and a change of GNOME's button layout is
// written into the stylesheet. Reading the files and the client's script for
// the class names is done only when something changed, and asynchronously. It
// never removes the patch when the extension is disabled — that happens at
// every screen lock — only when the switch goes off.
//
// Making one does nothing; start() connects it and runs the first pass. Runs
// go one at a time, and a newer request drops what is left of an older one.
// `findRoots` and `monitorDirectory` are there for the tests.
const SETTLE_MS = 3000;

export class SteamButtonsKeeper {
    constructor(uuid, settings, {
        findRoots = () => runAsync(steamRootsSteps()),
        monitorDirectory = path => Gio.File.new_for_path(path)
            .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null),
        wm = null,
    } = {}) {
        this._uuid = uuid;
        this._settings = settings;
        this._findRoots = findRoots;
        this._monitorDirectory = monitorDirectory;
        this._wm = wm;
        this._layoutId = 0;
        this._monitors = [];
        this._settleId = 0;
        this._generation = 0;
        this._runs = Promise.resolve();
    }

    start() {
        try {
            this._wm ??= new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
            this._layoutId = this._wm.connect('changed::button-layout', () => this._queue());
            this.sync();
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    // Called when the switch changes, and by start().
    sync() {
        if (!this._settings)
            return;
        this._unwatch();
        this._run();
    }

    // Settles once the runs asked for so far are done; for the tests.
    get settled() {
        return this._runs;
    }

    _run() {
        const generation = ++this._generation;
        const current = () => this._settings !== null && generation === this._generation;
        this._runs = this._runs.then(() => this._pass(current)).catch(e =>
            console.warn(`[${this._uuid}] keeping Steam's window buttons failed:`, e));
    }

    async _pass(current) {
        if (!current())
            return;
        const on = this._settings.get_boolean(STEAM_BUTTONS_KEY);
        const roots = await this._findRoots();
        if (!current())
            return;
        if (on) {
            try {
                this._watch(roots);
            } catch (e) {
                console.warn(`[${this._uuid}] watching Steam's stylesheets failed:`, e);
            }
        }
        const layout = this._wm.get_string('button-layout');
        for (const root of roots) {
            try {
                const state = on ? await runAsync(stateSteps(root), current) : null;
                if (on && state && !state.adwaita)
                    await runAsync(applySteps(root, layout), current);
                else if (!on)
                    await runAsync(restoreSteps(root), current);
            } catch (e) {
                if (current())
                    console.warn(`[${this._uuid}] ${on ? 'patching' : 'restoring'} Steam's window buttons in ${root} failed:`, e);
            }
        }
    }

    // Every monitor is made or none is kept: one that fails takes back the
    // ones made before it.
    _watch(roots) {
        this._cancelMonitors();
        const made = [];
        try {
            for (const root of roots) {
                const monitor = this._monitorDirectory(cssDir(root));
                made.push(monitor);
                monitor.connect('changed', (_monitor, file) => {
                    const name = file?.get_basename();
                    if (TARGETS.includes(name))
                        this._queue();
                });
            }
        } catch (e) {
            for (const monitor of made)
                monitor.cancel();
            throw e;
        }
        this._monitors = made;
    }

    _cancelMonitors() {
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
    }

    _unwatch() {
        this._cancelMonitors();
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
                this._run();
            return GLib.SOURCE_REMOVE;
        });
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

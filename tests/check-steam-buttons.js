#!/usr/bin/gjs -m
// Steam: Buttons on the Left, against a Steam installation made up here: the
// patch has to be the original's size, import it unchanged, give the original
// back byte for byte, survive a Steam update and leave Adwaita for Steam's
// patch alone. Then the extension's keeper, which does the same work
// asynchronously: the same files, nothing left connected when it fails part
// way, and nothing written for a request that was dropped.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';
import {
    PATCH_HEADER,
    SteamButtonsKeeper,
    applySteamButtons,
    applySteamButtonsSteps,
    buttonsCss,
    restoreSteamButtons,
    runAsync,
    steamRoots,
    steamState,
    titleBarClasses,
    titleBarClassesIn,
} from '../steamButtons.js';

let failed = 0;

function check(label, condition) {
    if (condition) {
        print(`  ok   ${label}`);
    } else {
        printerr(`  FAIL ${label}`);
        failed++;
    }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LEFT = 'close,minimize,maximize:appmenu';
const RIGHT = 'appmenu:minimize,maximize,close';

const write = (path, text) => {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
};
const read = path => {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
};
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const sizeOf = path => Gio.File.new_for_path(path)
    .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();

const base = GLib.dir_make_tmp('pear-up-steam-XXXXXX');
const data = `${base}/data`;
const root = `${data}/Steam`;
const css = `${root}/steamui/css`;

// Steam's own files, as small as they can be and still look like them, and the
// line of its main script that holds the class names.
const LIBRARY = `.title-area{position:absolute;display:flex;justify-content:flex-end}\n${'.x{color:red}\n'.repeat(40)}`;
const RECORDING = `._3rMEP_IbC30BRuQuHY6F1E{position:absolute;bottom:72px;left:16px;min-width:260px;background:#2c3036}\n${'.y{color:blue}\n'.repeat(10)}`;
const SCRIPT = 'e.exports={OuterFrame:"_3mz8",TopBar:"_3Z7VQ1IMk4E3HsHvrkLNgo",OSX:"m_zdwpwXKR6k0qaLyoAaY",' +
    'WindowControls:"qP17eBPXkfezFfexZ4hC3",DragArea:"_30vB9DdsPK7VrZAbb5Q1Av",' +
    'TitleBarControls:"_1-9sir4j_KQiMqdkZjQN0u",TitleBar:"_39oUCO1OuizVPwcnnv88no",RootMenuBar:"_3s0l"}';

write(`${css}/library.css`, LIBRARY);
write(`${css}/gamerecording.css`, RECORDING);
write(`${css}/gamenotes.css`, '.z{}');
write(`${root}/steamui/chunk~2dcc5aaf7.js`, `var a=1;${SCRIPT};var b=2;`);

// ------------------------------------------------------------------ finding
check('the native installation is found', steamRoots(data, `${base}/home`).join() === root);
check('no installation where there is none', steamRoots(`${base}/nothing`, `${base}/home`).length === 0);
const flatpak = `${base}/home/.var/app/com.valvesoftware.Steam/.local/share/Steam`;
write(`${flatpak}/steamui/css/library.css`, LIBRARY);
check('the Flatpak installation is found beside it',
    steamRoots(data, `${base}/home`).join() === [root, flatpak].join());

const classes = titleBarClasses(root);
check('the title bar classes are read from the client script',
    classes?.titleBar === '_39oUCO1OuizVPwcnnv88no' && classes?.windowControls === 'qP17eBPXkfezFfexZ4hC3');
check('a script without them gives none', titleBarClassesIn('TopBar:"a",WindowControls:"b"') === null);

// --------------------------------------------------------------- the rules
const leftCss = buttonsCss(LEFT, classes);
check('left layout moves the controls first',
    /\.title-bar-actions\.window-controls \{\n {4}order: -1 !important;\n {4}flex-direction: row/.test(leftCss));
check('close first, minimize second, maximize and restore third',
    /closeButton \{\n {4}order: 1/.test(leftCss) && /minimizeButton \{\n {4}order: 2/.test(leftCss) &&
    /maximizeButton,\n[^{]*restoreButton \{\n {4}order: 3/.test(leftCss));
check('the main window box is addressed by its classes',
    leftCss.includes('._39oUCO1OuizVPwcnnv88no > .qP17eBPXkfezFfexZ4hC3 {'));
check('without classes it falls back to the structure',
    buttonsCss(LEFT, null).includes('div:empty ~ div:has(> .title-area > .title-bar-actions.window-controls)'));
check('a right layout changes nothing', !buttonsCss(RIGHT, classes).includes('{'));
check('buttons the layout leaves out are hidden',
    /minimizeButton[^{]*\{\n {4}display: none/.test(buttonsCss('close,maximize:', classes)) &&
    !/closeButton[^{]*\{\n {4}display: none/.test(buttonsCss('close,maximize:', classes)));
check('every brace is closed', leftCss.split('{').length === leftCss.split('}').length);

// ----------------------------------------------------------- switching on
check('steam state before: off', !steamState(root).on && !steamState(root).adwaita);
check('apply writes something', applySteamButtons(root, LEFT));
const patched = read(`${css}/library.css`);
check('the patch starts with the header', patched.startsWith(`${PATCH_HEADER}\n`));
check('the patch imports the original, then the rules',
    patched.includes('@import url("library.pear-up-original.css");\n@import url("../pear-up/window-buttons.css");'));
check('the patched file has the original\'s size',
    sizeOf(`${css}/library.css`) === encoder.encode(LIBRARY).length &&
    sizeOf(`${css}/gamerecording.css`) === encoder.encode(RECORDING).length);
check('the padding is spaces only', /^[^]*?;\n +$/.test(patched));
check('the originals are kept byte for byte',
    read(`${css}/library.pear-up-original.css`) === LIBRARY &&
    read(`${css}/gamerecording.pear-up-original.css`) === RECORDING);
check('the rules are written', read(`${root}/steamui/pear-up/window-buttons.css`) === leftCss);
check('a file it does not patch is untouched', read(`${css}/gamenotes.css`) === '.z{}' &&
    !exists(`${css}/gamenotes.pear-up-original.css`));
check('steam state after: on', steamState(root).on && !steamState(root).stale);
check('applying again changes nothing', !applySteamButtons(root, LEFT));
check('the original is not overwritten by the patch',
    read(`${css}/library.pear-up-original.css`) === LIBRARY);

// The script is read once; after that the stylesheet says what it found.
GLib.unlink(`${root}/steamui/chunk~2dcc5aaf7.js`);
check('a layout change rewrites the rules without the script', applySteamButtons(root, 'close:') &&
    read(`${root}/steamui/pear-up/window-buttons.css`).includes('._39oUCO1OuizVPwcnnv88no > .qP17eBPXkfezFfexZ4hC3'));
write(`${root}/steamui/chunk~2dcc5aaf7.js`, `var a=1;${SCRIPT};var b=2;`);
applySteamButtons(root, LEFT);

// ---------------------------------------------------------- a Steam update
const UPDATED = `${LIBRARY}.new{color:green}\n`;
write(`${css}/library.css`, UPDATED);
check('an update shows as stale', steamState(root).stale && !steamState(root).on);
check('applying after an update patches again', applySteamButtons(root, LEFT) && steamState(root).on);
check('the new original replaces the old one', read(`${css}/library.pear-up-original.css`) === UPDATED);
check('the other file kept its first original', read(`${css}/gamerecording.pear-up-original.css`) === RECORDING);

// ------------------------------------------------------------ switching off
check('restore writes something', restoreSteamButtons(root));
check('Steam\'s files are back byte for byte',
    read(`${css}/library.css`) === UPDATED && read(`${css}/gamerecording.css`) === RECORDING);
check('no originals are left', !exists(`${css}/library.pear-up-original.css`) &&
    !exists(`${css}/gamerecording.pear-up-original.css`));
check('the rules and their directory are gone', !exists(`${root}/steamui/pear-up`));
check('restoring again changes nothing', !restoreSteamButtons(root));

// An update while on, then switched off before the extension caught up: the
// old original is dropped and Steam's new file stays.
applySteamButtons(root, LEFT);
write(`${css}/library.css`, LIBRARY);
restoreSteamButtons(root);
check('off after an update keeps Steam\'s new file and drops the old original',
    read(`${css}/library.css`) === LIBRARY && !exists(`${css}/library.pear-up-original.css`) &&
    read(`${css}/gamerecording.css`) === RECORDING);

// The other process half way through patching: Steam's file still its own,
// with its copy already beside it. Restoring then leaves the copy for the
// patch that is about to land, which a later restore takes back properly.
write(`${css}/library.pear-up-original.css`, LIBRARY);
restoreSteamButtons(root);
check('a copy of Steam\'s file beside it, a patch about to land, is left for it',
    read(`${css}/library.pear-up-original.css`) === LIBRARY && read(`${css}/library.css`) === LIBRARY);
applySteamButtons(root, LEFT);
restoreSteamButtons(root);
check('and the restore after that patch gives Steam\'s file back and takes the copy away',
    read(`${css}/library.css`) === LIBRARY && !exists(`${css}/library.pear-up-original.css`));

// A file too small to hold the patch is left as it is.
write(`${css}/gamerecording.css`, '.a{}');
applySteamButtons(root, LEFT);
check('a file smaller than the patch is left alone', read(`${css}/gamerecording.css`) === '.a{}' &&
    !exists(`${css}/gamerecording.pear-up-original.css`));
restoreSteamButtons(root);
write(`${css}/gamerecording.css`, RECORDING);

// ------------------------------------------------------- Adwaita for Steam
const ADWAITA = `/* Adwaita-for-Steam */\n/* Version: v2 */\n@import url("library.original.css");\n${' '.repeat(300)}`;
write(`${css}/library.css`, ADWAITA);
let threw = false;
try {
    applySteamButtons(root, LEFT);
} catch {
    threw = true;
}
check('with Adwaita for Steam installed it refuses', threw && steamState(root).adwaita);
check('and touches nothing', read(`${css}/library.css`) === ADWAITA &&
    read(`${css}/gamerecording.css`) === RECORDING && !exists(`${root}/steamui/pear-up`));

// Adwaita for Steam installed over Pear Up's patch: its original is the patch,
// which imports Pear Up's original, so switching off keeps that.
write(`${css}/library.css`, LIBRARY);
applySteamButtons(root, LEFT);
const ours = read(`${css}/library.css`);
write(`${css}/library.original.css`, ours);
write(`${css}/library.css`, ADWAITA);
restoreSteamButtons(root);
check('off under Adwaita for Steam keeps the original its chain imports',
    read(`${css}/library.pear-up-original.css`) === LIBRARY && read(`${css}/library.css`) === ADWAITA);
check('while gamerecording.css, not patched over, is restored', read(`${css}/gamerecording.css`) === RECORDING);
check('and the rules are gone, so the chain moves nothing', !exists(`${root}/steamui/pear-up/window-buttons.css`));


// ------------------------------------------------------------- the keeper
// A Steam installation of its own for each case, made as above.
let installs = 0;
const install = () => {
    const at = `${base}/keeper-${installs++}/Steam`;
    write(`${at}/steamui/css/library.css`, LIBRARY);
    write(`${at}/steamui/css/gamerecording.css`, RECORDING);
    write(`${at}/steamui/chunk~2dcc5aaf7.js`, `var a=1;${SCRIPT};var b=2;`);
    return at;
};
const fakeSettings = on => ({ on, get_boolean() { return this.on; } });
const fakeWm = () => ({
    handlers: new Map(),
    next: 1,
    connect(signal, handler) {
        this.handlers.set(this.next, handler);
        return this.next++;
    },
    disconnect(id) {
        this.handlers.delete(id);
    },
    get_string() {
        return LEFT;
    },
});
const realMonitor = path => Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
// A look for Steam that waits to be let go, and says when it has been asked,
// so that a case can act while the keeper's pass is really in the middle.
const later = () => {
    let release;
    const gate = { entered: false };
    const promise = new Promise(resolve => {
        release = resolve;
    });
    gate.find = roots => () => {
        gate.entered = true;
        return promise.then(() => roots);
    };
    gate.release = () => release();
    gate.reached = async () => {
        for (let turn = 0; turn < 100 && !gate.entered; turn++)
            await null;
        return gate.entered;
    };
    return gate;
};

{
    // Constructed, it does nothing at all; started, it patches as the
    // synchronous functions do, byte for byte; switched off, it restores.
    const at = install();
    const same = install();
    const wmFake = fakeWm();
    const settings = fakeSettings(true);
    const keeper = new SteamButtonsKeeper('test', settings,
        { findRoots: async () => [at], monitorDirectory: realMonitor, wm: wmFake });
    check('the keeper connects nothing until it is started', wmFake.handlers.size === 0);
    keeper.start();
    check('started, it watches the layout', wmFake.handlers.size === 1);
    await keeper.settled;
    applySteamButtons(same, LEFT);
    check('the keeper patches as the synchronous functions do',
        steamState(at).on && read(`${at}/steamui/css/library.css`) === read(`${same}/steamui/css/library.css`) &&
        read(`${at}/steamui/pear-up/window-buttons.css`) === read(`${same}/steamui/pear-up/window-buttons.css`) &&
        read(`${at}/steamui/css/library.pear-up-original.css`) === LIBRARY);
    check('and watches the stylesheets', keeper._monitors.length === 1);
    settings.on = false;
    keeper.sync();
    await keeper.settled;
    check('switched off, the keeper puts Steam\'s files back',
        read(`${at}/steamui/css/library.css`) === LIBRARY && !exists(`${at}/steamui/pear-up`) &&
        !exists(`${at}/steamui/css/library.pear-up-original.css`));
    check('and stops watching them', keeper._monitors.length === 0);
    keeper.destroy();
    check('destroyed, it leaves nothing connected', wmFake.handlers.size === 0);
}

{
    // A monitor that cannot be made: the ones made before it are taken back,
    // none is kept, the patch is still made, and destroy disconnects all.
    const first = install();
    const second = install();
    const wmFake = fakeWm();
    const made = [];
    const keeper = new SteamButtonsKeeper('test', fakeSettings(true), {
        findRoots: async () => [first, second],
        monitorDirectory: path => {
            if (made.length > 0)
                throw new Error('no more inotify watches');
            const monitor = realMonitor(path);
            made.push(monitor);
            return monitor;
        },
        wm: wmFake,
    });
    keeper.start();
    await keeper.settled;
    check('a monitor that fails takes back the one made before it',
        made.length === 1 && made[0].is_cancelled() && keeper._monitors.length === 0);
    check('and both installations are patched all the same', steamState(first).on && steamState(second).on);
    keeper.destroy();
    check('destroyed after a failed watch, nothing is left connected', wmFake.handlers.size === 0);
    restoreSteamButtons(first);
    restoreSteamButtons(second);
}

{
    // Destroyed while its first look for Steam is still out: nothing written.
    const at = install();
    const wmFake = fakeWm();
    const slow = later();
    const keeper = new SteamButtonsKeeper('test', fakeSettings(true),
        { findRoots: slow.find([at]), monitorDirectory: realMonitor, wm: wmFake });
    keeper.start();
    check('the first pass is under way', await slow.reached());
    keeper.destroy();
    slow.release();
    await keeper.settled;
    check('destroyed while reading, it writes nothing',
        !steamState(at).on && read(`${at}/steamui/css/library.css`) === LIBRARY && !exists(`${at}/steamui/pear-up`));
    check('and leaves nothing connected', wmFake.handlers.size === 0 && keeper._monitors.length === 0);
}

{
    // Switched on and off again while the first pass is still reading: the
    // first pass is dropped, the last request is what stands.
    const at = install();
    const settings = fakeSettings(true);
    const slow = later();
    const keeper = new SteamButtonsKeeper('test', settings,
        { findRoots: slow.find([at]), monitorDirectory: realMonitor, wm: fakeWm() });
    keeper.start();
    check('the pass switching on is under way', await slow.reached());
    settings.on = false;
    keeper.sync();
    slow.release();
    await keeper.settled;
    check('on then off while reading leaves Steam\'s files as they were',
        !steamState(at).on && read(`${at}/steamui/css/library.css`) === LIBRARY && !exists(`${at}/steamui/pear-up`));
    check('and watches nothing', keeper._monitors.length === 0);
    keeper.destroy();
}

{
    // The shell reads a file asynchronously and patches it a moment later; the
    // preferences may have patched it in between. The patch checks the file
    // is still what was read, and leaves one patched since alone.
    const at = install();
    function* meanwhile(steps, act) {
        let step = steps.next();
        while (!step.done) {
            if (step.value.op === 'patch')
                act();
            step = steps.next(yield step.value);
        }
        return step.value;
    }
    let acted = false;
    await runAsync(meanwhile(applySteamButtonsSteps(at, LEFT), () => {
        if (!acted)
            applySteamButtons(at, LEFT);
        acted = true;
    }));
    check('a file patched by the other process meanwhile is left as it patched it',
        steamState(at).on && read(`${at}/steamui/css/library.pear-up-original.css`) === LIBRARY &&
        read(`${at}/steamui/css/gamerecording.pear-up-original.css`) === RECORDING);
    restoreSteamButtons(at);
    check('and restores cleanly', read(`${at}/steamui/css/library.css`) === LIBRARY &&
        !exists(`${at}/steamui/css/library.pear-up-original.css`));
}

{
    // A start that fails part way undoes itself.
    const wmFake = fakeWm();
    wmFake.connect = () => {
        throw new Error('no such signal');
    };
    const keeper = new SteamButtonsKeeper('test', fakeSettings(true),
        { findRoots: async () => [], monitorDirectory: realMonitor, wm: wmFake });
    let threwOnStart = false;
    try {
        keeper.start();
    } catch {
        threwOnStart = true;
    }
    check('a start that fails throws and leaves the keeper destroyed', threwOnStart && keeper._settings === null);
}

GLib.spawn_command_line_sync(`rm -rf ${base}`);

if (failed > 0) {
    printerr(`${failed} Steam button check(s) failed`);
    system.exit(1);
}
print('  all Steam button checks passed');

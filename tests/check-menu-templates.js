#!/usr/bin/gjs -m
// The detection has to be exact tokens: a substring match is how New Folder
// and Documents used to appear on every app whose title mentioned Files.
import system from 'system';
import {
    isFileManager,
    fileMenu,
    goMenu,
    viewMenu,
    windowMenu,
    compactMenuItems,
} from '../menuTemplates.js';

let failed = 0;

function check(label, condition) {
    if (condition)
        print(`  ok   ${label}`);
    else {
        printerr(`  FAIL ${label}`);
        failed++;
    }
}

check('Nautilus desktop id is a file manager',
    isFileManager('org.gnome.Nautilus.desktop', ''));
check('Nautilus wm class is a file manager',
    isFileManager('', 'org.gnome.Nautilus'));
check('Files desktop id is a file manager',
    isFileManager('org.gnome.Files.desktop', 'org.gnome.Nautilus'));
check('the GTK test window is not a file manager',
    !isFileManager('io.github.maddinek.PearUpTestWindow.desktop',
        'PearUpTestWindow'));
check('Firefox is not a file manager',
    !isFileManager('org.mozilla.firefox.desktop', 'firefox'));
check('an app whose title would have matched "Files" is not a file manager',
    !isFileManager('com.example.MyFiles.desktop', 'MyFiles'));

const genericFile = fileMenu(false, 'Nautilus').children.map(item => item.label);
check('generic File has New Window', genericFile.includes('New Window'));
check('generic File has no New Folder', !genericFile.includes('New Folder'));
check('generic File has no New Nautilus Window',
    !genericFile.includes('New Nautilus Window'));

const filesFile = fileMenu(true, 'Nautilus').children.map(item => item.label);
check('file-manager File has New Folder', filesFile.includes('New Folder'));
check('file-manager File has New Nautilus Window',
    filesFile.includes('New Nautilus Window'));

const genericGo = goMenu(false).children.map(item => item.label);
check('generic Go has Back', genericGo.includes('Back'));
check('generic Go has no Home', !genericGo.includes('Home'));
check('file-manager Go has Home',
    goMenu(true).children.some(item => item.label === 'Home'));

check('View has Full Screen and nothing greyed out',
    viewMenu().children.length === 1 &&
    viewMenu().children[0].label === 'Enter Full Screen');

// Close Window / Close must not be the Quit action. Sharing "close" with
// Quit made File and Window take down every window of the focused app.
function actionOf(menu, label) {
    return menu.children.find(item => item.label === label)?.action;
}
check('File Close Window closes one window',
    actionOf(fileMenu(false, 'Nautilus'), 'Close Window') === 'close');
check('file-manager File Close Window closes one window',
    actionOf(fileMenu(true, 'Nautilus'), 'Close Window') === 'close');
check('Window Close closes one window',
    actionOf(windowMenu(), 'Close') === 'close');
check('File and Window have no Quit action',
    !fileMenu(false, 'Nautilus').children.some(item => item.action === 'quit') &&
    !windowMenu().children.some(item => item.action === 'quit'));

const compacted = compactMenuItems([
    { label: 'Keep', action: 'keep' },
    { label: 'Stub', enabled: false },
    { type: 'separator' },
    { type: 'separator' },
    { label: 'Also', action: 'also' },
    { type: 'separator' },
]);
check('stubs are dropped', !compacted.some(item => item.label === 'Stub'));
check('placeholders survive', compactMenuItems([
    { label: 'No items configured', enabled: false, placeholder: true },
]).length === 1);
check('extra separators are squeezed',
    compacted.length === 3 &&
    compacted[0].label === 'Keep' &&
    compacted[1].type === 'separator' &&
    compacted[2].label === 'Also');
// Built menus must be safe to mutate: everything compactMenuItems hands back
// is a copy, so a tweak to a live menu can never reach the shared template
// constants underneath.
const sample = [
    { label: 'Leaf', action: 'leaf' },
    { type: 'separator' },
    { label: 'Branch', children: [{ label: 'Inner', action: 'inner' }] },
];
const first = compactMenuItems(sample);
first[0].label = 'MUTATED';
first[0].extra = true;
first[2].children[0].label = 'MUTATED';
check('mutating a built leaf does not reach the template',
    sample[0].label === 'Leaf' && sample[0].extra === undefined);
check('mutating a built subtree does not reach the template',
    sample[2].children[0].label === 'Inner');
const second = compactMenuItems(sample);
check('a fresh build is unaffected by an earlier mutation',
    second[0].label === 'Leaf' && second[2].children[0].label === 'Inner');

if (failed === 0)
    print('menu templates: all checks passed');
else
    printerr(`menu templates: ${failed} failed`);
system.exit(failed === 0 ? 0 : 1);

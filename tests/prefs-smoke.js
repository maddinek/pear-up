#!/usr/bin/gjs -m
// Build every preferences page and fail if any of them throws.
//
// Preferences run in their own process, so nothing about them is exercised by
// the shell-side tests: a mistyped property or a method that does not exist on
// this libadwaita only shows up when the window is opened, and then it shows up
// as an empty window with a stack trace in the journal. This opens it.
//
// It is a smoke test, deliberately: it asserts that the pages build, not that
// they look right or that the controls do anything.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import system from 'system';

const extensionDir = system.programArgs[0];
if (!extensionDir) {
    print('usage: prefs-smoke.js <extension-directory>');
    system.exit(2);
}

if (!Gtk.init_check()) {
    print('FAIL: no display; run this under xvfb-run');
    system.exit(2);
}
Adw.init();

const [, bytes] = GLib.file_get_contents(`${extensionDir}/metadata.json`);
const metadata = JSON.parse(new TextDecoder().decode(bytes));
metadata.dir = Gio.File.new_for_path(extensionDir);
metadata.path = extensionDir;

const { default: Preferences } = await import(`file://${extensionDir}/prefs.js`);
const preferences = new Preferences(metadata);

const window = new Adw.PreferencesWindow();

// Record what gets added. There is no public way to enumerate the pages of an
// AdwPreferencesWindow afterwards, and "how many pages did it add" is worth
// asserting: a page that throws half-way leaves the window looking fine.
const pages = [];
const add = window.add.bind(window);
window.add = page => {
    pages.push(page);
    add(page);
};

let failure = null;
try {
    await preferences.fillPreferencesWindow(window);
} catch (e) {
    failure = e;
}

if (failure) {
    print(`FAIL: building the preferences window threw: ${failure.message}`);
    if (failure.stack)
        print(failure.stack.split('\n').map(line => `    ${line}`).join('\n'));
    system.exit(1);
}

const titles = pages.map(page => page.title ?? '(untitled)');
print(`  built ${pages.length} pages: ${titles.join(', ')}`);

const problems = [];
if (pages.length < 6)
    problems.push(`expected at least 6 pages, got ${pages.length}`);
for (const [index, title] of titles.entries()) {
    if (!title || title === '(untitled)')
        problems.push(`page ${index} has no title, so its tab would be blank`);
}

// The pages hand out no references to their rows, so look them up in the tree.
const findWidget = (widget, matches) => {
    if (matches(widget))
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = findWidget(child, matches);
        if (found)
            return found;
    }
    return null;
};

// With Dash to Dock installed, the Dock page is its settings rather than the
// "not installed" notice, and the running indicator row is the one place these
// pages write several of its keys at once. Pick every choice and read back what
// was stored — the backend is in memory, so nothing outlives the run.
if (GLib.getenv('PREFS_SMOKE_DOCK')) {
    const findRow = (widget, title) =>
        findWidget(widget, found => found instanceof Adw.ComboRow && found.title === title);

    const dockPage = pages.find(page => page.title === 'Dock');
    const dock = preferences._dashToDockSettings();
    const key = dock?.settings_schema.get_key('running-indicator-style');
    const row = dockPage && findRow(dockPage, 'Indicator');

    if (!dock) {
        problems.push('PREFS_SMOKE_DOCK is set but the Dash to Dock schema was not found');
    } else if (!key.range_check(GLib.Variant.new_string('DOT'))) {
        print('  running indicator: this Dash to Dock has no single-dot style; row correctly absent');
        if (row)
            problems.push('running indicator row shown although this Dash to Dock cannot store DOT');
    } else if (!row) {
        problems.push('Dash to Dock is installed but the Dock page has no running indicator row');
    } else {
        const expected = [
            ['DOT', true, '#ffffff'],
            ['DEFAULT', false, null],
            ['DOT', true, 'rgba(255,255,255,0)'],
        ];
        // Start from the last choice so that selecting the first one is a change.
        for (const index of [2, 0, 1, 2]) {
            row.selected = index;
            const [style, customize, color] = expected[index];
            const got = [
                dock.get_string('running-indicator-style'),
                dock.get_boolean('custom-theme-customize-running-dots'),
                dock.get_string('custom-theme-running-dots-color'),
            ];
            if (got[0] !== style || got[1] !== customize || (color !== null && got[2] !== color))
                problems.push(`indicator choice ${index} stored ${JSON.stringify(got)}`);
            else if (preferences._currentRunningIndicator(dock) !== index)
                problems.push(`indicator choice ${index} reads back as ${preferences._currentRunningIndicator(dock)}`);
        }
        if (dock.get_int('custom-theme-running-dots-border-width') !== 0)
            problems.push('the dot keeps a border, so None would still draw a ring');
        print('  running indicator: every choice stored and read back');
    }
}

// Magnification is Pear Up's own setting, but it only means something over a
// dock, so the Dock page offers it when Dash to Dock is there and not otherwise.
// Driving the rows writes settings, which only the container run makes safe by
// pointing GSETTINGS_BACKEND at memory — hence the same switch as above.
{
    const dockPage = pages.find(page => page.title === 'Dock');
    const titled = (type, title) => widget => widget instanceof type && widget.title === title;
    const enabledRow = dockPage && findWidget(dockPage, titled(Adw.SwitchRow, 'Magnification'));
    const strengthRow = dockPage && findWidget(dockPage, titled(Adw.ActionRow, 'Strength'));
    const scale = strengthRow && findWidget(strengthRow, widget => widget instanceof Gtk.Scale);

    if (!preferences._dashToDockSettings()) {
        if (enabledRow || strengthRow)
            problems.push('the Dock page offers magnification although Dash to Dock is not installed');
    } else if (GLib.getenv('PREFS_SMOKE_DOCK')) {
        if (!enabledRow || !strengthRow || !scale) {
            problems.push('Dash to Dock is installed but the Dock page lacks the magnification ' +
                `switch (${!!enabledRow}), strength row (${!!strengthRow}) or its slider (${!!scale})`);
        } else {
            const settings = preferences.getSettings();
            const problemsBefore = problems.length;
            const sizeKey = settings.settings_schema.get_key('dock-magnification-size');
            const [min, max] = sizeKey.get_range().deep_unpack()[1].deep_unpack();
            const expect = (label, got, wanted) => {
                if (got !== wanted)
                    problems.push(`magnification: ${label} is ${got}, expected ${wanted}`);
            };

            // Off out of the box, and the slider has nothing to say until it is on.
            expect('the switch at first', enabledRow.active, false);
            expect('the slider sensitive at first', strengthRow.sensitive, false);
            expect('the slider start', scale.get_value(), settings.get_int('dock-magnification-size'));
            const adjustment = scale.get_adjustment();
            expect('the slider lower bound', adjustment.lower, min);
            expect('the slider upper bound', adjustment.upper, max);

            enabledRow.active = true;
            expect('dock-magnification after switching on', settings.get_boolean('dock-magnification'), true);
            expect('the slider sensitive when on', strengthRow.sensitive, true);

            for (const size of [max, min, 260]) {
                scale.set_value(size);
                expect(`dock-magnification-size after the slider moved to ${size}`,
                    settings.get_int('dock-magnification-size'), size);
            }
            expect('the value label', scale.get_layout()?.get_text(), '260%');

            // A change made outside the window moves the controls rather than
            // being overwritten by them.
            settings.set_int('dock-magnification-size', 130);
            expect('the slider after an outside change', scale.get_value(), 130);
            expect('dock-magnification-size after syncing the slider', settings.get_int('dock-magnification-size'), 130);

            enabledRow.active = false;
            expect('dock-magnification after switching off', settings.get_boolean('dock-magnification'), false);
            expect('the slider sensitive when off', strengthRow.sensitive, false);
            settings.set_boolean('dock-magnification', true);
            expect('the switch after an outside change', enabledRow.active, true);
            expect('the slider sensitive after an outside change', strengthRow.sensitive, true);
            if (problems.length === problemsBefore)
                print('  magnification: switch and slider write their keys and follow outside changes');
        }
    }
}

if (problems.length > 0) {
    for (const problem of problems)
        print(`FAIL: ${problem}`);
    system.exit(1);
}

print('preferences: every page built');
system.exit(0);

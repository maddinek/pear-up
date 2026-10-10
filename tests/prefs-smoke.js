#!/usr/bin/gjs -m
// Build every preferences page and fail if any of them throws.
//
// Preferences run in their own process, so nothing about them is exercised by
// the shell-side tests: a mistyped property or a method that does not exist on
// this libadwaita only shows up when the window is opened, and then it shows up
// as an empty window with a stack trace in the journal. This opens it.
//
// It is a smoke test, deliberately: it asserts that the pages build, and that
// the rows which write settings write the right ones, not that they look right.
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
if (pages.length < 7)
    problems.push(`expected at least 7 pages, got ${pages.length}`);
// Appearance drives settings of the desktop rather than of Pear Up, so it sits
// with the other pages that do (Dock, Keyboard) and not among the bar's own.
if (titles.join(', ') !== 'General, Menus, Custom Menus, Dock, Appearance, Keyboard, About')
    problems.push(`the pages are in the wrong order: ${titles.join(', ')}`);
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

// The focused-app backdrop is Pear Up's own setting too, offered beside the
// running indicator whenever there is a Dash to Dock to draw it — including one
// too old for the single dot, which leaves that group with this row alone.
{
    const dockPage = pages.find(page => page.title === 'Dock');
    const row = dockPage && findWidget(dockPage, widget =>
        widget instanceof Adw.SwitchRow && widget.title === 'Highlight the Focused App');

    if (!preferences._dashToDockSettings()) {
        if (row)
            problems.push('the Dock page offers the focus highlight although Dash to Dock is not installed');
    } else if (GLib.getenv('PREFS_SMOKE_DOCK')) {
        if (!row) {
            problems.push('Dash to Dock is installed but the Dock page has no focus highlight switch');
        } else {
            const settings = preferences.getSettings();
            const problemsBefore = problems.length;
            const expect = (label, got, wanted) => {
                if (got !== wanted)
                    problems.push(`focus highlight: ${label} is ${got}, expected ${wanted}`);
            };

            // Off out of the box: macOS draws no backdrop.
            expect('the switch at first', row.active, false);
            row.active = true;
            expect('dock-focus-highlight after switching on', settings.get_boolean('dock-focus-highlight'), true);
            row.active = false;
            expect('dock-focus-highlight after switching off', settings.get_boolean('dock-focus-highlight'), false);
            settings.set_boolean('dock-focus-highlight', true);
            expect('the switch after an outside change', row.active, true);
            settings.reset('dock-focus-highlight');
            if (problems.length === problemsBefore)
                print('  focus highlight: switch writes its key and follows outside changes');
        }
    }
}

// Appearance writes GNOME's own settings, not Pear Up's. Run here they land in
// the in-memory backend, so driving them is safe; and since a switch has to
// give back what it replaced, the checks that matter are the round trips: the
// user's values go out and come back exactly, also through a second preferences
// object, which stands in for the window having been closed and reopened.
{
    const INTERFACE = 'org.gnome.desktop.interface';
    const WM = 'org.gnome.desktop.wm.preferences';
    const interfaceSettings = preferences._settingsForSchema(INTERFACE);
    const wmSettings = preferences._settingsForSchema(WM);
    const pearUp = preferences.getSettings();
    const problemsBefore = problems.length;

    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`appearance: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };

    // Pages keep their rows alive only while somebody holds the page.
    const kept = [];
    const rowOf = (prefs, title) => {
        const page = prefs._buildAppearancePage();
        kept.push(page);
        return findWidget(page, widget => widget instanceof Adw.SwitchRow && widget.title === title);
    };
    // A new object is a new process as far as anything held in memory goes.
    // `installed` stands in for the fonts the system has; without it Pango is
    // asked, as in the real window.
    const prefsWith = installed => {
        const fresh = new Preferences(metadata);
        if (installed)
            fresh._fontFamilyInstalled = family => installed.includes(family);
        return fresh;
    };
    const forgetDisplaced = () => pearUp.reset('displaced-settings');

    if (!interfaceSettings || !wmSettings) {
        problems.push('appearance: the GNOME interface or window schemas are missing in this container');
    } else {
        const TYPE_ROW = 'macOS-Like Type';
        const typeKeys = [
            [interfaceSettings, 'font-name'],
            [interfaceSettings, 'document-font-name'],
            [wmSettings, 'titlebar-font'],
            [interfaceSettings, 'font-hinting'],
        ];
        const typeValues = () => typeKeys.map(([settings, key]) => settings.get_string(key));
        // What the user set, as opposed to what is in effect: null is a key
        // left at its default, which must come back as exactly that.
        const typeUserValues = () => typeKeys.map(([settings, key]) =>
            settings.get_user_value(key)?.unpack() ?? null);
        const setType = values => typeKeys.forEach(([settings, key], index) => {
            if (values[index] === null)
                settings.reset(key);
            else
                settings.set_string(key, values[index]);
        });
        const typeFor = family => [`${family} 11`, `${family} 11`, `${family} Bold 11`, 'none'];
        const unset = [null, null, null, null];
        const mine = ['Previous Sans 12', 'Previous Serif 13', 'Previous Sans Bold 12', 'full'];

        // Pango has to agree with fontconfig about what is installed, since
        // that is the whole basis for choosing between the two fonts.
        const [listed, listing] = GLib.spawn_command_line_sync('fc-list : family');
        if (listed) {
            const families = new Set(new TextDecoder().decode(listing).split(/[\n,]/)
                .map(family => family.trim().toLowerCase()));
            const expected = ['Adwaita Sans', 'Inter'].find(family => families.has(family.toLowerCase())) ?? null;
            expect('the font Pango finds', preferences._macOSTypeFamily(), expected);
            print(`  appearance: this system has ${expected ?? 'neither Adwaita Sans nor Inter'}`);
        }

        // Whichever of the two fonts is there, the same behaviour.
        for (const family of ['Adwaita Sans', 'Inter']) {
            const at = what => `${family}: ${what}`;

            setType(mine);
            forgetDisplaced();
            let row = rowOf(prefsWith([family]), TYPE_ROW);
            expect(at('the switch while the type is the user\'s own'), row.active, false);
            expect(at('the switch can be turned on'), row.sensitive, true);
            row.active = true;
            expect(at('the four values after switching on'), typeValues(), typeFor(family));
            expect(at('the switch after switching on'), row.active, true);

            // The window closed and opened again: nothing but the stored note.
            row = rowOf(prefsWith([family]), TYPE_ROW);
            expect(at('the switch after reopening'), row.active, true);
            row.active = false;
            expect(at('the four values after switching off'), typeValues(), mine);
            expect(at('the notes once handed back'), pearUp.get_string('displaced-settings'), '{}');

            // Nothing set by the user comes back as nothing set by the user.
            setType(unset);
            forgetDisplaced();
            const defaults = typeValues();
            row = rowOf(prefsWith([family]), TYPE_ROW);
            expect(at('the switch at the defaults'), row.active,
                JSON.stringify(defaults) === JSON.stringify(typeFor(family)));
            row.active = true;
            expect(at('the four values after switching on from the defaults'), typeValues(), typeFor(family));
            row = rowOf(prefsWith([family]), TYPE_ROW);
            row.active = false;
            expect(at('the user\'s values after switching off, back to the defaults'), typeUserValues(), unset);
            expect(at('the values after switching off, back to the defaults'), typeValues(), defaults);

            // One of them already in place is still the user's to get back.
            const partial = [`${family} 11`, ...mine.slice(1)];
            setType(partial);
            forgetDisplaced();
            row = rowOf(prefsWith([family]), TYPE_ROW);
            expect(at('the switch with only one value in place'), row.active, false);
            row.active = true;
            row = rowOf(prefsWith([family]), TYPE_ROW);
            row.active = false;
            expect(at('the user\'s values after a partial match'), typeUserValues(), partial);

            // Set by hand, before this switch existed: nothing was noted, and
            // the default is the only thing there is to go back to.
            setType(typeFor(family));
            forgetDisplaced();
            row = rowOf(prefsWith([family]), TYPE_ROW);
            expect(at('the switch when all four already match'), row.active, true);
            row.active = false;
            expect(at('the user\'s values after switching off values set by hand'), typeUserValues(), unset);

            // It follows the keys when they change somewhere else.
            setType(typeFor(family));
            forgetDisplaced();
            row = rowOf(prefsWith([family]), TYPE_ROW);
            interfaceSettings.set_string('font-hinting', 'slight');
            expect(at('the switch after the hinting changed elsewhere'), row.active, false);
            interfaceSettings.set_string('font-hinting', 'none');
            expect(at('the switch after the hinting changed back'), row.active, true);
        }

        // Neither font: the row says why, rather than writing a font that is not there.
        setType(mine);
        forgetDisplaced();
        let row = rowOf(prefsWith([]), TYPE_ROW);
        expect('no font: the switch', [row.active, row.sensitive], [false, false]);
        if (!/neither/.test(row.subtitle ?? ''))
            problems.push(`appearance: no font: the subtitle does not say why (${row.subtitle})`);
        row.active = true;
        expect('no font: the values after trying to switch on', typeValues(), mine);
        // ...but a type that is already macOS's can still be switched off.
        setType(typeFor('Adwaita Sans'));
        forgetDisplaced();
        row = rowOf(prefsWith([]), TYPE_ROW);
        expect('no font: the switch while the values are in place', [row.active, row.sensitive], [true, true]);

        // The accent exists from GNOME 47; before that the row must not.
        const ACCENT_ROW = 'Blue Accent, Like macOS';
        if (!preferences._schemaHasKey(interfaceSettings, 'accent-color')) {
            expect('the accent row on a release without accent colors',
                rowOf(prefsWith(), ACCENT_ROW), null);
        } else {
            const accent = () => interfaceSettings.get_string('accent-color');
            const accentUser = () => interfaceSettings.get_user_value('accent-color')?.unpack() ?? null;

            interfaceSettings.set_string('accent-color', 'purple');
            forgetDisplaced();
            row = rowOf(prefsWith(), ACCENT_ROW);
            expect('the accent switch while it is purple', row.active, false);
            row.active = true;
            expect('the accent after switching on', accent(), 'blue');
            row = rowOf(prefsWith(), ACCENT_ROW);
            expect('the accent switch after reopening', row.active, true);
            row.active = false;
            expect('the accent after switching off', accent(), 'purple');

            interfaceSettings.reset('accent-color');
            forgetDisplaced();
            row = rowOf(prefsWith(), ACCENT_ROW);
            row.active = true;
            row = rowOf(prefsWith(), ACCENT_ROW);
            row.active = false;
            expect('the accent after switching off, back to the default', accentUser(), null);

            interfaceSettings.set_string('accent-color', 'blue');
            forgetDisplaced();
            row = rowOf(prefsWith(), ACCENT_ROW);
            expect('the accent switch when it is already blue', row.active, true);
            interfaceSettings.set_string('accent-color', 'green');
            expect('the accent switch after the accent changed elsewhere', row.active, false);

            // Both switches share one note, and neither disturbs the other's.
            setType(mine);
            interfaceSettings.set_string('accent-color', 'purple');
            forgetDisplaced();
            const both = prefsWith(['Adwaita Sans']);
            const typeSwitch = rowOf(both, TYPE_ROW);
            const accentSwitch = rowOf(both, ACCENT_ROW);
            typeSwitch.active = true;
            accentSwitch.active = true;
            accentSwitch.active = false;
            expect('the accent with the type still on', accent(), 'purple');
            expect('the type with the accent switched off', typeValues(), typeFor('Adwaita Sans'));
            typeSwitch.active = false;
            expect('the type after both are off', typeValues(), mine);
        }
    }

    if (problems.length === problemsBefore)
        print('  appearance: type and accent switches write their keys and hand the user\'s values back');
}

// A shortcut set stands conflicting grabs down while it is on, and has to give
// them back as the user had them. The window set displaces the shortcut that
// reveals Dash to Dock. The note of what was there is read back from our own
// settings, so it is driven through a second preferences object, as after the
// window was closed and opened again. The shortcut is set to something other
// than Dash to Dock's own default, since resetting would hand back that.
if (GLib.getenv('PREFS_SMOKE_DOCK')) {
    const dock = preferences._dashToDockSettings();
    const pearUp = preferences.getSettings();
    const problemsBefore = problems.length;

    if (dock && preferences._schemaHasKey(dock, 'shortcut')) {
        const kept = [];
        const setRow = prefs => {
            const page = prefs._buildKeyboardPage();
            kept.push(page);
            return findWidget(page, widget =>
                widget instanceof Adw.ExpanderRow && widget.title === 'macOS Window Shortcuts');
        };
        const mine = ['<Alt>x'];
        const shortcut = () => dock.get_strv('shortcut').join(',');

        pearUp.reset('displaced-keybindings');
        dock.set_strv('shortcut', mine);
        if (dock.settings_schema.get_key('shortcut').get_default_value().deepUnpack().join(',') === mine.join(','))
            problems.push('shortcut set: the test shortcut is Dash to Dock\'s default, so it proves nothing');
        setRow(new Preferences(metadata)).enable_expansion = true;
        if (shortcut() !== '')
            problems.push(`shortcut set: Dash to Dock keeps its shortcut (${shortcut()}) after the set is switched on`);
        if (!pearUp.get_string('displaced-keybindings').includes('dash-to-dock:shortcut'))
            problems.push('shortcut set: the displaced shortcut was not stored');

        // Reopened: only the stored note can say what the shortcut was.
        const reopened = setRow(new Preferences(metadata));
        if (!reopened.enable_expansion)
            problems.push('shortcut set: the set does not read as on after reopening');
        reopened.enable_expansion = false;
        if (shortcut() !== mine.join(','))
            problems.push(`shortcut set: the shortcut came back as '${shortcut()}', not the user's own`);
        if (pearUp.get_string('displaced-keybindings') !== '{}')
            problems.push('shortcut set: the displaced note was not cleared');
        if (problems.length === problemsBefore)
            print('  shortcut set: hands Dash to Dock\'s shortcut back as the user had it, after a reopen');
    }
}

if (problems.length > 0) {
    for (const problem of problems)
        print(`FAIL: ${problem}`);
    system.exit(1);
}

print('preferences: every page built');
system.exit(0);

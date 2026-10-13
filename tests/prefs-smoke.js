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
if (pages.length < 8)
    problems.push(`expected at least 8 pages, got ${pages.length}`);
// Appearance and Windows drive settings of the desktop rather than of Pear Up,
// so they sit with the other pages that do (Dock, Keyboard) and not among the
// bar's own.
if (titles.join(', ') !== 'General, Menus, Custom Menus, Dock, Appearance, Windows, Keyboard, About')
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
        // The dropdown's value shares the row with the subtitle, and a subtitle
        // as long as the old one, 81 characters, left "One Dot, Like macOS" room
        // for an ellipsis at the default window width.
        if (row.subtitle.length > 48)
            problems.push(`the indicator row's subtitle is ${row.subtitle.length} characters, ` +
                'enough to squeeze the selected value out of the row');
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

// Bouncing is Pear Up's own as well, and offered on the Dock page only when
// there is a Dash to Dock to bounce.
{
    const dockPage = pages.find(page => page.title === 'Dock');
    const rows = ['Bounce While Opening', 'Bounce for Attention'].map(title => dockPage &&
        findWidget(dockPage, widget => widget instanceof Adw.SwitchRow && widget.title === title));
    const keys = ['dock-bounce-on-launch', 'dock-bounce-on-attention'];

    if (!preferences._dashToDockSettings()) {
        if (rows.some(Boolean))
            problems.push('the Dock page offers bouncing although Dash to Dock is not installed');
    } else if (GLib.getenv('PREFS_SMOKE_DOCK')) {
        if (!rows.every(Boolean)) {
            problems.push(`Dash to Dock is installed but the Dock page lacks a bounce switch (${rows.map(Boolean)})`);
        } else {
            const settings = preferences.getSettings();
            const problemsBefore = problems.length;
            const expect = (label, got, wanted) => {
                if (got !== wanted)
                    problems.push(`bounce: ${label} is ${got}, expected ${wanted}`);
            };
            rows.forEach((row, index) => {
                const key = keys[index];
                expect(`${key} switch at first`, row.active, false);
                row.active = true;
                expect(`${key} after switching on`, settings.get_boolean(key), true);
                row.active = false;
                expect(`${key} after switching off`, settings.get_boolean(key), false);
                settings.set_boolean(key, true);
                expect(`${key} switch after an outside change`, row.active, true);
                settings.reset(key);
            });
            if (problems.length === problemsBefore)
                print('  bounce: both switches write their keys and follow outside changes');
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

// The icon and cursor pickers list what is installed, macOS-style themes first,
// and write the key they were asked for. What is installed is whatever the scan
// finds, so this runs three ways: against the container as it is, against
// directories with nothing in them, and — when the runner has dropped fixture
// themes into its XDG directories, as tests/lib/check-prefs-here.sh does —
// against those, whose names and layout are known.
{
    const INTERFACE = 'org.gnome.desktop.interface';
    const settings = preferences._settingsForSchema(INTERFACE);
    const fixtures = GLib.getenv('PREFS_SMOKE_THEMES');
    const problemsBefore = problems.length;

    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`themes: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };

    const pickers = [
        {
            kind: 'icons', key: 'icon-theme', title: 'Icon Theme',
            macOS: name => /^(MacTahoe|WhiteSur)/i.test(name),
            links: ['vinceliuice/MacTahoe-icon-theme', 'vinceliuice/WhiteSur-icon-theme'],
        },
        {
            kind: 'cursors', key: 'cursor-theme', title: 'Cursor Theme',
            macOS: name => /^(macOS|MacTahoe|WhiteSur)/i.test(name),
            links: ['ful1e5/apple_cursor'],
        },
    ];

    const kept = [];
    const pageWith = dirs => {
        const fresh = new Preferences(metadata);
        if (dirs)
            fresh._themeDirs = () => dirs;
        const page = fresh._buildAppearancePage();
        kept.push(page);
        return page;
    };
    const rowOf = (page, picker) => findWidget(page, widget =>
        widget instanceof Adw.ComboRow && widget.title === picker.title);
    const labelsOf = row => Array.from({ length: row.model.get_n_items() },
        (_, index) => row.model.get_string(index));
    const linkTo = (page, target) => findWidget(page, widget =>
        widget instanceof Gtk.LinkButton && widget.uri.endsWith(target));

    const emptyDir = GLib.dir_make_tmp('pear-up-no-themes-XXXXXX');

    if (!settings) {
        problems.push('themes: the GNOME interface schema is missing in this container');
    } else {
        for (const picker of pickers) {
            const at = what => `${picker.kind}: ${what}`;
            const present = (labels, name) => labels.includes(name);

            // 1. Whatever this container (and the runner's fixtures) have.
            settings.reset(picker.key);
            let page = pageWith();
            let row = rowOf(page, picker);
            if (!row) {
                problems.push(at('there is no picker row'));
                continue;
            }
            let labels = labelsOf(row);
            const offered = labels.filter(label => !label.endsWith(' (not installed)'));

            expect(at('every name once'), new Set(offered).size, offered.length);
            for (const never of ['hicolor', 'locolor', 'default'])
                expect(at(`${never} offered`), present(offered, never), false);

            // macOS-style first, each group alphabetical.
            const styled = offered.filter(picker.macOS);
            const others = offered.filter(name => !picker.macOS(name));
            expect(at('macOS-style themes come first'), offered, [...styled, ...others]);
            for (const group of [styled, others]) {
                const lowered = group.map(name => name.toLowerCase());
                expect(at('a group is in alphabetical order'), lowered, [...lowered].sort());
            }

            // The stock theme is the key's own default, whether or not it hides.
            expect(at('the selected row is the current theme'),
                labels[row.selected].replace(/ \(not installed\)$/, ''), settings.get_string(picker.key));
            const stock = picker.kind === 'icons' ? 'index.theme' : 'cursors';
            if (GLib.file_test(`/usr/share/icons/Adwaita/${stock}`, GLib.FileTest.EXISTS))
                expect(at('Adwaita, installed here, is offered'), present(offered, 'Adwaita'), true);

            // The link to where a macOS-style theme comes from shows exactly
            // when there is none to pick.
            for (const target of picker.links)
                expect(at(`the link to ${target}`), !!linkTo(page, target), styled.length === 0);

            // Picking writes the key; the key moving moves the row. With a
            // single theme installed there is nothing to pick between.
            if (offered.length > 1) {
                const other = offered.findIndex(name => name !== settings.get_string(picker.key));
                row.selected = other;
                expect(at('the key after picking an entry'), settings.get_string(picker.key), offered[other]);
                const back = other === 0 ? 1 : 0;
                settings.set_string(picker.key, offered[back]);
                expect(at('the row after the key changed elsewhere'), row.selected, back);
            }
            settings.set_string(picker.key, 'Gone-Theme');
            expect(at('the row names a theme that is not installed'),
                labelsOf(row)[row.selected], 'Gone-Theme (not installed)');
            if (offered.length > 0) {
                settings.set_string(picker.key, offered[0]);
                expect(at('the row when it comes back'), row.selected, 0);
            }

            // 2. Nothing installed anywhere: nothing offered but the theme in
            // use, marked as missing, and the way to get one is shown.
            settings.set_string(picker.key, 'Adwaita');
            page = pageWith([emptyDir]);
            row = rowOf(page, picker);
            expect(at('with no themes installed'), labelsOf(row), ['Adwaita (not installed)']);
            for (const target of picker.links)
                expect(at(`the link to ${target} with no themes installed`), !!linkTo(page, target), true);
            settings.reset(picker.key);
        }

        // 3. The runner's fixtures, whose names and layout are known.
        if (fixtures) {
            const dirs = preferences._themeDirs();
            for (const wanted of [`${fixtures}/data/icons`, `${fixtures}/home/.icons`, `${fixtures}/share/icons`])
                expect('the directories scanned include the fixtures\' ' + wanted, dirs.includes(wanted), true);

            const [icons, cursors] = pickers;
            const iconsPage = pageWith();
            const iconNames = labelsOf(rowOf(iconsPage, icons));
            const cursorNames = labelsOf(rowOf(pageWith(), cursors));

            // The fixtures, in the order they must come: macOS-style first.
            // Each name is in two places or reached by a link, and is found
            // once. WhiteSur-Test has icons and cursors both.
            const iconFixtures = ['MacTahoe-Test', 'WhiteSur-Test', 'Alpha-Icons', 'Linked-Icons', 'Zeta-Icons'];
            const cursorFixtures = ['macOS-Test', 'WhiteSur-Test', 'Alpha-Cursors', 'Plain-Cursors'];
            const fixtureNames = [...new Set([...iconFixtures, ...cursorFixtures, 'Hidden-Icons'])];
            expect('icon themes found, macOS-style first',
                iconNames.filter(name => fixtureNames.includes(name)), iconFixtures);
            expect('cursor themes found, macOS-style first',
                cursorNames.filter(name => fixtureNames.includes(name)), cursorFixtures);

            // Nothing to point to once a macOS-style theme is installed.
            for (const target of [...icons.links, ...cursors.links])
                expect(`the link to ${target} with its theme installed`, !!linkTo(iconsPage, target), false);

            // A hidden theme is still shown while it is the one in use.
            settings.set_string('icon-theme', 'Hidden-Icons');
            const hiddenRow = rowOf(pageWith(), icons);
            expect('the hidden theme in use', labelsOf(hiddenRow)[hiddenRow.selected], 'Hidden-Icons');
            settings.reset('icon-theme');

            // Picking one of the fixtures writes it.
            const row = rowOf(iconsPage, icons);
            row.selected = iconNames.indexOf('MacTahoe-Test');
            expect('the icon theme after picking MacTahoe-Test', settings.get_string('icon-theme'), 'MacTahoe-Test');
            settings.reset('icon-theme');
        }
    }

    GLib.rmdir(emptyDir);

    if (problems.length === problemsBefore)
        print(`  themes: icon and cursor pickers list what is installed${fixtures ? ', fixtures included,' : ''} and write their keys`);
}

// The switcher along the bottom gives each page an equal share of the window's
// width, and cuts a label that does not fit: at 680 wide "Custom Menus" had
// already become "Custom Me…" with eight pages. The window is opened at the size
// fillPreferencesWindow asks for and every label has to be whole. The font is
// this release's default, since that is what the window is drawn in.
{
    const problemsBefore = problems.length;
    const sized = new Adw.PreferencesWindow();
    await new Preferences(metadata).fillPreferencesWindow(sized);
    sized.present();
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

    const inSwitcher = widget => {
        for (let parent = widget.get_parent(); parent; parent = parent.get_parent()) {
            if (parent.get_css_name() === 'viewswitcher')
                return true;
        }
        return false;
    };
    const labels = [];
    const collect = widget => {
        if (widget instanceof Gtk.Label && widget.get_mapped() && inSwitcher(widget))
            labels.push(widget);
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
            collect(child);
    };
    collect(sized);

    const shown = labels.map(label => label.get_label());
    if (shown.join(', ') !== titles.join(', '))
        problems.push(`switcher: the labels on show are ${shown.join(', ')}, expected ${titles.join(', ')}`);
    for (const label of labels) {
        if (label.get_layout().is_ellipsized())
            problems.push(`switcher: "${label.get_label()}" is cut at ${sized.get_width()} wide`);
    }
    sized.destroy();

    if (problems.length === problemsBefore)
        print(`  switcher: all ${labels.length} page labels fit at the default width`);
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

// The Window Keys group: Cmd+M and Cmd+D are shortcut sets, the tiling keys a
// switch that refills only what is empty. Each is driven through a second
// preferences object after the first, as after the window was reopened, and
// must hand the user's own values back. Settings live in memory here.
{
    const WM = 'org.gnome.desktop.wm.keybindings';
    const MUTTER = 'org.gnome.mutter.keybindings';
    const SHELL = 'org.gnome.shell.keybindings';
    const wm = preferences._settingsForSchema(WM);
    const mutter = preferences._settingsForSchema(MUTTER);
    const shell = preferences._settingsForSchema(SHELL);
    const pearUp = preferences.getSettings();
    const problemsBefore = problems.length;
    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`window keys: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };

    if (!wm || !mutter || !shell || !preferences._schemaHasKey(shell, 'toggle-message-tray') ||
        !preferences._schemaHasKey(mutter, 'toggle-tiled-left')) {
        print('  window keys: skipped, the GNOME keybinding schemas are not complete here');
    } else {
        const kept = [];
        const rowOf = (type, title) => {
            const page = new Preferences(metadata)._buildKeyboardPage();
            kept.push(page);
            return findWidget(page, widget => widget instanceof type && widget.title === title);
        };
        const reset = () => {
            for (const [settings, key] of [[wm, 'minimize'], [wm, 'show-desktop'], [wm, 'maximize'],
                [wm, 'unmaximize'], [mutter, 'toggle-tiled-left'], [mutter, 'toggle-tiled-right'],
                [shell, 'toggle-message-tray']])
                settings.reset(key);
            pearUp.reset('displaced-keybindings');
            pearUp.reset('displaced-settings');
        };

        // Cmd+M: minimize gains it, the tray loses only it, and off puts both back.
        reset();
        wm.set_strv('minimize', ['<Super>h']);
        shell.set_strv('toggle-message-tray', ['<Super>v', '<Super>m', '<Super>n']);
        let row = rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes');
        expect('Cmd+M row before', row.enable_expansion, false);
        row.enable_expansion = true;
        expect('minimize on', wm.get_strv('minimize'), ['<Super>h', '<Super>m']);
        expect('tray on', shell.get_strv('toggle-message-tray'), ['<Super>v', '<Super>n']);
        row = rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes');
        expect('Cmd+M row reopened', row.enable_expansion, true);
        row.enable_expansion = false;
        expect('minimize off', wm.get_strv('minimize'), ['<Super>h']);
        expect('tray off', shell.get_strv('toggle-message-tray'), ['<Super>v', '<Super>m', '<Super>n']);
        expect('keybinding notes after Cmd+M', pearUp.get_string('displaced-keybindings'), '{}');

        // Already set by hand, as on framy: reads on, off goes back to GNOME's own.
        reset();
        wm.set_strv('minimize', ['<Super>h', '<Super>m']);
        shell.set_strv('toggle-message-tray', ['<Super>v']);
        row = rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes');
        expect('Cmd+M row set by hand', row.enable_expansion, true);
        row.enable_expansion = false;
        expect('minimize off after hand-set', wm.get_strv('minimize'), ['<Super>h']);
        expect('tray off after hand-set', shell.get_strv('toggle-message-tray').includes('<Super>m'), true);

        // Super+M in minimize while the tray still holds it, as the old window
        // set left it: Cmd+M does not minimize yet, so the row reads off, and
        // switching it on takes Super+M from the tray without adding it twice.
        reset();
        wm.set_strv('minimize', ['<Super>h', '<Super>m']);
        shell.set_strv('toggle-message-tray', ['<Super>v', '<Super>m']);
        row = rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes');
        expect('Cmd+M row while the tray holds it', row.enable_expansion, false);
        row.enable_expansion = true;
        expect('minimize on over the old set', wm.get_strv('minimize'), ['<Super>h', '<Super>m']);
        expect('tray on over the old set', shell.get_strv('toggle-message-tray'), ['<Super>v']);

        // Cmd+M has one owner. The macOS Window Shortcuts set no longer lists
        // it, and switching that set off leaves Cmd+M Minimizes and its Super+M
        // alone; switching Cmd+M off then leaves the set on.
        const WINDOW_SET = 'macOS Window Shortcuts';
        const media = preferences._settingsForSchema('org.gnome.settings-daemon.plugins.media-keys');
        const windowSetKeys = [[wm, 'close'], [wm, 'toggle-fullscreen'],
            [shell, 'toggle-overview'], [pearUp, 'quit-app']];
        if (media && preferences._schemaHasKey(media, 'screensaver'))
            windowSetKeys.push([media, 'screensaver']);
        reset();
        for (const [settings, key] of windowSetKeys)
            settings.reset(key);
        row = rowOf(Adw.ExpanderRow, WINDOW_SET);
        const listed = [];
        findWidget(row, widget => {
            if (widget instanceof Adw.ActionRow && widget !== row)
                listed.push(`${widget.title} ${widget.subtitle}`);
            return false;
        });
        expect('window set lists Cmd+M', listed.some(title => /Cmd\+M|Super\+M/i.test(title)), false);
        row.enable_expansion = true;
        expect('minimize after the window set alone', wm.get_strv('minimize').includes('<Super>m'), false);
        rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes').enable_expansion = true;
        expect('minimize with both on', wm.get_strv('minimize').filter(a => a === '<Super>m').length, 1);
        rowOf(Adw.ExpanderRow, WINDOW_SET).enable_expansion = false;
        expect('minimize after the window set goes off', wm.get_strv('minimize').includes('<Super>m'), true);
        expect('Cmd+M row after the window set goes off',
            rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes').enable_expansion, true);
        expect('tray after the window set goes off',
            shell.get_strv('toggle-message-tray').includes('<Super>m'), false);
        rowOf(Adw.ExpanderRow, WINDOW_SET).enable_expansion = true;
        rowOf(Adw.ExpanderRow, 'Cmd+M Minimizes').enable_expansion = false;
        expect('minimize after Cmd+M goes off', wm.get_strv('minimize').includes('<Super>m'), false);
        expect('window set after Cmd+M goes off', rowOf(Adw.ExpanderRow, WINDOW_SET).enable_expansion, true);
        rowOf(Adw.ExpanderRow, WINDOW_SET).enable_expansion = false;
        for (const [settings, key] of windowSetKeys)
            settings.reset(key);

        // Cmd+D
        reset();
        wm.set_strv('show-desktop', []);
        row = rowOf(Adw.ExpanderRow, 'Cmd+D Shows the Desktop');
        expect('Cmd+D row before', row.enable_expansion, false);
        row.enable_expansion = true;
        expect('show-desktop on', wm.get_strv('show-desktop'), ['<Super>d']);
        rowOf(Adw.ExpanderRow, 'Cmd+D Shows the Desktop').enable_expansion = false;
        expect('show-desktop off', wm.get_strv('show-desktop'), []);
        wm.set_strv('show-desktop', ['<Super>d']);
        expect('Cmd+D row set by hand', rowOf(Adw.ExpanderRow, 'Cmd+D Shows the Desktop').enable_expansion, true);

        // Tiling keys: emptied ones refilled, a key the user filled is not touched.
        const TILING = 'Restore GNOME Window Keys';
        const state = () => [wm.get_strv('maximize'), wm.get_strv('unmaximize'),
            mutter.get_strv('toggle-tiled-left'), mutter.get_strv('toggle-tiled-right')];
        reset();
        wm.set_strv('maximize', []);
        wm.set_strv('unmaximize', []);
        mutter.set_strv('toggle-tiled-left', []);
        mutter.set_strv('toggle-tiled-right', ['<Super>Right', '<Alt>r']);
        row = rowOf(Adw.SwitchRow, TILING);
        expect('tiling switch while emptied', row.active, false);
        row.active = true;
        expect('tiling keys refilled', state(), [['<Super>Up'], ['<Super>Down', '<Alt>F5'],
            ['<Super>Left'], ['<Super>Right', '<Alt>r']]);
        row = rowOf(Adw.SwitchRow, TILING);
        expect('tiling switch reopened', row.active, true);
        row.active = false;
        expect('tiling keys handed back', state(), [[], [], [], ['<Super>Right', '<Alt>r']]);
        expect('settings notes after tiling', pearUp.get_string('displaced-settings'), '{}');

        // Filled by hand already reads on and is left alone when switched off.
        wm.set_strv('maximize', ['<Super>Up']);
        wm.set_strv('unmaximize', ['<Super>Down', '<Alt>F5']);
        mutter.set_strv('toggle-tiled-left', ['<Super>Left']);
        mutter.set_strv('toggle-tiled-right', ['<Super>Right']);
        row = rowOf(Adw.SwitchRow, TILING);
        expect('tiling switch set by hand', row.active, true);
        row.active = false;
        expect('tiling keys set by hand stay', state(), [['<Super>Up'], ['<Super>Down', '<Alt>F5'],
            ['<Super>Left'], ['<Super>Right']]);

        reset();
        if (problems.length === problemsBefore)
            print('  window keys: Cmd+M, Cmd+D and the tiling keys set, read back and restore; Cmd+M has one owner');
    }
}

// The Windows page drives GNOME's window settings, the user's gtk.css files and
// two other extensions. As with Appearance, the checks that matter are what is
// written and what is handed back; run here the settings land in the in-memory
// backend and the files in a directory the runner made, so it is safe to drive.
const BUTTON_LAYOUT_LEFT = 'close,minimize,maximize:appmenu';
const BUTTON_LAYOUT_RIGHT = 'appmenu:minimize,maximize,close';
const BLOCK_BEGIN = '/* >>> pear-up window buttons >>> */';
const BLOCK_END = '/* <<< pear-up window buttons <<< */';
const ROUNDED_UUID = 'rounded-window-corners@fxgn';
const ROUNDED_SCHEMA = 'org.gnome.shell.extensions.rounded-window-corners-reborn';
const ROUNDED_KEY = 'global-rounded-corner-settings';
const LAMP_UUID = 'compiz-alike-magic-lamp-effect@hermes83.github.com';

// The page and the row in it, from a preferences object of its own, which as far
// as anything held in memory goes is a window opened afresh.
const windowsKept = [];
const windowsPageOf = prefs => {
    const page = prefs._buildWindowsPage();
    windowsKept.push(page);
    return page;
};
const windowsSwitch = (page, title) =>
    findWidget(page, widget => widget instanceof Adw.SwitchRow && widget.title === title);
const windowsExpecter = label => (what, got, wanted) => {
    if (JSON.stringify(got) !== JSON.stringify(wanted))
        problems.push(`${label}: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
};

// The buttons moved here from General: same row, same behaviour.
{
    const wm = preferences._settingsForSchema('org.gnome.desktop.wm.preferences');
    const problemsBefore = problems.length;
    const expect = windowsExpecter('window buttons');
    const TITLE = 'Window Buttons on the Left';

    const general = pages.find(page => page.title === 'General');
    expect('the row still on the General page', !!windowsSwitch(general, TITLE), false);

    wm.set_string('button-layout', BUTTON_LAYOUT_RIGHT);
    const row = windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE);
    if (!row) {
        problems.push('window buttons: the Windows page has no Window Buttons on the Left row');
    } else {
        expect('the switch with the buttons on the right', row.active, false);
        row.active = true;
        expect('button-layout after switching on', wm.get_string('button-layout'), BUTTON_LAYOUT_LEFT);
        row.active = false;
        expect('button-layout after switching off', wm.get_string('button-layout'), BUTTON_LAYOUT_RIGHT);
        wm.set_string('button-layout', BUTTON_LAYOUT_LEFT);
        expect('the switch after the layout changed elsewhere', row.active, true);
        wm.set_string('button-layout', 'appmenu:close');
        expect('the switch after the buttons went back to the right', row.active, false);
        expect('the switch reading a layout set by hand',
            windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE).active, false);
    }
    wm.reset('button-layout');

    if (problems.length === problemsBefore)
        print('  window buttons: the switch moved to the Windows page and writes the same layouts');
}

// Auto-maximize is a GNOME setting like the Appearance ones, so it has to hand
// back what it replaced: the user's own value, or none at all.
{
    const mutter = preferences._settingsForSchema('org.gnome.mutter');
    const pearUp = preferences.getSettings();
    const problemsBefore = problems.length;
    const expect = windowsExpecter('auto-maximize');
    const TITLE = 'Don’t Maximize New Windows';
    const KEY = 'auto-maximize';
    const userValue = () => mutter.get_user_value(KEY)?.unpack() ?? null;
    const rowOf = () => windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE);

    if (!preferences._schemaHasKey(mutter, KEY)) {
        expect('the row on a mutter without the key', !!rowOf(), false);
    } else {
        // GNOME maximizes by default, which is the thing being switched off.
        expect('the key\'s default', mutter.get_default_value(KEY).unpack(), true);

        // Set to true by the user: it comes back as set, not as unset.
        mutter.set_boolean(KEY, true);
        pearUp.reset('displaced-settings');
        let row = rowOf();
        expect('the switch while GNOME maximizes', row.active, false);
        row.active = true;
        expect('auto-maximize after switching on', mutter.get_boolean(KEY), false);
        row = rowOf();
        expect('the switch after reopening', row.active, true);
        row.active = false;
        expect('the user\'s value after switching off', userValue(), true);
        expect('the notes once handed back', pearUp.get_string('displaced-settings'), '{}');

        // At its default: back to the default, not to a copy of it.
        mutter.reset(KEY);
        pearUp.reset('displaced-settings');
        row = rowOf();
        row.active = true;
        expect('auto-maximize from the default', mutter.get_boolean(KEY), false);
        rowOf().active = false;
        expect('the user\'s value after switching off, back to the default', userValue(), null);

        // Already off, set by hand before this switch existed: it reads on, and
        // the default is the only thing there is to go back to.
        mutter.set_boolean(KEY, false);
        pearUp.reset('displaced-settings');
        row = rowOf();
        expect('the switch when GNOME already leaves windows alone', row.active, true);
        row.active = false;
        expect('the user\'s value after switching off what was set by hand', userValue(), null);

        // It follows the key when something else changes it.
        mutter.set_boolean(KEY, false);
        row = rowOf();
        mutter.set_boolean(KEY, true);
        expect('the switch after auto-maximize changed elsewhere', row.active, false);
        mutter.reset(KEY);
    }

    if (problems.length === problemsBefore)
        print('  auto-maximize: the switch writes the key and hands the user\'s value back, after a reopen');
}

// Small window buttons are blocks in two files of the user's own. Everything
// that matters is what happens to the rest of those files, so the runner points
// XDG_CONFIG_HOME at a directory of its own and says so; without that nothing
// here writes anything.
const smokeConfig = GLib.getenv('PREFS_SMOKE_CONFIG');
if (!smokeConfig || smokeConfig !== GLib.get_user_config_dir() ||
    !GLib.path_get_basename(smokeConfig).startsWith('pear-up-smoke-')) {
    print('  small window buttons: skipped, the runner has not given this process a config directory of its own');
} else {
    const configDir = GLib.get_user_config_dir();
    const problemsBefore = problems.length;
    const expect = windowsExpecter('small buttons');
    const TITLE = 'Small Window Buttons';

    const path4 = `${configDir}/gtk-4.0/gtk.css`;
    const path3 = `${configDir}/gtk-3.0/gtk.css`;
    // The file as text with a byte order mark kept as U+FEFF, whatever this
    // engine's decoder would do with one; null when there is no file.
    const read = path => {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS) || GLib.file_test(path, GLib.FileTest.IS_DIR))
            return null;
        const bytes = GLib.file_get_contents(path)[1];
        const marked = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const text = new TextDecoder('utf-8').decode(marked ? bytes.subarray(3) : bytes);
        return marked ? `\uFEFF${text}` : text;
    };
    const write = (path, text) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, typeof text === 'string' ? new TextEncoder().encode(text) : text);
    };
    const modified = path => {
        const info = Gio.File.new_for_path(path).query_info('time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE, null);
        return [info.get_attribute_uint64('time::modified'), info.get_attribute_uint32('time::modified-usec')];
    };
    // Starts every case from nothing, in a directory only this test writes in.
    const reset = () => {
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(configDir)}`);
        GLib.mkdir_with_parents(configDir, 0o755);
    };
    const rowOf = (prefs = new Preferences(metadata)) => windowsSwitch(windowsPageOf(prefs), TITLE);
    const lines = text => text.split('\n');
    const blockLines = text => {
        const all = lines(text);
        const first = all.lastIndexOf(BLOCK_BEGIN);
        const last = all.indexOf(BLOCK_END, first);
        return first < 0 || last < 0 ? null : all.slice(first, last + 1);
    };
    // What a file should hold after the block went in: everything the user
    // had, byte for byte, a blank line, then the block. A file that did not end
    // in a newline gets the one it needed.
    const withBlockAfter = (seed, block) =>
        `${seed === '' ? '' : `${seed.endsWith('\n') ? seed : `${seed}\n`}\n`}${block.join('\n')}\n`;
    const terminated = seed => seed === '' || seed.endsWith('\n') ? seed : `${seed}\n`;

    // The block as it has to look, spelt out here and not taken from the code.
    const BLOCK4 = [
        BLOCK_BEGIN,
        '/* Written by Pear Up (Preferences, Windows, Small Window Buttons). Switching',
        '   that off removes this block; nothing outside it is ever touched. */',
        'windowcontrols > button {',
        '  min-width: 14px;',
        '  min-height: 14px;',
        '  padding: 3px;',
        '}',
        'windowcontrols > button > image {',
        '  -gtk-icon-size: 8px;',
        '  padding: 2px;',
        '}',
        BLOCK_END,
    ];
    const BLOCK3 = [
        BLOCK_BEGIN,
        '/* Written by Pear Up (Preferences, Windows, Small Window Buttons). Switching',
        '   that off removes this block; nothing outside it is ever touched. */',
        'headerbar button.titlebutton,',
        '.titlebar button.titlebutton {',
        '  min-width: 14px;',
        '  min-height: 14px;',
        '  padding: 2px;',
        '  margin: 0 1px;',
        '}',
        'headerbar button.titlebutton image,',
        '.titlebar button.titlebutton image {',
        '  -gtk-icon-transform: scale(0.6);',
        '}',
        BLOCK_END,
    ];

    // Neither file nor directory exists: both are made, and each holds the
    // block and nothing else.
    reset();
    let row = rowOf();
    expect('the switch with no files', row.active, false);
    row.active = true;
    expect('gtk-4.0/gtk.css made from nothing', read(path4), `${BLOCK4.join('\n')}\n`);
    expect('gtk-3.0/gtk.css made from nothing', read(path3), `${BLOCK3.join('\n')}\n`);
    expect('the switch after switching on', row.active, true);
    expect('the switch after reopening', rowOf().active, true);
    row.active = false;
    expect('gtk-4.0/gtk.css once switched off', read(path4), '');
    expect('gtk-3.0/gtk.css once switched off', read(path3), '');
    expect('the switch after switching off', rowOf().active, false);

    // The user's own CSS, each in a way a hand-kept file can be: comments and
    // odd spacing, Windows line endings, no final newline, blank lines at the
    // end, a byte order mark, text that is not ASCII, an empty file.
    const seeds = {
        plain: '@define-color accent_bg_color #3584e4;\n\n/* my header */\nheaderbar {\n    background: red;\n}\n\n\n.title { font-weight:   300 }\n',
        crlf: 'a { color: red; }\r\nb { color: blue; }\r\n',
        noNewline: 'a { color: red; }',
        blankEnd: 'a { color: red; }\n\n\n',
        bom: '﻿a { color: red; }\n',
        unicode: '/* Größe – 大きさ */\nlabel { color: green; }\n',
        empty: '',
    };
    for (const [name, seed] of Object.entries(seeds)) {
        const at = what => `${name}: ${what}`;
        reset();
        write(path4, seed);
        write(path3, `${seed}/* gtk 3 */\n`);
        // Files beside them, and in the directory above, are none of its business.
        write(`${configDir}/gtk-4.0/settings.ini`, '[Settings]\ngtk-application-prefer-dark-theme=1\n');
        write(`${configDir}/gtk-3.0/settings.ini`, '[Settings]\ngtk-cursor-theme-size=24\n');
        write(`${configDir}/gtk-4.0/gtk-dark.css`, 'a { color: white; }\n');
        write(`${configDir}/other/app.conf`, 'unrelated\n');
        const bystanders = ['gtk-4.0/settings.ini', 'gtk-3.0/settings.ini', 'gtk-4.0/gtk-dark.css', 'other/app.conf']
            .map(file => [file, read(`${configDir}/${file}`)]);

        row = rowOf();
        expect(at('the switch over a file of the user\'s own'), row.active, false);
        row.active = true;
        const seed3 = `${seed}/* gtk 3 */\n`;
        expect(at('gtk-4.0/gtk.css with the block'), read(path4), withBlockAfter(seed, BLOCK4));
        expect(at('gtk-3.0/gtk.css with the block'), read(path3), withBlockAfter(seed3, BLOCK3));
        expect(at('the switch after switching on'), row.active, true);
        expect(at('one block in the file'), read(path4).split(BLOCK_BEGIN).length - 1, 1);

        // Switching on again, from a window opened afresh, writes nothing.
        const stamps = [modified(path4), modified(path3)];
        const bytes = [read(path4), read(path3)];
        expect(at('the second call'), preferences._setWindowButtons(true), null);
        expect(at('gtk-4.0/gtk.css after switching on twice'), read(path4), bytes[0]);
        expect(at('gtk-3.0/gtk.css after switching on twice'), read(path3), bytes[1]);
        expect(at('the modification times after switching on twice'), [modified(path4), modified(path3)], stamps);

        row.active = false;
        expect(at('gtk-4.0/gtk.css back as it was'), read(path4), terminated(seed));
        expect(at('gtk-3.0/gtk.css back as it was'), read(path3), terminated(seed3));
        expect(at('the switch after switching off'), row.active, false);
        const stampsOff = [modified(path4), modified(path3)];
        expect(at('switching off again'), preferences._setWindowButtons(false), null);
        expect(at('the modification times after switching off twice'), [modified(path4), modified(path3)], stampsOff);
        for (const [file, before] of bystanders)
            expect(at(`${file} through all of it`), read(`${configDir}/${file}`), before);
    }

    // Edited while on: what the user adds around the block stays when it goes.
    reset();
    write(path4, 'a { color: red; }\n');
    write(path3, 'b { color: red; }\n');
    row = rowOf();
    row.active = true;
    write(path4, `/* mine */\nx { top: 1px; }\n${read(path4)}y { bottom: 2px; }\n`);
    row.active = false;
    expect('gtk-4.0/gtk.css with lines added before and after the block',
        read(path4), '/* mine */\nx { top: 1px; }\na { color: red; }\ny { bottom: 2px; }\n');

    // Half a block is not a block: a stray start marker, or a stray end marker,
    // is the user's text and stays, whatever lies between it and a real block.
    reset();
    const strayStart = `a { color: red; }\n${BLOCK_BEGIN}\nb { color: blue; }\n`;
    const strayEnd = `a { color: red; }\n${BLOCK_END}\n`;
    write(path4, strayStart);
    write(path3, strayEnd);
    row = rowOf();
    expect('the switch with half a block in each file', row.active, false);
    row.active = true;
    expect('the real block, after the stray start', blockLines(read(path4)), BLOCK4);
    expect('the stray start is kept', read(path4).startsWith(strayStart), true);
    expect('the real block, after the stray end', blockLines(read(path3)), BLOCK3);
    row.active = false;
    expect('gtk-4.0/gtk.css with a stray start marker', read(path4), strayStart);
    expect('gtk-3.0/gtk.css with a stray end marker', read(path3), strayEnd);

    // The rules framy had written by hand, unmarked: they are the buttons
    // already being small. Nothing is added and nothing removed, the row says
    // so and where, and is greyed out since there is nothing for it to undo.
    reset();
    const hand4 = '/* framy: window buttons 40% smaller. Delete to undo. */\nwindowcontrols > button {\n  min-width: 14px;\n  min-height: 14px;\n  padding: 3px;\n}\nwindowcontrols > button > image {\n  -gtk-icon-size: 8px;\n  padding: 2px;\n}\n';
    const hand3 = '/* framy */\nheaderbar button.titlebutton,\n.titlebar button.titlebutton {\n  min-width: 14px;\n  min-height: 14px;\n  padding: 2px;\n  margin: 0 1px;\n}\nheaderbar button.titlebutton image,\n.titlebar button.titlebutton image {\n  -gtk-icon-transform: scale(0.6);\n}\n';
    write(path4, hand4);
    write(path3, hand3);
    const stampsHand = [modified(path4), modified(path3)];
    row = rowOf();
    expect('the switch over hand-written rules', row.active, true);
    expect('the switch can be used over hand-written rules', row.sensitive, false);
    if (!/your own/i.test(row.subtitle ?? '') || !row.subtitle.includes('gtk-4.0/gtk.css') ||
        !row.subtitle.includes('gtk-3.0/gtk.css'))
        problems.push(`small buttons: the subtitle does not say the rules are the user's own, and where (${row.subtitle})`);
    row.active = false;
    expect('the switch after being switched off over hand-written rules', row.active, true);
    expect('hand-written gtk-4.0/gtk.css left alone', read(path4), hand4);
    expect('hand-written gtk-3.0/gtk.css left alone', read(path3), hand3);
    expect('switching on over hand-written rules', preferences._setWindowButtons(true), null);
    expect('hand-written files untouched', [read(path4), read(path3), ...[modified(path4), modified(path3)]],
        [hand4, hand3, ...stampsHand]);

    // Rules of the user's own in one file only: the other gets the block, and
    // switching it off takes that away and leaves the user's.
    reset();
    write(path4, hand4);
    row = rowOf();
    expect('the switch with hand-written rules in one file', row.active, false);
    row.active = true;
    expect('the file with hand-written rules', read(path4), hand4);
    expect('the file without', read(path3), `${BLOCK3.join('\n')}\n`);
    expect('the switch once switched on', [row.active, row.sensitive], [true, true]);
    if (!/your own rules/i.test(row.subtitle ?? '') || !row.subtitle.includes('gtk-4.0/gtk.css'))
        problems.push(`small buttons: the subtitle does not mention the hand-written rules (${row.subtitle})`);
    row.active = false;
    expect('the file with hand-written rules, switched off', read(path4), hand4);
    expect('the file without, switched off', read(path3), '');
    expect('the switch once switched off', row.active, false);

    // Rules of the user's own in the same file as the block: only the block goes.
    reset();
    write(path4, hand4);
    write(path3, 'a { color: red; }\n');
    preferences._setWindowButtons(true);
    write(path4, `${hand4}\n${BLOCK4.join('\n')}\n`);
    preferences._setWindowButtons(false);
    expect('hand-written rules next to the block', read(path4), hand4);

    // A mention in a comment is not a rule.
    reset();
    const mention = '/* try: windowcontrols > button { min-width: 14px; padding: 3px; } */\n';
    write(path4, mention);
    expect('the switch over a commented-out rule', rowOf().active, false);
    rowOf().active = true;
    expect('a commented-out rule does not count', blockLines(read(path4)), BLOCK4);

    // A symlink, as a dotfile manager leaves: the file it points to changes and
    // the link stays a link.
    reset();
    write(`${configDir}/dotfiles/gtk4.css`, 'a { color: red; }\n');
    GLib.mkdir_with_parents(`${configDir}/gtk-4.0`, 0o755);
    Gio.File.new_for_path(path4).make_symbolic_link(`${configDir}/dotfiles/gtk4.css`, null);
    rowOf().active = true;
    expect('the link is still a link', GLib.file_test(path4, GLib.FileTest.IS_SYMLINK), true);
    expect('the file the link points to', read(`${configDir}/dotfiles/gtk4.css`),
        withBlockAfter('a { color: red; }\n', BLOCK4));
    rowOf().active = false;
    expect('the file the link points to, switched off', read(`${configDir}/dotfiles/gtk4.css`), 'a { color: red; }\n');
    expect('the link, switched off', GLib.file_test(path4, GLib.FileTest.IS_SYMLINK), true);

    // A file Pear Up cannot hand back unchanged is left alone, and so is the
    // other: nothing is written until every file has been read. The bad one is
    // the second to be read, so a write made before the last read would show.
    reset();
    const notText = new Uint8Array([0x61, 0x20, 0xff, 0xfe, 0x7b, 0x7d, 0x0a]);
    write(path4, 'a { color: red; }\n');
    write(path3, notText);
    row = rowOf();
    row.active = true;
    expect('the switch with a file in another encoding', row.active, false);
    if (!/utf-8/i.test(row.subtitle ?? '') || !row.subtitle.includes('gtk-3.0/gtk.css'))
        problems.push(`small buttons: the subtitle does not say why (${row.subtitle})`);
    expect('the file in another encoding', Array.from(GLib.file_get_contents(path3)[1]), Array.from(notText));
    expect('the other file, which waited', read(path4), 'a { color: red; }\n');
    // Switched off, the same.
    expect('switching off with a file in another encoding', preferences._setWindowButtons(false) !== null, true);
    expect('the file in another encoding, switched off', Array.from(GLib.file_get_contents(path3)[1]), Array.from(notText));

    // A decoder that changes what it reads cannot be trusted with a file that is
    // written back whole: the text is encoded again and must be the bytes read.
    reset();
    write(path4, 'a { color: red; }\r\nb { color: blue; }\r\n');
    const lossy = (() => {
        const prefs = new Preferences(metadata);
        prefs._decodeUtf8 = bytes => new TextDecoder('utf-8').decode(bytes).replace(/\r/g, '');
        return prefs._setWindowButtons(true);
    })();
    if (!/exactly/.test(lossy ?? ''))
        problems.push(`small buttons: a file read back changed was not refused (${lossy})`);
    expect('a file the decoder would have changed', read(path4), 'a { color: red; }\r\nb { color: blue; }\r\n');
    expect('the other file, which waited for it', read(path3), null);

    // A directory where the file should be.
    reset();
    write(path3, 'b { color: red; }\n');
    GLib.mkdir_with_parents(path4, 0o755);
    row = rowOf();
    row.active = true;
    expect('the switch over a directory', row.active, false);
    expect('the other file, beside a directory', read(path3), 'b { color: red; }\n');
    if (!/^Could not/.test(row.subtitle ?? ''))
        problems.push(`small buttons: the subtitle does not say it failed (${row.subtitle})`);

    // A write that fails half way puts back what was written: both files change
    // or neither does, also when one of them did not exist.
    const failingPrefs = failOn => {
        const prefs = new Preferences(metadata);
        const write = prefs._writeStylesheet.bind(prefs);
        prefs._writeStylesheet = (path, text) => {
            if (path === failOn)
                throw new Error('disk full');
            write(path, text);
        };
        prefs.attempts = 0;
        const set = prefs._setWindowButtons.bind(prefs);
        prefs._setWindowButtons = on => {
            prefs.attempts++;
            return set(on);
        };
        return prefs;
    };
    reset();
    write(path4, 'a { color: red; }\n');
    let failing = failingPrefs(path3);
    row = rowOf(failing);
    row.active = true;
    expect('the file written first, when the second could not be', read(path4), 'a { color: red; }\n');
    expect('the file that did not exist, when it could not be written', read(path3), null);
    expect('the switch when the second file could not be written', row.active, false);
    if (!/^Could not write .*gtk-3\.0\/gtk\.css: disk full/.test(row.subtitle ?? ''))
        problems.push(`small buttons: the subtitle does not say what failed (${row.subtitle})`);
    // The row putting itself back is not the user switching it off again.
    expect('attempts made while the switch put itself back', failing.attempts, 1);

    reset();
    write(path3, 'b { color: red; }\n');
    preferences._setWindowButtons(true);
    const withBlocks = [read(path4), read(path3)];
    failing = failingPrefs(path3);
    row = rowOf(failing);
    expect('the switch with the blocks in', row.active, true);
    row.active = false;
    expect('the files when taking the blocks out failed half way', [read(path4), read(path3)], withBlocks);
    expect('the switch when taking the blocks out failed', row.active, true);
    expect('attempts made while the switch put itself back, switching off', failing.attempts, 1);

    reset();
    if (problems.length === problemsBefore)
        print('  small window buttons: the block goes in and out of both files, touching nothing else');
}

// Opening and closing like macOS is Pear Up's own key, off by default, and the
// switch writes it and follows it.
{
    const pearUp = preferences.getSettings();
    const problemsBefore = problems.length;
    const expect = windowsExpecter('window animations');
    const TITLE = 'Open and Close Like macOS';
    const KEY = 'macos-window-animations';
    const row = windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE);
    if (!row) {
        problems.push(`window animations: the Windows page has no "${TITLE}" switch`);
    } else {
        expect('the default', pearUp.get_default_value(KEY).unpack(), false);
        expect('the switch at first', row.active, false);
        row.active = true;
        expect(`${KEY} after switching on`, pearUp.get_boolean(KEY), true);
        pearUp.set_boolean(KEY, false);
        expect('the switch after an outside change', row.active, false);
    }
    pearUp.reset(KEY);
    if (problems.length === problemsBefore)
        print('  window animations: off by default, the switch writes and follows its key');
}

// The extensions the Windows page drives, installed or not. Whether they are is
// whatever the runner arranged: with PREFS_SMOKE_HELPERS it has put both where
// GNOME looks, one in the user's data directory and one in a system one.
{
    const helpers = GLib.getenv('PREFS_SMOKE_HELPERS');
    const problemsBefore = problems.length;
    const expect = windowsExpecter('extensions');
    const ROUNDED_URL = 'extensions.gnome.org/extension/7048/rounded-window-corners-reborn/';
    const LAMP_URL = 'extensions.gnome.org/extension/3740/compiz-alike-magic-lamp-effect/';
    const ROUNDED_ROW = 'Rounded Corners';
    const RADIUS_ROW = 'Corner Radius';
    const LAMP_ROW = 'Genie Effect';

    const shell = preferences._settingsForSchema('org.gnome.shell');
    const linkTo = (page, target) => findWidget(page, widget =>
        widget instanceof Gtk.LinkButton && widget.uri.endsWith(target));
    const radiusRowOf = page => findWidget(page, widget =>
        widget instanceof Adw.ActionRow && widget.title === RADIUS_ROW);
    const scaleOf = row => findWidget(row, widget => widget instanceof Gtk.Scale);

    if (!helpers) {
        // Neither is installed: the links, and nothing that would do anything.
        const page = windowsPageOf(new Preferences(metadata));
        expect('the rounded corners switch without the extension', !!windowsSwitch(page, ROUNDED_ROW), false);
        expect('the radius without the extension', !!radiusRowOf(page), false);
        expect('the genie switch without the extension', !!windowsSwitch(page, LAMP_ROW), false);
        expect('the link to Rounded Window Corners Reborn', !!linkTo(page, ROUNDED_URL), true);
        expect('the link to Magic Lamp', !!linkTo(page, LAMP_URL), true);
        expect('both links, in full', [
            linkTo(page, ROUNDED_URL)?.uri, linkTo(page, LAMP_URL)?.uri,
        ], [`https://${ROUNDED_URL}`, `https://${LAMP_URL}`]);
        if (problems.length === problemsBefore)
            print('  extensions: neither installed, so both show where to get them and nothing else');
    } else {
        // Both installed: no links, and the rows work through the shell.
        expect('the fixture directories are the ones GNOME would search', [
            preferences._extensionInstalled(ROUNDED_UUID), preferences._extensionInstalled(LAMP_UUID),
            preferences._extensionInstalled('nothing@nowhere'),
        ], [true, true, false]);
        const page = windowsPageOf(new Preferences(metadata));
        expect('the link to Rounded Window Corners Reborn once installed', !!linkTo(page, ROUNDED_URL), false);
        expect('the link to Magic Lamp once installed', !!linkTo(page, LAMP_URL), false);

        // The shell, as far as these rows can tell: the two methods the Extensions
        // app calls, doing what the shell's own enableExtension and
        // disableExtension do to the two lists, for the extensions it knows.
        const calls = [];
        const fakeShell = (known = [ROUNDED_UUID, LAMP_UUID]) => (method, uuid) => {
            calls.push([method, uuid]);
            if (!known.includes(uuid))
                return Promise.resolve(false);
            const enabled = shell.get_strv('enabled-extensions').filter(item => item !== uuid);
            const disabled = shell.get_strv('disabled-extensions').filter(item => item !== uuid);
            if (method === 'EnableExtension') {
                shell.set_strv('disabled-extensions', disabled);
                shell.set_strv('enabled-extensions', [...enabled, uuid]);
            } else {
                shell.set_strv('enabled-extensions', enabled);
                shell.set_strv('disabled-extensions', [...disabled, uuid]);
            }
            return Promise.resolve(true);
        };
        const prefsWithShell = fake => {
            const fresh = new Preferences(metadata);
            fresh._callShellExtensions = fake ?? fakeShell();
            return fresh;
        };
        // The answers arrive in later turns of the loop.
        const settle = async () => {
            for (let turn = 0; turn < 8; turn++)
                await null;
        };
        const resetShell = () => {
            shell.reset('enabled-extensions');
            shell.reset('disabled-extensions');
            shell.reset('disable-user-extensions');
            calls.length = 0;
        };
        const lamp = prefs => windowsSwitch(windowsPageOf(prefs), LAMP_ROW);

        resetShell();
        shell.set_strv('enabled-extensions', ['other@elsewhere']);
        let row = lamp(prefsWithShell());
        const subtitle = row.subtitle;
        expect('the genie switch with the extension off', [row.active, row.sensitive], [false, true]);
        row.active = true;
        await settle();
        expect('the call made to switch it on', calls, [['EnableExtension', LAMP_UUID]]);
        expect('enabled-extensions after switching on', shell.get_strv('enabled-extensions'), ['other@elsewhere', LAMP_UUID]);
        expect('the genie switch after switching on', [row.active, row.subtitle], [true, subtitle]);
        expect('the genie switch after reopening', lamp(prefsWithShell()).active, true);

        // Off goes through the shell too, which also puts it in the list that
        // beats the other, so that a system-wide default cannot bring it back.
        row.active = false;
        await settle();
        expect('the call made to switch it off', calls.at(-1), ['DisableExtension', LAMP_UUID]);
        expect('enabled-extensions after switching off', shell.get_strv('enabled-extensions'), ['other@elsewhere']);
        expect('disabled-extensions after switching off', shell.get_strv('disabled-extensions'), [LAMP_UUID]);
        expect('the genie switch after switching off', lamp(prefsWithShell()).active, false);
        row.active = true;
        await settle();
        expect('disabled-extensions after switching on again', shell.get_strv('disabled-extensions'), []);

        // A uuid in both lists is off: the shell lets the second win.
        shell.set_strv('enabled-extensions', [LAMP_UUID]);
        shell.set_strv('disabled-extensions', [LAMP_UUID]);
        expect('the genie switch with the uuid in both lists', lamp(prefsWithShell()).active, false);

        // Extensions switched off as a whole: nothing here can switch one on.
        resetShell();
        shell.set_strv('enabled-extensions', [LAMP_UUID]);
        row = lamp(prefsWithShell());
        expect('the genie switch with the extension on', row.active, true);
        shell.set_boolean('disable-user-extensions', true);
        expect('the genie switch with extensions switched off', [row.active, row.sensitive], [false, false]);
        if (!/switched off/.test(row.subtitle))
            problems.push(`extensions: the subtitle does not say extensions are switched off (${row.subtitle})`);
        shell.set_boolean('disable-user-extensions', false);
        expect('the genie switch with extensions switched on again', [row.active, row.sensitive], [true, true]);

        // It follows the keys when they change elsewhere, without a call.
        calls.length = 0;
        shell.set_strv('enabled-extensions', []);
        expect('the genie switch after the extension was switched off elsewhere', row.active, false);
        shell.set_strv('enabled-extensions', [LAMP_UUID]);
        expect('the genie switch after it was switched on elsewhere', row.active, true);
        expect('calls made for changes made elsewhere', calls, []);

        // While the shell is working on a call, its half-written lists are not
        // the answer: the switch stays as the user left it.
        resetShell();
        let release;
        row = lamp(prefsWithShell((method, uuid) => {
            calls.push([method, uuid]);
            return new Promise(resolve => {
                release = () => {
                    shell.set_strv('disabled-extensions', []);
                    shell.set_strv('enabled-extensions', [uuid]);
                    resolve(true);
                };
            });
        }));
        row.active = true;
        shell.set_strv('disabled-extensions', ['unrelated@elsewhere']);
        expect('the genie switch while the shell is still working', row.active, true);
        release();
        await settle();
        expect('the genie switch once the shell has finished', row.active, true);

        // Flipped back before the shell has answered: two requests, in order,
        // and the switch shows the last while the first is answered.
        resetShell();
        const queue = [];
        row = lamp(prefsWithShell((method, uuid) =>
            new Promise(resolve => queue.push(() => resolve(fakeShell()(method, uuid))))));
        row.active = true;
        row.active = false;
        expect('requests made before the shell answered', queue.length, 2);
        queue[0]?.();
        await settle();
        expect('the genie switch when only the first request is answered', row.active, false);
        queue[1]?.();
        await settle();
        expect('the calls made, in order', calls, [['EnableExtension', LAMP_UUID], ['DisableExtension', LAMP_UUID]]);
        expect('the genie switch when both are answered', row.active, false);
        expect('disabled-extensions when both are answered', shell.get_strv('disabled-extensions'), [LAMP_UUID]);

        // A shell that does not know the extension, as when it was installed
        // after login: the switch goes back and says what to do.
        resetShell();
        row = lamp(prefsWithShell(fakeShell([])));
        row.active = true;
        await settle();
        expect('the genie switch for an extension the shell has not loaded', row.active, false);
        expect('calls made for an extension the shell has not loaded, putting the switch back asks nothing more',
            calls, [['EnableExtension', LAMP_UUID]]);
        expect('the lists for an extension the shell has not loaded',
            [shell.get_strv('enabled-extensions'), shell.get_strv('disabled-extensions')], [[], []]);
        if (!/log out/i.test(row.subtitle))
            problems.push(`extensions: the subtitle does not say to log out and in (${row.subtitle})`);

        // No shell to ask, or one that refuses: the same.
        resetShell();
        let refused = 0;
        const refusing = prefsWithShell(() => {
            refused++;
            return Promise.reject(new Error('no bus'));
        });
        row = lamp(refusing);
        row.active = true;
        await settle();
        expect('the genie switch with no shell to ask', row.active, false);
        expect('calls made with no shell to ask', refused, 1);
        if (!/no bus/.test(row.subtitle))
            problems.push(`extensions: the subtitle does not say what went wrong (${row.subtitle})`);
        // ...and a later try that works clears it.
        refusing._callShellExtensions = fakeShell();
        row.active = true;
        await settle();
        expect('the genie switch once the shell answers', [row.active, row.subtitle], [true, subtitle]);

        // The radius: one entry of the extension's dictionary, the others kept.
        resetShell();
        const rounded = preferences._settingsForSchema(ROUNDED_SCHEMA);
        const dictOf = () => {
            const value = rounded.get_value(ROUNDED_KEY);
            return Array.from({ length: value.n_children() }, (_, index) => {
                const entry = value.get_child_value(index);
                const inner = entry.get_child_value(1).get_variant();
                return [entry.get_child_value(0).get_string()[0], inner.get_type_string(), inner.print(true)];
            });
        };
        const others = () => dictOf().filter(([name]) => name !== 'borderRadius');
        const radiusOf = () => dictOf().find(([name]) => name === 'borderRadius');

        if (!rounded) {
            problems.push('extensions: the Rounded Window Corners Reborn schema was not found in its directory');
        } else {
            rounded.reset(ROUNDED_KEY);
            const untouched = dictOf();
            expect('the dictionary at first', untouched.map(([name]) => name),
                ['padding', 'keepRoundedCorners', 'borderRadius', 'smoothing', 'borderColor', 'enabled']);
            const roundedRow = prefs => windowsSwitch(windowsPageOf(prefs), ROUNDED_ROW);

            const rowRounded = roundedRow(prefsWithShell());
            rowRounded.active = true;
            await settle();
            expect('the call made to switch the corners on', calls.at(-1), ['EnableExtension', ROUNDED_UUID]);
            expect('enabled-extensions with the corners on', shell.get_strv('enabled-extensions'), [ROUNDED_UUID]);

            const radiusPage = windowsPageOf(prefsWithShell());
            const radiusRow = radiusRowOf(radiusPage);
            const scale = radiusRow && scaleOf(radiusRow);
            if (!scale) {
                problems.push('extensions: the radius row or its slider is missing with the extension installed');
            } else {
                const adjustment = scale.get_adjustment();
                expect('the slider bounds', [adjustment.lower, adjustment.upper], [0, 40]);
                expect('the slider at the extension\'s default', scale.get_value(), 15);
                expect('the slider with the extension on', radiusRow.sensitive, true);

                scale.set_value(22);
                expect('the radius after the slider moved', radiusOf(), ['borderRadius', 'u', 'uint32 22']);
                expect('every other entry after the slider moved', others(), untouched.filter(([name]) => name !== 'borderRadius'));
                expect('the order of the entries after the slider moved', dictOf().map(([name]) => name),
                    untouched.map(([name]) => name));
                scale.set_value(0);
                expect('the radius at the bottom of the slider', radiusOf(), ['borderRadius', 'u', 'uint32 0']);
                scale.set_value(40);
                expect('the radius at the top of the slider', radiusOf(), ['borderRadius', 'u', 'uint32 40']);
                expect('every other entry after the slider moved again', others(), untouched.filter(([name]) => name !== 'borderRadius'));

                // The key changing elsewhere, as when the extension's own window is used.
                rounded.set_value(ROUNDED_KEY, GLib.Variant.parse(null,
                    "{'borderRadius': <uint32 9>, 'enabled': <true>}", null, null));
                expect('the slider after the dictionary changed elsewhere', scale.get_value(), 9);

                // Whatever the dictionary holds besides the radius, of whatever type,
                // comes through a change of radius as it was.
                rounded.set_value(ROUNDED_KEY, GLib.Variant.parse(null,
                    "{'enabled': <false>, 'smoothing': <2.5>, 'padding': <{'left': <uint32 4>}>, 'borderRadius': <15.0>, 'keepRoundedCorners': <{'maximized': <true>}>, 'extra': <['a', 'b']>}",
                    null, null));
                const unusual = others();
                expect('the slider on a radius stored as a double', scale.get_value(), 15);
                scale.set_value(18);
                expect('the radius, stored as an unsigned integer again', radiusOf(), ['borderRadius', 'u', 'uint32 18']);
                expect('the unusual entries, with their types', others(), unusual);

                // A dictionary with no radius in it takes one, and loses nothing.
                rounded.set_value(ROUNDED_KEY, GLib.Variant.parse(null,
                    "{'enabled': <false>, 'smoothing': <2.5>}", null, null));
                const sparse = others();
                scale.set_value(12);
                expect('the radius added to a dictionary without one', radiusOf(), ['borderRadius', 'u', 'uint32 12']);
                expect('the entries of a dictionary without a radius', others(), sparse);

                // Nothing to set while the extension is off.
                rowRounded.active = false;
                await settle();
                expect('the call made to switch the corners off', calls.at(-1), ['DisableExtension', ROUNDED_UUID]);
                expect('the slider with the extension off', radiusRowOf(windowsPageOf(prefsWithShell())).sensitive, false);
                expect('the slider already open, with the extension off', radiusRow.sensitive, false);
            }
            rounded.reset(ROUNDED_KEY);
        }

        resetShell();
        if (problems.length === problemsBefore)
            print('  extensions: both installed; the switches go through the shell, the radius keeps the other entries');
    }
}

// The Dock page's Glass group drives one component of Blur my Shell, the one
// that blurs Dash to Dock, and is a link where that is not installed. The
// runner arranges which: with PREFS_SMOKE_BLUR=full it has put the extension
// where Bazzite does, in a system directory, with the schemas of the components
// that matter here; with `settingless` it has put its metadata alone in the
// user's data directory; with neither there is none. What matters with it is
// what is written and handed back, and that the other components are not
// written to at all, so every key of theirs is read from the settings and has
// to have no value of the user's at the end. The backend is in memory.
{
    const mode = GLib.getenv('PREFS_SMOKE_BLUR');
    const BLUR_UUID = 'blur-my-shell@aunetx';
    const BLUR_URL = 'https://extensions.gnome.org/extension/3193/blur-my-shell/';
    const DOCK_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.dash-to-dock';
    const OTHERS = [
        'org.gnome.shell.extensions.blur-my-shell.panel',
        'org.gnome.shell.extensions.blur-my-shell.popup',
    ];
    const problemsBefore = problems.length;
    const expect = (what, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`glass: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };

    const kept = [];
    const glassOf = prefs => {
        const page = prefs._buildDockPage(prefs.getSettings());
        kept.push(page);
        const group = findWidget(page, widget => widget instanceof Adw.PreferencesGroup && widget.title === 'Glass');
        const titled = (type, title) => findWidget(page, widget => widget instanceof type && widget.title === title);
        const brightness = titled(Adw.ActionRow, 'Brightness');
        return {
            group,
            switchRow: titled(Adw.SwitchRow, 'Frosted Glass, Like macOS'),
            tint: titled(Adw.ComboRow, 'Tint'),
            brightness,
            scale: brightness && findWidget(brightness, widget => widget instanceof Gtk.Scale),
            link: group && findWidget(group, widget => widget instanceof Gtk.LinkButton),
        };
    };

    if (!preferences._dashToDockSettings()) {
        // Without a dock there is no Dock page to speak of, and nothing to glaze.
        expect('the Glass group without Dash to Dock', !!glassOf(new Preferences(metadata)).group, false);
    } else if (!mode) {
        const glass = glassOf(new Preferences(metadata));
        expect('the Glass group without Blur my Shell', !!glass.group, true);
        expect('the link to Blur my Shell', glass.link?.uri, BLUR_URL);
        expect('the switch, tint and brightness without Blur my Shell',
            [!!glass.switchRow, !!glass.tint, !!glass.brightness], [false, false, false]);
        if (problems.length === problemsBefore)
            print('  glass: Blur my Shell is not installed, so the group shows where to get it and nothing else');
    } else if (mode === 'settingless') {
        const glass = glassOf(new Preferences(metadata));
        expect('the Glass group with Blur my Shell but no settings', !!glass.group, true);
        expect('the link, to update it', glass.link?.uri, BLUR_URL);
        expect('the switch, tint and brightness without its settings',
            [!!glass.switchRow, !!glass.tint, !!glass.brightness], [false, false, false]);
        if (problems.length === problemsBefore)
            print('  glass: Blur my Shell without a dock component is said so, not built into rows');
    } else if (mode === 'full') {
        const blur = preferences._settingsForSchema(DOCK_SCHEMA);
        const pearUp = preferences.getSettings();
        const interfaceSettings = preferences._settingsForSchema('org.gnome.desktop.interface');
        const shell = preferences._settingsForSchema('org.gnome.shell');
        const userValue = key => blur.get_user_value(key)?.deepUnpack() ?? null;
        const stored = () => Object.fromEntries(
            ['blur', 'override-background', 'style-dash-to-dock', 'brightness'].map(key => [key, userValue(key)]));
        const resetAll = () => {
            for (const key of blur.settings_schema.list_keys())
                blur.reset(key);
            pearUp.reset('displaced-settings');
            interfaceSettings.set_string('color-scheme', 'prefer-dark');
            shell.reset('enabled-extensions');
        };
        // What the keys hold, which is not what is stored: a key that already
        // holds the value the switch writes is left as it is, at its default.
        const current = () => ({
            'blur': blur.get_boolean('blur'),
            'override-background': blur.get_boolean('override-background'),
            'style-dash-to-dock': blur.get_int('style-dash-to-dock'),
            'brightness': blur.get_double('brightness'),
        });
        // The notes as the page keeps them, printed GVariants: a double is
        // printed as the shortest text that reads back as it, which for 0.7 is not "0.7".
        const noted = () => Object.fromEntries(Object.entries(JSON.parse(pearUp.get_string('displaced-settings')))
            .map(([id, text]) => [id, text !== null && id.endsWith(':brightness') ? Number(text) : text]));
        // The page has no use for the other components' schemas, so Pear Up cannot
        // be asked for them: read them from where the runner put them. Not finding
        // them would make "never written" prove nothing, so it fails.
        const componentSettings = id => {
            for (const dir of [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
                const schemaDir = `${dir}/gnome-shell/extensions/${BLUR_UUID}/schemas`;
                if (!GLib.file_test(schemaDir, GLib.FileTest.IS_DIR))
                    continue;
                const found = Gio.SettingsSchemaSource.new_from_directory(
                    schemaDir, Gio.SettingsSchemaSource.get_default(), false).lookup(id, true);
                if (found)
                    return new Gio.Settings({ settings_schema: found });
            }
            problems.push(`glass: the fixture schema ${id} was not found`);
            return null;
        };
        const others = OTHERS.map(id => [id, componentSettings(id)]).filter(([, settings]) => settings);
        const PRESET_DARK = { 'blur': true, 'override-background': true, 'style-dash-to-dock': 2, 'brightness': 0.9 };
        const AT_DEFAULTS = { 'blur': null, 'override-background': null, 'style-dash-to-dock': null, 'brightness': null };
        // Every key of the dock component but the four the switch writes, and
        // every key of the other components, must have no value of the user's.
        const untouched = (label, except = []) => {
            const written = [];
            for (const key of blur.settings_schema.list_keys()) {
                if (!['blur', 'override-background', 'style-dash-to-dock', 'brightness', ...except].includes(key) &&
                    blur.get_user_value(key) !== null)
                    written.push(`${DOCK_SCHEMA}:${key}`);
            }
            for (const [id, other] of others) {
                for (const key of other.settings_schema.list_keys()) {
                    if (other.get_user_value(key) !== null)
                        written.push(`${id}:${key}`);
                }
            }
            expect(`the keys written outside the four, ${label}`, written, []);
        };

        if (!blur) {
            problems.push('glass: the Blur my Shell fixture schema was not found');
        } else {
            resetAll();
            expect('the fixture directory is where GNOME would search', preferences._extensionInstalled(BLUR_UUID), true);

            // Opened, it only reads. Out of the box the dock is blurred, a
            // transparent glass, and brightness is the static blur's to ignore.
            let glass = glassOf(new Preferences(metadata));
            if (!glass.group || !glass.switchRow || !glass.tint || !glass.brightness || !glass.scale) {
                problems.push('glass: Blur my Shell is installed but the group lacks its switch, tint or brightness');
            } else {
                expect('the link with Blur my Shell installed', !!glass.link, false);
                expect('nothing written by opening the page', stored(), AT_DEFAULTS);
                expect('the switch out of the box', glass.switchRow.active, false);
                expect('the tint out of the box', [glass.tint.selected, glass.tint.selected_item.string], [0, 'Transparent']);
                expect('the tints offered', Array.from({ length: glass.tint.model.get_n_items() },
                    (_, index) => glass.tint.model.get_item(index).string), ['Transparent', 'Light', 'Dark']);
                expect('the slider at the extension\'s default', glass.scale.get_value(), 60);
                const adjustment = glass.scale.get_adjustment();
                expect('the slider bounds', [adjustment.lower, adjustment.upper], [50, 100]);
                expect('the tint with blur on', glass.tint.sensitive, true);

                // Static blur, the default, ignores the key: the slider says so
                // rather than moving something that does nothing.
                expect('the slider with static blur', glass.brightness.sensitive, false);
                if (!/dynamic/.test(glass.brightness.subtitle))
                    problems.push(`glass: the slider does not say static blur ignores it (${JSON.stringify(glass.brightness.subtitle)})`);

                // Switched off in the shell, it does nothing, and the group says so.
                if (!/switched off/.test(glass.group.description))
                    problems.push(`glass: the group does not say Blur my Shell is off (${JSON.stringify(glass.group.description)})`);
                shell.set_strv('enabled-extensions', [BLUR_UUID]);
                if (/switched off/.test(glass.group.description))
                    problems.push('glass: the group still says Blur my Shell is off once it is on');
                shell.set_boolean('disable-user-extensions', true);
                if (!/switched off/.test(glass.group.description))
                    problems.push('glass: the group does not say so when extensions are switched off as a whole');
                shell.reset('disable-user-extensions');

                // On: blur, the background it tints, dark glass with the dark
                // colour scheme, and the brightness of the macOS Dock. What each
                // key held is noted, defaults as null.
                glass.switchRow.active = true;
                expect('the keys after switching on', current(), PRESET_DARK);
                expect('the notes after switching on', noted(), Object.fromEntries(
                    Object.keys(PRESET_DARK).map(key => [`${DOCK_SCHEMA}:${key}`, null])));
                expect('the tint after switching on', glass.tint.selected, 2);
                expect('the slider after switching on', glass.scale.get_value(), 90);
                untouched('after switching on');

                // Off: the defaults, which is what was there, and no notes.
                glass.switchRow.active = false;
                expect('the keys after switching off', stored(), AT_DEFAULTS);
                expect('the notes after switching off', noted(), {});
                expect('the tint after switching off', glass.tint.selected, 0);
                untouched('after switching off');

                // A light colour scheme gets the light glass, and it is read
                // when the switch is flipped, not when the page was built.
                for (const scheme of ['default', 'prefer-light']) {
                    interfaceSettings.set_string('color-scheme', scheme);
                    glass.switchRow.active = true;
                    expect(`the style with the colour scheme ${scheme}`, userValue('style-dash-to-dock'), 1);
                    glass.switchRow.active = false;
                }
                interfaceSettings.set_string('color-scheme', 'prefer-dark');
                glass.switchRow.active = true;
                expect('the style with the colour scheme dark again', userValue('style-dash-to-dock'), 2);
                interfaceSettings.set_string('color-scheme', 'default');
                glass.switchRow.active = false;
                glass.switchRow.active = true;
                expect('the style after the colour scheme changed with the page open', userValue('style-dash-to-dock'), 1);
                glass.switchRow.active = false;
                expect('the keys after all that', stored(), AT_DEFAULTS);
                interfaceSettings.set_string('color-scheme', 'prefer-dark');
            }

            // The user's own values go out and come back exactly, also through a
            // second preferences object, which stands in for the window having
            // been closed and opened again. Their blur is off, so the switch is
            // off, and their light glass is only the style the switch replaces.
            resetAll();
            blur.set_boolean('blur', false);
            blur.set_boolean('override-background', false);
            blur.set_int('style-dash-to-dock', 1);
            blur.set_double('brightness', 0.7);
            blur.set_boolean('static-blur', false);
            const own = stored();
            glass = glassOf(new Preferences(metadata));
            expect('the switch with blur off', glass.switchRow.active, false);
            expect('the tint and slider with blur off', [glass.tint.sensitive, glass.brightness.sensitive], [false, false]);
            glass.switchRow.active = true;
            expect('the keys after switching on over the user\'s own', stored(), PRESET_DARK);
            expect('the notes of the user\'s own', noted(), {
                [`${DOCK_SCHEMA}:blur`]: 'false',
                [`${DOCK_SCHEMA}:override-background`]: 'false',
                [`${DOCK_SCHEMA}:style-dash-to-dock`]: '1',
                [`${DOCK_SCHEMA}:brightness`]: 0.7,
            });
            expect('the tint and slider once blur is on', [glass.tint.sensitive, glass.brightness.sensitive], [true, true]);
            const reopened = glassOf(new Preferences(metadata));
            expect('the switch after reopening', reopened.switchRow.active, true);
            reopened.switchRow.active = false;
            expect('the user\'s own values after switching off', stored(), own);
            expect('the notes once handed back', noted(), {});
            expect('the switch already open, after the other one switched off', glass.switchRow.active, false);
            untouched('after the user\'s own values came back', ['static-blur']);

            // Made by hand, as on a machine set up before this switch existed: it
            // reads on, there is nothing noted, and the default is all there is
            // to go back to.
            resetAll();
            for (const [key, value] of Object.entries(PRESET_DARK))
                blur.set_value(key, typeof value === 'boolean' ? GLib.Variant.new_boolean(value)
                    : Number.isInteger(value) ? GLib.Variant.new_int32(value) : GLib.Variant.new_double(value));
            glass = glassOf(new Preferences(metadata));
            expect('the switch for a look made by hand', glass.switchRow.active, true);
            expect('the tint for a look made by hand', glass.tint.selected, 2);
            glass.switchRow.active = false;
            expect('the keys after switching off a look made by hand', stored(), AT_DEFAULTS);

            // Moving the controls beside the switch is no reason to switch it off.
            resetAll();
            glass = glassOf(new Preferences(metadata));
            glass.switchRow.active = true;
            glass.tint.selected = 1;
            expect('the style after choosing Light', userValue('style-dash-to-dock'), 1);
            expect('the switch after choosing Light', glass.switchRow.active, true);
            glass.tint.selected = 2;
            expect('the style after choosing Dark', userValue('style-dash-to-dock'), 2);
            blur.set_boolean('static-blur', false);
            expect('the slider with dynamic blur', [glass.brightness.sensitive, glass.brightness.subtitle], [true, '']);
            for (const value of [100, 50, 75]) {
                glass.scale.set_value(value);
                expect(`the brightness after the slider moved to ${value}`, userValue('brightness'), value / 100);
                expect(`the switch with the slider at ${value}`, glass.switchRow.active, true);
            }
            expect('the value label', glass.scale.get_layout()?.get_text(), '75%');
            expect('the keys after the controls were moved', current(), { ...PRESET_DARK, 'brightness': 0.75 });

            // Choosing Transparent takes the glass off, and the controls stay usable.
            glass.tint.selected = 0;
            expect('the style after choosing Transparent', userValue('style-dash-to-dock'), 0);
            expect('the switch with a transparent tint', glass.switchRow.active, false);
            expect('the tint and slider with a transparent tint', [glass.tint.sensitive, glass.brightness.sensitive], [true, true]);

            // Switched on from there it writes its own values over the tweaks. The
            // notes taken at the first switch-on are still there, and are the
            // older, truer ones: the brightness goes back to what it was before
            // any glass, not to the tweak, while the style, which was changed
            // since, is noted as it stood.
            glass.switchRow.active = true;
            expect('the keys after switching on over a tweaked look', current(), PRESET_DARK);
            glass.switchRow.active = false;
            expect('the keys after switching that off', stored(),
                { ...AT_DEFAULTS, 'style-dash-to-dock': 0 });

            // The keys changing elsewhere, as when Blur my Shell's own window is used.
            blur.set_int('style-dash-to-dock', 1);
            expect('the tint after the style changed elsewhere', glass.tint.selected, 1);
            expect('the switch after the style changed elsewhere', glass.switchRow.active, true);
            blur.set_double('brightness', 0.55);
            expect('the slider after the brightness changed elsewhere', glass.scale.get_value(), 55);
            blur.set_double('brightness', 0.2);
            expect('the slider with a brightness below its range', glass.scale.get_value(), 50);
            expect('the brightness key, which showing it does not write', userValue('brightness'), 0.2);
            expect('the switch with a brightness below the slider\'s range', glass.switchRow.active, false);
            blur.set_double('brightness', 0.9);

            // A style Blur my Shell may have and this list does not is shown as such.
            blur.set_int('style-dash-to-dock', 7);
            expect('the tint for a style of Blur my Shell\'s own', [
                glass.tint.model.get_n_items(), glass.tint.selected, glass.tint.selected_item.string,
            ], [4, 3, 'Set in Blur my Shell']);
            expect('the style, which showing it does not write', userValue('style-dash-to-dock'), 7);
            expect('the switch for a style of Blur my Shell\'s own', glass.switchRow.active, true);
            glass.tint.selected = 1;
            expect('the style after choosing a tint over it', userValue('style-dash-to-dock'), 1);
            blur.set_int('style-dash-to-dock', 2);
            expect('the entry goes when the style is one of ours again', [
                glass.tint.model.get_n_items(), glass.tint.selected,
            ], [3, 2]);
            expect('the reopened tint for a style of Blur my Shell\'s own', (() => {
                blur.set_int('style-dash-to-dock', 9);
                const again = glassOf(new Preferences(metadata)).tint;
                return [again.model.get_n_items(), again.selected_item.string];
            })(), [4, 'Set in Blur my Shell']);

            // Blur off, in Blur my Shell: nothing is blurred or tinted, so the
            // controls rest, and the slider says nothing about static blur.
            resetAll();
            glass = glassOf(new Preferences(metadata));
            blur.set_boolean('blur', false);
            expect('the controls with blur off', [glass.switchRow.active, glass.tint.sensitive, glass.brightness.sensitive],
                [false, false, false]);
            expect('the slider\'s subtitle with blur off', glass.brightness.subtitle, '');
            blur.set_boolean('blur', true);
            expect('the controls with blur back on', [glass.tint.sensitive, glass.brightness.sensitive], [true, false]);

            // Whatever was done above, the panel, the popups and the dock's other
            // settings were never written.
            blur.reset('static-blur');
            untouched('at the end');
            resetAll();

            if (problems.length === problemsBefore)
                print('  glass: switch, tint and brightness write the dock\'s keys, hand the user\'s own back, and write nothing else');
        }
    }
}

// The About page names the release as people do. `version` is the integer GNOME
// compares, which printed as "Version 2" for 0.2.0; it is only what is shown
// where metadata.json has no version-name.
{
    const versionShown = meta => {
        const page = new Preferences(meta)._buildAboutPage();
        const row = findWidget(page, widget =>
            widget instanceof Adw.ActionRow && widget.title === 'Version');
        return row ? row.subtitle : null;
    };
    const { 'version-name': name, ...unnamed } = metadata;
    const problemsBefore = problems.length;

    if (!name) {
        problems.push('about: metadata.json has no version-name');
    } else {
        if (versionShown(metadata) !== name)
            problems.push(`about: the version is ${JSON.stringify(versionShown(metadata))}, expected ${JSON.stringify(name)}`);
        if (versionShown(unnamed) !== String(metadata.version))
            problems.push(`about: without a version-name the version is ${JSON.stringify(versionShown(unnamed))}, expected ${JSON.stringify(String(metadata.version))}`);
    }
    if (problems.length === problemsBefore)
        print(`  about: shows ${name}, and ${metadata.version} without a version-name`);
}

// The file manager's name is empty out of the box, which follows the app: File
// → New … Window says "Files" where the bar does. It used to default to
// "Nautilus", which is what the app's code calls it. A name typed here wins, and
// the row writes it once typing pauses.
{
    const settings = preferences.getSettings();
    const page = pages.find(candidate => candidate.title === 'General');
    const row = page && findWidget(page, widget =>
        widget instanceof Adw.ActionRow && widget.title === 'File Manager Name');
    const entry = row && findWidget(row, widget => widget instanceof Gtk.Entry);
    const problemsBefore = problems.length;
    const expect = (label, got, wanted) => {
        if (got !== wanted)
            problems.push(`file manager name: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };
    // The write waits for typing to pause, which takes a turn of the main loop.
    const pause = () => {
        const loop = new GLib.MainLoop(null, false);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
    };

    if (!entry) {
        problems.push('the General page has no File Manager Name entry');
    } else {
        expect('the default', settings.get_default_value('desktop-app-name').unpack(), '');
        expect('the entry at first', entry.get_text(), '');

        entry.set_text('  Finder ');
        pause();
        expect('the key after typing a name', settings.get_string('desktop-app-name'), 'Finder');

        entry.set_text('');
        pause();
        expect('the key after clearing it', settings.get_string('desktop-app-name'), '');
        if (problems.length === problemsBefore)
            print('  file manager name: empty by default, written as typed, empty again once cleared');
    }
    settings.reset('desktop-app-name');
}

// Notifications Slide In from the Right: off out of the box, under the switch
// that puts banners in the corner, and greyed out while that one is off.
{
    const settings = preferences.getSettings();
    const page = pages.find(candidate => candidate.title === 'General');
    const problemsBefore = problems.length;
    const key = 'banners-slide-from-right';
    const title = 'Notifications Slide In from the Right';
    const expect = (label, got, wanted) => {
        if (got !== wanted)
            problems.push(`banner slide: ${label} is ${got}, expected ${wanted}`);
    };
    const row = page && findWidget(page, widget =>
        widget instanceof Adw.SwitchRow && widget.title === title);
    const corner = page && findWidget(page, widget =>
        widget instanceof Adw.SwitchRow && widget.title === 'Notifications at the Top Right');
    if (!row || !corner) {
        problems.push(`the General page has no "${title}" switch under the corner one`);
    } else {
        expect('the default', settings.get_default_value(key).unpack(), false);
        expect('the row at first', row.active, false);
        expect('the row right under the corner switch', corner.get_next_sibling() === row, true);
        row.active = true;
        expect('the key after switching it on', settings.get_boolean(key), true);
        settings.set_boolean(key, false);
        expect('the row after an outside change', row.active, false);
        expect('the row while banners are in the corner', row.sensitive, true);
        settings.set_boolean('notifications-top-right', false);
        expect('the row while banners are not in the corner', row.sensitive, false);
        settings.reset('notifications-top-right');
        expect('the row with the corner back', row.sensitive, true);
        settings.reset(key);
        if (problems.length === problemsBefore)
            print('  banner slide: off by default, written and followed, greyed out without the corner');
    }
}

// The Desktop group on the General page: the shell's pieces that are not the bar,
// one switch each, all on out of the box like the bar's own tweaks. Each row has
// to write its own key and follow it when it changes from outside.
{
    const settings = preferences.getSettings();
    const page = pages.find(candidate => candidate.title === 'General');
    const problemsBefore = problems.length;
    const rows = [
        ['Notifications at the Top Right', 'notifications-top-right'],
        ['Volume and Brightness at the Top Right', 'osd-top-right'],
        ['No Popup When Switching Desktops', 'hide-workspace-popup'],
        ['Always Show the Desktops in the Overview', 'always-show-workspace-thumbnails'],
        ['Start on the Desktop', 'start-on-desktop'],
    ];
    const expect = (label, got, wanted) => {
        if (got !== wanted)
            problems.push(`desktop group: ${label} is ${got}, expected ${wanted}`);
    };

    // Smooth Automatic Brightness is there only where the shell sets the
    // brightness itself, from GNOME 49; before, gnome-settings-daemon does. The
    // page asks the shell's keybindings, so the release is asked here instead,
    // of the shell this container has.
    const brightnessTitle = 'Smooth Automatic Brightness';
    let release = NaN;
    try {
        const [, out] = GLib.spawn_command_line_sync('gnome-shell --version');
        release = Number(/(\d+)\.\d+/.exec(new TextDecoder().decode(out))?.[1]);
    } catch {
        // Reported below.
    }
    const brightnessRow = page && findWidget(page, widget =>
        widget instanceof Adw.SwitchRow && widget.title === brightnessTitle);
    if (!Number.isFinite(release))
        problems.push('desktop group: could not tell which GNOME this is');
    else if (release >= 49)
        rows.push([brightnessTitle, 'smooth-auto-brightness']);
    else if (brightnessRow)
        problems.push(`desktop group: GNOME ${release} leaves the brightness to gnome-settings-daemon, ` +
            `yet the General page offers "${brightnessTitle}"`);

    for (const [title, key] of rows) {
        const row = page && findWidget(page, widget =>
            widget instanceof Adw.SwitchRow && widget.title === title);
        if (!row) {
            problems.push(`the General page has no "${title}" switch`);
            continue;
        }
        expect(`the default of ${key}`, settings.get_default_value(key).unpack(), true);
        expect(`"${title}" at first`, row.active, true);
        row.active = false;
        expect(`${key} after switching "${title}" off`, settings.get_boolean(key), false);
        settings.set_boolean(key, true);
        expect(`"${title}" after an outside change`, row.active, true);
        settings.reset(key);
    }
    // Springy Desktop Switching is the one in the group that starts off.
    const springTitle = 'Springy Desktop Switching';
    const springRow = page && findWidget(page, widget =>
        widget instanceof Adw.SwitchRow && widget.title === springTitle);
    if (!springRow) {
        problems.push(`the General page has no "${springTitle}" switch`);
    } else {
        expect('the default of spaces-spring', settings.get_default_value('spaces-spring').unpack(), false);
        expect(`"${springTitle}" at first`, springRow.active, false);
        springRow.active = true;
        expect(`spaces-spring after switching "${springTitle}" on`, settings.get_boolean('spaces-spring'), true);
        settings.set_boolean('spaces-spring', false);
        expect(`"${springTitle}" after an outside change`, springRow.active, false);
        settings.reset('spaces-spring');
    }

    if (problems.length === problemsBefore)
        print(`  desktop group: ${rows.length} switches, on by default, each writing its own key, ` +
            `and ${springTitle}, off by default; ` +
            `GNOME ${release}, so ${release >= 49 ? 'with' : 'without'} ${brightnessTitle}`);
}

// Scroll acceleration is one file, which the switch installs into the user's
// libinput plugin directory with the speed written into it, and removes
// again. Only GNOME 50 and later load it, so before that the switch is greyed
// and writes nothing. The file goes into the runner's config directory, like
// the gtk.css ones, and nothing is written without one.
{
    const TITLE = 'macOS-Like Scroll Acceleration';
    const problemsBefore = problems.length;
    const shell = parseInt(GLib.getenv('PREFS_SMOKE_SHELL_VERSION') ?? '0', 10);
    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`scroll acceleration: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };
    const titled = (type, title) => widget => widget instanceof type && widget.title === title;
    const rowsOf = (prefs = new Preferences(metadata)) => {
        const page = prefs._buildKeyboardPage();
        windowsKept.push(page);
        return [findWidget(page, titled(Adw.SwitchRow, TITLE)), findWidget(page, titled(Adw.ComboRow, 'Scroll Speed'))];
    };
    const keyboard = pages.find(page => page.title === 'Keyboard');
    const configDir = GLib.get_user_config_dir();
    const ours = smokeConfig && smokeConfig === configDir &&
        GLib.path_get_basename(smokeConfig).startsWith('pear-up-smoke-');
    const pluginDir = `${configDir}/libinput/plugins`;
    const target = `${pluginDir}/10-pear-up-scroll-acceleration.lua`;
    const read = path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)
        ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null;
    const write = (path, text) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, new TextEncoder().encode(text));
    };
    const reset = () => {
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(`${configDir}/libinput`)}`);
    };
    const source = read(`${extensionDir}/libinput/10-pear-up-scroll-acceleration.lua`);
    const withSpeed = speed => source.replace(/^local SPEED = [0-9.]+$/m, `local SPEED = ${speed}`);

    if (!keyboard || !findWidget(keyboard, titled(Adw.SwitchRow, TITLE))) {
        problems.push('the Keyboard page has no scroll acceleration switch');
    } else if (shell < 50) {
        const [row, strength] = rowsOf();
        expect('the switch on GNOME ' + shell + ', sensitive', row.sensitive, false);
        expect('the strength on GNOME ' + shell + ', sensitive', strength.sensitive, false);
        if (!/GNOME 50/.test(row.subtitle ?? ''))
            problems.push(`scroll acceleration: the subtitle does not say it needs GNOME 50 (${row.subtitle})`);
        if (ours) {
            reset();
            row.active = true;
            expect('the switch set on where it cannot work', row.active, false);
            expect('the plugin written where it cannot work', read(target), null);
        }
        if (problems.length === problemsBefore)
            print(`  scroll acceleration: greyed out on GNOME ${shell}, saying it needs GNOME 50`);
    } else if (!ours) {
        print('  scroll acceleration: not driven, the runner has not given this process a config directory of its own');
    } else if (source === null || !/^local SPEED = [0-9.]+$/m.test(source)) {
        problems.push('scroll acceleration: the plugin is not in libinput/ or has no SPEED line');
    } else {
        reset();
        write(`${pluginDir}/20-of-my-own.lua`, 'libinput:register({1})\n');
        let [row, strength] = rowsOf();
        expect('the switch with nothing installed', row.active, false);
        expect('the switch sensitive', row.sensitive, true);
        expect('the strength while off, sensitive', strength.sensitive, false);
        expect('the strength while off', strength.selected, 1);

        row.active = true;
        expect('the plugin after switching on', read(target), withSpeed(0.7));
        expect('the strength after switching on, sensitive', strength.sensitive, true);
        strength.selected = 2;
        expect('the plugin at As Fast as GNOME', read(target), withSpeed(1));
        strength.selected = 0;
        expect('the plugin at As on a MacBook', read(target), withSpeed(0.34));

        [row, strength] = rowsOf();
        expect('the switch reopened', row.active, true);
        expect('the strength reopened', strength.selected, 0);

        // A strength written by hand reads as itself, not as one of the three.
        write(target, withSpeed(0.5));
        [row, strength] = rowsOf();
        expect('the strengths with one written by hand', strength.model.get_n_items(), 4);
        expect('the strength written by hand', strength.model.get_string(strength.selected), 'Custom (0.5)');

        // Off takes Pear Up's file away and nothing else.
        row.active = false;
        expect('the plugin after switching off', read(target), null);
        expect('another plugin after switching off', read(`${pluginDir}/20-of-my-own.lua`), 'libinput:register({1})\n');
        expect('the plugin directory after switching off', GLib.file_test(pluginDir, GLib.FileTest.IS_DIR), true);

        // A copy from another version of Pear Up is still Pear Up's, and says so.
        write(target, `${withSpeed(0.7)}-- an older line\n`);
        [row] = rowsOf();
        expect('the switch with an older copy', row.active, true);
        if (!/another version/.test(row.subtitle ?? ''))
            problems.push(`scroll acceleration: an older copy is not mentioned (${row.subtitle})`);
        row.active = false;
        expect('the older copy after switching off', read(target), null);

        // So is one from before the speed line, with the strength line of then:
        // shown at the default speed, and replaced when a speed is chosen.
        write(target, '-- Pear Up\nlocal SLOW_GAIN = 0.35\n');
        [row, strength] = rowsOf();
        expect('the switch with a copy from before the speed line', row.active, true);
        expect('its speed', strength.selected, 1);
        if (!/another version/.test(row.subtitle ?? ''))
            problems.push(`scroll acceleration: a copy from before the speed line is not mentioned (${row.subtitle})`);
        strength.selected = 0;
        expect('it, after choosing a speed', read(target), withSpeed(0.34));
        row.active = false;

        // A file of the same name that is not Pear Up's is never touched.
        write(target, 'print("mine")\n');
        [row] = rowsOf();
        expect('the switch over a file of someone else\'s', row.active, false);
        expect('the switch over a file of someone else\'s, sensitive', row.sensitive, false);
        if (!/not Pear Up/.test(row.subtitle ?? ''))
            problems.push(`scroll acceleration: someone else's file is not explained (${row.subtitle})`);
        row.active = true;
        expect('someone else\'s file after the switch was set', read(target), 'print("mine")\n');
        expect('someone else\'s file after removing', preferences._setScrollPlugin(null) !== null, true);
        expect('someone else\'s file, still', read(target), 'print("mine")\n');

        // Where the directory cannot be made, the switch says so and stays off.
        reset();
        write(`${configDir}/libinput/plugins`, 'not a directory\n');
        [row] = rowsOf();
        row.active = true;
        expect('the switch where the directory cannot be made', row.active, false);
        if (!/^Could not write/.test(row.subtitle ?? ''))
            problems.push(`scroll acceleration: the subtitle does not say it failed (${row.subtitle})`);

        reset();
        if (problems.length === problemsBefore)
            print('  scroll acceleration: installs and removes only its own file, with the speed written in');
    }
}

// Browser scrolling is two lines in the flags file of each Flatpak Chromium
// browser installed, in a home directory made up for the test: written, set to
// another speed, taken out again with the rest of the file as it was, and a
// file with an --enable-features of its own left alone.
{
    const problemsBefore = problems.length;
    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`browser scrolling: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };
    const home = GLib.dir_make_tmp('pear-up-browser-home-XXXXXX');
    const read = path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)
        ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null;
    const write = (path, text) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, new TextEncoder().encode(text));
    };
    // The plugin's speed the Mac scale is worked out from: 1, as without it,
    // so As on a MacBook is 0.84.
    const rowsOf = () => {
        const group = new Adw.PreferencesGroup();
        windowsKept.push(group);
        return new Preferences(metadata)._buildBrowserScrollRows(group, home, 1);
    };
    const comment = '# Pear Up: touchpad scrolling at macOS’s or GNOME’s scale (Keyboard → Trackpad)';
    const oldComment = '# Pear Up: touchpad scrolling as far as in GNOME’s apps (Keyboard → Trackpad)';
    const flag = factor => `--enable-features=WaylandUnscaledTouchpadScrolling:scroll_scaling_factor/${factor}`;
    const brave = `${home}/.var/app/com.brave.Browser/config/brave-flags.conf`;
    const chromium = `${home}/.var/app/org.chromium.Chromium/config/chromium-flags.conf`;
    const theirs = '--enable-features=VaapiVideoDecoder\n--ozone-platform=wayland\n';
    const flatpakSystem = ['com.brave.Browser', 'org.chromium.Chromium', 'com.google.Chrome']
        .some(app => GLib.file_test(`/var/lib/flatpak/app/${app}`, GLib.FileTest.IS_DIR));

    let [row] = rowsOf();
    let speed;
    if (!flatpakSystem) {
        expect('the switch with no browser, sensitive', row.sensitive, false);
        if (!/None of/.test(row.subtitle ?? ''))
            problems.push(`browser scrolling: no browser is not explained (${row.subtitle})`);
    }

    write(brave, '--password-store=basic\n');
    write(chromium, theirs);
    [row, speed] = rowsOf();
    expect('the switch with nothing written', row.active, false);
    expect('the switch with a browser, sensitive', row.sensitive, true);
    expect('the speed while off, sensitive', speed.sensitive, false);
    row.active = true;
    expect('Brave\'s file after switching on', read(brave), `--password-store=basic\n${comment}\n${flag(0.84)}\n`);
    expect('Chromium\'s file of its own after switching on', read(chromium), theirs);
    if (!/Left alone: .*chromium-flags\.conf/.test(row.subtitle ?? ''))
        problems.push(`browser scrolling: the file left alone is not named (${row.subtitle})`);
    speed.selected = 3;
    expect('Brave\'s file at Slowest', read(brave), `--password-store=basic\n${comment}\n${flag(1)}\n`);
    [row, speed] = rowsOf();
    expect('the switch reopened', row.active, true);
    expect('the speed reopened', speed.selected, 3);
    speed.selected = 1;
    expect('Brave\'s file at As in GNOME’s Apps', read(brave), `--password-store=basic\n${comment}\n${flag(2.5)}\n`);
    // The lines of the version before are Pear Up's too.
    write(brave, `--password-store=basic\n${oldComment}\n${flag(2.5)}\n`);
    [row, speed] = rowsOf();
    expect('the switch with the lines of the version before', row.active, true);
    speed.selected = 0;
    expect('Brave\'s file with them, at As on a MacBook', read(brave), `--password-store=basic\n${comment}\n${flag(0.84)}\n`);
    // At As on a MacBook the scale follows the plugin's speed; at a speed of
    // its own it stays.
    const follow = rowsOf()[2];
    follow(1, 0.34);
    expect('Brave\'s file after the plugin went to 0.34', read(brave), `--password-store=basic\n${comment}\n${flag(2.46)}\n`);
    write(brave, `--password-store=basic\n${comment}\n${flag(1.5)}\n`);
    follow(1, 0.34);
    expect('Brave\'s file at Slower after the plugin moved', read(brave), `--password-store=basic\n${comment}\n${flag(1.5)}\n`);
    [row] = rowsOf();
    row.active = false;
    expect('Brave\'s file after switching off', read(brave), '--password-store=basic\n');
    expect('Chromium\'s file after switching off', read(chromium), theirs);

    // A file Pear Up made is gone again when switched off.
    GLib.unlink(brave);
    GLib.unlink(chromium);
    [row] = rowsOf();
    row.active = true;
    expect('Brave\'s new file', read(brave), `${comment}\n${flag(0.84)}\n`);
    expect('Chromium\'s new file', read(chromium), `${comment}\n${flag(0.84)}\n`);
    row.active = false;
    expect('Brave\'s file after switching off', read(brave), null);
    expect('Chromium\'s file after switching off', read(chromium), null);

    // ChatGPT: the flag goes into the Exec line of its desktop file, and the
    // line as it was comes back. A desktop file with features of its own is
    // left alone.
    const chatgpt = `${home}/.local/share/applications/chatgpt.desktop`;
    const entry = exec => `[Desktop Entry]\nName=ChatGPT\nExec=${exec}\nType=Application\n\n[Desktop Action new]\nExec=/opt/chatgpt --new\n`;
    const original = entry('/opt/chatgpt/codex-launcher --no-sandbox %U');
    write(chatgpt, original);
    [row, speed] = rowsOf();
    row.active = true;
    expect('ChatGPT\'s desktop file after switching on', read(chatgpt),
        '[Desktop Entry]\nName=ChatGPT\nExec=/opt/chatgpt/codex-launcher ' +
        '--enable-features=WaylandUnscaledTouchpadScrolling:scroll_scaling_factor/0.84 --no-sandbox %U\n' +
        'X-Pear-Up-Scroll-Exec=/opt/chatgpt/codex-launcher --no-sandbox %U\nType=Application\n\n' +
        '[Desktop Action new]\nExec=/opt/chatgpt --new\n');
    speed.selected = 1;
    if (!/ --enable-features=WaylandUnscaledTouchpadScrolling:scroll_scaling_factor\/2\.5 --no-sandbox %U\n/.test(read(chatgpt) ?? ''))
        problems.push(`browser scrolling: ChatGPT's speed did not change (${read(chatgpt)})`);
    [row, speed] = rowsOf();
    expect('the switch with only ChatGPT', row.active, true);
    expect('the speed with only ChatGPT', speed.selected, 1);
    row.active = false;
    expect('ChatGPT\'s desktop file after switching off', read(chatgpt), original);
    const quoted = entry('"/opt/Chat GPT/chatgpt" %U');
    write(chatgpt, quoted);
    [row] = rowsOf();
    row.active = true;
    if (!(read(chatgpt) ?? '').includes('Exec="/opt/Chat GPT/chatgpt" --enable-features=WaylandUnscaledTouchpadScrolling:scroll_scaling_factor/0.84 %U\n'))
        problems.push(`browser scrolling: a quoted program is not kept whole (${read(chatgpt)})`);
    row.active = false;
    expect('a quoted ChatGPT after switching off', read(chatgpt), quoted);
    const own = entry('/opt/chatgpt --enable-features=Foo %U');
    write(chatgpt, own);
    [row] = rowsOf();
    row.active = true;
    expect('a ChatGPT with features of its own', read(chatgpt), own);

    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);
    if (problems.length === problemsBefore)
        print('  browser scrolling: writes and removes only its own two lines and ChatGPT\'s Exec, leaves files with their own features alone');
}

// macOS momentum in Firefox is a block in user.js of each profile, in a home
// directory made up for the test with a Flatpak Firefox of two profiles: the
// block written with the Mac scale for the plugin's speed, the prefs it
// displaces in prefs.js kept in it and put back when switched off, and the
// rest of both files as they were. Switching off waits for Firefox to quit.
{
    const problemsBefore = problems.length;
    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`Firefox momentum: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    };
    const home = GLib.dir_make_tmp('pear-up-firefox-home-XXXXXX');
    const read = path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)
        ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null;
    const write = (path, text) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, new TextEncoder().encode(text));
    };
    const prefs = new Preferences(metadata);
    let running = false;
    prefs._firefoxRunning = () => running;
    const rowOf = level => {
        const group = new Adw.PreferencesGroup();
        windowsKept.push(group);
        return prefs._buildFirefoxMomentumRow(group, home, level);
    };
    let [row] = rowOf(0.7);
    expect('the switch with no Firefox, sensitive', row.sensitive, false);

    const dir = `${home}/.var/app/org.mozilla.firefox/.mozilla/firefox`;
    write(`${dir}/profiles.ini`, '[Profile1]\nName=default\nIsRelative=1\nPath=a.default\n\n' +
        '[Profile0]\nName=default-release\nIsRelative=1\nPath=b.default-release\n\n[General]\nVersion=2\n');
    const userA = `${dir}/a.default/user.js`;
    const userB = `${dir}/b.default-release/user.js`;
    const prefsB = `${dir}/b.default-release/prefs.js`;
    GLib.mkdir_with_parents(`${dir}/a.default`, 0o755);
    write(userB, 'user_pref("browser.startup.page", 3);\n');
    const prefsBefore = '// Mozilla User Preferences\n\nuser_pref("apz.fling_friction", "0.004");\n' +
        'user_pref("browser.startup.page", 3);\n';
    write(prefsB, prefsBefore);
    [row] = rowOf(0.7);
    expect('the switch with two profiles', [row.active, row.sensitive], [false, true]);
    row.active = true;
    const block = (multiplier, was = []) => [
        '// Pear Up: macOS momentum (Keyboard → Trackpad). Switch it off there to remove these lines.',
        ...was.map(line => `// Pear Up: was ${line}`),
        'user_pref("apz.gtk.kinetic_scroll.enabled", true);',
        'user_pref("apz.fling_friction", "0.0015");',
        'user_pref("apz.fling_stopped_threshold", "0.1");',
        'user_pref("apz.fling_min_velocity_threshold", "0.2");',
        'user_pref("apz.overscroll.enabled", true);',
        `user_pref("apz.gtk.pangesture.pixel_delta_mode_multiplier", "${multiplier}");`,
        '// Pear Up: end of macOS momentum',
    ].join('\n');
    expect('a profile\'s new user.js', read(userA), `${block('12.0')}\n`);
    expect('a user.js of its own, with the block', read(userB),
        `user_pref("browser.startup.page", 3);\n${block('12.0', ['user_pref("apz.fling_friction", "0.004");'])}\n`);
    [row] = rowOf(0.7);
    expect('the switch reopened', row.active, true);

    // The plugin's speed moves Firefox's scale with it.
    rowOf(0.7)[1](0.7, 0.34);
    expect('a profile after the plugin went to 0.34', read(userA), `${block('24.6')}\n`);

    // Firefox has run and written Pear Up's values into prefs.js.
    write(prefsB, '// Mozilla User Preferences\n\nuser_pref("apz.fling_friction", "0.0015");\n' +
        'user_pref("apz.gtk.pangesture.pixel_delta_mode_multiplier", "24.6");\nuser_pref("browser.startup.page", 3);\n');
    running = true;
    [row] = rowOf(0.34);
    row.active = false;
    expect('the switch while Firefox runs', row.active, true);
    if (!/Quit Firefox/.test(row.subtitle ?? ''))
        problems.push(`Firefox momentum: switching off while it runs is not explained (${row.subtitle})`);
    running = false;
    row.active = false;
    expect('the switch after Firefox quit', row.active, false);
    expect('a profile\'s user.js after switching off', read(userA), null);
    expect('a user.js of its own after switching off', read(userB), 'user_pref("browser.startup.page", 3);\n');
    expect('prefs.js after switching off', read(prefsB),
        '// Mozilla User Preferences\n\nuser_pref("browser.startup.page", 3);\nuser_pref("apz.fling_friction", "0.004");\n');

    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(home)}`);
    if (problems.length === problemsBefore)
        print('  Firefox momentum: writes its block into each profile, follows the speed, puts prefs.js back, waits for Firefox to quit');
}

// The macOS keys are one file too, with a line for each of three switches,
// the Alt/Cmd swap written in as it is set, and the Cmd key list kept as found.
// All three off removes it; nothing else in the directory is touched. An
// input-remapper preset that translates the same keys gets a warning, read
// from a fixture laid out as framy's, and is only ever read.
{
    const problemsBefore = problems.length;
    const shell = parseInt(GLib.getenv('PREFS_SMOKE_SHELL_VERSION') ?? '0', 10);
    // A copy of the plugin is told by the lines Pear Up writes, and by
    // whether the rest is the same, rather than printed whole.
    const brief = value => typeof value === 'string' && value.includes('\nlocal SWAPPED = ')
        ? `${value.match(/^local (SWAPPED|WORDS|DESKTOPS|SHORTCUTS|SHORTCUT_KEYS) = .*$/gm).join('; ')}` +
            ` (${value.length} characters)`
        : JSON.stringify(value);
    const expect = (label, got, wanted) => {
        if (JSON.stringify(got) !== JSON.stringify(wanted))
            problems.push(`macOS keys: ${label} is ${brief(got)}, expected ${brief(wanted)}`);
    };
    const TITLES = ['Option+←/→ Moves by Word', 'Ctrl+←/→ Switches Desktops', 'macOS Shortcuts in Apps'];
    const titled = (type, title) => widget => widget instanceof type && widget.title === title;
    const groupOf = (prefs = new Preferences(metadata)) => {
        const page = prefs._buildKeyboardPage();
        windowsKept.push(page);
        const [words, desktops, shortcuts] = TITLES.map(title => findWidget(page, titled(Adw.SwitchRow, title)));
        const remapper = findWidget(page, titled(Adw.ActionRow, 'input-remapper Translates These Keys Too'));
        const status = findWidget(page, widget => widget.get_name() === 'pear-up-app-keys-status');
        return { words, desktops, shortcuts, remapper, status, page };
    };
    const configDir = GLib.get_user_config_dir();
    const ours = smokeConfig && smokeConfig === configDir &&
        GLib.path_get_basename(smokeConfig).startsWith('pear-up-smoke-');
    const pluginDir = `${configDir}/libinput/plugins`;
    const target = `${pluginDir}/10-pear-up-macos-keys.lua`;
    const read = path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)
        ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null;
    const write = (path, text) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, new TextEncoder().encode(text));
    };
    const reset = () => {
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(`${configDir}/libinput`)} ` +
            `${GLib.shell_quote(`${configDir}/input-remapper-2`)}`);
    };
    const source = read(`${extensionDir}/libinput/10-pear-up-macos-keys.lua`);
    const shipped = (values = {}) => {
        let text = source;
        for (const [name, value] of Object.entries(values))
            text = text.replace(new RegExp(`^local ${name} = .*$`, 'm'), `local ${name} = ${value}`);
        return text;
    };
    const plugin = values => shipped({ SWAPPED: false, WORDS: false, DESKTOPS: false, SHORTCUTS: false, ...values });
    const input = new Gio.Settings({ schema_id: 'org.gnome.desktop.input-sources' });
    const wm = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
    const swap = on => input.set_strv('xkb-options', on ? ['altwin:swap_alt_win'] : []);

    const first = groupOf();
    if (!first.words || !first.desktops || !first.shortcuts || !first.status) {
        problems.push('the Keyboard page has no Inside Apps group with three switches and a status row');
    } else if (shell < 50) {
        for (const row of [first.words, first.desktops, first.shortcuts])
            expect(`"${row.title}" on GNOME ${shell}, sensitive`, row.sensitive, false);
        expect('the status row on GNOME ' + shell, first.status.visible, true);
        if (!/GNOME 50/.test(first.status.subtitle ?? '') || !/keyd/.test(first.status.subtitle ?? ''))
            problems.push(`macOS keys: the status does not say it needs GNOME 50, or what to use instead (${first.status.subtitle})`);
        if (ours) {
            reset();
            const { words } = groupOf();
            words.active = true;
            expect('the switch set on where it cannot work', words.active, false);
            expect('the plugin written where it cannot work', read(target), null);
        }
        if (problems.length === problemsBefore)
            print(`  macOS keys: greyed out on GNOME ${shell}, saying it needs GNOME 50 and what does it before`);
    } else if (!ours) {
        print('  macOS keys: not driven, the runner has not given this process a config directory of its own');
    } else if (source === null) {
        problems.push('macOS keys: the plugin is not in libinput/');
    } else {
        reset();
        swap(false);
        write(`${pluginDir}/20-of-my-own.lua`, 'libinput:register({1})\n');
        write(`${pluginDir}/10-pear-up-scroll-acceleration.lua`, '-- Pear Up\nlocal SLOW_GAIN = 0.35\n');
        let rows = groupOf();
        expect('the switches with nothing installed', [rows.words.active, rows.desktops.active, rows.shortcuts.active],
            [false, false, false]);
        expect('the switches sensitive', [rows.words.sensitive, rows.desktops.sensitive, rows.shortcuts.sensitive],
            [true, true, true]);
        expect('the status row with nothing to say', rows.status.visible, false);
        expect('the input-remapper row with no presets', rows.remapper.visible, false);
        if (!/Cmd\+C, V, X, Z, A, S, F, T, W and N/.test(rows.shortcuts.subtitle ?? '') ||
            !/terminal/.test(rows.shortcuts.subtitle ?? ''))
            problems.push(`macOS keys: the shortcut row does not list the keys or warn of terminals (${rows.shortcuts.subtitle})`);

        rows.words.active = true;
        expect('the plugin after switching on word jumps', read(target), plugin({ WORDS: true }));
        rows.shortcuts.active = true;
        expect('and the shortcuts', read(target), plugin({ WORDS: true, SHORTCUTS: true }));
        rows.desktops.active = true;
        rows.words.active = false;
        expect('desktops on, words off', read(target), plugin({ DESKTOPS: true, SHORTCUTS: true }));

        rows = groupOf();
        expect('the switches reopened', [rows.words.active, rows.desktops.active, rows.shortcuts.active],
            [false, true, true]);

        // The swap decides the keys, so the copy follows it, set from the
        // Layout row or from anywhere else.
        const swapRow = findWidget(rows.page, titled(Adw.SwitchRow, 'Swap Alt and Cmd'));
        swapRow.active = true;
        expect('the plugin after the swap is switched on', read(target),
            plugin({ SWAPPED: true, DESKTOPS: true, SHORTCUTS: true }));
        swap(false);
        expect('the plugin after the swap is switched off elsewhere', read(target),
            plugin({ DESKTOPS: true, SHORTCUTS: true }));
        // Out of step when the window opens, as after a change made while it
        // was closed.
        write(target, plugin({ SWAPPED: true, DESKTOPS: true, SHORTCUTS: true }));
        groupOf();
        expect('a copy out of step with the swap, on opening', read(target), plugin({ DESKTOPS: true, SHORTCUTS: true }));

        // A list of keys edited by hand is kept, and shown.
        write(target, plugin({ SHORTCUTS: true, SHORTCUT_KEYS: '"C V Q"' }));
        rows = groupOf();
        if (!/Cmd\+C, V and Q act as Ctrl/.test(rows.shortcuts.subtitle ?? ''))
            problems.push(`macOS keys: a list edited by hand is not shown (${rows.shortcuts.subtitle})`);
        if (!/GNOME’s own Cmd\+V gives way/.test(rows.shortcuts.subtitle ?? ''))
            problems.push(`macOS keys: the GNOME shortcuts giving way are not named (${rows.shortcuts.subtitle})`);
        rows.words.active = true;
        expect('a list edited by hand after switching words on', read(target),
            plugin({ WORDS: true, SHORTCUTS: true, SHORTCUT_KEYS: '"C V Q"' }));

        // All off takes Pear Up's file away and nothing else.
        rows.words.active = false;
        rows.shortcuts.active = false;
        expect('the plugin after switching all off', read(target), null);
        expect('another plugin after switching off', read(`${pluginDir}/20-of-my-own.lua`), 'libinput:register({1})\n');
        expect('the scroll plugin after switching off', read(`${pluginDir}/10-pear-up-scroll-acceleration.lua`),
            '-- Pear Up\nlocal SLOW_GAIN = 0.35\n');

        // Without GNOME's Ctrl+Option+← the desktop switch says it has nothing
        // to work through.
        wm.set_strv('switch-to-workspace-left', ['<Super>Page_Up']);
        rows = groupOf();
        if (!/not set/.test(rows.desktops.subtitle ?? ''))
            problems.push(`macOS keys: a missing desktop shortcut is not mentioned (${rows.desktops.subtitle})`);
        wm.reset('switch-to-workspace-left');
        if (/not set/.test(groupOf().desktops.subtitle ?? ''))
            problems.push('macOS keys: GNOME\'s default desktop shortcuts read as not set');

        // A copy from another version of Pear Up is still Pear Up's, and says so.
        write(target, `${plugin({ WORDS: true })}-- an older line\n`);
        rows = groupOf();
        expect('the switch with an older copy', rows.words.active, true);
        if (!rows.status.visible || !/another version/.test(rows.status.subtitle ?? ''))
            problems.push(`macOS keys: an older copy is not mentioned (${rows.status.subtitle})`);
        rows.words.active = false;
        expect('the older copy after switching off', read(target), null);

        // A file of the same name that is not Pear Up's is never touched.
        write(target, 'print("mine")\n');
        rows = groupOf();
        expect('the switches over a file of someone else\'s, sensitive', rows.words.sensitive, false);
        if (!rows.status.visible || !/not Pear Up/.test(rows.status.subtitle ?? ''))
            problems.push(`macOS keys: someone else's file is not explained (${rows.status.subtitle})`);
        rows.words.active = true;
        expect('someone else\'s file after the switch was set', read(target), 'print("mine")\n');
        expect('someone else\'s file after removing', preferences._setKeysPlugin(null) !== null, true);
        expect('someone else\'s file, still', read(target), 'print("mine")\n');

        // Where the directory cannot be made, the switch says so and stays off.
        reset();
        write(`${configDir}/libinput/plugins`, 'not a directory\n');
        rows = groupOf();
        rows.desktops.active = true;
        expect('the switch where the directory cannot be made', rows.desktops.active, false);
        if (!rows.status.visible || !/^Could not write/.test(rows.status.subtitle ?? ''))
            problems.push(`macOS keys: the status does not say it failed (${rows.status.subtitle})`);
        reset();

        // input-remapper: framy's preset, its backups beside it, and a preset
        // of another device that maps nothing of the kind.
        const presets = `${configDir}/input-remapper-2/presets`;
        const mapping = (codes, output) => ({
            input_combination: codes.map(code => ({ type: 1, code, origin_hash: '0c64c979fda14716c05663b585a0cbd9' })),
            target_uinput: 'keyboard', output_symbol: output, mapping_type: 'key_macro', release_combination_keys: true,
        });
        const framy = JSON.stringify([
            ...[46, 47, 45, 44, 30, 31, 33, 20, 17, 49].map(code => mapping([56, code], 'KEY_LEFTCTRL+KEY_C')),
            mapping([125, 105], 'KEY_LEFTCTRL+KEY_LEFT'), mapping([125, 106], 'KEY_LEFTCTRL+KEY_RIGHT'),
            mapping([29, 105], 'KEY_LEFTALT+KEY_LEFTCTRL+KEY_LEFT'), mapping([29, 106], 'KEY_LEFTALT+KEY_LEFTCTRL+KEY_RIGHT'),
        ], null, 4);
        write(`${presets}/AT Translated Set 2 keyboard/mac-keys.json`, framy);
        write(`${presets}/AT Translated Set 2 keyboard/mac-keys.json.bak-2026-10-11`, framy);
        write(`${presets}/Logitech Mouse/buttons.json`, JSON.stringify([mapping([275], 'KEY_BACK')]));
        rows = groupOf();
        expect('the input-remapper row with framy\'s preset', rows.remapper.visible, true);
        const said = rows.remapper.subtitle ?? '';
        if (!/“mac-keys” for AT Translated Set 2 keyboard has 4 mappings of a modifier with ←\/→ and 10 of Alt or Super/.test(said) ||
            !/twice/.test(said) || /buttons|bak/.test(said))
            problems.push(`macOS keys: the input-remapper warning is not what it should be (${said})`);
        expect('framy\'s preset after reading it', read(`${presets}/AT Translated Set 2 keyboard/mac-keys.json`), framy);
        // The 1.x format, keyed by "type,code,value+…".
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(presets)}`);
        write(`${presets}/Apple Keyboard/old.json`, JSON.stringify({ mapping: { '1,56,1+1,105,1': ['KEY_HOME', 'keyboard'] } }));
        if (!/“old” for Apple Keyboard has 1 mapping of a modifier/.test(groupOf().remapper.subtitle ?? ''))
            problems.push('macOS keys: an input-remapper 1.x preset is not read');
        // One without these keys, or not JSON at all, is no warning.
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(presets)}`);
        write(`${presets}/Apple Keyboard/plain.json`, JSON.stringify([mapping([58], 'KEY_ESC'), mapping([56, 16], 'KEY_Q')]));
        write(`${presets}/Apple Keyboard/broken.json`, '{ not json');
        expect('the input-remapper row with nothing of the kind', groupOf().remapper.visible, false);

        reset();
        swap(false);
        if (problems.length === problemsBefore)
            print('  macOS keys: three switches in one file, following the swap and keeping the key list; ' +
                'removes only its own file; warns of framy\'s input-remapper preset without touching it');
    }
}

// The floating screenshot thumbnail, with the screenshot shortcuts on the
// Keyboard page: off by default; its banner switch on by default and greyed
// out while the thumbnail is off.
{
    const problemsBefore = problems.length;
    const settings = preferences.getSettings();
    const keyboard = pages.find(page => page.title === 'Keyboard');
    const rowTitled = title => keyboard && findWidget(keyboard, widget =>
        widget instanceof Adw.SwitchRow && widget.title === title);
    const thumbnail = rowTitled('Floating Thumbnail');
    const banner = rowTitled('Hide the Screenshot Banner');
    const expect = (label, got, wanted) => {
        if (got !== wanted)
            problems.push(`screenshot thumbnail: ${label} is ${got}, expected ${wanted}`);
    };
    if (!thumbnail || !banner) {
        problems.push('the Keyboard page has no Floating Thumbnail and Hide the Screenshot Banner switches');
    } else {
        expect('the default of screenshot-thumbnail',
            settings.get_default_value('screenshot-thumbnail').unpack(), false);
        expect('the default of screenshot-thumbnail-hide-banner',
            settings.get_default_value('screenshot-thumbnail-hide-banner').unpack(), true);
        expect('"Floating Thumbnail" at first', thumbnail.active, false);
        expect('"Hide the Screenshot Banner" while the thumbnail is off, sensitive', banner.sensitive, false);
        thumbnail.active = true;
        expect('screenshot-thumbnail after switching it on', settings.get_boolean('screenshot-thumbnail'), true);
        expect('"Hide the Screenshot Banner" with the thumbnail on, sensitive', banner.sensitive, true);
        banner.active = false;
        expect('screenshot-thumbnail-hide-banner after switching it off',
            settings.get_boolean('screenshot-thumbnail-hide-banner'), false);
        settings.reset('screenshot-thumbnail');
        settings.reset('screenshot-thumbnail-hide-banner');
        expect('"Floating Thumbnail" after a reset', thumbnail.active, false);
    }
    if (problems.length === problemsBefore)
        print('  screenshot thumbnail: off by default, its banner switch greyed out until it is on');
}

// Steam: Buttons on the Left. The row is there only where Steam is, so it is
// checked in the run that has put a made-up Steam into the user's data
// directory (PREFS_SMOKE_STEAM): on patches both stylesheets and keeps the
// originals, off gives back exactly what was there.
{
    const TITLE = 'Steam: Buttons on the Left';
    const steam = GLib.getenv('PREFS_SMOKE_STEAM');
    const problemsBefore = problems.length;
    const row = windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE);
    if (!steam) {
        if (row)
            problems.push('steam buttons: the row is there with no Steam installed');
    } else if (!row) {
        problems.push('steam buttons: the Windows page has no Steam row with Steam installed');
    } else {
        const css = `${steam}/steamui/css`;
        const read = path => GLib.file_test(path, GLib.FileTest.EXISTS)
            ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null;
        const library = read(`${css}/library.css`);
        const recording = read(`${css}/gamerecording.css`);
        const pearUp = preferences.getSettings();
        const expect = windowsExpecter('steam buttons');

        const wm = preferences._settingsForSchema('org.gnome.desktop.wm.preferences');
        wm.set_string('button-layout', BUTTON_LAYOUT_LEFT);
        expect('the switch before', row.active, false);
        row.active = true;
        expect('the setting after switching on', pearUp.get_boolean('steam-buttons-left'), true);
        expect('library.css patched', read(`${css}/library.css`)?.startsWith('/* Pear Up: Steam window buttons */'), true);
        expect('the patch the original\'s size', read(`${css}/library.css`)?.length, library.length);
        expect('the original kept', read(`${css}/library.pear-up-original.css`), library);
        expect('the rules written', read(`${steam}/steamui/pear-up/window-buttons.css`)?.includes('closeButton'), true);
        expect('the switch on a fresh page',
            windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE).active, true);
        row.active = false;
        expect('the setting after switching off', pearUp.get_boolean('steam-buttons-left'), false);
        expect('library.css given back', read(`${css}/library.css`), library);
        expect('gamerecording.css given back', read(`${css}/gamerecording.css`), recording);
        expect('no original left', read(`${css}/library.pear-up-original.css`), null);
        expect('no rules left', GLib.file_test(`${steam}/steamui/pear-up`, GLib.FileTest.EXISTS), false);

        // Adwaita for Steam's patch greys the row out and is never touched.
        const adwaita = `/* Adwaita-for-Steam */\n${library.slice(23)}`;
        GLib.file_set_contents(`${css}/library.css`, adwaita);
        const greyed = windowsSwitch(windowsPageOf(new Preferences(metadata)), TITLE);
        expect('the row with Adwaita for Steam', [greyed.active, greyed.sensitive], [false, false]);
        GLib.file_set_contents(`${css}/library.css`, library);
        wm.reset('button-layout');
    }
    if (steam && problems.length === problemsBefore)
        print('  steam buttons: patches both stylesheets keeping the originals, gives them back exactly, ' +
            'and leaves Adwaita for Steam alone');
}

if (problems.length > 0) {
    for (const problem of problems)
        print(`FAIL: ${problem}`);
    system.exit(1);
}

print('preferences: every page built');
system.exit(0);

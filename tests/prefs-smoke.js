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

if (problems.length > 0) {
    for (const problem of problems)
        print(`FAIL: ${problem}`);
    system.exit(1);
}

print('preferences: every page built');
system.exit(0);

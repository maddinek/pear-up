// Reports the state of the panel to the test suite.
//
// This lives here rather than in Pear Up on purpose. A headless shell has no
// Looking Glass, and Eval refuses to run without the unsafe mode only Looking
// Glass can enable, so a test has no way to look inside a running shell. Rather
// than ship that capability to users, the ability to pry is a separate
// extension that exists only in the test container.
//
// It knows nothing about Pear Up's internals: it reads the panel the same way
// anything else would, so it stays useful even as Pear Up changes.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

const IFACE = `
<node>
  <interface name="io.github.maddinek.PearUpTestHook">
    <method name="GetPanelState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="GetMenuTree">
      <arg type="s" direction="out" name="tree"/>
    </method>
    <method name="FocusFirstWindow">
      <arg type="b" direction="out" name="focused"/>
    </method>
    <method name="HideOverview">
      <arg type="b" direction="out" name="hidden"/>
    </method>
    <method name="ActivateSearch">
      <arg type="b" direction="out" name="activated"/>
    </method>
    <method name="ClaimLeftEdge">
      <arg type="b" direction="out" name="claimed"/>
    </method>
    <method name="ReleaseLeftEdge">
      <arg type="b" direction="out" name="released"/>
    </method>
    <method name="LeftBoxOrder">
      <arg type="s" direction="out" name="roles"/>
    </method>
    <method name="AddLateIndicator">
      <arg type="s" direction="in" name="name"/>
      <arg type="b" direction="out" name="added"/>
    </method>
    <method name="RemoveLateIndicators">
      <arg type="b" direction="out" name="removed"/>
    </method>
    <method name="AddVitalsStandIn">
      <arg type="b" direction="out" name="added"/>
    </method>
    <method name="MeasureVitalsStandIn">
      <arg type="s" direction="out" name="metrics"/>
    </method>
    <method name="MeasureLateIndicators">
      <arg type="s" direction="out" name="metrics"/>
    </method>
    <method name="OpenSubMenu">
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="items"/>
    </method>
    <method name="MeasureSystemMenu">
      <arg type="s" direction="out" name="metrics"/>
    </method>
    <method name="MeasureBarTitles">
      <arg type="s" direction="out" name="metrics"/>
    </method>
    <method name="MeasureMenuGeometry">
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="geometry"/>
    </method>
    <method name="OpenTopMenu">
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="opened"/>
    </method>
    <method name="CloseTopMenu">
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="closed"/>
    </method>
    <method name="MovePointer">
      <arg type="d" direction="in" name="x"/>
      <arg type="d" direction="in" name="y"/>
      <arg type="b" direction="out" name="moved"/>
    </method>
    <method name="GetDockState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="OpenDockMenu">
      <arg type="s" direction="in" name="appId"/>
      <arg type="b" direction="out" name="opened"/>
    </method>
    <method name="CloseDockMenu">
      <arg type="s" direction="in" name="appId"/>
      <arg type="b" direction="out" name="closed"/>
    </method>
    <method name="SignalItemDrag">
      <arg type="b" direction="in" name="begin"/>
      <arg type="b" direction="out" name="signalled"/>
    </method>
    <method name="PressKeys">
      <arg type="as" direction="in" name="keys"/>
      <arg type="b" direction="out" name="pressed"/>
    </method>
    <method name="CountWindows">
      <arg type="s" direction="in" name="wmClass"/>
      <arg type="i" direction="out" name="count"/>
    </method>
    <method name="SetPowerIcon">
      <arg type="s" direction="in" name="iconName"/>
      <arg type="b" direction="out" name="set"/>
    </method>
    <method name="SetDockIconFocused">
      <arg type="s" direction="in" name="appId"/>
      <arg type="b" direction="in" name="focused"/>
      <arg type="b" direction="out" name="set"/>
    </method>
    <method name="GetSystemActions">
      <arg type="s" direction="out" name="actions"/>
    </method>
    <method name="SetSystemAction">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="in" name="available"/>
      <arg type="b" direction="in" name="notify"/>
      <arg type="b" direction="out" name="set"/>
    </method>
    <method name="OpenSystemMenu">
      <arg type="s" direction="out" name="items"/>
    </method>
    <method name="CloseSystemMenu">
      <arg type="b" direction="out" name="closed"/>
    </method>
    <method name="ActivateSystemMenuItem">
      <arg type="s" direction="in" name="prefix"/>
      <arg type="b" direction="out" name="activated"/>
    </method>
    <method name="StandInForSession">
      <arg type="b" direction="out" name="ready"/>
    </method>
    <method name="LogoutCalls">
      <arg type="s" direction="out" name="modes"/>
    </method>
    <method name="PearUpNotifications">
      <arg type="s" direction="out" name="notifications"/>
    </method>
    <method name="SaveStage">
      <arg type="s" direction="in" name="path"/>
      <arg type="b" direction="out" name="saved"/>
    </method>
    <method name="MoveClock">
      <arg type="s" direction="in" name="box"/>
      <arg type="b" direction="out" name="moved"/>
    </method>
    <method name="HoldClock">
      <arg type="s" direction="in" name="box"/>
      <arg type="b" direction="out" name="holding"/>
    </method>
    <method name="ReleaseClock">
      <arg type="i" direction="out" name="moves"/>
    </method>
    <method name="ShowTestNotification">
      <arg type="b" direction="out" name="shown"/>
    </method>
    <method name="SetBannerAlignment">
      <arg type="i" direction="in" name="align"/>
      <arg type="b" direction="out" name="set"/>
    </method>
    <method name="GetBannerState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="ShowTestOsd">
      <arg type="b" direction="out" name="shown"/>
    </method>
    <method name="HideOsd">
      <arg type="b" direction="out" name="hidden"/>
    </method>
    <method name="GetOsdState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="ShowOverview">
      <arg type="b" direction="out" name="shown"/>
    </method>
    <method name="GetWorkspaceState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="GetStartupState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="AddFakeBacklight">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="RemoveFakeBacklight">
      <arg type="b" direction="out" name="removed"/>
    </method>
    <method name="GetBrightnessState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="ClearBrightnessWrites">
      <arg type="b" direction="out" name="cleared"/>
    </method>
    <method name="SetBrightnessSlider">
      <arg type="d" direction="in" name="value"/>
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="ReadBackBacklight">
      <arg type="i" direction="in" name="brightness"/>
      <arg type="s" direction="out" name="state"/>
    </method>
  </interface>
</node>`;

const PATH = '/io/github/maddinek/PearUpTestHook';

// The one method of gnome-session that Pear Up's Log Out calls, answered by the
// hook while a test asks for it: there is no gnome-session in the container.
const SESSION_IFACE = `
<node>
  <interface name="org.gnome.SessionManager">
    <method name="Logout">
      <arg type="u" direction="in" name="mode"/>
    </method>
  </interface>
</node>`;

// The SystemActions property each action id reports through.
const ACTION_PROPERTIES = {
    'suspend': 'can-suspend',
    'restart': 'can-restart',
    'power-off': 'can-power-off',
    'lock-screen': 'can-lock-screen',
    'logout': 'can-logout',
};

// The shell promisifies these itself in screenshot.js; repeated here so the hook
// does not depend on that module having been loaded first.
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

// Items built by hand carry their label in a child actor rather than in
// `label`, so fall back to the first label found among the children.
function labelOf(item) {
    const own = item.label?.text ?? item.label;
    if (typeof own === 'string')
        return own;

    const child = item.get_children?.()
        .find(actor => typeof actor.text === 'string' && actor.text !== '');
    return child?.text ?? null;
}

// One level deep: nothing in these menus nests further than Recent Items, and
// that one is opened explicitly because it fills itself on the way open.
function describeItem(item, withChildren = true) {
    return {
        label: labelOf(item),
        sensitive: item.sensitive ?? null,
        separator: item.constructor?.name?.includes('Separator') ?? false,
        submenu: !!item.menu,
        items: withChildren && item.menu
            ? (item.menu._getMenuItems?.() ?? []).map(child => describeItem(child, false))
            : null,
    };
}

// Pear Up names its panel buttons after its own UUID, plus the System Menu.
const PEAR_UP_UUID = 'pear-up@maddinek.github.io';
const LOGO_ROLE = 'pearup-logo';
const SEARCH_ROLE = 'pearup-search';
const DECOY_ROLE = 'pear-up-test-decoy';
const LATE_ROLE_PREFIX = 'pear-up-test-late-';

// Kept here rather than on the extension object: disabling Pear Up makes the
// shell disable and enable again every extension loaded after it, this one
// included, so anything held per instance is lost exactly when the suite wants
// to see what Pear Up left behind. The indicators are the suite's to remove.
const lateIndicators = new Map();
let vitalsStandIn = null;

// A stand-in for an extension that keeps the clock where it wants it — Just
// Perfection with a position of its own, say — by moving it back whenever it is
// moved. Module-level for the same reason as the indicators: it has to outlive
// the re-enable that disabling Pear Up causes, so that it can be let go of.
let clockHolder = null;

// What the shell did while it started, as seen from this hook, which is enabled
// straight after Pear Up at login: whether the shell was still starting then,
// whether the overview was open by then, how often it began to show before the
// start finished, and whether it was open when it did. Module-level, so that the
// re-enable that disabling Pear Up causes does not start it over.
const startup = { seen: null, overviewAtEnable: null, showings: 0, overviewAtComplete: null };

function watchStartup() {
    if (startup.seen !== null)
        return;

    startup.seen = Main.layoutManager._startingUp;
    if (!startup.seen)
        return;

    startup.overviewAtEnable = Main.overview.visible;
    const showingId = Main.overview.connect('showing', () => startup.showings++);
    const completeId = Main.layoutManager.connect('startup-complete', () => {
        startup.overviewAtComplete = Main.overview.visible;
        Main.overview.disconnect(showingId);
        Main.layoutManager.disconnect(completeId);
    });
}

// A built-in screen for the brightness checks: the container's virtual monitor
// has no backlight, so the shell has no brightness to set. GNOME 49 and later
// set it through a monitor scale per backlit monitor, of a class the shell does
// not export; the shell is made to build one of its own for a monitor that
// stands in for a laptop's, whose backlight is this one. It behaves as mutter's
// does where the shell can see it: an int property, which GJS truncates a
// number to, clamped to its range, announced and written only when it changes.
// The range is framy's. Module-level, like the indicators above.
const FAKE_BACKLIGHT_MAX = 65535;
const brightnessTest = { backlight: null, writes: [] };
let FakeBacklight = null;

function fakeBacklight() {
    FakeBacklight ??= GObject.registerClass({
        GTypeName: 'PearUpTestFakeBacklight',
        Properties: {
            'brightness': GObject.ParamSpec.int('brightness', null, null,
                GObject.ParamFlags.READWRITE, 0, GLib.MAXINT32, 0),
        },
    }, class FakeBacklight extends GObject.Object {
        constructor() {
            super();
            this._target = Math.trunc(FAKE_BACKLIGHT_MAX / 2);
        }

        get brightnessMin() {
            return 0;
        }

        get brightnessMax() {
            return FAKE_BACKLIGHT_MAX;
        }

        get brightness() {
            return this._target;
        }

        set brightness(value) {
            const target = Math.min(FAKE_BACKLIGHT_MAX, Math.max(0, Math.trunc(value)));
            if (target === this._target)
                return;
            this._target = target;
            brightnessTest.writes.push([GLib.get_monotonic_time() / 1000, target]);
            this.notify('brightness');
        }

        // What mutter does when udev says the backlight changed: it reads the
        // level, and takes it for its own if it differs — one of the shell's
        // earlier writes, while a later one is still on its way, or a change
        // from outside.
        readBack(value) {
            if (value === this._target)
                return;
            this._target = value;
            this.notify('brightness');
        }
    });
    brightnessTest.backlight ??= new FakeBacklight();
    return brightnessTest.backlight;
}

const fakeMonitor = {
    get_backlight: () => brightnessTest.backlight,
    is_active: () => true,
    get_display_name: () => 'Built-in display (Pear Up test)',
};

const fakeLogicalMonitor = {
    get_monitors: () => [fakeMonitor],
    get_number: () => 0,
};

// The panel box an actor is in, by the name Pear Up's settings and the shell's
// session layouts use for it.
function panelBoxOf(actor) {
    const parent = actor?.get_parent?.() ?? null;
    if (parent === Main.panel._leftBox)
        return 'left';
    if (parent === Main.panel._centerBox)
        return 'center';
    if (parent === Main.panel._rightBox)
        return 'right';
    return parent ? 'elsewhere' : null;
}

function panelBox(name) {
    return { left: Main.panel._leftBox, center: Main.panel._centerBox, right: Main.panel._rightBox }[name] ?? null;
}

// As Just Perfection moves it: out of wherever it is and into a box at index 0.
function moveClockTo(name) {
    const container = Main.panel.statusArea.dateMenu?.container;
    const box = panelBox(name);
    if (!container || !box)
        return false;
    container.get_parent()?.remove_child(container);
    box.insert_child_at_index(container, 0);
    return true;
}

// The child-added signal, under the name this release gives it.
function childAddedSignal(actor) {
    return GObject.signal_lookup('child-added', actor.constructor.$gtype)
        ? 'child-added' : 'actor-added';
}

// The overlay Pear Up draws magnified dock icons into. Found by name, the same
// way Looking Glass would find it.
const MAGNIFIER_NAME = 'pearup-dock-magnifier';

// The weight the theme actually resolved for an actor's text, as a Pango
// weight (400 regular, 700 bold) — what is drawn, rather than what a
// stylesheet hoped for.
function fontWeight(actor) {
    try {
        return actor?.get_theme_node()?.get_font()?.get_weight() ?? null;
    } catch {
        // Unmapped actors have no theme node; treat as unreadable.
        return null;
    }
}

function stageBox(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return [x, y, width, height];
}

function rectBox(rect) {
    return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
}

// A monitor, its work area and the bar's bottom edge, to measure things placed
// within them against.
function screenGeometry(index) {
    const monitor = Main.layoutManager.monitors[index];
    const [, panelY] = Main.layoutManager.panelBox.get_transformed_position();
    return {
        monitor: rectBox(monitor),
        workArea: rectBox(Main.layoutManager.getWorkAreaForMonitor(index)),
        panelBottom: panelY + Main.layoutManager.panelBox.height,
    };
}

export default class TestHookExtension extends Extension {
    enable() {
        watchStartup();
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(Gio.DBus.session, PATH);
    }

    disable() {
        this.LogoutCalls();
        this.ReleaseLeftEdge();
        this._pointer = null;
        this._keyboard = null;
        this._export?.unexport();
        this._export = null;
    }

    _pearUpRoles() {
        return Object.keys(Main.panel.statusArea)
            .filter(role => role === LOGO_ROLE || role.startsWith(`${PEAR_UP_UUID}-`))
            .sort();
    }

    // null only when there is no button to ask about. A release without the
    // gesture class answers false, which is the true answer to "does this
    // button take clicks through a gesture" rather than a missing one.
    _usesClickGesture(button) {
        if (!button)
            return null;
        if (!Clutter.ClickGesture)
            return false;

        return (button.get_actions?.() ?? [])
            .some(action => action instanceof Clutter.ClickGesture && action.enabled);
    }

    GetPanelState() {
        const roles = Object.keys(Main.panel.statusArea);
        const layout = Main.sessionMode?.panel ?? {};
        const system = Main.panel.statusArea.quickSettings?._system;
        const powerIcon = system?._indicator ?? system;
        const activities = Main.panel.statusArea['activities'];
        const activitiesActor = activities?.container ?? activities;
        const search = Main.panel.statusArea[SEARCH_ROLE];
        const dateMenu = Main.panel.statusArea.dateMenu;
        const clockLabel = dateMenu?.label_actor ?? dateMenu;

        // What the shell thinks is in front, which is what decides whether Pear
        // Up builds any application menus at all.
        const focus = global.display.get_focus_window();
        const focusInfo = focus ? {
            title: focus.get_title(),
            wmClass: focus.get_wm_class(),
            windowType: focus.get_window_type(),
            minimized: focus.minimized,
            onWorkspace: focus.showing_on_its_workspace?.() ?? null,
        } : null;

        return JSON.stringify({
            focusWindow: focusInfo,
            windowCount: global.get_window_actors().length,
            panelRoles: roles,
            hasSystemMenu: roles.includes(LOGO_ROLE),
            menuButtons: roles.filter(r => r.startsWith(`${PEAR_UP_UUID}-`)).length,
            panelStyled: Main.panel.has_style_class_name('pearup-panel'),
            dockPlainFocus: Main.layoutManager.uiGroup.has_style_class_name('pearup-dock-plain-focus'),
            clockInRight: (layout.right ?? []).includes('dateMenu'),
            clockInCentre: (layout.center ?? []).includes('dateMenu'),
            // Where the clock actually is, which another extension can change
            // without touching the layout above.
            clockBox: panelBoxOf(dateMenu?.container),
            clockIsLastOnRight: Main.panel._rightBox.get_last_child() === dateMenu?.container,
            powerIconFound: !!powerIcon,
            powerIconVisible: powerIcon ? powerIcon.visible : null,
            powerIconName: powerIcon?.icon_name ?? null,
            // The clock's own label, and the Quick Settings button whose weight
            // the battery percentage inherits.
            clockWeight: fontWeight(clockLabel),
            statusWeight: fontWeight(Main.panel.statusArea.quickSettings),
            activitiesVisible: activitiesActor ? activitiesActor.visible : null,
            hasSearchButton: !!search,
            searchButtonVisible: search ? search.visible : null,
            overviewVisible: Main.overview.visible,
            // Which way the button is wired for clicks. Calling the handler
            // proves what a click does but not that a click can reach it, and
            // the answer differs by release: GNOME 50 recognises presses through
            // a gesture, older versions deliver an event. Reported so the suite
            // can check the wiring suits the shell it is running on.
            clutterHasClickGesture: !!Clutter.ClickGesture,
            // Ground truth: how the shell wires a panel button of its own.
            shellUsesClickGesture: this._usesClickGesture(Main.panel.statusArea.dateMenu),
            searchUsesClickGesture: this._usesClickGesture(search),
        });
    }

    // Put a window in front. A headless shell has no pointer or keyboard to do
    // it, and it starts with nothing focused at all — in the overview, unless
    // Pear Up's Start on the Desktop kept it out — so without this there is
    // never an application for the menu bar to describe.
    FocusFirstWindow() {
        Main.overview.hide();

        const actor = global.get_window_actors()
            .find(a => a.meta_window?.get_window_type() === 0);
        if (!actor)
            return false;

        actor.meta_window.activate(global.get_current_time());
        return true;
    }

    HideOverview() {
        Main.overview.hide();
        return true;
    }

    // The Quick Settings system indicator is the power glyph only where there
    // is no battery; on a laptop the shell turns it into the battery once UPower
    // answers. Whichever this session has, this makes the other the way the
    // shell's own status/system.js does: a battery gicon, or the glyph by name.
    SetPowerIcon(iconName) {
        const icon = Main.panel.statusArea.quickSettings?._system?._indicator;
        if (!icon)
            return false;

        if (iconName === 'system-shutdown-symbolic')
            icon.icon_name = iconName;
        else
            icon.set({ gicon: new Gio.ThemedIcon({ name: iconName, use_default_fallbacks: false }) });
        return true;
    }

    // The one place this reaches into Pear Up, and only because there is no way
    // around it: a headless shell has no pointer, and on GNOME 50 the button is
    // driven by a ClickGesture, which cannot be made to recognise without one.
    // Calling the handler tests what a click does — the dispatch it defers, the
    // backend it picks, the search it opens — but not Clutter's recognition of
    // the click itself, which belongs to the shell and not to this extension.
    ActivateSearch() {
        const button = Main.panel.statusArea[SEARCH_ROLE];
        if (typeof button?._activate !== 'function')
            return false;

        button._activate();
        return true;
    }

    // Stand in for the kind of extension that puts its own button at the left
    // edge of the panel — a distro logo menu, say, which is enabled by default
    // on Bazzite. Pear Up used to assume that slot was its own and inserted the
    // menu bar at fixed indices, which pushed its System Menu further right with
    // every menu it added.
    ClaimLeftEdge() {
        if (this._decoy)
            return true;

        this._decoy = new PanelMenu.Button(0.5, 'Test Decoy', true);
        this._decoy.add_child(new St.Icon({
            icon_name: 'start-here-symbolic',
            style_class: 'system-status-icon',
        }));
        Main.panel.addToStatusArea(DECOY_ROLE, this._decoy, 0, 'left');
        return true;
    }

    ReleaseLeftEdge() {
        this._decoy?.destroy();
        this._decoy = null;
        return true;
    }

    LeftBoxOrder() {
        const roles = Main.panel._leftBox.get_children().map(container => {
            const role = Object.keys(Main.panel.statusArea).find(
                r => Main.panel.statusArea[r]?.container === container);
            return role ?? 'unknown';
        });
        return JSON.stringify(roles);
    }

    // Stand in for an extension that puts an indicator on the panel after Pear Up
    // is enabled: Vitals, which loads later, or the tray icon of an app that
    // starts once the session is up. Added the way they add theirs, through
    // addToStatusArea into the right box, with nothing of Pear Up's involved.
    AddLateIndicator(name) {
        const role = `${LATE_ROLE_PREFIX}${name}`;
        if (lateIndicators.has(name))
            return false;

        const button = new PanelMenu.Button(0.5, `Test Late Indicator ${name}`, true);
        button.add_child(new St.Icon({
            icon_name: 'start-here-symbolic',
            style_class: 'system-status-icon',
        }));
        Main.panel.addToStatusArea(role, button, 0, 'right');
        lateIndicators.set(name, button);
        return true;
    }

    RemoveLateIndicators() {
        for (const button of lateIndicators.values())
            button.destroy();
        lateIndicators.clear();
        vitalsStandIn?.button.destroy();
        vitalsStandIn = null;
        return true;
    }

    // The horizontal padding each button computed after the theme and any
    // inline style, beside the Quick Settings button's, which the shell builds
    // and Pear Up has long since spaced. In theme-node lengths, which are scaled
    // by the monitor's scale factor, so that comes along to divide it out.
    MeasureLateIndicators() {
        const measure = button => {
            const node = button.get_theme_node();
            return {
                natHPadding: node.get_length('-natural-hpadding'),
                minHPadding: node.get_length('-minimum-hpadding'),
            };
        };

        return JSON.stringify({
            scale: St.ThemeContext.get_for_stage(global.stage).scale_factor,
            reference: measure(Main.panel.statusArea.quickSettings),
            indicators: Object.fromEntries(
                [...lateIndicators].map(([name, button]) => [name, measure(button)])),
        });
    }

    // Built the way Vitals builds its panel button: a box of icon and value
    // pairs, carrying the classes its stylesheet (stylesheet.css, here) styles
    // them by. Like the indicators above it arrives after Pear Up is enabled.
    AddVitalsStandIn() {
        if (vitalsStandIn)
            return false;

        const button = new PanelMenu.Button(0.5, 'Test Vitals', true);
        const menu = new St.BoxLayout({ style_class: 'vitals-panel-menu' });
        const labels = ['12%', '48\u00b0C'].map(text => {
            const item = new St.BoxLayout({ style_class: 'vitals-panel-item' });
            item.add_child(new St.Icon({
                icon_name: 'start-here-symbolic',
                style_class: 'system-status-icon',
            }));
            const label = new St.Label({
                style_class: 'vitals-panel-label',
                text,
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(label);
            menu.add_child(item);
            return label;
        });
        button.add_child(menu);
        Main.panel.addToStatusArea(`${LATE_ROLE_PREFIX}vitals`, button, 0, 'right');
        vitalsStandIn = { button, menu, label: labels[0] };
        return true;
    }

    // What the theme resolved for the readouts: the gap between them, and the
    // size and weight of a value, beside the clock's size, which is the bar's
    // own type. Sizes are Pango units, so only their ratio means anything here.
    MeasureVitalsStandIn() {
        if (!vitalsStandIn)
            return JSON.stringify(null);

        const { menu, label } = vitalsStandIn;
        const dateMenu = Main.panel.statusArea.dateMenu;
        const pangoSize = actor => actor.get_theme_node().get_font().get_size();
        return JSON.stringify({
            scale: St.ThemeContext.get_for_stage(global.stage).scale_factor,
            spacing: menu.get_theme_node().get_length('spacing'),
            labelPangoSize: pangoSize(label),
            labelWeight: fontWeight(label),
            barPangoSize: pangoSize(dateMenu?.label_actor ?? dateMenu),
        });
    }

    // The computed type size of the System Menu, after the theme and any
    // inline style have been applied. A test that only round-trips the
    // setting would stay green even if the labels never changed size.
    MeasureSystemMenu() {
        const button = Main.panel.statusArea[LOGO_ROLE];
        if (!button?.menu)
            return JSON.stringify(null);

        // The items have to be on stage for the theme node to exist, so the
        // font size is the one actually drawn rather than a style string that
        // might never have been applied.
        button.menu.open(false);

        const labels = [];
        const collect = actor => {
            if (actor instanceof St.Label && actor.text)
                labels.push(actor);
            for (const child of actor.get_children?.() ?? [])
                collect(child);
        };
        for (const item of button.menu._getMenuItems?.() ?? [])
            collect(item);

        const items = labels.slice(0, 6).map(label => {
            let pangoSize = 0;
            try {
                const font = label.get_theme_node()?.get_font();
                pangoSize = font?.get_size() ?? 0;
            } catch {
                // Unmapped actors have no theme node; treat as unreadable.
            }
            return {
                label: label.text,
                pangoSize,
                height: label.height,
                itemHeight: label.get_parent?.()?.height ?? 0,
            };
        });

        button.menu.close();
        return JSON.stringify({ items });
    }

    // The computed spacing and type of each menu-bar title, after the theme
    // and any inline style have been applied. ButtonBox derives its layout
    // from the two hpadding theme properties, so those — not a style string —
    // are what a test has to see change.
    MeasureBarTitles() {
        const titles = this._pearUpRoles()
            .filter(role => role.startsWith(PEAR_UP_UUID))
            .map(role => {
                const button = Main.panel.statusArea[role];
                if (!button)
                    return null;

                let labelPangoSize = 0;
                try {
                    labelPangoSize = button.label?.get_theme_node()
                        ?.get_font()?.get_size() ?? 0;
                } catch {
                    // Unmapped labels have no theme node; treat as unreadable.
                }

                const node = button.get_theme_node();
                return {
                    role,
                    natHPadding: node.get_length('-natural-hpadding'),
                    minHPadding: node.get_length('-minimum-hpadding'),
                    labelPangoSize,
                    labelWeight: fontWeight(button.label),
                    appMenu: button.has_style_class_name('pearup-app-menu'),
                };
            })
            .filter(Boolean);
        return JSON.stringify(titles);
    }

    // Opens a top-level dropdown by title, for a follow-up geometry read.
    // The box pointer places itself on a later frame, so the suite sleeps
    // between opening and measuring - a blocking sleep here would freeze the
    // very loop that has to do the placing.
    OpenTopMenu(label) {
        for (const role of this._pearUpRoles()) {
            const button = Main.panel.statusArea[role];
            if ((button?.label?.text ?? null) !== label || !button?.menu)
                continue;
            button.menu.open(false);
            return JSON.stringify({ role });
        }
        return JSON.stringify(null);
    }

    CloseTopMenu(label) {
        for (const role of this._pearUpRoles()) {
            const button = Main.panel.statusArea[role];
            if ((button?.label?.text ?? null) !== label || !button?.menu)
                continue;
            button.menu.close();
            return JSON.stringify({ closed: true });
        }
        return JSON.stringify(null);
    }

    // Stage coordinates of a top-level dropdown and its source button, taken
    // while the dropdown is open. A left-aligned menu puts the two left edges
    // together; this is the comparison an alignment test has to make.
    MeasureMenuGeometry(label) {
        for (const role of this._pearUpRoles()) {
            const button = Main.panel.statusArea[role];
            const title = button?.label?.text ?? null;
            if (title !== label || !button?.menu)
                continue;

            if (!button.menu.isOpen)
                return JSON.stringify(null);

            const actor = button.menu._boxPointer ?? button.menu.actor;
            const [menuX] = actor.get_transformed_position();
            const [buttonX] = button.get_transformed_position();
            const translationX = actor.translation_x;
            const finite = v => typeof v === 'number' && Number.isFinite(v);
            const geometry = {
                role,
                menuX: finite(menuX) ? Math.round(menuX) : null,
                buttonX: finite(buttonX) ? Math.round(buttonX) : null,
                menuWidth: actor.get_width(),
                translationX: finite(translationX) ? Math.round(translationX) : null,
                offset: finite(menuX) && finite(buttonX)
                    ? Math.round(menuX - buttonX) : null,
            };
            return JSON.stringify(geometry);
        }
        return JSON.stringify(null);
    }

    // A pointer of the shell's own, moved through the same input path a mouse
    // takes, so hover and crossing events reach the dock exactly as they would
    // on a desktop. A headless shell has no pointer otherwise.
    MovePointer(x, y) {
        if (!this._pointer) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        }
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        return true;
    }

    // A chord typed on a keyboard of the shell's own, through the same path a
    // real one takes, so the shell's keybindings see it. Keys are keysym names
    // such as Super_L and q, pressed in order and released in reverse.
    PressKeys(keys) {
        const keyvals = keys.map(name => Clutter[`KEY_${name}`]);
        if (keyvals.some(keyval => keyval === undefined))
            return false;
        if (!this._keyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        // Millisecond stamps, comparable to global.get_current_time().
        let time = global.get_current_time();
        for (const keyval of keyvals)
            this._keyboard.notify_keyval(time++, keyval, Clutter.KeyState.PRESSED);
        for (const keyval of [...keyvals].reverse())
            this._keyboard.notify_keyval(time++, keyval, Clutter.KeyState.RELEASED);
        return true;
    }

    CountWindows(wmClass) {
        return global.get_window_actors()
            .filter(actor => actor.meta_window?.get_wm_class() === wmClass).length;
    }

    // The right-click menu of a dock icon, opened the way Dash to Dock opens it
    // for a long press. A synthetic right click would need a pointer button the
    // shell's gestures accept, which is more than this needs to prove.
    _dockAppIcon(appId) {
        for (const dock of Main.layoutManager.uiGroup.get_children()) {
            if (dock.name !== 'dashtodockContainer' || !dock.dash?._box)
                continue;
            const item = dock.dash._box.get_children()
                .find(slot => slot.child?.app?.get_id?.() === appId);
            if (item)
                return item.child;
        }
        return null;
    }

    OpenDockMenu(appId) {
        const icon = this._dockAppIcon(appId);
        if (typeof icon?.popupMenu !== 'function')
            return false;
        icon.popupMenu();
        return true;
    }

    CloseDockMenu(appId) {
        const menu = this._dockAppIcon(appId)?._menu;
        if (!menu?.isOpen)
            return false;
        menu.close();
        return true;
    }

    // Marks a dock icon as the focused app's through Dash to Dock's own
    // `focused` property, which is what puts its `.focused` style class on —
    // the container's applications launch nothing, so none is ever in front.
    // Dash to Dock sets it again on the next focus change.
    SetDockIconFocused(appId, focused) {
        const icon = this._dockAppIcon(appId);
        if (typeof icon?.focused !== 'boolean')
            return false;
        icon.focused = focused;
        return true;
    }

    // What the overview announces when an app icon starts or stops being
    // dragged — a dock icon being reordered, say — without a drag to go with
    // it, which would need a pointer button held down through the DND grab.
    SignalItemDrag(begin) {
        if (begin)
            Main.overview.beginItemDrag(this);
        else
            Main.overview.endItemDrag(this);
        return true;
    }

    // What GNOME itself says about the system actions, which is what the System
    // Menu's items have to follow. canLogout in particular is not "may this
    // user log out": it is whether the shell offers an entry for it.
    GetSystemActions() {
        const actions = SystemActions.getDefault();
        return JSON.stringify({
            canLogout: actions.canLogout,
            canSuspend: actions.canSuspend,
            canRestart: actions.canRestart,
            canPowerOff: actions.canPowerOff,
            canLockScreen: actions.canLockScreen,
        });
    }

    // Says what the shell would say for one action, as when the answers from
    // gnome-session and polkit arrive after the menu was built — with the
    // notification the shell sends for them, or without, as polkit's changes
    // arrive. Reaches into the shell's own bookkeeping, which is the only way
    // to put the answer where a real session has it.
    SetSystemAction(id, available, notify) {
        const actions = SystemActions.getDefault();
        const action = actions._actions?.get(id);
        if (!action)
            return false;

        action.available = available;
        if (notify)
            actions.notify(ACTION_PROPERTIES[id]);
        return true;
    }

    // Opens the System Menu and reads it in the same call, before the shell
    // gets back to its main loop: what the items say at the moment the menu
    // appears, not what they come to say.
    OpenSystemMenu() {
        const menu = Main.panel.statusArea[LOGO_ROLE]?.menu;
        if (!menu)
            return JSON.stringify(null);

        menu.open(false);
        return JSON.stringify((menu._getMenuItems?.() ?? []).map(item => describeItem(item, false)));
    }

    CloseSystemMenu() {
        Main.panel.statusArea[LOGO_ROLE]?.menu?.close();
        return true;
    }

    // Activates an item of the System Menu by the start of its label, which runs
    // what a click on it runs without needing a pointer.
    ActivateSystemMenuItem(prefix) {
        const item = (Main.panel.statusArea[LOGO_ROLE]?.menu?._getMenuItems?.() ?? [])
            .find(candidate => labelOf(candidate)?.startsWith(prefix));
        if (!item)
            return false;

        item.activate(Clutter.get_current_event());
        return true;
    }

    // Answers for gnome-session until LogoutCalls() lets go of it, and records
    // what Log Out asks it. Its name is claimed asynchronously, so the suite
    // waits a moment after this before it clicks.
    StandInForSession() {
        if (this._session)
            return true;

        this._logoutModes = [];
        this._sessionExport = Gio.DBusExportedObject.wrapJSObject(SESSION_IFACE, {
            Logout: mode => {
                this._logoutModes.push(mode);
            },
        });
        this._sessionExport.export(Gio.DBus.session, '/org/gnome/SessionManager');
        this._session = Gio.bus_own_name_on_connection(Gio.DBus.session,
            'org.gnome.SessionManager', Gio.BusNameOwnerFlags.NONE, null, null);
        return true;
    }

    // The modes Log Out has asked for since StandInForSession(), and the name back.
    LogoutCalls() {
        const modes = this._logoutModes ?? [];
        if (this._session) {
            Gio.bus_unown_name(this._session);
            this._session = 0;
        }
        this._sessionExport?.unexport();
        this._sessionExport = null;
        this._logoutModes = null;
        return JSON.stringify(modes);
    }

    // What Pear Up has put in the message tray: its notifications are how it
    // says that something a click was meant to do could not be done.
    PearUpNotifications() {
        const found = [];
        for (const source of Main.messageTray.getSources()) {
            for (const notification of source.notifications ?? []) {
                // `body` is newer than the banner text of the older releases.
                if (notification.title === 'Pear Up')
                    found.push(notification.body ?? notification.bannerBodyText ?? null);
            }
        }
        return JSON.stringify(found);
    }

    // A picture of the stage, painted straight into an offscreen buffer. The
    // screencast route in assert.py needs PipeWire to agree a format with an
    // encoder, which some releases' media stacks never manage; painting the
    // stage needs nothing but the compositor, so it works wherever the shell
    // does. Answers once the file is written.
    SaveStageAsync([path], invocation) {
        this._saveStage(path).then(
            saved => invocation.return_value(new GLib.Variant('(b)', [saved])),
            e => {
                console.warn('[pear-up-test-hook] stage capture failed:', e);
                invocation.return_value(new GLib.Variant('(b)', [false]));
            });
    }

    async _saveStage(path) {
        const shooter = new Shell.Screenshot();
        const [content, scale] = await shooter.screenshot_stage_to_content();
        const stream = Gio.File.new_for_path(path)
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        await Shell.Screenshot.composite_to_stream(content.get_texture(),
            0, 0, -1, -1, scale, null, 0, 0, 1, stream);
        stream.close(null);
        return true;
    }

    _backgroundAlpha(actor) {
        try {
            return actor.get_theme_node().get_background_color().alpha;
        } catch {
            return null;
        }
    }

    // Dash to Dock's docks and what is drawn over them, in stage coordinates.
    // Reads Dash to Dock's actor tree the way Pear Up's magnifier does — its
    // dash items, each one's BaseIcon and the St.Icon inside it — but nothing
    // of Pear Up's beyond the overlay's name, so the suite compares what is on
    // screen rather than what the magnifier believes.
    GetDockState() {
        const children = Main.layoutManager.uiGroup.get_children();

        const docks = children
            .filter(actor => actor.name === 'dashtodockContainer' && actor.dash?._box)
            .map(dock => {
                const { dash } = dock;
                const slots = [...dash._box.get_children(), dash._showAppsIcon]
                    .filter(slot => slot?.visible && slot.mapped);
                const items = slots.map(slot => {
                    const base = slot.child?.icon ?? slot.icon;
                    const icon = base?.icon instanceof St.Icon ? base.icon : null;
                    const siblings = icon
                        ? base.get_parent().get_children().filter(child => child !== base)
                        : [];
                    return {
                        kind: icon ? 'icon' : 'other',
                        id: slot === dash._showAppsIcon
                            ? 'show-apps'
                            : slot.child?.app?.get_id?.() ?? null,
                        slot: stageBox(slot),
                        icon: icon ? stageBox(icon) : null,
                        opacity: icon ? base.opacity : slot.opacity,
                        siblingOpacities: siblings.map(child => child.opacity),
                        focused: slot.child?.focused ?? null,
                        // The backdrop Dash to Dock draws behind a focused
                        // (or hovered) icon: the BaseIcon's background.
                        backdropAlpha: icon ? this._backgroundAlpha(base) : null,
                        label: slot.label ? {
                            visible: slot.label.visible,
                            translation: [slot.label.translation_x, slot.label.translation_y],
                        } : null,
                    };
                });
                const next = children[children.indexOf(dock) + 1];
                return {
                    position: dock._position,
                    box: stageBox(dock),
                    background: dash._background ? stageBox(dash._background) : null,
                    backgroundOpacity: dash._background?.opacity ?? null,
                    hover: dock._box?.hover ?? null,
                    nextSibling: next?.name ?? null,
                    items,
                };
            });

        const overlays = children
            .filter(actor => actor.name === MAGNIFIER_NAME)
            .map(overlay => ({
                children: overlay.get_children().map(child => ({
                    type: child instanceof St.Icon ? 'icon'
                        : child instanceof Clutter.Clone ? 'clone' : 'other',
                    box: stageBox(child),
                    scale: [child.scale_x, child.scale_y],
                    clip: child.has_clip ? child.get_clip() : null,
                    opacity: child.opacity,
                    visible: child.visible,
                    iconSize: child instanceof St.Icon ? child.icon_size : null,
                    // What the icon actually loaded, for when a copy is there
                    // but draws nothing.
                    gicon: child.gicon?.to_string?.() ?? null,
                    fallback: child.fallback_gicon?.to_string?.() ?? null,
                    style: child.get_style?.() ?? null,
                    texture: child instanceof St.Icon && child.get_first_child() ? {
                        opacity: child.get_first_child().opacity,
                        size: [child.get_first_child().width, child.get_first_child().height],
                        content: !!child.get_first_child().content,
                    } : null,
                })),
            }));

        const [x, y] = global.get_pointer();
        return JSON.stringify({
            pointer: [x, y],
            docks,
            overlays,
            // For a failure message: what is there when no dock is found.
            uiGroup: children.map(actor => actor.name || actor.constructor.name),
        });
    }

    // Moves the clock the way Just Perfection does at its defaults whenever it
    // is enabled: once, into the centre box, with nothing left watching.
    MoveClock(name) {
        return moveClockTo(name);
    }

    // Keeps the clock in a box by moving it back whenever it lands anywhere
    // else, watching every box's child-added as Just Perfection does with a
    // clock position of its own. Its moves wait for idle, as anything moving
    // actors on GNOME 50 has to, so the two sides take turns rather than
    // recursing.
    HoldClock(name) {
        if (clockHolder || !panelBox(name))
            return false;

        const holder = { name, moves: 0, sourceId: 0, boxes: [] };
        const hold = () => {
            if (holder.sourceId)
                return;
            holder.sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                holder.sourceId = 0;
                const container = Main.panel.statusArea.dateMenu?.container;
                if (container && panelBoxOf(container) !== holder.name) {
                    holder.moves++;
                    moveClockTo(holder.name);
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        for (const box of ['left', 'center', 'right'].map(panelBox))
            holder.boxes.push([box, box.connect(childAddedSignal(box), hold)]);
        clockHolder = holder;
        moveClockTo(name);
        return true;
    }

    // Stops holding it, and says how many times it had to move it back.
    ReleaseClock() {
        const holder = clockHolder;
        clockHolder = null;
        if (!holder)
            return -1;

        for (const [box, id] of holder.boxes)
            box.disconnect(id);
        if (holder.sourceId)
            GLib.source_remove(holder.sourceId);
        return holder.moves;
    }

    // A notification from the shell itself, so its banner shows wherever the
    // message tray puts banners. Transient: it goes away on its own.
    ShowTestNotification() {
        Main.notify('Pear Up test', 'Where does the banner go?');
        return true;
    }

    // Sets where banners go the way Just Perfection does at its defaults — top
    // centre — whenever it is enabled.
    SetBannerAlignment(align) {
        Main.messageTray.bannerAlignment = align;
        return true;
    }

    GetBannerState() {
        const tray = Main.messageTray;
        const bin = tray._bannerBin;
        const shown = (bin?.get_n_children?.() ?? 0) > 0;
        return JSON.stringify({
            alignment: tray.bannerAlignment,
            shown,
            box: shown ? stageBox(bin) : null,
            ...screenGeometry(Main.layoutManager.primaryIndex),
        });
    }

    // The volume bubble, as a volume key brings it up, on every monitor.
    // GNOME 49 split show() into showOne() and showAll(); before, show() took a
    // monitor index, -1 for all of them.
    ShowTestOsd() {
        const manager = Main.osdWindowManager;
        const icon = new Gio.ThemedIcon({ name: 'audio-volume-medium-symbolic' });
        if (typeof manager.showAll === 'function')
            manager.showAll(icon, null, 0.5, 1);
        else
            manager.show(-1, icon, null, 0.5, 1);
        return true;
    }

    HideOsd() {
        Main.osdWindowManager.hideAll();
        return true;
    }

    // Each bubble window's alignment within its monitor, whether its monitor
    // constraint keeps it to the work area, and where the bubble itself is.
    GetOsdState() {
        const windows = (Main.osdWindowManager._osdWindows ?? []).filter(Boolean).map((window, index) => {
            const constraint = window.get_constraints()
                .find(c => 'work_area' in c && 'index' in c);
            const bubble = window.get_first_child();
            return {
                xAlign: window.x_align,
                yAlign: window.y_align,
                onWorkArea: constraint ? constraint.work_area : null,
                visible: window.visible,
                box: bubble && window.visible ? stageBox(bubble) : null,
                ...screenGeometry(index),
            };
        });
        return JSON.stringify({
            windows,
            styled: Main.layoutManager.uiGroup.has_style_class_name('pearup-osd-top-right'),
        });
    }

    ShowOverview() {
        Main.overview.show();
        return true;
    }

    // The desktops: which is active and how many, whether the window manager
    // has a switch popup up, and what the overview's strip of them says and
    // shows. Whether the two methods involved are the shell's own is read from
    // their source, which is what tells a method put back from a wrapper left
    // behind.
    GetWorkspaceState() {
        const manager = global.workspace_manager;
        const strip = Main.overview._overview?.controls?._thumbnailsBox ?? null;
        const source = (proto, name) => proto?.[name]?.toString() ?? '';
        return JSON.stringify({
            active: manager.get_active_workspace_index(),
            count: manager.n_workspaces,
            popup: !!Main.wm._workspaceSwitcherPopup ||
                Main.layoutManager.uiGroup.get_children()
                    .some(actor => actor instanceof WorkspaceSwitcherPopup.WorkspaceSwitcherPopup),
            dynamic: Meta.prefs_get_dynamic_workspaces(),
            stripShouldShow: strip ? strip.shouldShow : null,
            stripShown: strip ? strip.visible && strip.mapped : null,
            overviewVisible: Main.overview.visible,
            // DISPLAY_TIMEOUT is in display() on every release from 45 to 50,
            // and in no wrapper.
            popupDisplayIsShells: source(WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype, 'display')
                .includes('DISPLAY_TIMEOUT'),
            stripRuleIsShells: source(WorkspaceThumbnail.ThumbnailsBox.prototype, '_updateShouldShow')
                .includes('NUM_WORKSPACES_THRESHOLD'),
        });
    }

    // The overview's state is its controls' adjustment: 0 hidden, 1 the window
    // picker, 2 the app grid. And whether anything still stands in for the
    // overview's startup animation, an own property over the shell's method.
    GetStartupState() {
        return JSON.stringify({
            ...startup,
            startingUp: Main.layoutManager._startingUp,
            overviewVisible: Main.overview.visible,
            overviewState: Main.overview._overview?.controls?._stateAdjustment?.value ?? null,
            standIn: Object.hasOwn(Main.overview, 'runStartupAnimation'),
            panelStyle: Main.panel.style,
        });
    }

    // Has the brightness manager build its monitor scales for the stand-in
    // screen, through its own handler for a change of monitors: the monitor
    // manager's list is answered with that screen for the length of the call,
    // and nothing else runs in between.
    AddFakeBacklight() {
        const manager = Main.brightnessManager;
        if (typeof manager?._monitorsChanged !== 'function')
            return JSON.stringify({ added: false, reason: 'no brightness manager' });

        fakeBacklight();
        const monitorManager = global.backend.get_monitor_manager();
        monitorManager.get_logical_monitors = () => [fakeLogicalMonitor];
        try {
            manager._monitorsChanged();
        } finally {
            delete monitorManager.get_logical_monitors;
        }
        const scale = manager.scales[0];
        return JSON.stringify({ added: scale?.monitor === fakeLogicalMonitor, scaleClass: scale?.constructor?.name ?? null });
    }

    // The same handler with the container's own monitors, none with a backlight.
    RemoveFakeBacklight() {
        Main.brightnessManager?._monitorsChanged?.();
        return true;
    }

    // What the brightness manager has applied and to what, every level written
    // to the stand-in backlight with the time in milliseconds, and whether the
    // monitor scales' methods are the shell's own, read from their source.
    GetBrightnessState() {
        const manager = Main.brightnessManager;
        if (!manager)
            return JSON.stringify({ manager: false });

        const scale = manager.scales?.[0] ?? null;
        const proto = scale ? Object.getPrototypeOf(scale) : null;
        const source = name => proto?.[name]?.toString() ?? '';
        return JSON.stringify({
            manager: true,
            fake: scale?.monitor === fakeLogicalMonitor,
            abTarget: manager._abTarget,
            ownAccessor: Object.hasOwn(manager, 'autoBrightnessTarget'),
            dimming: manager.dimming,
            dimmingTarget: manager._dimmingTarget,
            slider: scale?.value ?? null,
            globalSlider: manager.globalScale?.value ?? null,
            backlight: brightnessTest.backlight?.brightness ?? null,
            max: FAKE_BACKLIGHT_MAX,
            setBacklightIsShells: source('setBacklight').includes('_setRelativeBrightness'),
            syncWithBacklightIsShells: source('syncWithBacklight').includes('_getRelativeBrightness'),
            writes: brightnessTest.writes,
            now: GLib.get_monotonic_time() / 1000,
        });
    }

    ClearBrightnessWrites() {
        brightnessTest.writes = [];
        return true;
    }

    // As the slider in Quick Settings sets it, or the brightness keys.
    SetBrightnessSlider(value) {
        Main.brightnessManager.globalScale.value = value;
        return this.GetBrightnessState();
    }

    ReadBackBacklight(value) {
        brightnessTest.backlight?.readBack(value);
        return this.GetBrightnessState();
    }

    // Opens a submenu by label and reports what appeared in it. Submenus whose
    // contents depend on the state of the system are filled as they open, so
    // reading them without opening one reports an empty menu.
    OpenSubMenu(label) {
        for (const role of this._pearUpRoles()) {
            const items = Main.panel.statusArea[role]?.menu?._getMenuItems?.() ?? [];
            const found = items.find(item => item.menu && labelOf(item) === label);
            if (!found)
                continue;

            found.menu.open(false);
            return JSON.stringify((found.menu._getMenuItems?.() ?? [])
                .map(item => describeItem(item, false)));
        }

        return JSON.stringify(null);
    }

    // The label on each panel button, and the items inside its menu. Enough to
    // assert that a menu offers what it should without simulating a pointer.
    GetMenuTree() {
        const menus = this._pearUpRoles().map(role => {
            const button = Main.panel.statusArea[role];
            const items = button?.menu?._getMenuItems?.() ?? [];
            return {
                role,
                label: button?.label?.text ?? null,
                items: items.map(describeItem),
            };
        });

        return JSON.stringify(menus);
    }
}

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
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

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
    <method name="OpenSubMenu">
      <arg type="s" direction="in" name="label"/>
      <arg type="s" direction="out" name="items"/>
    </method>
  </interface>
</node>`;

const PATH = '/io/github/maddinek/PearUpTestHook';

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

export default class TestHookExtension extends Extension {
    enable() {
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(Gio.DBus.session, PATH);
    }

    disable() {
        this.ReleaseLeftEdge();
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
            clockInRight: (layout.right ?? []).includes('dateMenu'),
            clockInCentre: (layout.center ?? []).includes('dateMenu'),
            powerIconFound: !!powerIcon,
            powerIconVisible: powerIcon ? powerIcon.visible : null,
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
    // it, and it starts in the overview where nothing is focused at all — so
    // without this there is never an application for the menu bar to describe.
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

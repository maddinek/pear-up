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
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
  </interface>
</node>`;

const PATH = '/io/github/maddinek/PearUpTestHook';

// Pear Up names its panel buttons after its own UUID, plus the System Menu.
const PEAR_UP_UUID = 'pear-up@maddinek.github.io';
const LOGO_ROLE = 'pearup-logo';

export default class TestHookExtension extends Extension {
    enable() {
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(Gio.DBus.session, PATH);
    }

    disable() {
        this._export?.unexport();
        this._export = null;
    }

    _pearUpRoles() {
        return Object.keys(Main.panel.statusArea)
            .filter(role => role === LOGO_ROLE || role.startsWith(`${PEAR_UP_UUID}-`))
            .sort();
    }

    GetPanelState() {
        const roles = Object.keys(Main.panel.statusArea);
        const layout = Main.sessionMode?.panel ?? {};
        const system = Main.panel.statusArea.quickSettings?._system;
        const powerIcon = system?._indicator ?? system;
        const activities = Main.panel.statusArea['activities'];
        const activitiesActor = activities?.container ?? activities;

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

    // The label on each panel button, and the items inside its menu. Enough to
    // assert that a menu offers what it should without simulating a pointer.
    GetMenuTree() {
        const describeItem = item => {
            // Separators carry no label; submenus have a menu of their own.
            const label = item.label?.text ?? item.label ?? null;
            return {
                label: typeof label === 'string' ? label : null,
                sensitive: item.sensitive ?? null,
                separator: item.constructor?.name?.includes('Separator') ?? false,
                submenu: !!item.menu,
            };
        };

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

#!/usr/bin/env python3
"""Assert that the extension actually did what it claims, in a live shell.

These are the failures a static API check cannot see. The power icon is the
example: every symbol involved existed, but the icon was hidden before the thing
that draws it had been built, so it came back on every login. Only a running
shell shows that.

State is read from the extension's own debug interface. A headless shell has no
Looking Glass, and Eval refuses to run without the unsafe mode that only Looking
Glass can enable, so there is no other way in.
"""
import json
import math
import os
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

from dock_magnification import DockChecks

UUID = sys.argv[1]
ARTIFACTS = sys.argv[2] if len(sys.argv) > 2 else "/artifacts"

HOOK_NAME = "org.gnome.Shell"
HOOK_PATH = "/io/github/maddinek/PearUpTestHook"
HOOK_IFACE = "io.github.maddinek.PearUpTestHook"

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
results = []


def call(name, path, interface, method, args=None, signature="()"):
    return bus.call_sync(
        name, path, interface, method,
        GLib.Variant(signature, args) if args else None,
        None, Gio.DBusCallFlags.NONE, 15000, None)


def check(label, condition, detail=""):
    results.append((label, bool(condition), detail))
    print(f"  {'ok  ' if condition else 'FAIL'} {label}" + (f" — {detail}" if detail else ""))
    return bool(condition)


def pear_up_gsettings(*args):
    return subprocess.run(
        ["gsettings", *args],
        env={**os.environ,
             "GSETTINGS_SCHEMA_DIR":
                 f"{os.environ.get('HOME', '/root')}/.local/share/gnome-shell"
                 f"/extensions/{UUID}/schemas"},
        capture_output=True, text=True, check=False)


def pear_up_setting(key, value):
    pear_up_gsettings("set", "org.gnome.shell.extensions.pear-up", key, value)


def pear_up_value(key):
    return pear_up_gsettings("get", "org.gnome.shell.extensions.pear-up", key).stdout.strip()


def extension_info():
    return call("org.gnome.Shell", "/org/gnome/Shell",
                "org.gnome.Shell.Extensions", "GetExtensionInfo",
                (UUID,), "(s)").unpack()[0]


def panel_state():
    raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "GetPanelState").unpack()[0]
    return json.loads(raw)


def menu_tree():
    raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "GetMenuTree").unpack()[0]
    return json.loads(raw)


# ------------------------------------------------------------ enabled state
info = extension_info()
# 1 is ACTIVE in the shell's own enumeration.
check("extension is active", info.get("state") == 1, f"state={info.get('state')}")
check("extension reported no error", not info.get("error"), info.get("error") or "none")

# ------------------------------------------------------------ what it did
try:
    state = panel_state()
except GLib.Error as exc:
    check("panel state could be read", False, exc.message.splitlines()[0])
    state = None

if state:
    with open(f"{ARTIFACTS}/panel-state.json", "w") as handle:
        json.dump(state, handle, indent=2)

    check("system menu button is on the panel", state["hasSystemMenu"],
          f"roles={state['panelRoles']}")
    check("panel carries the extension's style class", state["panelStyled"])
    check("UI group carries the dock highlight class, off by default as on macOS",
          state.get("dockPlainFocus") is True)
    check("clock moved out of the centre and to the right",
          state["clockInRight"] and not state["clockInCentre"],
          f"right={state['clockInRight']} centre={state['clockInCentre']}")
    check("Activities button is hidden", state["activitiesVisible"] is False,
          f"visible={state['activitiesVisible']}")

    check("search button is on the panel", state.get("hasSearchButton"),
          f"roles={state['panelRoles']}")

    # The regression that shipped twice: the icon existed, and was visible. The
    # one after it: on a laptop the same icon is the battery, and went too.
    # Which one this session has depends on the machine — a privileged
    # container's UPower sees the host's battery — so both are checked: the one
    # it has, then the other, made the way the shell's status/system.js makes
    # it, and back.
    if state["powerIconFound"]:
        POWER_GLYPH = "system-shutdown-symbolic"
        icon = state.get("powerIconName")
        has_battery = icon != POWER_GLYPH
        check("power icon is hidden" if not has_battery else "battery icon is not hidden",
              state["powerIconVisible"] is has_battery,
              f"visible={state['powerIconVisible']} icon={icon}")

        def power_icon_after(name):
            call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "SetPowerIcon", (name,), "(s)")
            GLib.usleep(300 * 1000)
            return panel_state()["powerIconVisible"]

        try:
            if has_battery:
                as_power = power_icon_after(POWER_GLYPH)
                as_battery = power_icon_after(icon)
            else:
                as_battery = power_icon_after("battery-level-80-symbolic")
                as_power = power_icon_after(POWER_GLYPH)
            check("a battery in that place stays visible", as_battery is True,
                  f"visible={as_battery}")
            check("the power glyph in that place is hidden", as_power is False,
                  f"visible={as_power}")
        except GLib.Error as exc:
            check("the power icon could be switched to and from a battery", False,
                  exc.message.splitlines()[0])
    else:
        print("  note: this session has no power indicator to hide")

    # The shell theme makes every panel button bold; the macOS bar is regular
    # weight throughout but for the app name (checked with the titles below).
    # Pango weights: 400 regular, 700 bold.
    check("the clock is regular weight", state.get("clockWeight") == 400,
          f"weight={state.get('clockWeight')}")
    check("the status area is regular weight", state.get("statusWeight") == 400,
          f"weight={state.get('statusWeight')}")

# ------------------------------------------------- the bar with nothing in front
# An empty desktop should carry the System Menu and nothing else. This is the
# regression that had "Nautilus File Edit View" sitting there after everything
# was minimized.
try:
    empty = menu_tree()
    app_menus = [m["label"] for m in empty if m["label"]]
    check("no application menus while nothing is in front",
          len(app_menus) == 0, f"found {app_menus}")
except GLib.Error as exc:
    check("menu structure could be read", False, exc.message.splitlines()[0])

# ------------------------------------------------------- what the search does
# The click itself cannot be delivered here — no pointer, and GNOME 50 drives
# the button with a gesture that needs one — so the handler is called and its
# effect is what gets asserted: the work is deferred by an idle tick precisely
# so it lands after the dispatch, and it should end with GNOME's own search open.
if state:
    try:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "HideOverview")
        GLib.usleep(1000 * 1000)
        before = panel_state()["overviewVisible"]

        activated = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                         "ActivateSearch").unpack()[0]
        # Long enough for the idle tick and the overview's animation.
        GLib.usleep(2 * 1000 * 1000)
        opened = panel_state()["overviewVisible"]

        check("search button reachable", activated)
        check("search opens GNOME's search", before is False and opened is True,
              f"overview before={before} after={opened}")

        # The wiring, which the call above deliberately bypasses: it proves what a
        # click does, not that one can arrive. The button has to be reachable the
        # same way the shell's own panel buttons are, or on a gesture-driven shell
        # a real press would never reach it at all — and the class merely existing
        # does not mean presses come that way.
        shell_gesture = state.get("shellUsesClickGesture")
        ours_gesture = state.get("searchUsesClickGesture")
        check("click arrives the same way the shell's own buttons receive it",
              shell_gesture is not None and shell_gesture == ours_gesture,
              f"shell={'gesture' if shell_gesture else 'event'} "
              f"ours={'gesture' if ours_gesture else 'event'}")
    except GLib.Error as exc:
        check("search button could be activated", False,
              exc.message.splitlines()[0])

# --------------------------------------------------------- what the menus hold
# Asserting the built menus rather than clicking them: this exercises the real
# structure without depending on pixel coordinates or animation timing, and it
# is where the missing System Settings entry and the description that rendered
# blank would both have shown up.
try:
    subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except FileNotFoundError:
    print("  note: gjs missing, cannot open a window")

# Wait for the window to map, then put it in front: a headless shell starts in
# the overview with nothing focused, and the menu bar describes the focused
# application.
menus = []
for _ in range(40):
    GLib.usleep(500 * 1000)
    try:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "FocusFirstWindow")
        menus = menu_tree()
    except GLib.Error:
        menus = []
    if any(menu["label"] for menu in menus):
        break

if not any(menu["label"] for menu in menus):
    # Report what the shell sees, so a failure here says why.
    try:
        seen = panel_state()
        detail = (f"windows={seen['windowCount']} focus={seen['focusWindow']}")
    except GLib.Error:
        detail = "could not read panel state"
    check("menus appear once a window is in front", False, detail)
    menus = []
else:
    check("menus appear once a window is in front", True)

if menus:
    with open(f"{ARTIFACTS}/menu-tree.json", "w") as handle:
        json.dump(menus, handle, indent=2)

    labels = {menu["label"] for menu in menus if menu["label"]}
    check("the expected menus are on the bar",
          {"File", "Edit", "View", "Go", "Window", "Help"} <= labels,
          f"found {sorted(labels)}")

    def items_of(label):
        for menu in menus:
            if menu["label"] == label:
                return [item["label"] for item in menu["items"] if item["label"]]
        return []

    for menu_label, expected in [
        ("File", {"New Window", "New Tab", "Close Window"}),
        ("Edit", {"Copy", "Paste", "Select All"}),
        ("View", {"Enter Full Screen"}),
        ("Window", {"Minimize", "Maximize", "Close"}),
        ("Go", {"Back", "Forward"}),
    ]:
        found = set(items_of(menu_label))
        check(f"{menu_label} menu offers its entries", expected <= found,
              f"missing {sorted(expected - found)}" if not expected <= found else "")

    # The GTK test window is not a file manager. Nautilus items on it is the
    # leak that made every app look like Files.
    file_leaks = {"New Folder", "Open With", "Get Info", "Move to Trash",
                  "New Nautilus Window", "Compress", "Duplicate"}
    go_leaks = {"Recents", "Documents", "Desktop", "Downloads", "Home"}
    view_stubs = {"as Icons", "as List"}
    leaked_file = file_leaks & set(items_of("File"))
    leaked_go = go_leaks & set(items_of("Go"))
    leaked_view = view_stubs & set(items_of("View"))
    check("File menu does not leak file-manager actions onto other apps",
          not leaked_file, f"leaked {sorted(leaked_file)}")
    check("Go menu does not leak folder shortcuts onto other apps",
          not leaked_go, f"leaked {sorted(leaked_go)}")
    check("View menu omits unimplemented layout items",
          not leaked_view, f"still showing {sorted(leaked_view)}")

    # ------------------------------------------ sharing the bar with a stranger
    # Found on Bazzite, whose distro logo menu owns the left edge: the menu bar
    # was inserted at fixed indices on the assumption that slot 0 belonged to
    # this extension, so every menu added pushed the System Menu one place
    # further right until it sat behind the whole bar.
    try:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "ClaimLeftEdge")
        # Rebuild the bar now that the decoy holds slot 0.
        pear_up_setting("menu-help-enabled", "false")
        GLib.usleep(500 * 1000)
        pear_up_setting("menu-help-enabled", "true")
        GLib.usleep(1500 * 1000)

        order = json.loads(
            call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "LeftBoxOrder").unpack()[0])
        logo_at = order.index("pearup-logo") if "pearup-logo" in order else -1
        menus_at = [i for i, role in enumerate(order) if role.startswith(f"{UUID}-")]

        check("the System Menu stays ahead of the menu bar when another "
              "extension owns the left edge",
              logo_at >= 0 and menus_at and logo_at < min(menus_at),
              f"order={order}")
    except (GLib.Error, ValueError) as exc:
        check("panel order could be checked against a competing extension",
              False, str(exc).splitlines()[0])
    finally:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "ReleaseLeftEdge")

    # The System Menu is the icon-only button, so it has no label of its own.
    system_menu = next((m for m in menus if m["role"] == "pearup-logo"), None)
    if system_menu:
        entries = [item["label"] for item in system_menu["items"] if item["label"]]
        check("System Menu offers About and Settings",
              {"About This System", "System Settings…"} <= set(entries),
              f"found {entries}")
        # Deliberately absent: these settings belong in GNOME Settings, and
        # nothing can put them there.
        check("System Menu has no settings entry of its own",
              not any("Pear Up" in entry for entry in entries))

        # The order the Apple menu uses. Checked as an order rather than a set,
        # because the grouping is the whole point of the arrangement.
        expected_order = ["About This System", "System Settings…", "Recent Items",
                          "Force Quit…", "Sleep", "Restart…", "Shut Down…",
                          "Lock Screen"]
        present = [entry for entry in entries if entry in expected_order]
        check("System Menu follows the macOS order",
              present == [entry for entry in expected_order if entry in present],
              f"found {present}")

        check("Log Out names the account",
              any(entry.startswith("Log Out ") and entry != "Log Out …"
                  for entry in entries),
              f"found {[e for e in entries if e.startswith('Log Out')]}")

        # ------------------------------------------- Log Out, and the power items
        # GNOME's own Log Out entry is left out on a machine with one local user
        # and no other session, and the shell's canLogout says so; macOS always
        # offers it, and so does this menu. Found as a greyed-out item on a laptop
        # with one account, and only in some sessions, because the answer also
        # depended on whether AccountsService had replied before the menu was
        # built. The answer is forced to "no" and the menu rebuilt under it, so
        # this holds on any machine whatever its accounts are.
        def hook(method, args=None, signature="()"):
            return call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, method,
                        args, signature).unpack()[0]

        def system_item(prefix):
            tree = next((m for m in menu_tree() if m["role"] == "pearup-logo"), None)
            return next((item for item in (tree["items"] if tree else [])
                         if (item["label"] or "").startswith(prefix)), None)

        try:
            hook("SetSystemAction", ("logout", False, False), "(sbb)")
            pear_up_setting("show-log-out", "false")
            GLib.usleep(500 * 1000)
            pear_up_setting("show-log-out", "true")
            GLib.usleep(800 * 1000)

            gnome = json.loads(hook("GetSystemActions"))
            logout = system_item("Log Out")
            check("Log Out is available although GNOME offers no entry of its own",
                  bool(logout) and logout["sensitive"] is True,
                  f"canLogout={gnome['canLogout']} item={logout}")

            # What a click does with gnome-session there to ask: the ordinary
            # logout, mode 0, the one with the confirmation dialog.
            hook("StandInForSession")
            GLib.usleep(500 * 1000)
            activated = hook("ActivateSystemMenuItem", ("Log Out",), "(s)")
            GLib.usleep(500 * 1000)
            modes = json.loads(hook("LogoutCalls"))
            check("Log Out asks gnome-session to end the session",
                  activated and modes == [0], f"activated={activated} modes={modes}")

            # And with nothing to ask it must not go quiet: the click has closed
            # the menu, so a notification is the only way to hear about it.
            before = json.loads(hook("PearUpNotifications"))
            hook("ActivateSystemMenuItem", ("Log Out",), "(s)")
            GLib.usleep(1200 * 1000)
            after = json.loads(hook("PearUpNotifications"))
            check("Log Out says so when there is no session to ask",
                  len(after) == len(before) + 1 and after[-1:] == ["Log Out is not available."],
                  f"before={before} after={after}")

            # Sleep, Restart, Shut Down and Lock Screen are answered by
            # gnome-session, polkit and logind some time after the menu is
            # built, and polkit's answers arrive with no notification at all.
            # So the menu asks again when it opens, and follows the ones that do
            # announce themselves. Without either a menu built too early stayed
            # greyed out for the whole session.
            hook("SetSystemAction", ("suspend", True, False), "(sbb)")
            opened = json.loads(hook("OpenSystemMenu") or "[]")
            hook("CloseSystemMenu")
            sleep = next((item for item in opened or [] if item["label"] == "Sleep"), None)
            check("Sleep reflects GNOME's answer at the moment the menu opens",
                  bool(sleep) and sleep["sensitive"] is True, f"item={sleep}")

            # Let the answers the open asked for come back, then change it again.
            GLib.usleep(800 * 1000)
            hook("SetSystemAction", ("suspend", True, True), "(sbb)")
            GLib.usleep(200 * 1000)
            on = (system_item("Sleep") or {}).get("sensitive")
            hook("SetSystemAction", ("suspend", False, True), "(sbb)")
            GLib.usleep(200 * 1000)
            off = (system_item("Sleep") or {}).get("sensitive")
            check("Sleep follows GNOME's answer when it changes",
                  on is True and off is False, f"available={on} unavailable={off}")
        except GLib.Error as exc:
            check("Log Out and the power items could be exercised", False,
                  exc.message.splitlines()[0])
        finally:
            try:
                hook("LogoutCalls")
            except GLib.Error:
                pass

        # Separators group the menu; leading, trailing or doubled ones are the
        # symptom of building them inline as items are added.
        flags = [item["separator"] for item in system_menu["items"]]
        check("System Menu separators only fall between groups",
              flags and not flags[0] and not flags[-1]
              and not any(a and b for a, b in zip(flags, flags[1:])),
              f"separator positions {[i for i, f in enumerate(flags) if f]} of {len(flags)}")

        recent = next((item for item in system_menu["items"]
                       if item["label"] == "Recent Items"), None)
        check("Recent Items is a submenu", bool(recent and recent["submenu"]))

        if recent:
            # It fills itself as it opens, so the empty state is what a shell
            # with no recent files should report — and it must say so rather
            # than offering an empty menu.
            opened = json.loads(call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                                     "OpenSubMenu", ("Recent Items",),
                                     "(s)").unpack()[0])
            labels = [item["label"] for item in (opened or []) if item["label"]]
            check("Recent Items fills itself when opened",
                  labels and (labels == ["No Recent Items"] or "Clear Menu" in labels),
                  f"found {labels}")

        # The slider writes system-menu-font-size. Assert the labels actually
        # drew at that size — not that the key was stored, and not that a
        # style string was set on a parent that the theme might ignore.
        def measure_menu_type():
            raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                       "MeasureSystemMenu").unpack()[0]
            data = json.loads(raw) if raw else None
            if not data or not data.get("items"):
                return None
            return next((item for item in data["items"]
                         if item.get("label") == "About This System"),
                        data["items"][0])

        def type_size(sample):
            if not sample:
                return 0
            return sample.get("pangoSize") or sample.get("height") or 0

        at_default = measure_menu_type()
        pear_up_setting("system-menu-font-size", "10")
        GLib.usleep(800 * 1000)
        at_small = measure_menu_type()
        pear_up_setting("system-menu-font-size", "16")
        GLib.usleep(800 * 1000)
        at_large = measure_menu_type()
        pear_up_setting("system-menu-font-size", "13")

        small, large = type_size(at_small), type_size(at_large)
        check("Menu Text Size actually changes the type on the System Menu",
              small and large and small < large,
              f"10px={at_small} default={at_default} 16px={at_large}")

        # The bar's own two sliders. Same discipline as above: read what the
        # buttons actually computed, because ButtonBox derives its spacing from
        # the hpadding theme properties and ignores CSS padding entirely — a
        # style string that sets `padding` round-trips the setting and still
        # changes nothing on screen, which is exactly how this broke once.
        def measure_bar_titles():
            raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                       "MeasureBarTitles").unpack()[0]
            return json.loads(raw) if raw else []

        at_rest = measure_bar_titles()

        # File, Edit and the rest regular; the app name bold, as on macOS. The
        # theme's own bold on .panel-button used to win over the panel's weight.
        title_weights = {m["role"]: m.get("labelWeight") for m in at_rest if not m.get("appMenu")}
        app_weights = [m.get("labelWeight") for m in at_rest if m.get("appMenu")]
        check("the menu titles are regular weight",
              title_weights and all(weight == 400 for weight in title_weights.values()),
              f"weights={title_weights}")
        check("the app name is bold, heavier than the menu titles",
              len(app_weights) == 1 and (app_weights[0] or 0) >= 700,
              f"app={app_weights} titles={sorted(set(title_weights.values()))}")

        pear_up_setting("menu-bar-padding", "18")
        pear_up_setting("menu-bar-font-size", "16")
        GLib.usleep(800 * 1000)
        at_wide = measure_bar_titles()
        pear_up_setting("menu-bar-padding", "0")
        GLib.usleep(800 * 1000)
        at_tight = measure_bar_titles()
        pear_up_setting("menu-bar-padding", "6")
        pear_up_setting("menu-bar-font-size", "13")

        def by_role(samples, field):
            return {m["role"]: m[field] for m in samples}

        if at_rest:
            rest_pad, wide_pad = by_role(at_rest, "natHPadding"), by_role(at_wide, "natHPadding")
            tight_pad = by_role(at_tight, "natHPadding")
            check("Title Padding actually spaces the bar titles",
                  wide_pad and all(
                      wide_pad[r] > tight_pad.get(r, 0) and wide_pad[r] >= rest_pad.get(r, 0)
                      for r in wide_pad),
                  f"rest={rest_pad} 18px={wide_pad} 0px={tight_pad}")

            rest_type, wide_type = by_role(at_rest, "labelPangoSize"), by_role(at_wide, "labelPangoSize")
            check("Title Size actually changes the type on the bar titles",
                  wide_type and all(
                      wide_type[r] > rest_type.get(r, 0) for r in wide_type),
                  f"default={rest_type} 16px={wide_type}")
        else:
            check("Bar titles were found to measure", False, "no pearup menu-button roles")

        # macOS alignment: each dropdown's left edge sits under its title's
        # left edge. This regressed into a rightward drift on the widest menus
        # when the offset was hand-computed from a width read before the menu
        # was allocated, so assert on real stage coordinates while open.
        #
        # A non-finite offset is the File-click crash: Clutter was given
        # translation-x: nan and the shell went with it. Dropping nulls used
        # to let the other titles carry the check.
        tree = json.loads(call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                               "GetMenuTree").unpack()[0])
        titles = [m["label"] for m in tree if m.get("label")][:4]
        offsets = {}
        translations = {}
        for label in titles:
            try:
                call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                     "OpenTopMenu", (label,), "(s)")
                # The box pointer places itself on a later frame of the shell's
                # loop; sleeping here (not inside the shell) gives it that frame.
                GLib.usleep(600 * 1000)
                raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                           "MeasureMenuGeometry", (label,), "(s)").unpack()[0]
                call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                     "CloseTopMenu", (label,), "(s)")
            except GLib.Error as exc:
                check(f"Opening {label} did not crash the shell", False,
                      exc.message.splitlines()[0])
                offsets[label] = None
                translations[label] = None
                continue
            geometry = json.loads(raw) if raw else None
            offsets[label] = geometry.get("offset") if geometry else None
            translations[label] = geometry.get("translationX") if geometry else None

        def finite_number(value):
            return isinstance(value, (int, float)) and math.isfinite(value)

        nonfinite = [label for label, value in offsets.items()
                     if not finite_number(value)]
        check("Every opened dropdown reports a finite offset, never NaN",
              bool(titles) and not nonfinite,
              f"non-finite {nonfinite} offsets {offsets}")
        nan_tx = [label for label, value in translations.items()
                  if not finite_number(value)]
        check("translation-x on an open dropdown is a finite number",
              bool(titles) and not nan_tx,
              f"non-finite {nan_tx} translationX {translations}")
        if "File" in offsets:
            check("File dropdown reports a finite offset",
                  finite_number(offsets["File"]),
                  f"offset={offsets['File']} translationX={translations.get('File')}")
        check("Dropdowns open left-aligned under their titles",
              len(offsets) >= 3 and not nonfinite and
              all(abs(value) <= 3 for value in offsets.values()),
              f"offsets {offsets}")
    else:
        check("System Menu was found", False, "no pearup-logo role")

# ------------------------------------------- a dialog is its app's window too
# GNOME's Extensions app opens an extension's preferences, Pear Up's own among
# them, as a modal dialog. The bar was built only for windows of the normal type,
# so with those preferences in front it showed the pear and nothing else: no app
# name, no menus. A dialog belongs to its app as much as any other window.
DIALOG_CLASS = "io.github.maddinek.PearUpTestDialog"
print()
print("  Dialogs:")
dialog = None
try:
    dialog = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-dialog.js"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    focus = None
    for _ in range(40):
        GLib.usleep(500 * 1000)
        focus = (panel_state().get("focusWindow") or {})
        if focus.get("wmClass") == DIALOG_CLASS:
            break
    if focus.get("wmClass") != DIALOG_CLASS:
        check("a modal window could be put in front", False, f"focus={focus}")
    elif focus.get("windowType") not in (3, 4):
        # Whether a modal window is classed as a dialog is up to the compositor,
        # and the older ones are not told it is modal at all.
        print(f"  note: this release classes the modal window as type "
              f"{focus.get('windowType')}, not as a dialog, so there is nothing to check")
    else:
        titles = set()
        for _ in range(20):
            GLib.usleep(250 * 1000)
            titles = {m["label"] for m in menu_tree() if m["label"]}
            if "File" in titles:
                break
        check("the menu bar stays while a dialog is in front",
              {"File", "Edit", "Window"} <= titles,
              f"window type {focus['windowType']}, bar shows {sorted(titles)}")
except FileNotFoundError:
    print("  note: gjs missing, cannot open a dialog")
except GLib.Error as exc:
    check("a dialog could be exercised", False, exc.message.splitlines()[0])
finally:
    if dialog:
        dialog.terminate()
        dialog.wait()
        GLib.usleep(800 * 1000)

# ------------------------------------------------------------ Cmd+Q quits
# Two windows of one app, then Cmd+Q: both have to go. Closing only the one in
# front is what GNOME's own close binding does, and what Cmd+Q used to do here.
TEST_WINDOW_CLASS = "io.github.maddinek.PearUpTestWindow"


def test_windows():
    return call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "CountWindows",
                (TEST_WINDOW_CLASS,), "(s)")[0]


print()
print("  Cmd+Q:")
try:
    subprocess.run(
        ["gsettings", "set", "org.gnome.shell.extensions.pear-up", "quit-app", "['<Super>q']"],
        env={**os.environ,
             "GSETTINGS_SCHEMA_DIR":
                 f"{os.environ.get('HOME', '/root')}/.local/share/gnome-shell"
                 f"/extensions/{UUID}/schemas"},
        capture_output=True, check=False)

    # A second launch of the same application opens another window in the
    # instance already running, so both windows belong to one app.
    for _ in range(2):
        subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        GLib.usleep(1500 * 1000)
    for _ in range(20):
        if test_windows() >= 2:
            break
        GLib.usleep(250 * 1000)
    before = test_windows()
    check("two windows of the test app are open", before >= 2, f"{before} open")

    call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "FocusFirstWindow")
    GLib.usleep(500 * 1000)
    pressed = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "PressKeys",
                   (["Super_L", "q"],), "(as)")[0]
    check("Cmd+Q could be typed", pressed)

    left = before
    for _ in range(20):
        GLib.usleep(250 * 1000)
        left = test_windows()
        if left == 0:
            break
    check("Cmd+Q quits the app, every window of it", before >= 2 and left == 0,
          f"{before} open before, {left} after")
except FileNotFoundError:
    print("  note: gjs missing, cannot open a window")
except GLib.Error as exc:
    check("Cmd+Q could be exercised", False, exc.message.splitlines()[0])

# ------------------------------------------------ indicators that arrive late
# The status area is spaced by a pass over the panel at start-up and after each
# rebuild, so an indicator added in between kept the theme's padding until the
# next lock and unlock: Vitals, which loads after Pear Up, or the tray icon of an
# app that starts once the session is up. The padding is set to values that are
# neither what the stylesheet falls back to (3px) nor the shell's own (12px), so
# an indicator nobody spaced cannot pass by chance.
def late_indicators():
    """(padding of the Quick Settings button, padding of each test indicator),
    each as (natural, minimum) in logical pixels."""
    data = json.loads(call(HOOK_NAME, HOOK_PATH, HOOK_IFACE,
                           "MeasureLateIndicators").unpack()[0])
    scale = data["scale"] or 1

    def logical(metrics):
        return (round(metrics["natHPadding"] / scale, 2),
                round(metrics["minHPadding"] / scale, 2))

    return (logical(data["reference"]),
            {name: logical(m) for name, m in data["indicators"].items()})


def add_late_indicators(*names):
    for name in names:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "AddLateIndicator", (name,), "(s)")
    # They are spaced on an idle after they arrive.
    GLib.usleep(800 * 1000)


print()
print("  indicators that arrive late:")
original_padding = pear_up_value("status-icon-padding")
if state:
    try:
        pear_up_setting("status-icon-padding", "8")
        GLib.usleep(800 * 1000)

        # A burst, as when an extension brings up several at once.
        add_late_indicators("first", "second", "third")
        reference, late = late_indicators()
        check("indicators added after start-up take the status icon padding",
              len(late) == 3 and all(m == (8, 0) for m in late.values()),
              f"setting=8 shell-built={reference} added={late}")

        pear_up_setting("status-icon-padding", "1")
        GLib.usleep(800 * 1000)
        reference, late = late_indicators()
        check("and follow the setting afterwards",
              all(m == (1, 0) for m in late.values()),
              f"setting=1 shell-built={reference} added={late}")

        # An extension that makes its indicator again, which is a new actor.
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "RemoveLateIndicators")
        add_late_indicators("again")
        reference, late = late_indicators()
        check("an indicator made again is spaced like the rest",
              late == {"again": (1, 0)} and reference == (1, 0),
              f"setting=1 shell-built={reference} added={late}")

        # Left in place for the teardown below, which checks it is let go of.
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "RemoveLateIndicators")
        add_late_indicators("survivor")
    except GLib.Error as exc:
        check("late indicators could be added and measured", False,
              exc.message.splitlines()[0])
    finally:
        pear_up_setting("status-icon-padding", original_padding)

# ----------------------------------------------------------------- Vitals
# Vitals puts its readouts in the right cluster some time after Pear Up is up,
# spaced 11px apart in the bar's type; Pear Up sets them closer and a size
# smaller. What stands in for it carries its classes and the stylesheet it
# ships, loaded after Pear Up's the way Vitals is, plus a rule that sets a size
# and weight of its own at the same specificity (hook-extension/stylesheet.css),
# so the check is also that Pear Up's rules win against them.
def vitals_readouts():
    raw = call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "MeasureVitalsStandIn").unpack()[0]
    data = json.loads(raw)
    if not data:
        return None
    scale = data["scale"] or 1
    return {
        "spacing": round(data["spacing"] / scale, 2),
        "size": round(data["labelPangoSize"] / data["barPangoSize"], 3),
        "weight": data["labelWeight"],
    }


print()
print("  Vitals:")
if state:
    try:
        call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "AddVitalsStandIn")
        GLib.usleep(800 * 1000)
        readouts = vitals_readouts()
        check("Vitals' readouts sit 5px apart, not the 11px its stylesheet asks for",
              readouts and readouts["spacing"] == 5, f"{readouts}")
        # 12px against the bar's 13px, compared as a ratio because the sizes
        # come back in Pango units.
        check("Vitals' values are 12px, a size below the bar's 13px",
              readouts and abs(readouts["size"] - 12 / 13) < 0.005, f"{readouts}")
        check("Vitals' values are regular weight, whatever its stylesheet says",
              readouts and readouts["weight"] == 400, f"{readouts}")
    except GLib.Error as exc:
        check("Vitals' readouts could be measured", False, exc.message.splitlines()[0])

# ------------------------------------------------------------ screenshot
# Recorded rather than screenshotted. A headless mutter only composites while
# something consumes its output, and the shell's screenshot API returns an empty
# buffer here even once frames are flowing — but a screencast gets real ones, so
# take a still out of the recording.
#
# On unless PEAR_UP_SCREENSHOT=0.
def record_and_extract(video_stem, shot):
    # The picture is of an empty desktop, which is what a shell with no windows
    # shows: the menu bar is bare by design until something is in front. Opening
    # an app first would make it more informative, but PipeWire then fails to
    # negotiate a format with the encoder — "no more input formats" — and no
    # recording is produced at all. Left as it is deliberately; the panel-state
    # assertions are what carry the weight.
    try:
        call("org.gnome.Shell.Screencast", "/org/gnome/Shell/Screencast",
             "org.gnome.Shell.Screencast", "Screencast",
             (video_stem, {}), "(sa{sv})")
    except GLib.Error as exc:
        print(f"  note: screencast refused ({exc.message.splitlines()[0]})")
        return 0

    GLib.usleep(3 * 1000 * 1000)

    try:
        call("org.gnome.Shell.Screencast", "/org/gnome/Shell/Screencast",
             "org.gnome.Shell.Screencast", "StopScreencast")
    except GLib.Error:
        pass

    # The file is finalised a moment after the recording stops.
    video = f"{video_stem}.webm"
    for _ in range(20):
        GLib.usleep(250 * 1000)
        if os.path.exists(video) and os.path.getsize(video) > 0:
            break

    if not os.path.exists(video):
        print("  note: no recording produced")
        return 0

    subprocess.run(
        ["gst-launch-1.0", "-q",
         "filesrc", f"location={video}", "!", "decodebin", "!",
         "videoconvert", "!", "pngenc", "snapshot=true", "!",
         "filesink", f"location={shot}"],
        capture_output=True, timeout=60, check=False)

    return os.path.getsize(shot) if os.path.exists(shot) else 0


if state and os.environ.get("PEAR_UP_SCREENSHOT", "1") != "0":
    shot = f"{ARTIFACTS}/panel.png"
    size = record_and_extract(f"{ARTIFACTS}/session", shot)
    # Reported, not asserted. Whether a recording can be made depends on the
    # release and the container's media stack — GNOME 45 manages none — and that
    # says nothing about the extension. The assertions above are the evidence.
    print(f"  note: screenshot {size // 1024} KiB" if size else
          "  note: no screenshot on this release")

# ------------------------------------------------------- dock magnification
# Last, because it switches Dash to Dock on: everything above runs against the
# stock shell, as it always has.
print()
print("  dock magnification:")
dock = DockChecks(call, check, UUID, ARTIFACTS)
try:
    dock.run()
except GLib.Error as exc:
    check("dock magnification could be exercised", False, exc.message.splitlines()[0])

# ------------------------------------------------------------ clean teardown
# Disabled with the dock still magnified, so there is something to undo.
try:
    dock.hover_before_disable()
except GLib.Error as exc:
    check("the dock could be hovered before disabling", False, exc.message.splitlines()[0])

call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
     "DisableExtension", (UUID,), "(s)")
GLib.usleep(2 * 1000 * 1000)

after = extension_info()
check("extension reports itself disabled", after.get("state") != 1,
      f"state={after.get('state')}")
check("disabling produced no error", not after.get("error"),
      after.get("error") or "none")

# The hook stays loaded, so it can report that Pear Up left nothing behind.
try:
    after_state = panel_state()
    check("no menu buttons left on the panel", after_state["menuButtons"] == 0,
          f"{after_state['menuButtons']} left")
    check("System Menu removed", not after_state["hasSystemMenu"])
    check("search button removed", not after_state.get("hasSearchButton"))
    check("panel style class removed", not after_state["panelStyled"])
    check("dock highlight class removed from the UI group",
          not after_state.get("dockPlainFocus"))
    check("clock returned to the centre", after_state["clockInCentre"],
          f"right={after_state['clockInRight']}")
    check("Activities button shown again", after_state["activitiesVisible"] is True,
          f"visible={after_state['activitiesVisible']}")
except GLib.Error as exc:
    check("panel state readable after disable", False, exc.message.splitlines()[0])

# An indicator that arrived late was spaced like the rest, so it has to be let go
# of like the rest. One made now, with Pear Up off, shows what the shell's own
# padding is, and the Quick Settings button is what it was before Pear Up.
if state:
    try:
        add_late_indicators("stock")
        reference, late = late_indicators()
        check("a late indicator is back to the shell's own padding once Pear Up is off",
              late.get("survivor") == late.get("stock") == reference,
              f"shell-built={reference} added-late={late}")
    except GLib.Error as exc:
        check("late indicators could be measured after disabling", False,
              exc.message.splitlines()[0])

# The stand-in's own stylesheet is what is left once Pear Up's rules are gone.
# Without this the checks above could be passing because nothing else was
# asking for anything different.
if state:
    try:
        readouts = vitals_readouts()
        check("Vitals' own spacing and weight show once Pear Up is off",
              readouts and readouts["spacing"] == 11 and readouts["weight"] == 700,
              f"{readouts}")
    except GLib.Error as exc:
        check("Vitals' readouts could be measured after disabling", False,
              exc.message.splitlines()[0])

if dock.ready:
    dock.check_left_nothing("Pear Up is disabled")

# ------------------------------------------------------------------ summary
failures = [label for label, ok, _ in results if not ok]
print()
print(f"{len(results) - len(failures)} of {len(results)} checks passed")
for label in failures:
    print(f"  failed: {label}")
sys.exit(1 if failures else 0)

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


def hook(method, args=None, signature="()"):
    return call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, method, args, signature).unpack()[0]


# ------------------------------------------------------------ enabled state
info = extension_info()
# 1 is ACTIVE in the shell's own enumeration.
check("extension is active", info.get("state") == 1, f"state={info.get('state')}")
check("extension reported no error", not info.get("error"), info.get("error") or "none")

# ------------------------------------------------------------ the first view
# GNOME opens the overview at login, as its startup animation; with Start on the
# Desktop on, as it is by default, the shell has to finish starting with it
# closed. The hook is enabled straight after Pear Up, so it sees whether the
# overview so much as began to show once Pear Up was in place. If the shell had
# already begun before Pear Up was enabled — the two race at login, and with no
# wallpaper to load here the shell can win — Pear Up closes it straight away.
try:
    first = json.loads(hook("GetStartupState"))
    check("the session starts on the desktop, not in the overview",
          first["startingUp"] is False and first["overviewVisible"] is False
          and first["overviewState"] == 0,
          f"overview visible={first['overviewVisible']} state={first['overviewState']} "
          f"starting={first['startingUp']}")
    if first["seen"]:
        check("the overview never began to show while the shell started",
              first["showings"] == 0, f"began to show {first['showings']} times")
        if first["overviewAtEnable"]:
            print("  note: the shell had begun to show the overview before Pear Up was enabled, "
                  "so it was closed rather than skipped; open when the start completed: "
                  f"{first['overviewAtComplete']}")
    else:
        print("  note: the shell had finished starting before the hook was enabled")
    check("nothing is left standing in for the overview's startup animation",
          first["standIn"] is False)
    # The startup animation turns the bar's transitions off while it runs, and
    # the overview closing, part-way through it or after, turns them on again.
    check("the bar keeps its transitions after the start",
          not first["panelStyle"], f"style={first['panelStyle']!r}")
except GLib.Error as exc:
    check("the first view could be read", False, exc.message.splitlines()[0])

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

# Wait for the window to map, then put it in front: a headless shell starts with
# nothing focused, and the menu bar describes the focused application.
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

# ------------------------------------------------------ the clock stays put
# Just Perfection, at its defaults, moves the clock to the centre whenever it is
# enabled — at login, at every unlock, and when it is installed mid-session — and
# the shell's layout still said right, so nothing ever put it back. The hook moves
# it the way Just Perfection does. Then it holds it in the centre the way Just
# Perfection does with a clock position of its own, moving it back each time it
# is moved: Pear Up has to let it have the clock after a few rounds rather than
# fight for as long as the session lasts.
print()
print("  the clock in the corner:")
if state:
    def clock_after(method, box, wait=800):
        hook(method, (box,), "(s)")
        GLib.usleep(wait * 1000)
        return panel_state()

    try:
        placed = panel_state()
        check("the clock is the last item on the right of the bar",
              placed.get("clockBox") == "right" and placed.get("clockIsLastOnRight"),
              f"box={placed.get('clockBox')} last={placed.get('clockIsLastOnRight')}")

        for box in ("center", "left"):
            moved = clock_after("MoveClock", box)
            check(f"moved to the {box} box by another extension, the clock comes back to the corner",
                  moved.get("clockBox") == "right" and moved.get("clockIsLastOnRight"),
                  f"box={moved.get('clockBox')} last={moved.get('clockIsLastOnRight')}")

        held = clock_after("HoldClock", "center", wait=3000)
        moves = hook("ReleaseClock")
        info = extension_info()
        check("held in the centre by another extension, Pear Up lets it have the clock "
              "after a few returns instead of fighting on",
              0 < moves <= 5 and held.get("clockBox") == "center"
              and info.get("state") == 1 and not info.get("error"),
              f"the other side moved it back {moves} times; clock in {held.get('clockBox')}; "
              f"state={info.get('state')} error={info.get('error') or 'none'}")
    except GLib.Error as exc:
        check("the clock could be moved", False, exc.message.splitlines()[0])
    finally:
        try:
            hook("ReleaseClock")
        except GLib.Error:
            pass

    # Placing it from scratch takes it back, and wins it back from a fight.
    pear_up_setting("clock-on-the-right", "false")
    GLib.usleep(800 * 1000)
    pear_up_setting("clock-on-the-right", "true")
    GLib.usleep(1500 * 1000)
    try:
        replaced = panel_state()
        check("switching Clock on the Right off and on puts it back in the corner",
              replaced.get("clockBox") == "right" and replaced.get("clockIsLastOnRight"),
              f"box={replaced.get('clockBox')}")
    except GLib.Error as exc:
        check("the clock could be read after placing it again", False, exc.message.splitlines()[0])

# --------------------------------------------- notifications and the bubble
# Clutter.ActorAlign, as the shell stores where banners and the bubble go.
START, CENTER, END = 1, 2, 3


def right_edge(box):
    return box[0] + box[2]


def banner_state():
    return json.loads(hook("GetBannerState"))


def osd_state(show=True):
    if show:
        hook("ShowTestOsd")
        # The bubble fades in over 100ms, and is laid out on the frame after.
        GLib.usleep(600 * 1000)
    data = json.loads(hook("GetOsdState"))
    if show:
        hook("HideOsd")
    return data


print()
print("  notifications and the volume bubble:")
if state:
    try:
        hook("ShowTestNotification")
        GLib.usleep(1000 * 1000)
        banner = banner_state()
        check("notification banners go to the top right", banner["alignment"] == END,
              f"alignment={banner['alignment']}")
        if banner["shown"]:
            work = banner["workArea"]
            check("and a banner is drawn against the right edge, under the bar",
                  abs(right_edge(banner["box"]) - right_edge(work)) <= 2
                  and banner["box"][1] >= banner["panelBottom"] - 1,
                  f"banner={banner['box']} work area={work} bar ends at {banner['panelBottom']}")
        else:
            print("  note: no banner was drawn here, so only its alignment is checked")

        # What Just Perfection does at its defaults whenever it is enabled.
        hook("SetBannerAlignment", (CENTER,), "(i)")
        GLib.usleep(600 * 1000)
        check("banners go back to the right after another extension centres them",
              banner_state()["alignment"] == END)

        osd = osd_state()
        windows = osd["windows"]
        placed = [w for w in windows if w["box"]]
        check("the volume bubble's windows are aligned to the top right and kept to the work area",
              windows and all(w["xAlign"] == END and w["yAlign"] == START and w["onWorkArea"] is True
                              for w in windows) and osd["styled"],
              f"{[(w['xAlign'], w['yAlign'], w['onWorkArea']) for w in windows]} styled={osd['styled']}")
        check("the volume bubble shows in the top right corner, under the bar",
              placed and all(
                  w["panelBottom"] <= w["box"][1] <= w["panelBottom"] + 20
                  and right_edge(w["workArea"]) - 20 <= right_edge(w["box"]) <= right_edge(w["workArea"])
                  for w in placed),
              f"{[(w['box'], w['workArea'], w['panelBottom']) for w in windows]}")
    except GLib.Error as exc:
        check("notifications and the volume bubble could be exercised", False,
              exc.message.splitlines()[0])

# ------------------------------------------------------------------ desktops
# Switched with the keyboard, the way GNOME's own bindings do it, so the popup
# is made by the window manager exactly as it would be: Cmd+PageDown, then back.
# A window on the first desktop gives dynamic workspaces a second one to switch
# to, and two in all, which is too few for GNOME to show the overview's strip.
def workspace_state():
    return json.loads(hook("GetWorkspaceState"))


def switch_desktop(key):
    """Types Cmd and the key; whether the switch popup was up at any moment
    while the switch happened, and the desktops after it. From outside the
    overview, which is the only place GNOME shows the popup at all."""
    if workspace_state()["overviewVisible"]:
        hook("HideOverview")
        GLib.usleep(1000 * 1000)
    hook("PressKeys", (["Super_L", key],), "(as)")
    popup = False
    # GNOME's popup stays up for 600ms, so sampling for that long sees it.
    for _ in range(12):
        GLib.usleep(50 * 1000)
        popup = popup or workspace_state()["popup"]
    GLib.usleep(400 * 1000)
    return popup, workspace_state()


print()
print("  desktops:")
if state:
    desktop_window = None
    try:
        desktop_window = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            GLib.usleep(500 * 1000)
            if test_windows() >= 1:
                break
        hook("FocusFirstWindow")
        GLib.usleep(1000 * 1000)

        before = workspace_state()
        check("while on, the popup's display and the strip's rule are Pear Up's",
              not before["popupDisplayIsShells"] and not before["stripRuleIsShells"],
              f"display is the shell's: {before['popupDisplayIsShells']}, "
              f"rule is the shell's: {before['stripRuleIsShells']}")

        popup, there = switch_desktop("Page_Down")
        check("switching desktops with the keyboard shows no popup",
              there["active"] != before["active"] and not popup,
              f"desktop {before['active']} -> {there['active']} of {there['count']}, "
              f"popup {'seen' if popup else 'not seen'}")
        popup, back = switch_desktop("Page_Up")
        check("and switching back shows none either",
              back["active"] == before["active"] and not popup,
              f"desktop {there['active']} -> {back['active']}, popup {'seen' if popup else 'not seen'}")

        check("the overview's strip of desktops is on with only two desktops",
              back["dynamic"] and back["count"] <= 2 and back["stripShouldShow"] is True,
              f"{back['count']} desktops, dynamic: {back['dynamic']}, "
              f"should show: {back['stripShouldShow']}")
        hook("ShowOverview")
        GLib.usleep(1500 * 1000)
        opened = workspace_state()
        hook("HideOverview")
        GLib.usleep(1000 * 1000)
        check("and is drawn when the overview opens",
              opened["overviewVisible"] and opened["stripShown"] is True,
              f"overview {opened['overviewVisible']}, strip shown: {opened['stripShown']}")
    except (GLib.Error, FileNotFoundError) as exc:
        check("the desktops could be switched", False, str(exc).splitlines()[0])
    finally:
        if desktop_window:
            desktop_window.terminate()
            desktop_window.wait()
            GLib.usleep(800 * 1000)

# ------------------------------------------------------- automatic brightness
# From GNOME 49 the shell sets the backlight itself, and gnome-settings-daemon
# sends it a target level over D-Bus whenever the light changes. The container
# has no backlight and no daemon, so the hook has the shell build a monitor scale
# of its own class for a stand-in screen, and the levels are sent here, through
# the shell's own D-Bus interface, the way the daemon sends them. Every level the
# shell writes to the stand-in backlight is recorded, with the time.
BRIGHTNESS = ("org.gnome.Shell.Brightness", "/org/gnome/Shell/Brightness",
              "org.gnome.Shell.Brightness")


def auto_brightness(target):
    call(*BRIGHTNESS, "SetAutoBrightnessTarget", (float(target),), "(d)")


def set_dimming(on):
    call(*BRIGHTNESS, "SetDimming", (bool(on),), "(b)")


def brightness_state():
    return json.loads(hook("GetBrightnessState"))


def brightness_slider(value):
    return json.loads(hook("SetBrightnessSlider", (float(value),), "(d)"))


def read_back(value):
    return json.loads(hook("ReadBackBacklight", (int(value),), "(i)"))


def level(bright, value=None):
    """A backlight level, as a share of its range."""
    return (bright["backlight"] if value is None else value) / bright["max"]


def expected_level(bright):
    """What the shell applies: the automatic level plus the slider's share, or
    the slider alone, capped while dimmed."""
    target = bright["slider"] if bright["abTarget"] < 0 else \
        min(1.0, max(0.0, bright["abTarget"] + bright["slider"] - 0.5))
    return min(bright["dimmingTarget"], target) if bright["dimming"] else target


def at_expected(bright):
    # Two units: GJS truncates the share to the backlight's integer.
    return abs(bright["backlight"] - expected_level(bright) * bright["max"]) <= 2


def fade_to(target, timeout=20):
    """Sends a target and waits for the automatic level to get there. The
    levels written on the way as (ms after sending, share), the state before and
    the state at the end, None if it never arrived."""
    hook("ClearBrightnessWrites")
    before = brightness_state()
    auto_brightness(target)
    arrived = None
    for _ in range(timeout * 10):
        current = brightness_state()
        if current["abTarget"] == target:
            arrived = current
            break
        GLib.usleep(100 * 1000)
    after = arrived or brightness_state()
    writes = [(time - before["now"], level(before, value)) for time, value in after["writes"]]
    return writes, before, arrived


def writes_since(bright, since):
    return [value for time, value in bright["writes"] if time >= since]


def describe(writes):
    if not writes:
        return "nothing written"
    steps = [abs(b - a) for (_, a), (_, b) in zip(writes, writes[1:])]
    return (f"{len(writes)} levels {writes[0][1]:.3f} -> {writes[-1][1]:.3f} over "
            f"{writes[-1][0] / 1000:.1f}s, largest step {max(steps, default=0):.3f}")


print()
print("  automatic brightness:")
bright = None
brightness_log = f"{ARTIFACTS}/shell.log"
if state:
    try:
        bright = brightness_state()
    except GLib.Error as exc:
        check("the brightness could be read", False, exc.message.splitlines()[0])

if bright and not bright["manager"]:
    print("  note: this shell leaves the brightness to gnome-settings-daemon, "
          "so there is nothing to smooth")
elif bright:
    try:
        added = json.loads(hook("AddFakeBacklight"))
        GLib.usleep(300 * 1000)
        bright = brightness_state()
        check("a stand-in screen has a monitor scale of the shell's own class",
              added["added"] and bright["fake"], f"{added}")
        check("Pear Up stands in for the automatic level and watches what is read back",
              bright["ownAccessor"] and not bright["setBacklightIsShells"]
              and not bright["syncWithBacklightIsShells"],
              f"own accessor: {bright['ownAccessor']}, setBacklight the shell's: "
              f"{bright['setBacklightIsShells']}, syncWithBacklight the shell's: "
              f"{bright['syncWithBacklightIsShells']}")

        # Switched on with the screen at the slider's level: it starts from
        # there rather than jumping to the first target.
        writes, before, arrived = fade_to(0.8)
        start = level(before)
        check("switched on, automatic brightness fades in from where the screen was",
              before["abTarget"] < 0 and arrived and at_expected(arrived) and writes
              and abs(writes[0][1] - start) <= 0.05
              and all(b >= a for (_, a), (_, b) in zip(writes, writes[1:])),
              f"from {start:.3f}: {describe(writes)}")

        # The jump this is for: a lamp switched off, from 80% to 30%.
        writes, before, arrived = fade_to(0.3)
        start = level(before)
        path = [start] + [value for _, value in writes]
        steps = [b - a for a, b in zip(path, path[1:])]
        half = next((time for time, value in writes if value <= (start + 0.3) / 2), None)
        check("a step from 80% to 30% fades down with no step over 5%",
              arrived and at_expected(arrived) and len(writes) >= 20
              and all(step <= 0 for step in steps) and max(-step for step in steps) <= 0.05,
              describe(writes))
        check("and takes seconds, not a frame: half-way after one to three",
              half is not None and 1000 <= half <= 3000,
              f"half-way after {half / 1000:.2f}s" if half is not None else "never half-way")

        # The slider moves the screen at once, with the automatic level as it is.
        hook("ClearBrightnessWrites")
        moved = brightness_slider(0.7)
        GLib.usleep(600 * 1000)
        settled = brightness_state()
        check("the slider applies at once, with nothing fading after it",
              moved["abTarget"] == 0.3 and at_expected(moved)
              and abs(level(moved) - 0.5) <= 0.001 and len(settled["writes"]) == 1,
              f"slider 0.7 -> level {level(moved):.3f}, {len(settled['writes'])} levels written")

        # Idle dimming caps it at once, and a level of the shell's own read back
        # while it is dimmed — the race — neither ends the dimming nor moves the
        # slider.
        undimmed = brightness_slider(0.9)
        set_dimming(True)
        GLib.usleep(200 * 1000)
        dimmed = brightness_state()
        check("idle dimming caps the screen at once",
              dimmed["dimming"] and abs(level(dimmed) - dimmed["dimmingTarget"]) <= 0.001,
              f"level {level(undimmed):.3f} -> {level(dimmed):.3f}, cap {dimmed['dimmingTarget']}")
        # The level the slider wrote a moment ago, as mutter reports it when the
        # write for the cap is still on its way.
        read_back(undimmed["backlight"])
        GLib.usleep(200 * 1000)
        raced = brightness_state()
        check("a level of its own read back while dimmed leaves dimming on and the slider where it was",
              raced["dimming"] and abs(raced["slider"] - 0.9) <= 1e-6 and at_expected(raced),
              f"dimming {raced['dimming']}, slider {raced['slider']:.3f}, level {level(raced):.3f}")
        set_dimming(False)
        GLib.usleep(200 * 1000)
        check("and undimming gives the level back at once", at_expected(brightness_state()))
        brightness_slider(0.5)

        # A change from outside: the screen stays where it was put, and the
        # automatic level is taken off it before it becomes the slider's.
        outside = round(0.62 * bright["max"]) + 1
        changed = read_back(outside)
        GLib.usleep(200 * 1000)
        changed = brightness_state()
        slider_then = level(changed, outside) - (changed["abTarget"] - 0.5)
        check("a change from outside stays put, with the automatic level taken off the slider",
              abs(changed["backlight"] - outside) <= 2 and abs(changed["slider"] - slider_then) <= 1e-3,
              f"set {level(changed, outside):.3f} from outside -> level {level(changed):.3f}, "
              f"slider {changed['slider']:.3f}, expected {slider_then:.3f}")
        brightness_slider(0.5)

        # Off, or the screen blanked, part-way through a fade: at once, and the
        # fade stops there.
        hook("ClearBrightnessWrites")
        auto_brightness(0.9)
        GLib.usleep(400 * 1000)
        fading = brightness_state()
        auto_brightness(-1)
        off = brightness_state()
        GLib.usleep(600 * 1000)
        settled = brightness_state()
        after_off = writes_since(settled, off["now"])
        check("turned off part-way through a fade, the slider's level applies at once and the fade stops",
              0.3 < fading["abTarget"] < 0.9 and off["abTarget"] == -1 and at_expected(off)
              and not after_off,
              f"was at {fading['abTarget']:.3f}, then {level(off):.3f}; "
              f"{len(after_off)} levels written after")
    except GLib.Error as exc:
        check("automatic brightness could be exercised", False, exc.message.splitlines()[0])
        bright = None

# Whether the checks after disabling have a stand-in screen to read.
smoothing = bool(bright and bright["manager"])

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

# Part-way through a fade, so that disabling has one to stop.
fading_at_disable = None
if smoothing:
    try:
        hook("ClearBrightnessWrites")
        auto_brightness(0.8)
        GLib.usleep(300 * 1000)
        fading_at_disable = brightness_state()["abTarget"]
    except GLib.Error as exc:
        check("a fade could be started before disabling", False, exc.message.splitlines()[0])

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
    check("and the clock itself is in the centre box", after_state.get("clockBox") == "center",
          f"box={after_state.get('clockBox')}")

    # GNOME's own places: banners under the centred clock, and the bubble at the
    # bottom centre of each monitor.
    check("notification banners are centred again, under the clock",
          banner_state()["alignment"] == CENTER)
    osd = osd_state()
    windows = osd["windows"]
    check("the volume bubble's windows have GNOME's alignment and constraint back",
          windows and all(w["xAlign"] == CENTER and w["yAlign"] == END and w["onWorkArea"] is False
                          for w in windows) and not osd["styled"],
          f"{[(w['xAlign'], w['yAlign'], w['onWorkArea']) for w in windows]} styled={osd['styled']}")
    placed = [w for w in windows if w["box"]]
    check("and the bubble shows at the bottom centre again",
          placed and all(
              abs(w["box"][0] + w["box"][2] / 2 - (w["monitor"][0] + w["monitor"][2] / 2)) <= 2
              and w["box"][1] + w["box"][3] > w["monitor"][1] + w["monitor"][3] / 2
              for w in placed),
          f"{[(w['box'], w['monitor']) for w in windows]}")

    desktops = workspace_state()
    check("the popup's display and the strip's rule are the shell's own again",
          desktops["popupDisplayIsShells"] and desktops["stripRuleIsShells"],
          f"display: {desktops['popupDisplayIsShells']}, rule: {desktops['stripRuleIsShells']}")
    check("the strip of desktops is off again with two desktops or fewer, as GNOME has it",
          desktops["count"] <= 2 and desktops["stripShouldShow"] is False,
          f"{desktops['count']} desktops, should show: {desktops['stripShouldShow']}")
    check("Activities button shown again", after_state["activitiesVisible"] is True,
          f"visible={after_state['activitiesVisible']}")
except GLib.Error as exc:
    check("panel state readable after disable", False, exc.message.splitlines()[0])

# Disabled part-way through a fade: where it was heading applies at once, the
# shell's own accessor and methods are back, and no timer is left behind — a
# level sent now applies at once, and nothing is written after it.
if smoothing:
    try:
        stopped = brightness_state()
        check("disabled part-way through a fade, where it was heading applies at once",
              fading_at_disable is not None and fading_at_disable < 0.8
              and stopped["abTarget"] == 0.8 and at_expected(stopped),
              f"was at {fading_at_disable}, now {stopped['abTarget']} at level {level(stopped):.3f}")
        check("the shell's own accessor and monitor scale methods are back",
              not stopped["ownAccessor"] and stopped["setBacklightIsShells"]
              and stopped["syncWithBacklightIsShells"],
              f"own accessor: {stopped['ownAccessor']}, setBacklight the shell's: "
              f"{stopped['setBacklightIsShells']}, syncWithBacklight the shell's: "
              f"{stopped['syncWithBacklightIsShells']}")
        hook("ClearBrightnessWrites")
        auto_brightness(0.4)
        jumped = brightness_state()
        GLib.usleep(600 * 1000)
        quiet = brightness_state()
        check("with Pear Up off a level applies at once, and no timer is left writing",
              jumped["abTarget"] == 0.4 and at_expected(jumped) and len(quiet["writes"]) == 1,
              f"{len(quiet['writes'])} levels written")

        # GNOME's own race, which the patch is for: reported, not asserted, as a
        # release that fixes it is no failure of Pear Up's.
        brightness_slider(0.9)
        own_level = brightness_state()["backlight"]
        set_dimming(True)
        GLib.usleep(200 * 1000)
        read_back(own_level)
        GLib.usleep(200 * 1000)
        print("  note: with Pear Up off, a level of the shell's own read back while dimmed "
              f"{'ends' if not brightness_state()['dimming'] else 'leaves'} the dimming")
        set_dimming(False)
        brightness_slider(0.5)
    except GLib.Error as exc:
        check("automatic brightness could be read after disabling", False,
              exc.message.splitlines()[0])

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

# GNOME shows no switch popup with a single desktop, so a window makes a second,
# now that nothing else here could be disturbed by one. It stays for the second
# enable below.
desktop_window = None
if state:
    try:
        desktop_window = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            GLib.usleep(500 * 1000)
            if test_windows() >= 1 and workspace_state()["count"] >= 2:
                break
        desktops = workspace_state()
        popup, moved = switch_desktop("Page_Down")
        check("with Pear Up off, switching desktops shows GNOME's popup again", popup,
              f"desktop {desktops['active']} -> {moved['active']} of {moved['count']}, "
              f"overview {moved['overviewVisible']}")
        if moved["active"] != desktops["active"]:
            switch_desktop("Page_Up")
    except (GLib.Error, FileNotFoundError) as exc:
        check("the desktops could be switched with Pear Up off", False, str(exc).splitlines()[0])

# ------------------------------------------ enabled again, as after an unlock
# The shell disables extensions at every lock and enables them again at unlock,
# in the same shell, so whatever Pear Up patched the first time is still loaded
# when it is enabled the second. Patched again on top of itself, one disable
# would leave the first wrapper behind; this enables and disables once more and
# expects the shell's own methods back, and everything else as before.
print()
print("  enabled again, as after an unlock:")
if state:
    try:
        call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
             "EnableExtension", (UUID,), "(s)")
        GLib.usleep(3 * 1000 * 1000)
        again = extension_info()
        check("Pear Up enables again with no error",
              again.get("state") == 1 and not again.get("error"),
              f"state={again.get('state')} error={again.get('error') or 'none'}")

        desktops = workspace_state()
        check("the popup is hidden and the strip shown again",
              not desktops["popupDisplayIsShells"] and not desktops["stripRuleIsShells"]
              and desktops["stripShouldShow"] is True,
              f"display is the shell's: {desktops['popupDisplayIsShells']}, "
              f"should show: {desktops['stripShouldShow']}")
        popup, moved = switch_desktop("Page_Down")
        check("and switching desktops shows no popup", not popup)
        if moved["active"] != desktops["active"]:
            switch_desktop("Page_Up")
        check("notifications go to the right again", banner_state()["alignment"] == END)
        if smoothing:
            again_bright = brightness_state()
            hook("ClearBrightnessWrites")
            auto_brightness(0.7)
            GLib.usleep(500 * 1000)
            fading = brightness_state()
            check("automatic brightness fades again, with its patches in place once",
                  again_bright["ownAccessor"] and not again_bright["setBacklightIsShells"]
                  and not again_bright["syncWithBacklightIsShells"]
                  and len(fading["writes"]) >= 3 and 0.4 < fading["abTarget"] < 0.7,
                  f"{len(fading['writes'])} levels in 0.5s, at {fading['abTarget']:.3f}")

        call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
             "DisableExtension", (UUID,), "(s)")
        GLib.usleep(2 * 1000 * 1000)
        desktops = workspace_state()
        check("disabled again, the shell's own methods are back, with nothing left wrapped",
              desktops["popupDisplayIsShells"] and desktops["stripRuleIsShells"]
              and desktops["count"] <= 2 and desktops["stripShouldShow"] is False,
              f"display: {desktops['popupDisplayIsShells']}, rule: {desktops['stripRuleIsShells']}, "
              f"should show: {desktops['stripShouldShow']}")
        osd = osd_state(show=False)
        check("and notifications and the bubble are GNOME's again",
              banner_state()["alignment"] == CENTER and not osd["styled"]
              and all(w["xAlign"] == CENTER and w["yAlign"] == END and w["onWorkArea"] is False
                      for w in osd["windows"]))
        if smoothing:
            stopped = brightness_state()
            check("and the brightness is the shell's own, at where the fade was heading",
                  not stopped["ownAccessor"] and stopped["setBacklightIsShells"]
                  and stopped["syncWithBacklightIsShells"] and stopped["abTarget"] == 0.7
                  and at_expected(stopped),
                  f"own accessor: {stopped['ownAccessor']}, at {stopped['abTarget']}")
    except GLib.Error as exc:
        check("Pear Up could be enabled and disabled again", False, exc.message.splitlines()[0])
    finally:
        if desktop_window:
            desktop_window.terminate()
            desktop_window.wait()

# The stand-in screen goes, and the brightness is left as the container had it.
if smoothing:
    try:
        auto_brightness(-1)
        set_dimming(False)
        hook("RemoveFakeBacklight")
    except GLib.Error:
        pass

# What Pear Up said about brightness in the journal: once per session at most,
# however often it was enabled, and only where there is nothing to smooth.
BRIGHTNESS_WORDS = ("automatic brightness", "backlight", "the brightness", "new brightness")
try:
    with open(brightness_log, encoding="utf-8", errors="replace") as handle:
        lines = [line.strip() for line in handle
                 if f"[{UUID}]" in line and any(word in line for word in BRIGHTNESS_WORDS)]
    said = [line for line in lines if "failed" not in line]
    failed = [line for line in lines if "failed" in line]
    if smoothing:
        check("Pear Up had nothing to say about this shell's brightness",
              not said and not failed, "; ".join(said + failed) or "nothing")
    elif bright is not None:
        check("Pear Up says once per session that there is no brightness here to smooth",
              len(said) == 1 and "gnome-settings-daemon" in said[0] and not failed,
              "; ".join(said + failed) or "nothing")
except OSError as exc:
    print(f"  note: the shell's log could not be read ({exc})")

# ------------------------------------------------------------------ summary
failures = [label for label, ok, _ in results if not ok]
print()
print(f"{len(results) - len(failures)} of {len(results)} checks passed")
for label in failures:
    print(f"  failed: {label}")
sys.exit(1 if failures else 0)

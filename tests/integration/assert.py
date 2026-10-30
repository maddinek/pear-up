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

from dock_bounce import BounceChecks
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

# ------------------------------------------- opening and closing like macOS
# The shell's animations, sampled as they run at a quarter speed. Stock GNOME
# pops a window up from a sliver at its bottom edge; with Open and Close Like
# macOS on, it grows from nine tenths around its centre, the same in both
# directions, and shrinks back to nine tenths as it fades out. A window closed
# while it is still opening has to be finished all the same, and switching the
# setting off has to give the shell its own method back. All of it with a
# stand-in for Magic Lamp in place, which keeps the method it finds when it is
# enabled and calls that, so a patch that went round it would never be reached.
def window_animations():
    return json.loads(hook("GetWindowAnimations"))


def open_and_close_test_window(close_at_once=False):
    hook("WatchWindowAnimations", (TEST_WINDOW_CLASS, 4.0), "(sd)")
    process = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(200 if close_at_once else 40):
        if test_windows() >= 1:
            break
        GLib.usleep((10 if close_at_once else 100) * 1000)
    if not close_at_once:
        GLib.usleep(2000 * 1000)
    hook("CloseWindows", (TEST_WINDOW_CLASS,), "(s)")
    GLib.usleep(2500 * 1000)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
    return window_animations()


def moving(samples):
    return [s for s in samples if "sx" in s and 0 < s["opacity"] < 255]


def opening(samples):
    """The samples of a window that has just been mapped, up to the one where
    it first stands at full size and opacity; the same window's closing comes
    later in the same series."""
    for index, s in enumerate(samples):
        if "sx" in s and s["opacity"] == 255 and s["sx"] == 1 and s["sy"] == 1:
            return samples[:index + 1]
    return samples


def uniform(samples):
    return all(abs(s["sx"] - s["sy"]) < 0.01 for s in samples)


def centred(samples):
    return all(abs(s["px"] - 0.5) < 0.01 and abs(s["py"] - 0.5) < 0.01 for s in samples)


def span(samples):
    return round(samples[-1]["t"] - samples[0]["t"]) if samples else 0


def describe_samples(samples):
    return ", ".join(f"{s['sx']:.2f}x{s['sy']:.2f}@{s['opacity']}" for s in samples[:6])


print()
print("  window open and close:")
try:
    stock = open_and_close_test_window()
    check("the test window was mapped and destroyed", stock["open"] and stock["close"],
          f"{len(stock['open'])} mapped, {len(stock['close'])} destroyed")
    stock_open = moving(opening(stock["open"][0])) if stock["open"] else []
    # GNOME 45 run headless here maps the window without animating it at all,
    # Pear Up or not; there is no shape to check there, only what is left over.
    animates = bool(stock_open) or any(
        "sx" in sample and sample["opacity"] < 255
        for series in stock["open"] for sample in series[1:])
    hook("StandInLikeMagicLamp", (True,), "(b)")
    if not animates:
        print("  note: this shell did not animate the test window at all, "
              "so only what is left behind is checked")
        pear_up_setting("macos-window-animations", "true")
        GLib.usleep(300 * 1000)
    else:
        check("stock GNOME pops a window up from a sliver (setting off)",
              stock_open and (min(s["sx"] for s in stock_open) < 0.5 or not uniform(stock_open)),
              describe_samples(stock_open))

        pear_up_setting("macos-window-animations", "true")
        GLib.usleep(300 * 1000)
        state = window_animations()
        check("the window manager's _shouldAnimateActor is wrapped while it is on, over Magic Lamp's",
              state["shouldAnimateActor"] == "wrapper", state["shouldAnimateActor"])

        mac = open_and_close_test_window()
        opened = opening(mac["open"][0]) if mac["open"] else []
        closed = mac["close"][0] if mac["close"] else []
        grow = moving(opened)
        shrink = moving(closed)
        check("a window opens growing from nine tenths, evenly, around its centre",
              len(grow) >= 3 and uniform(grow) and centred(grow)
              and min(s["sx"] for s in grow) >= 0.89,
              f"{len(grow)} samples over {span(grow)} ms: {describe_samples(grow)}")
        # Settled: a sample well after the opening and before the closing began
        # (the closing sets its own pivot a frame before the window first fades).
        whole = mac["open"][0] if mac["open"] else []
        settled = []
        for sample in whole[len(opened):]:
            if "sx" not in sample or sample["opacity"] < 255:
                break
            settled.append(sample)
        last = settled[len(settled) // 2:][:1] or [{}]
        check("it ends at full size and opacity, with the shell's pivot back",
              last[0].get("sx") == 1 and last[0].get("opacity") == 255
              and last[0].get("px") == 0 and last[0].get("py") == 0, json.dumps(last[0]))
        check("a window closes fading and shrinking to nine tenths, around its centre",
              len(shrink) >= 3 and uniform(shrink) and centred(shrink)
              and min(s["sx"] for s in shrink) >= 0.89 and max(s["sx"] for s in shrink) <= 1
              and any(s.get("gone") for s in closed),
              f"{len(shrink)} samples over {span(shrink)} ms: {describe_samples(shrink)}")
        print(f"  note: at a quarter speed the opening moved for {span(grow)} ms "
              f"(stock {span(stock_open)} ms), the closing for {span(shrink)} ms")

    rushed = open_and_close_test_window(close_at_once=True)
    check("a window closed while it opens is finished, nothing left behind",
          rushed["mapping"] == 0 and rushed["destroying"] == 0 and rushed["ownEase"] == 0
          and test_windows() == 0,
          f"mapping={rushed['mapping']} destroying={rushed['destroying']} "
          f"ownEase={rushed['ownEase']} windows={test_windows()}")

    pear_up_setting("macos-window-animations", "false")
    GLib.usleep(300 * 1000)
    state = window_animations()
    check("switched off, Magic Lamp's _shouldAnimateActor is on top again",
          state["shouldAnimateActor"] not in ("wrapper", "the shell's") and state["ownEase"] == 0,
          f"{state['shouldAnimateActor']!r}, ownEase={state['ownEase']}")
    hook("StandInLikeMagicLamp", (False,), "(b)")
    pear_up_setting("macos-window-animations", "true")
    GLib.usleep(300 * 1000)
    pear_up_setting("macos-window-animations", "false")
    GLib.usleep(300 * 1000)
    state = window_animations()
    check("on and off again alone, the shell's own method shows through, nothing on the instance",
          state["shouldAnimateActor"] == "the shell's" and not state["shouldAnimateActorOwn"],
          f"{state['shouldAnimateActor']!r}, own={state['shouldAnimateActorOwn']}")
except FileNotFoundError:
    print("  note: gjs missing, cannot open a window")
except GLib.Error as exc:
    check("window animations could be exercised", False, exc.message.splitlines()[0])
finally:
    try:
        hook("WatchWindowAnimations", ("", 1.0), "(sd)")
        hook("StandInLikeMagicLamp", (False,), "(b)")
    except GLib.Error:
        pass
    pear_up_setting("macos-window-animations", "false")

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

    # Banners that slide in from the right edge and back out, as on macOS.
    # Off by default; on, a banner should never move up or down, only along x,
    # and leave nothing of itself behind once it is gone.
    def banner_trace(ms, action):
        hook("TraceBanner", (ms,), "(u)")
        hook(action)
        GLib.usleep((ms + 300) * 1000)
        trace = json.loads(hook("GetBannerTrace"))
        return trace, [s for s in trace["samples"] if s["shown"]]

    # Until no banner is up and none is waiting: an expired banner makes way
    # for the next in the queue, which would otherwise be the one traced.
    def settle_banner():
        for _ in range(6):
            try:
                if not hook("ExpireTestNotification"):
                    return
            except GLib.Error:
                return
            GLib.usleep(1200 * 1000)

    try:
        settle_banner()
        idle = banner_state()
        check("banners slide off by default, with the shell's own methods in place",
              pear_up_value("banners-slide-from-right") == "false"
              and idle["showIsShells"] and idle["hideIsShells"],
              f"show is the shell's: {idle['showIsShells']}, hide: {idle['hideIsShells']}")

        pear_up_setting("banners-slide-from-right", "true")
        GLib.usleep(500 * 1000)
        trace, shown = banner_trace(1200, "ShowTestNotification")
        if not shown:
            print("  note: no banner was drawn here, so how it slides is not checked")
        elif not trace["animations"]:
            check("with animations off, a banner is simply there, in place",
                  all(s["tx"] == 0 and s["y"] == 0 for s in shown),
                  f"{[(s['tx'], s['y']) for s in shown[:5]]}")
        else:
            xs = [s["tx"] for s in shown]
            moving = [s for s in shown if s["tx"] > 0]
            check("switched on, a banner comes in from beyond the right edge, along x only",
                  moving and moving[0]["tx"] >= 0.5 * moving[0]["width"]
                  and all(s["y"] == 0 for s in shown)
                  and all(b <= a for a, b in zip(xs, xs[1:])) and xs[-1] == 0,
                  f"x {[round(x) for x in xs[:12]]}…; y {sorted({s['y'] for s in shown})}")
            check("and with no overshoot, and in about a third of a second",
                  min(xs) == 0 and len(moving) >= 3
                  and 150 <= (moving[-1]["t"] - shown[0]["t"]) / trace["slowDown"] <= 600,
                  f"moving for {moving[-1]['t'] - shown[0]['t']:.0f} ms over {len(moving)} samples"
                  if moving else "never moved")
            placed = banner_state()
            check("and it ends against the right edge, under the bar",
                  placed["shown"] and abs(right_edge(placed["box"]) - right_edge(placed["workArea"])) <= 2
                  and placed["box"][1] >= placed["panelBottom"] - 1,
                  f"banner={placed['box']} work area={placed['workArea']}")

            trace, shown = banner_trace(1000, "ExpireTestNotification")
            xs = [s["tx"] for s in shown]
            gone = banner_state()
            check("when its time is up it slides back out to the right, without fading, "
                  "and is put back in place once gone",
                  len(xs) >= 3 and all(b >= a for a, b in zip(xs, xs[1:]))
                  and xs[-1] >= 0.8 * shown[-1]["width"]
                  and all(s["y"] == 0 and s["opacity"] == 255 for s in shown)
                  and not gone["shown"] and gone["translationX"] == 0 and gone["trayClip"],
                  f"x {[round(x) for x in xs]}; then shown={gone['shown']} x={gone['translationX']} "
                  f"tray clipped to itself={gone['trayClip']}")
        check("nothing of the slide is left on the banner between calls",
              not any(s["ownEase"] for s in trace["samples"]) and not banner_state()["ownEase"])
        settle_banner()

        # Only from the corner: centred by someone else, banners drop as GNOME's do.
        pear_up_setting("notifications-top-right", "false")
        GLib.usleep(500 * 1000)
        trace, shown = banner_trace(800, "ShowTestNotification")
        if shown and trace["animations"]:
            check("with banners not in the corner, they drop from the top as GNOME's do",
                  all(s["tx"] == 0 for s in shown) and any(s["y"] < 0 for s in shown),
                  f"x {sorted({s['tx'] for s in shown})}; y from {min(s['y'] for s in shown)}")
        settle_banner()
        pear_up_setting("notifications-top-right", "true")

        pear_up_setting("banners-slide-from-right", "false")
        GLib.usleep(500 * 1000)
        off = banner_state()
        check("switched off, the shell's own methods are back",
              off["showIsShells"] and off["hideIsShells"] and off["translationX"] == 0
              and off["trayClip"])
        trace, shown = banner_trace(800, "ShowTestNotification")
        if shown and trace["animations"]:
            check("and banners drop from the top again",
                  all(s["tx"] == 0 for s in shown) and any(s["y"] < 0 for s in shown))
        settle_banner()
    except GLib.Error as exc:
        check("sliding banners could be exercised", False, exc.message.splitlines()[0])
    finally:
        pear_up_gsettings("reset", "org.gnome.shell.extensions.pear-up", "banners-slide-from-right")
        pear_up_gsettings("reset", "org.gnome.shell.extensions.pear-up", "notifications-top-right")

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

# ------------------------------------------------------- desktop switching
# Springy Desktop Switching (spaces-spring), read from the shell's own switch:
# the controller's progress curve, sampled by pausing it and setting its time;
# the desktops' shift beyond their progress while they are pulled past the end;
# the bump, a one-desktop switch the shell's way. Keys go through the virtual
# keyboard, so the shell's own keybinding reaches Pear Up's handler; the
# touchpad is the tracker's touchpad gesture, fed as libinput feeds it.
def switch_state():
    return json.loads(hook("GetSwitchState"))


def swipe(phase, delta=0.0):
    return json.loads(hook("SwipeTouchpad", (phase, delta), "(sd)"))


def settle(timeout=3.0):
    for _ in range(int(timeout / 0.05)):
        now = switch_state()
        if not now["switching"] and not now["others"]:
            return now
        GLib.usleep(50 * 1000)
    return switch_state()


def keyboard_switch(key):
    """Ctrl+Alt+<key>; the switch's curve, or None if nothing animated."""
    hook("PressKeys", (["Control_L", "Alt_L", key],), "(as)")
    for _ in range(40):
        sampled = json.loads(hook("SampleSwitch"))
        if sampled:
            return sampled
        GLib.usleep(10 * 1000)
    return None


def share(sampled, ms):
    """How far along the switch is at ms, from its first to its last sample."""
    first, last = sampled["samples"][0][1], sampled["samples"][-1][1]
    at = min(sampled["samples"], key=lambda s: abs(s[0] - ms))[1]
    return (at - first) / (last - first) if last != first else 1.0


def watch_bump(seconds=0.8):
    shifts = []
    for _ in range(int(seconds / 0.03)):
        now = switch_state()
        if now["switching"] and not now["gesture"] and now["indices"] == 1 and now["shift"]:
            shifts.append(now["shift"][0])
        GLib.usleep(30 * 1000)
    return shifts


SPRING_OWN = {"animateSwitch", "_prepareWorkspaceSwitch"}
RUBBER_OWN = {"confirmSwipe", "_reset", "_updateGesture", "_endGesture"}

print()
print("  desktop switching:")
spring_window = None
try:
    pear_up_setting("spaces-spring", "false")
    GLib.usleep(500 * 1000)
    off = switch_state()
    check("off by default, the desktop switch and swipe are the shell's own",
          pear_up_value("spaces-spring") == "false" and not off["controllerOwn"]
          and not off["trackerOwn"],
          f"own on the controller: {off['controllerOwn']}, on the tracker: {off['trackerOwn']}")

    spring_window = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        GLib.usleep(500 * 1000)
        if test_windows() >= 1:
            break
    hook("FocusFirstWindow")
    GLib.usleep(1000 * 1000)

    pear_up_setting("spaces-spring", "true")
    GLib.usleep(500 * 1000)
    on = switch_state()
    rubber = on["updateThroughInstance"]
    check("on, the switch is Pear Up's, and the overview's swipe is still the shell's",
          SPRING_OWN <= set(on["controllerOwn"]) and on["overviewTrackerOwn"] == []
          and (RUBBER_OWN <= set(on["trackerOwn"]) if rubber else not on["trackerOwn"]),
          f"controller: {on['controllerOwn']}, tracker: {on['trackerOwn']}, "
          f"overview's tracker: {on['overviewTrackerOwn']}")
    if not rubber:
        print("  note: this shell binds its tracker's update when it makes it, so there is "
              "no rubber band here; the spring and the bump are checked")
    animated = on["animations"]
    if not animated:
        print("  note: animations are off in this shell, so every switch is at once; "
              "checked that nothing animates, bumps or stretches")

    # On the first of two desktops (the second is the empty one GNOME adds).
    on = settle()
    first = keyboard_switch("Right") if on["active"] == 0 and on["count"] == 2 else None
    after = settle()
    steps = [b[1] - a[1] for a, b in zip(first["samples"], first["samples"][1:])] if first else []
    check("Ctrl+Alt+Right slides to the next desktop on the spring, in 380 ms"
          if animated else "Ctrl+Alt+Right switches at once, with animations off",
          (not first and after["active"] == 1) if not animated else first and 370 <= first["duration"] <= 390 and min(steps) >= -1e-9
          and 0.8 <= share(first, 140) <= 0.95 and share(first, 300) > 0.99
          and first["samples"][-1][1] == 1 and after["active"] == 1,
          (f"{first['duration']} ms, {share(first, 60):.2f} of the way at 60 ms, "
           f"{share(first, 140):.2f} at 140, {share(first, 300):.3f} at 300; "
           f"desktop {after['active']} of {after['count']}") if first
          else f"no switch animated (desktop {on['active']} of {on['count']})")

    # The last desktop: Ctrl+Alt+Right has nowhere to go.
    hook("PressKeys", (["Control_L", "Alt_L", "Right"],), "(as)")
    shifts = watch_bump()
    after = settle()
    check("Ctrl+Alt+Right on the last desktop bumps it a little to the left and back"
          if animated else "Ctrl+Alt+Right on the last desktop does nothing, with animations off",
          (not shifts and after["active"] == 1) if not animated else shifts and min(shifts) < -20 and min(shifts) > -0.06 * 1280
          and after["active"] == 1 and after["count"] == 2 and not after["switching"],
          f"shifted as far as {min(shifts) if shifts else 0:.0f} px over {len(shifts)} samples; "
          f"then desktop {after['active']} of {after['count']}, switching {after['switching']}")

    # Pulled past the last desktop with three fingers.
    swipe("begin")
    pulled = [swipe("update", 16) for _ in range(12)]
    shown = [-p["shift"][0] for p in pulled if p and p["shift"]]
    held = all(p["progress"] == 1 for p in pulled if p)
    if rubber:
        gains = [b - a for a, b in zip(shown, shown[1:])]
        base = pulled[-1]["base"] if pulled[-1] else 0
        check("pulled past the last desktop, it follows with growing resistance",
              len(shown) == 12 and held and shown[0] > 0 and min(gains) > 0
              and all(b < a for a, b in zip(gains, gains[1:])) and shown[-1] < 0.15 * base,
              f"shown {shown[0]:.0f}, {shown[5]:.0f}, {shown[-1]:.0f} px for a pull of "
              f"16, 96, 192 of 400 a desktop; progress held at the end: {held}"
              if len(shown) == 12 else f"{pulled[-1]}")
    else:
        check("pulled past the last desktop, it stops there as before",
              held and not any(shown), f"shown {shown}, progress held: {held}")
    swipe("end")
    back = []
    for _ in range(40):
        now = switch_state()
        back.append(-now["shift"][0] if now["shift"] else 0)
        if not now["switching"]:
            break
        GLib.usleep(30 * 1000)
    after = settle()
    if rubber:
        check("let go, it springs back onto the last desktop",
              back and back[0] > 0 and back[-1] == 0
              and all(b <= a + 0.5 for a, b in zip(back, back[1:]))
              and after["active"] == 1 and not after["switching"],
              f"{len(back)} samples from {back[0]:.0f} px to {back[-1]:.0f}; "
              f"desktop {after['active']}" if back else "nothing")
    else:
        check("let go, it stays on the last desktop", after["active"] == 1 and not after["switching"])

    # Half a desktop back towards the first, and let go.
    swipe("begin")
    for _ in range(10):
        swipe("update", -24)
    swipe("end")
    released = json.loads(hook("SampleSwitch"))
    after = settle()
    if released:
        samples = released["samples"]
        speed = (samples[0][1] - samples[1][1]) / samples[1][0]
    check("let go part way, the slide lands on the spring, as fast as the fingers to begin with"
          if animated else "let go part way, it lands at once, with animations off",
          (not released and after["active"] == 0) if not animated else released and 410 <= released["duration"] <= 430 and samples[-1][1] == 0
          and 0.7 < speed / (24 / 16 / 400) < 1.3 and after["active"] == 0,
          f"{released['duration']} ms, starting at {speed * 1000:.2f} desktops/s against the "
          f"fingers' {24 / 16 / 400 * 1000:.2f}; desktop {after['active']}" if released
          else "nothing animated")

    # Off again: everything the shell's, and the shell's switch and dead stop.
    pear_up_setting("spaces-spring", "false")
    GLib.usleep(500 * 1000)
    off = switch_state()
    check("off again, nothing of Pear Up's is left on the switch or the tracker",
          not off["controllerOwn"] and not off["trackerOwn"],
          f"controller: {off['controllerOwn']}, tracker: {off['trackerOwn']}")
    plain = keyboard_switch("Right")
    settle()
    check("and Ctrl+Alt+Right is GNOME's 250 ms slide again",
          (plain and plain["duration"] == 250) if animated else not plain, f"{plain['duration'] if plain else 'no'} ms")
    hook("PressKeys", (["Control_L", "Alt_L", "Right"],), "(as)")
    shifts = watch_bump(0.5)
    swipe("begin")
    pulled = [swipe("update", 16) for _ in range(6)]
    swipe("end")
    after = settle()
    check("with no bump and no stretch at the end",
          not shifts and not any(p["shift"][0] for p in pulled if p and p["shift"])
          and after["active"] == 1,
          f"bump samples {len(shifts)}, shifts {[p['shift'] for p in pulled if p]}")

    # Switched on and off in quick succession, as a lock and unlock does.
    for value in ("true", "false", "true", "false"):
        pear_up_setting("spaces-spring", value)
        GLib.usleep(150 * 1000)
    GLib.usleep(400 * 1000)
    off = switch_state()
    check("switched on and off repeatedly, it leaves nothing behind",
          not off["controllerOwn"] and not off["trackerOwn"] and not off["others"])
except (GLib.Error, FileNotFoundError, KeyError, TypeError) as exc:
    check("desktop switching could be exercised", False, str(exc).splitlines()[0])
finally:
    pear_up_setting("spaces-spring", "false")
    # Back on the first desktop, with the window, so its closing leaves the
    # one desktop the later checks expect.
    try:
        if switch_state()["active"] != 0:
            hook("PressKeys", (["Control_L", "Alt_L", "Left"],), "(as)")
            settle()
    except GLib.Error:
        pass
    if spring_window:
        spring_window.terminate()
        spring_window.wait()
        GLib.usleep(800 * 1000)

try:
    with open(os.path.join(ARTIFACTS, "shell.log"), encoding="utf-8", errors="replace") as handle:
        spring_lines = [line.strip() for line in handle
                        if f"[{UUID}]" in line and ("spring" in line or "desktop" in line
                                                    or "stretch" in line or "bump" in line)]
    failed = [line for line in spring_lines if "failed" in line]
    check("nothing about desktop switching failed in the journal", not failed,
          "; ".join(failed) or "nothing")
except OSError as exc:
    print(f"  note: the shell's log could not be read ({exc})")

# ------------------------------------------------- swipe direction like macOS
# Swipe Between Desktops Like macOS (macos-gesture-direction). GNOME turns its
# three-finger swipes round with Natural Scrolling off; macOS never does. Each
# swipe goes through the gesture's own event handler, as the touchpad feeds it,
# with Natural Scrolling on and off: fingers to the left should bring in the
# desktop on the right (the tracker's progress rises), fingers up should open
# the overview, whenever the switch is on, and only with Natural Scrolling on
# when it is off. The setting itself must never change.
def touchpad_natural(value=None):
    if value is not None:
        subprocess.run(["gsettings", "set", "org.gnome.desktop.peripherals.touchpad",
                        "natural-scroll", value], check=False)
        GLib.usleep(200 * 1000)
    return subprocess.run(["gsettings", "get", "org.gnome.desktop.peripherals.touchpad",
                           "natural-scroll"], capture_output=True, text=True,
                          check=False).stdout.strip()


def gesture_state():
    return json.loads(hook("GetGestureState"))


def feed_swipe(target, dx, dy, steps=5):
    return json.loads(hook("FeedSwipe", (target, dx, dy, steps), "(sddi)"))


def overview_closed(timeout=3.0):
    for _ in range(int(timeout / 0.05)):
        if not json.loads(hook("GetStartupState"))["overviewVisible"]:
            return True
        GLib.usleep(50 * 1000)
    return False


def swipe_directions():
    """Which way fingers left and fingers up went: True is the macOS way."""
    left = feed_swipe("desktops", -16, 0)
    settle()
    up = feed_swipe("overview", 0, -16)
    overview_closed()
    return {
        "left": left and sum(left["deltas"]) > 0 and max(left["progress"] or [0]) > 0.1,
        "leftBack": left and sum(left["deltas"]) < 0 and max(left["progress"] or [0]) == 0,
        "up": up and sum(up["deltas"]) > 0 and max(up["progress"] or [0]) > 0.1,
        "upBack": up and sum(up["deltas"]) < 0 and max(up["progress"] or [0]) == 0,
        "detail": f"left: deltas {sum(left['deltas']) if left else '-'}, "
                  f"progress {max(left['progress'] or [0]) if left else '-':.2f}; "
                  f"up: deltas {sum(up['deltas']) if up else '-'}, "
                  f"progress {max(up['progress'] or [0]) if up else '-'}",
    }


GESTURE_KEY = "macos-gesture-direction"
print()
print("  swipe direction:")
natural_before = touchpad_natural()
direction_window = None
try:
    pear_up_setting(GESTURE_KEY, "false")
    pear_up_setting("spaces-spring", "false")
    GLib.usleep(400 * 1000)
    direction_window = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(20):
        GLib.usleep(500 * 1000)
        if test_windows() >= 1:
            break
    hook("FocusFirstWindow")
    GLib.usleep(800 * 1000)
    recorded = json.loads(hook("RecordGestures"))
    names = {g["name"] for g in recorded["gestures"]}
    check("off by default, every swipe gesture has the shell's own touchpad settings",
          pear_up_value(GESTURE_KEY) == "false"
          and {"desktops", "overview", "overview desktops", "app grid"} <= names
          and all(g["shells"] for g in recorded["gestures"]),
          f"{sorted(names)}, {len(recorded['gestures'])} gestures")

    for natural in ("false", "true"):
        touchpad_natural(natural)
        pear_up_setting(GESTURE_KEY, "false")
        GLib.usleep(300 * 1000)
        plain = swipe_directions()
        if natural == "false":
            check("off, with Natural Scrolling off, GNOME's swipes are turned round",
                  plain["leftBack"] and plain["upBack"], plain["detail"])
        else:
            check("off, with Natural Scrolling on, GNOME's swipes already follow the fingers",
                  plain["left"] and plain["up"], plain["detail"])

        pear_up_setting(GESTURE_KEY, "true")
        GLib.usleep(300 * 1000)
        mac = swipe_directions()
        state = gesture_state()
        check(f"on, with Natural Scrolling {'on' if natural == 'true' else 'off'}, fingers left "
              "bring in the desktop on the right and fingers up open the overview",
              mac["left"] and mac["up"], mac["detail"])
        check(f"and Natural Scrolling is still {natural}, for content scrolling",
              touchpad_natural() == natural and state["natural"] == (natural == "true")
              and all(g["reads"] and not g["shells"] for g in state["gestures"]),
              f"setting {touchpad_natural()}, gestures read "
              f"{[(g['name'], g['reads'], g['shells']) for g in state['gestures']]}")

    # With Springy Desktop Switching, which wraps the same tracker's methods:
    # a quick swipe left with Natural Scrolling off lands on the next desktop.
    touchpad_natural("false")
    for first_off in ("spaces-spring", GESTURE_KEY):
        pear_up_setting("spaces-spring", "true")
        pear_up_setting(GESTURE_KEY, "true")
        GLib.usleep(400 * 1000)
        before = settle()
        flung = feed_swipe("desktops", -60, 0, 4)
        after = settle()
        moved = before["active"] == 0 and after["active"] == 1
        if after["active"] != 0:
            feed_swipe("desktops", 60, 0, 4)
        back = settle()
        check("with the spring as well, a swipe left goes to the desktop on the right and "
              "a swipe right comes back",
              moved and back["active"] == 0,
              f"desktop {before['active']} → {after['active']} → {back['active']}, "
              f"tracker own {after['trackerOwn']}")

        pear_up_setting(first_off, "false")
        GLib.usleep(300 * 1000)
        middle = gesture_state()
        spring = switch_state()
        if first_off == "spaces-spring":
            check("the spring off first, the swipes still follow the fingers and the tracker is the shell's",
                  all(not g["shells"] for g in middle["gestures"]) and not spring["trackerOwn"],
                  f"tracker own {spring['trackerOwn']}")
        else:
            check("the direction off first, the spring keeps its tracker and the gestures are the shell's",
                  all(g["shells"] for g in middle["gestures"] if g["recorded"])
                  and bool(spring["controllerOwn"]),
                  f"controller own {spring['controllerOwn']}")
        pear_up_setting("spaces-spring", "false")
        pear_up_setting(GESTURE_KEY, "false")
        GLib.usleep(300 * 1000)
        both_off = gesture_state()
        spring = switch_state()
        check("both off, the gestures and the tracker are the shell's again",
              all(g["shells"] for g in both_off["gestures"] if g["recorded"])
              and not spring["trackerOwn"] and not spring["controllerOwn"])

    # Disabled with the switch on, as at every lock, and enabled again.
    pear_up_setting(GESTURE_KEY, "true")
    GLib.usleep(300 * 1000)
    call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
         "DisableExtension", (UUID,), "(s)")
    GLib.usleep(1500 * 1000)
    locked = gesture_state()
    plain = swipe_directions()
    check("Pear Up disabled with it on, every gesture has the shell's settings back and turns round again",
          all(g["shells"] for g in locked["gestures"] if g["recorded"])
          and plain["leftBack"] and plain["upBack"], plain["detail"])
    call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
         "EnableExtension", (UUID,), "(s)")
    GLib.usleep(2500 * 1000)
    unlocked = gesture_state()
    mac = swipe_directions()
    check("enabled again, the swipes follow the fingers once more",
          all(not g["shells"] for g in unlocked["gestures"] if g["recorded"])
          and mac["left"] and mac["up"], mac["detail"])

    for value in ("false", "true", "false", "true", "false"):
        pear_up_setting(GESTURE_KEY, value)
        GLib.usleep(120 * 1000)
    GLib.usleep(300 * 1000)
    final = gesture_state()
    check("switched on and off repeatedly, it leaves every gesture as the shell made it",
          all(g["shells"] for g in final["gestures"] if g["recorded"]),
          f"{[(g['name'], g['shells']) for g in final['gestures']]}")
except (GLib.Error, FileNotFoundError, KeyError, TypeError, ValueError) as exc:
    check("the swipe direction could be exercised", False, str(exc).splitlines()[0])
finally:
    pear_up_setting(GESTURE_KEY, "false")
    pear_up_setting("spaces-spring", "false")
    touchpad_natural(natural_before)
    try:
        if switch_state()["active"] != 0:
            hook("PressKeys", (["Control_L", "Alt_L", "Left"],), "(as)")
            settle()
    except GLib.Error:
        pass
    if direction_window:
        direction_window.terminate()
        direction_window.wait()
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

# ------------------------------------------------- Steam's window buttons
# A made-up Steam in the user's data directory: switched on, the extension
# patches it, patches it again after a "Steam update" rewrites a stylesheet,
# rewrites the rules when GNOME's layout changes, and gives Steam's files back
# when switched off.
print("\n== Steam: Buttons on the Left ==")


def steam_buttons():
    import shutil
    import time

    steam = os.path.join(os.environ.get("HOME", "/root"), ".local/share/Steam")
    css = os.path.join(steam, "steamui/css")
    os.makedirs(css, exist_ok=True)
    library = ".title-area{display:flex}\n" + "".join(f".x{i}{{color:red}}\n" for i in range(40))
    recording = "._3rMEP{position:absolute}\n" + "".join(f".y{i}{{color:blue}}\n" for i in range(20))
    with open(os.path.join(css, "library.css"), "w") as f:
        f.write(library)
    with open(os.path.join(css, "gamerecording.css"), "w") as f:
        f.write(recording)
    with open(os.path.join(steam, "steamui/chunk~test.js"), "w") as f:
        f.write('x={TopBar:"tb",OSX:"o",WindowControls:"wc",DragArea:"d",TitleBarControls:"c",TitleBar:"t"}')

    def read(name):
        try:
            with open(os.path.join(css, name)) as f:
                return f.read()
        except FileNotFoundError:
            return None

    rules = os.path.join(steam, "steamui/pear-up/window-buttons.css")
    header = "/* Pear Up: Steam window buttons */"

    def wait_for(condition, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            time.sleep(0.2)
        return condition()

    wm = ["gsettings", "set", "org.gnome.desktop.wm.preferences", "button-layout"]
    subprocess.run([*wm, "close,minimize,maximize:appmenu"], check=False)
    pear_up_setting("steam-buttons-left", "true")
    check("Steam's stylesheets are patched when the switch goes on",
          wait_for(lambda: (read("library.css") or "").startswith(header)
                   and (read("gamerecording.css") or "").startswith(header)))
    check("the patch has the original's size", len(read("library.css") or "") == len(library))
    check("the originals are kept", read("library.pear-up-original.css") == library
          and read("gamerecording.pear-up-original.css") == recording)
    check("the rules use the main window's classes",
          wait_for(lambda: os.path.exists(rules) and ".t > .wc {" in open(rules).read()))

    updated = library + ".new{color:green}\n"
    with open(os.path.join(css, "library.css"), "w") as f:
        f.write(updated)
    check("a Steam update is patched again",
          wait_for(lambda: (read("library.css") or "").startswith(header)
                   and read("library.pear-up-original.css") == updated))

    subprocess.run([*wm, "appmenu:minimize,maximize,close"], check=False)
    check("a layout with the buttons on the right empties the rules",
          wait_for(lambda: os.path.exists(rules) and "{" not in open(rules).read()))
    subprocess.run([*wm, "close,minimize,maximize:appmenu"], check=False)
    check("and one with them on the left fills them again",
          wait_for(lambda: os.path.exists(rules) and "closeButton" in open(rules).read()))

    pear_up_setting("steam-buttons-left", "false")
    check("switched off, Steam's files are given back exactly",
          wait_for(lambda: read("library.css") == updated and read("gamerecording.css") == recording))
    check("and nothing of Pear Up's is left",
          read("library.pear-up-original.css") is None and read("gamerecording.pear-up-original.css") is None
          and not os.path.exists(os.path.dirname(rules)))

    with open(os.path.join(css, "library.css"), "w") as f:
        f.write(library)
    time.sleep(4)
    check("switched off, a Steam update is left alone", read("library.css") == library)

    subprocess.run(["gsettings", "reset", "org.gnome.desktop.wm.preferences", "button-layout"], check=False)
    shutil.rmtree(steam, ignore_errors=True)


steam_buttons()

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

# ------------------------------------------------- the screenshot thumbnail
# Shots are taken the way Print takes one, through the shell's own
# captureScreenshot, so the file is saved and the notification posted exactly
# as they would be.
def thumbnail_state():
    return json.loads(hook("GetScreenshotThumbnailState"))


def take_screenshot(wait_ms):
    hook("TakeTestScreenshot")
    GLib.usleep(wait_ms * 1000)
    return thumbnail_state()


def wait_thumbnail_gone(timeout_s):
    for _ in range(int(timeout_s * 10)):
        shot = thumbnail_state()
        if not shot["cards"]:
            return shot, True
        GLib.usleep(100 * 1000)
    return shot, False


thumbnail_ran = False
# GNOME 45 shows a banner however the notification is marked.
try:
    SHELL_MAJOR = int(subprocess.run(["gnome-shell", "--version"], capture_output=True, text=True,
                                     check=False).stdout.split()[-1].split(".")[0])
except (ValueError, IndexError):
    SHELL_MAJOR = 0
print()
print("  the screenshot thumbnail:")
if state:
    try:
        shot = take_screenshot(1500)
        last = shot["last"] or {}
        # GNOME 45's captureScreenshot saves the file but returns nothing.
        if last.get("pending") or "error" in last:
            print(f"  note: no screenshot could be taken here ({last}), so the thumbnail is not exercised")
        else:
            thumbnail_ran = True
            check("off by default, a screenshot shows no thumbnail",
                  pear_up_value("screenshot-thumbnail") == "false" and not shot["cards"],
                  f"{len(shot['cards'])} cards")
            # The shell's own banner for that one. A headless shell has no
            # user activity, and the tray keeps a banner up until there is
            # some, so it is cleared rather than waited out.
            hook("ClearScreenshotNotifications")
            GLib.usleep(600 * 1000)

            pear_up_setting("screenshot-thumbnail", "true")
            GLib.usleep(300 * 1000)
            hook("TakeTestScreenshot")
            first = None
            for _ in range(150):
                cards = thumbnail_state()["cards"]
                if cards:
                    first = cards[0]
                    break
                GLib.usleep(10 * 1000)
            GLib.usleep(900 * 1000)
            shot = thumbnail_state()
            cards = shot["cards"]
            card = cards[0] if cards else None
            work = shot["workArea"]
            check("on, a screenshot shows one thumbnail", len(cards) == 1, f"{len(cards)} cards")
            if card:
                check("it starts from the whole screen and shrinks into place",
                      first and (first["scale"][0] > 1.2 or not shot["animations"]),
                      f"first seen at scale {first and first['scale']}, animations {shot['animations']}")
                x, y, width, height = card["box"]
                check("it sits in the bottom right corner of the work area, 18px in",
                      abs((x + width) - (work[0] + work[2] - 18)) <= 2
                      and abs((y + height) - (work[1] + work[3] - 18)) <= 2,
                      f"card={card['box']} work area={work}")
                check("it is a card about 220px across, with rounded corners",
                      max(card["width"], card["height"]) == 220 and card["rounded"]
                      and card["scale"] == [1, 1] and card["opacity"] == 255,
                      f"{card['width']}x{card['height']} rounded={card['rounded']} scale={card['scale']}")
                check("it knows the file the shell saved",
                      card["file"] and os.path.exists(card["file"])
                      and card["file"] == (shot["last"].get("path") or card["file"]),
                      f"{card['file']} vs {shot['last'].get('path')}")
                held_back = SHELL_MAJOR >= 46
                if not held_back:
                    print(f"  note: GNOME {SHELL_MAJOR} shows its banner regardless")
                check("GNOME's banner is held back while it shows, the notification kept",
                      not held_back or
                      not shot["bannerIsScreenshot"]
                      and any(n["acknowledged"] for n in shot["notifications"]),
                      f"banner: {shot['bannerTitle']}, notifications: {shot['notifications']}")
                gone, went = wait_thumbnail_gone(6)
                check("it slides away on its own after about five seconds", went)
                check("and takes the held-back notification with it",
                      not held_back or not gone["notifications"], f"{gone['notifications']}")

            # Resting on it keeps it.
            shot = take_screenshot(900)
            if shot["cards"]:
                x, y, width, height = shot["cards"][0]["box"]
                # Moved onto it from beside it, so it sees the pointer arrive.
                hook("MovePointer", (x - 40, y + height / 2), "(dd)")
                GLib.usleep(200 * 1000)
                hook("MovePointer", (x + width / 2, y + height / 2), "(dd)")
                GLib.usleep(500 * 1000)
                over = thumbnail_state()["cards"]
                GLib.usleep(6000 * 1000)
                held = thumbnail_state()
                check("the pointer resting on it keeps it past five seconds", len(held["cards"]) == 1,
                      f"{len(held['cards'])} cards, hover was {over and over[0]['hover']}")
                hook("MovePointer", (10, y + height / 2), "(dd)")
                _, went = wait_thumbnail_gone(7)
                check("and it goes once the pointer leaves", went)
            else:
                check("a second screenshot shows a thumbnail too", False)

            # Dragged to the right, it goes at once; a second shot replaces the first.
            take_screenshot(300)
            shot = take_screenshot(900)
            check("a new screenshot replaces the thumbnail before it", len(shot["cards"]) == 1,
                  f"{len(shot['cards'])} cards")
            hook("DragThumbnail", (160.0,), "(d)")
            _, went = wait_thumbnail_gone(1.5)
            check("dragged to the right, it goes at once", went)

            # With the banner allowed, both show.
            pear_up_setting("screenshot-thumbnail-hide-banner", "false")
            GLib.usleep(300 * 1000)
            shot = take_screenshot(900)
            check("with Hide the Screenshot Banner off, GNOME's banner shows beside it",
                  len(shot["cards"]) == 1 and (shot["bannerIsScreenshot"] or SHELL_MAJOR < 46),
                  f"{len(shot['cards'])} cards, banner: {shot['bannerTitle']}")
            pear_up_gsettings("reset", "org.gnome.shell.extensions.pear-up",
                              "screenshot-thumbnail-hide-banner")
            hook("DragThumbnail", (160.0,), "(d)")
            wait_thumbnail_gone(1.5)
    except GLib.Error as exc:
        check("the screenshot thumbnail could be exercised", False, exc.message.splitlines()[0])

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

print()
print("  dock bounce:")
bounce = BounceChecks(dock)
bounce_ready = False
if dock.ready:
    try:
        bounce.run()
        bounce_ready = bounce.ready
    except GLib.Error as exc:
        check("the dock bounce could be exercised", False, exc.message.splitlines()[0])

# ------------------------------------------------------------ clean teardown
# Disabled with the dock still magnified, so there is something to undo.
try:
    dock.hover_before_disable()
except GLib.Error as exc:
    check("the dock could be hovered before disabling", False, exc.message.splitlines()[0])

# And an icon in the air, under the magnified dock, for the bounce to undo.
if bounce_ready:
    try:
        bounce_ready = bounce.bounce_before_disable()
    except GLib.Error as exc:
        check("an icon could be bounced before disabling", False, exc.message.splitlines()[0])
        bounce_ready = False

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

thumbnail_at_disable = False
if thumbnail_ran:
    try:
        thumbnail_at_disable = bool(take_screenshot(900)["cards"])
    except GLib.Error:
        pass

call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
     "DisableExtension", (UUID,), "(s)")
GLib.usleep(2 * 1000 * 1000)

if thumbnail_at_disable:
    try:
        left = thumbnail_state()
        check("disabling takes a showing screenshot thumbnail away, and its notification",
              not left["cards"] and (SHELL_MAJOR < 46 or not left["notifications"]),
              f"{len(left['cards'])} cards, {left['notifications']}")
    except GLib.Error as exc:
        check("the thumbnail could be checked after disabling", False, exc.message.splitlines()[0])

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
if bounce_ready:
    bounce.check_left_nothing("Pear Up is disabled")

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
        if thumbnail_ran:
            again_shot = take_screenshot(900)
            check("a screenshot shows one thumbnail again, not one per enable",
                  len(again_shot["cards"]) == 1, f"{len(again_shot['cards'])} cards")
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
        if thumbnail_ran:
            pear_up_gsettings("reset", "org.gnome.shell.extensions.pear-up", "screenshot-thumbnail")
            left_over = thumbnail_state()["cards"]
            check("and no thumbnail is left behind", not left_over, f"{left_over}")
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

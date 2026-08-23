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
import os
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

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
    check("clock moved out of the centre and to the right",
          state["clockInRight"] and not state["clockInCentre"],
          f"right={state['clockInRight']} centre={state['clockInCentre']}")
    check("Activities button is hidden", state["activitiesVisible"] is False,
          f"visible={state['activitiesVisible']}")

    check("search button is on the panel", state.get("hasSearchButton"),
          f"roles={state['panelRoles']}")

    # The regression that shipped twice: the icon existed, and was visible.
    if state["powerIconFound"]:
        check("power icon is hidden", state["powerIconVisible"] is False,
              f"visible={state['powerIconVisible']}")
    else:
        print("  note: this session has no power indicator to hide")

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
        ("File", {"New Folder", "New Tab", "Close Window"}),
        ("Edit", {"Copy", "Paste", "Select All"}),
        ("Window", {"Minimize", "Maximize", "Close"}),
        ("Go", {"Home", "Documents", "Downloads"}),
    ]:
        found = set(items_of(menu_label))
        check(f"{menu_label} menu offers its entries", expected <= found,
              f"missing {sorted(expected - found)}" if not expected <= found else "")

    # The System Menu is the icon-only button, so it has no label of its own.
    system_menu = next((m for m in menus if m["role"] == "pearup-logo"), None)
    if system_menu:
        entries = [item["label"] for item in system_menu["items"] if item["label"]]
        check("System Menu offers About and Settings",
              {"About This System", "System Settings"} <= set(entries),
              f"found {entries}")
        # Deliberately absent: these settings belong in GNOME Settings, and
        # nothing can put them there.
        check("System Menu has no settings entry of its own",
              not any("Pear Up" in entry for entry in entries))
    else:
        check("System Menu was found", False, "no pearup-logo role")

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

# ------------------------------------------------------------ clean teardown
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
    check("clock returned to the centre", after_state["clockInCentre"],
          f"right={after_state['clockInRight']}")
    check("Activities button shown again", after_state["activitiesVisible"] is True,
          f"visible={after_state['activitiesVisible']}")
except GLib.Error as exc:
    check("panel state readable after disable", False, exc.message.splitlines()[0])

# ------------------------------------------------------------------ summary
failures = [label for label, ok, _ in results if not ok]
print()
print(f"{len(results) - len(failures)} of {len(results)} checks passed")
for label in failures:
    print(f"  failed: {label}")
sys.exit(1 if failures else 0)

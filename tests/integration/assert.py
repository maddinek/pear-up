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

DEBUG_NAME = "org.gnome.Shell"
DEBUG_PATH = "/io/github/maddinek/PearUp/Debug"
DEBUG_IFACE = "io.github.maddinek.PearUp.Debug"

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
    raw = call(DEBUG_NAME, DEBUG_PATH, DEBUG_IFACE, "GetState").unpack()[0]
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
    check("Activities button is hidden", state["activitiesHidden"])
    check("inactive indicators are hidden", state["spacersHidden"] > 0,
          f"{state['spacersHidden']} hidden")

    # The regression that shipped twice: the icon existed, and was visible.
    if state["powerIconFound"]:
        check("power icon is hidden", state["powerIconVisible"] is False,
              f"visible={state['powerIconVisible']}")
    else:
        print("  note: this session has no power indicator to hide")

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

# The debug interface goes away with it, so its absence is the check.
try:
    panel_state()
    check("debug interface withdrawn on disable", False, "still answering")
except GLib.Error:
    check("debug interface withdrawn on disable", True)

# ------------------------------------------------------------------ summary
failures = [label for label, ok, _ in results if not ok]
print()
print(f"{len(results) - len(failures)} of {len(results)} checks passed")
for label in failures:
    print(f"  failed: {label}")
sys.exit(1 if failures else 0)

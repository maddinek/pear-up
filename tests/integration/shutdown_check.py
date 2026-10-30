"""The shell shutting down with Pear Up enabled, and the dock in use.

At logout the shell destroys its UI group, docks and all, without disabling
extensions first. Anything Pear Up queued for later during that teardown then
runs into actors that are already gone, and GJS says so in the log: "has been
already disposed", with a stack trace through the module that asked. This runs
last, after assert.py, with Pear Up switched on again over Dash to Dock and an
icon bouncing under a magnified dock, then ends the shell the way a logout
does and reads what it said on the way out.

    python3 shutdown_check.py <uuid> <shell pid> <shell log>
"""
import json
import os
import signal
import sys
import time

from gi.repository import Gio, GLib

UUID, SHELL_PID, SHELL_LOG = sys.argv[1], int(sys.argv[2]), sys.argv[3]
OURS = ("dockMagnifier.js", "dockBounce.js")
HOOK = ("org.gnome.Shell", "/io/github/maddinek/PearUpTestHook", "io.github.maddinek.PearUpTestHook")

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(name, path, interface, method, args=None, signature="()"):
    return bus.call_sync(name, path, interface, method,
                         GLib.Variant(signature, args) if args else None,
                         None, Gio.DBusCallFlags.NONE, 15000, None).unpack()


def hook(method, args=None, signature="()"):
    return call(*HOOK, method, args, signature)[0]


offset = os.path.getsize(SHELL_LOG)
status = 0


def report(label, ok, detail=""):
    global status
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    status |= 0 if ok else 1


# Set up: Pear Up on, the dock magnified under the pointer, an app starting.
ready, detail = False, ""
try:
    call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
         "EnableExtension", (UUID,), "(s)")
    time.sleep(2)
    state = json.loads(hook("GetDockState"))
    dock = state["docks"][0] if state["docks"] else None
    apps = [item for item in (dock or {}).get("items", [])
            if item["kind"] == "icon" and item["id"] not in (None, "show-apps")]
    if apps:
        x, y, width, height = apps[0]["slot"]
        hook("MovePointer", (float(x + width / 2), float(y + height / 2)), "(dd)")
        time.sleep(0.8)
        hook("LaunchApp", (apps[-1]["id"],), "(s)")
        time.sleep(0.4)
        state = json.loads(hook("GetDockState"))
        ready = bool(state["overlays"])
        detail = f"{len(state['overlays'])} magnifier overlays"
    else:
        detail = "no dock"
except GLib.Error as exc:
    detail = exc.message.splitlines()[0]
report("the dock is magnified as the shell shuts down", ready, detail)

def gone(pid):
    """Exited: no longer there, or a zombie waiting for run-tests.sh to reap it."""
    try:
        with open(f"/proc/{pid}/stat") as handle:
            return handle.read().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


os.kill(SHELL_PID, signal.SIGTERM)
exited = False
for _ in range(150):
    if gone(SHELL_PID):
        exited = True
        break
    time.sleep(0.1)
report("the shell shuts down on SIGTERM", exited, "still running after 15 s")

with open(SHELL_LOG, "rb") as handle:
    log = handle.read()
before = log[:offset].decode("utf-8", "replace")
after = log[offset:].decode("utf-8", "replace")


# A warning is followed by its stack trace; ours are those whose trace runs
# through the dock modules.
def disposed(text):
    lines = text.splitlines()
    found = []
    for index, line in enumerate(lines):
        if "already disposed" not in line and "already finalized" not in line:
            continue
        trace = lines[index + 1:index + 8]
        if any(module in frame for frame in trace for module in OURS):
            found.append(line.strip()[:160])
    return found


for label, found in (
        ("nothing of the dock's touches a disposed actor during the suite", disposed(before)),
        ("nothing of the dock's touches the shell after it shuts down", disposed(after))):
    report(label, not found, f"{len(found)} warnings: {found[0]}" if found else "")
sys.exit(status)

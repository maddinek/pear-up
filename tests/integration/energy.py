"""What the shell spends while nobody touches it, with Pear Up on and off.

Counted from outside the shell, the way a battery sees it: how often its main
thread is woken (each wake-up costs the CPU a trip out of its idle state), the
CPU time it uses, and the frames its frame clocks run (each one is a layout and
a paint). The frames come from the test hook; the rest is read from /proc, which
the container shares with the shell it started.

Two uses. The suite calls IdleChecks.run() once the dock checks are done: ten
seconds at rest with Pear Up on, then off, and it fails when Pear Up adds frames
or wake-ups to a shell at rest. `PEAR_UP_ENERGY=1 tests/integration/run.sh`
runs profile() instead of the suite: a minute at rest each way, then focus
moving between apps and menus opening, and prints the numbers as one JSON line
for the record.
"""
import json
import os
import subprocess
import sys
import time

from gi.repository import Gio, GLib

HOOK_NAME = "org.gnome.Shell"
HOOK_PATH = "/io/github/maddinek/PearUpTestHook"
HOOK_IFACE = "io.github.maddinek.PearUpTestHook"
DOCK_UUID = "dash-to-dock@micxgx.gmail.com"
BLUR_UUID = "blur-my-shell@aunetx"
WINDOW_CLASS = "io.github.maddinek.PearUpTestWindow"
OTHER_CLASS = "io.github.maddinek.PearUpTestOther"

# What Pear Up may add to a shell at rest over IDLE_MS, beyond what the same
# shell does with it off. A frame or two is a tooltip or a hover finishing; a
# handful of wake-ups is the D-Bus traffic of the measurement itself landing on
# a different side of the window. Anything that ticks — a timer, a timeline, a
# poll — adds one per tick, ten a second at the very least.
IDLE_MS = 10000
FRAME_SLACK = 3
WAKEUP_SLACK = 15


def shell_pid():
    """The gnome-shell this container started: the only one in here."""
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", encoding="utf-8") as handle:
                if handle.read().strip() == "gnome-shell":
                    return int(entry)
        except OSError:
            continue
    return None


class Meter:
    """Reads what the shell's process has spent so far."""

    def __init__(self, pid):
        self.pid = pid

    @staticmethod
    def _status(path):
        values = {}
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                if key.endswith("ctxt_switches"):
                    values[key] = int(value)
        return values

    @staticmethod
    def _schedstat(path):
        # Nanoseconds on a CPU, nanoseconds waiting for one, times it ran.
        with open(path, encoding="utf-8") as handle:
            run_ns, _, slices = (int(field) for field in handle.read().split()[:3])
        return run_ns, slices

    def sample(self):
        main = f"/proc/{self.pid}/task/{self.pid}"
        status = self._status(f"{main}/status")
        main_ns, main_slices = self._schedstat(f"{main}/schedstat")
        tasks = {}
        for tid in os.listdir(f"/proc/{self.pid}/task"):
            try:
                task_status = self._status(f"/proc/{self.pid}/task/{tid}/status")
                run_ns, _ = self._schedstat(f"/proc/{self.pid}/task/{tid}/schedstat")
            except OSError:
                continue  # a thread that ended while it was being read
            tasks[tid] = (task_status.get("voluntary_ctxt_switches", 0), run_ns)
        return {
            "time": time.monotonic(),
            "mainWakeups": status.get("voluntary_ctxt_switches", 0),
            "mainPreempted": status.get("nonvoluntary_ctxt_switches", 0),
            "mainSlices": main_slices,
            "mainCpuNs": main_ns,
            "tasks": tasks,
        }

    @staticmethod
    def delta(before, after):
        seconds = after["time"] - before["time"]
        # Threads come and go (GLib's thread pool, the GC's helpers): a thread
        # counts from zero if it started meanwhile, and not at all if it ended.
        all_wakeups = all_ns = 0
        for tid, (wakeups, run_ns) in after["tasks"].items():
            was_wakeups, was_ns = before["tasks"].get(tid, (0, 0))
            all_wakeups += wakeups - was_wakeups
            all_ns += run_ns - was_ns
        return {
            "seconds": round(seconds, 2),
            "mainWakeups": after["mainWakeups"] - before["mainWakeups"],
            "mainPreempted": after["mainPreempted"] - before["mainPreempted"],
            "mainSlices": after["mainSlices"] - before["mainSlices"],
            "mainCpuMs": round((after["mainCpuNs"] - before["mainCpuNs"]) / 1e6, 1),
            "allWakeups": all_wakeups,
            "allCpuMs": round(all_ns / 1e6, 1),
        }


class Energy:
    def __init__(self, bus, uuid):
        self._bus = bus
        self._uuid = uuid
        pid = shell_pid()
        self.meter = Meter(pid) if pid else None

    def call(self, name, path, interface, method, args=None, signature="()", timeout=15000):
        return self._bus.call_sync(
            name, path, interface, method,
            GLib.Variant(signature, args) if args else None,
            None, Gio.DBusCallFlags.NONE, timeout, None)

    def hook(self, method, args=None, signature="()"):
        return self.call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, method, args, signature).unpack()[0]

    def extensions(self, method, uuid):
        return self.call("org.gnome.Shell", "/org/gnome/Shell",
                         "org.gnome.Shell.Extensions", method, (uuid,), "(s)").unpack()[0]

    def measure(self, ms, action=None, every_ms=500):
        """Frames, wake-ups and CPU over `ms`, while `action` runs every
        `every_ms` (or nothing does). The frame count is asked for first and
        answered last, so it spans the whole of the window /proc is read over."""
        context = GLib.MainContext.default()
        answer = {}

        def done(bus, result):
            try:
                answer["frames"] = bus.call_finish(result).unpack()[0]
            except GLib.Error as exc:
                answer["error"] = exc.message.splitlines()[0]

        self._bus.call(HOOK_NAME, HOOK_PATH, HOOK_IFACE, "CountFrames",
                       GLib.Variant("(ub)", (int(ms), False)), None,
                       Gio.DBusCallFlags.NONE, ms + 15000, None, done)
        before = self.meter.sample()
        actions = 0
        deadline = time.monotonic() + ms / 1000
        while not answer:
            if action and time.monotonic() < deadline - every_ms / 1000:
                action(actions)
                actions += 1
                end = time.monotonic() + every_ms / 1000
            else:
                end = time.monotonic() + 0.05
            while time.monotonic() < end and not answer:
                if not context.iteration(False):
                    time.sleep(0.01)
        after = self.meter.sample()
        if "error" in answer:
            raise RuntimeError(answer["error"])
        result = Meter.delta(before, after)
        result["frames"] = answer["frames"]
        if action:
            result["actions"] = actions
        return result

    def set_enabled(self, on, settle=4):
        self.extensions("EnableExtension" if on else "DisableExtension", self._uuid)
        GLib.usleep(int(settle * 1000 * 1000))
        return self.extensions("GetExtensionInfo", self._uuid).get("state") == (1 if on else 2)


def describe(result):
    return (f"{result['frames']} frames, {result['mainWakeups']} wake-ups, "
            f"{result['mainCpuMs']} ms CPU")


class IdleChecks:
    """The shell at rest costs the same with Pear Up as without it."""

    def __init__(self, bus, check, uuid):
        self._energy = Energy(bus, uuid)
        self._check = check

    def run(self):
        check = self._check
        energy = self._energy
        if not energy.meter:
            print("  note: no gnome-shell process to read here; skipping")
            return
        # The pointer in the middle of the screen, away from the dock and the
        # bar, and nothing opening or closing.
        energy.hook("MovePointer", (640.0, 360.0), "(dd)")
        GLib.usleep(1500 * 1000)
        on = energy.measure(IDLE_MS)
        if not check("Pear Up could be switched off to compare", energy.set_enabled(False)):
            return
        try:
            off = energy.measure(IDLE_MS)
        finally:
            back = energy.set_enabled(True)
        print(f"  note: at rest for {IDLE_MS // 1000} s, on: {describe(on)}; "
              f"off: {describe(off)}; all threads {on['allWakeups']}/{off['allWakeups']} "
              f"wake-ups, {on['allCpuMs']}/{off['allCpuMs']} ms")
        check("Pear Up draws no frames into a shell at rest",
              on["frames"] <= off["frames"] + FRAME_SLACK,
              f"{on['frames']} frames on, {off['frames']} off in {IDLE_MS // 1000} s")
        check("Pear Up does not wake a shell at rest",
              on["mainWakeups"] <= off["mainWakeups"] + WAKEUP_SLACK,
              f"{on['mainWakeups']} wake-ups on, {off['mainWakeups']} off in {IDLE_MS // 1000} s")
        check("and is on again for what follows", back)


# --------------------------------------------------------------- the profile
def _gsettings(schema, key, value, env=None):
    subprocess.run(["gsettings", "set", schema, key, value], env=env,
                   capture_output=True, check=False)


def _framy_like(uuid):
    """Pear Up, Dash to Dock and Blur my Shell set the way framy has them."""
    env = {**os.environ,
           "GSETTINGS_SCHEMA_DIR": f"{os.environ.get('HOME', '/root')}/.local/share/"
                                   f"gnome-shell/extensions/{uuid}/schemas"}
    for key, value in [("banners-slide-from-right", "true"), ("clock-on-the-right", "true"),
                       ("dock-bounce-on-attention", "true"), ("dock-bounce-on-launch", "true"),
                       ("dock-magnification", "true"), ("dock-magnification-size", "150"),
                       ("macos-window-animations", "true"), ("screenshot-thumbnail", "true"),
                       ("show-log-out", "true"), ("show-search-icon", "false"),
                       ("spaces-spring", "true"), ("steam-buttons-left", "true")]:
        _gsettings("org.gnome.shell.extensions.pear-up", key, value, env)
    for key, value in [("dock-position", "'RIGHT'"), ("dock-fixed", "true"),
                       ("autohide", "false"), ("intellihide", "false"),
                       ("dash-max-icon-size", "16"), ("running-indicator-style", "'DOT'"),
                       ("custom-theme-shrink", "true"), ("extend-height", "false"),
                       ("height-fraction", "0.9")]:
        _gsettings("org.gnome.shell.extensions.dash-to-dock", key, value)
    for key, value in [("blur", "true"), ("static-blur", "true"), ("sigma", "30"),
                       ("brightness", "0.9"), ("style-dash-to-dock", "2")]:
        _gsettings("org.gnome.shell.extensions.blur-my-shell.dash-to-dock", key, value)


def _windows():
    """Two apps with a window each, open for as long as the profile runs."""
    script = "/src/tests/integration/test-window.js"
    return [subprocess.Popen(["gjs", "-m", script, app_id, "0", "600"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for app_id in (WINDOW_CLASS, OTHER_CLASS)]


def profile(uuid, seconds):
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    energy = Energy(bus, uuid)
    if not energy.meter:
        print("no gnome-shell process to read")
        return 1
    _framy_like(uuid)
    for extension in (DOCK_UUID, BLUR_UUID):
        try:
            energy.extensions("EnableExtension", extension)
        except GLib.Error as exc:
            print(f"note: {extension} not enabled: {exc.message.splitlines()[0]}")
    windows = _windows()
    GLib.usleep(6 * 1000 * 1000)
    energy.hook("MovePointer", (640.0, 360.0), "(dd)")
    GLib.usleep(3 * 1000 * 1000)

    classes = (WINDOW_CLASS, OTHER_CLASS)

    def focus(n):
        energy.hook("FocusWindowOf", (classes[n % 2],), "(s)")

    def system_menu(n):
        energy.hook("OpenSystemMenu" if n % 2 == 0 else "CloseSystemMenu")

    def top_menu(n):
        energy.hook("OpenTopMenu" if n % 2 == 0 else "CloseTopMenu", ("Edit",), "(s)")

    def date_menu(n):
        energy.hook("PressKeys", (["Super_L", "v"],), "(as)")

    report = {"seconds": seconds}
    try:
        for state in ("on", "off"):
            if state == "off" and not energy.set_enabled(False, settle=6):
                report["error"] = "Pear Up would not switch off"
                break
            energy.hook("MovePointer", (640.0, 360.0), "(dd)")
            GLib.usleep(2 * 1000 * 1000)
            report[f"idle-{state}"] = energy.measure(seconds * 1000)
            # Then again in pieces, with what starts main-loop work traced and
            # when each frame ran, to tell a beat from a one-off.
            energy.hook("TraceWork", (True,), "(b)")
            report[f"frametimes-{state}"] = json.loads(energy.call(
                HOOK_NAME, HOOK_PATH, HOOK_IFACE, "FrameTimes", (30000,), "(u)",
                timeout=60000).unpack()[0])
            report[f"trace-{state}"] = json.loads(energy.hook("TraceWork", (False,), "(b)"))
            energy.hook("TraceWork", (True,), "(b)")
            report[f"focus-{state}"] = energy.measure(20000, focus)
            report[f"focustrace-{state}"] = json.loads(energy.hook("TraceWork", (False,), "(b)"))
            GLib.usleep(2 * 1000 * 1000)
            report[f"datemenu-{state}"] = energy.measure(20000, date_menu, every_ms=1000)
            GLib.usleep(2 * 1000 * 1000)
            if state == "on":
                report["systemmenu-on"] = energy.measure(20000, system_menu)
                GLib.usleep(2 * 1000 * 1000)
                report["topmenu-on"] = energy.measure(20000, top_menu)
                GLib.usleep(2 * 1000 * 1000)
                # Resting on the magnified dock, then moving along it.
                state_json = json.loads(energy.hook("GetDockState"))
                docks = state_json.get("docks") or []
                icons = [item for item in (docks[0]["items"] if docks else [])
                         if item["kind"] == "icon"]
                if icons:
                    x, y, width, height = icons[len(icons) // 2]["slot"]
                    energy.hook("MovePointer", (x + width / 2, y + height / 2), "(dd)")
                    GLib.usleep(2 * 1000 * 1000)
                    report["dockrest-on"] = energy.measure(10000)
                    energy.hook("MovePointer", (640.0, 360.0), "(dd)")
                    GLib.usleep(2 * 1000 * 1000)
    finally:
        for window in windows:
            window.terminate()
    print("ENERGY " + json.dumps(report))
    for name, result in report.items():
        if name.startswith(("trace", "focustrace")):
            print(f"  {name}:")
            for place, counts in sorted(result.items(), key=lambda kv: -kv[1]["added"]):
                print(f"    {counts['added']:5} added {counts['ran']:5} ran  {place}")
        elif name.startswith("frametimes"):
            print(f"  {name}: {len(result)} frames at {result[:60]}")
        elif isinstance(result, dict):
            extra = f", {result['actions']} actions" if "actions" in result else ""
            print(f"  {name:14} {result['seconds']:6} s  {describe(result)}{extra}; "
                  f"all threads {result['allWakeups']} wake-ups {result['allCpuMs']} ms")
    return 0


if __name__ == "__main__":
    sys.exit(profile(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 60))

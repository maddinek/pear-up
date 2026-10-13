"""Dock bounce, checked against a real Dash to Dock in a live shell.

Runs after the magnification checks, with Dash to Dock already enabled. The
bounce is drawn in an overlay above the dock while the icon itself is made
transparent, so what is worth catching is again visual and stateful: an icon
that hops towards the screen edge or along the dock instead of away from it, a
hop of the wrong height, a bounce that never ends, an icon left transparent, an
overlay left behind, and the magnifier and the bounce drawing the same icon
twice.

The favourites launch `true` with startup notification, which leaves them
starting until the shell gives up on them; one extra app opens a real window
after a delay. Both are launched through the shell, as a dock click does.
"""
import os
import signal
import subprocess

from gi.repository import GLib

from dock_magnification import BOTTOM, LEFT, RIGHT, SIDE_NAMES, TOP, _box_center

BOUNCE = "pearup-dock-bounce"
LAUNCH_APP = "io.github.maddinek.PearUpTestLaunch"
OTHER_WINDOW = "io.github.maddinek.PearUpTestWindow"

# Shell.AppState
STOPPED, STARTING, RUNNING = range(3)

HOP_S = 0.6
HOP_HEIGHT = 1.0
HOP_MIN_PX = 16
LAUNCH_LIMIT_S = 10


def hop_peak(size):
    """The top of a hop for an icon `size` logical pixels across, as
    dockBounce.js works it out: its own size, at least HOP_MIN_PX."""
    return max(HOP_HEIGHT * size, HOP_MIN_PX)


def _quit(app_id):
    """End the test-window.js process started under this application id."""
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                argv = handle.read().split(b"\0")
        except OSError:
            continue
        if b"test-window.js" in b" ".join(argv) and app_id.encode() in argv:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass


class BounceChecks:
    def __init__(self, dock_checks):
        self._d = dock_checks
        self._check = dock_checks._check
        self._baseline = {}
        self._used = set()
        self.ready = False

    # ---------------------------------------------------------------- plumbing
    def _hook(self, method, args=None, signature="()"):
        return self._d._hook(method, args, signature)

    def _dock(self, state=None):
        return self._d._dock(state or self._d.state())

    def _apps(self, dock):
        return [item for item in dock["items"] if item["kind"] == "icon"
                and item["id"] not in (None, "show-apps")]

    def _item(self, state, app_id):
        dock = self._dock(state)
        return next((item for item in dock["items"] if item["id"] == app_id), None) if dock else None

    def _fresh_app(self, dock):
        """A favourite not launched yet, so it is not still starting from before."""
        for item in self._apps(dock):
            if item["id"].startswith("pear-up-test-app") and item["id"] not in self._used:
                self._used.add(item["id"])
                return item["id"]
        return None

    def _record_baseline(self):
        self._baseline = {item["id"]: item["iconOpacity"]
                          for item in self._dock()["items"] if item["id"]}

    def _sample(self, app_id, seconds, every=0.04):
        """What the bounce overlay draws for one app, over a stretch of time."""
        samples = []
        end = GLib.get_monotonic_time() + seconds * 1e6
        while GLib.get_monotonic_time() < end:
            state = self._d.state()
            item = self._item(state, app_id)
            clones = [child for overlay in state["bounces"] for child in overlay["children"]
                      if child["type"] == "clone"]
            samples.append({"item": item, "clones": clones, "state": state})
            GLib.usleep(int(every * 1e6))
        return samples

    def _lifts(self, samples, side):
        """How far each drawn clone sits from its icon: away from the edge, and
        along the dock. Only samples with one visible clone count."""
        out = []
        for sample in samples:
            item = sample["item"]
            visible = [c for c in sample["clones"] if c["visible"] and c["opacity"] > 0]
            # Read while Dash to Dock's urgent wiggle has the icon turned, its
            # box is not where the icon is; the clone itself is drawn upright.
            if not item or len(visible) != 1 or abs(item.get("iconRotation") or 0) > 0.01:
                continue
            ix, iy = _box_center(item["icon"])
            cx, cy = _box_center(visible[0]["box"])
            away = {RIGHT: ix - cx, LEFT: cx - ix, BOTTOM: iy - cy, TOP: cy - iy}[side]
            along = cy - iy if side in (LEFT, RIGHT) else cx - ix
            size = item["icon"][2] if side in (LEFT, RIGHT) else item["icon"][3]
            out.append({"away": away, "along": along, "size": size,
                        "clone": visible[0]["box"], "icon": item["icon"]})
        return out

    def _wait_gone(self, timeout):
        end = GLib.get_monotonic_time() + timeout * 1e6
        while GLib.get_monotonic_time() < end:
            if not self._d.state()["bounces"]:
                return True
            GLib.usleep(50 * 1000)
        return False

    def _left_nothing(self, what):
        check = self._check
        state = self._d.state()
        check(f"no bounce overlay left after {what}", not state["bounces"],
              f"{len(state['bounces'])} left")
        dock = self._dock(state)
        if not dock:
            check(f"the dock survived {what}", False)
            return
        changed = [f"{item['id']}: {self._baseline[item['id']]} -> {item['iconOpacity']}"
                   for item in dock["items"]
                   if item["id"] in self._baseline and item["iconOpacity"] != self._baseline[item["id"]]]
        check(f"every dock icon has its opacity back after {what}", not changed, "; ".join(changed))

    def _check_hops(self, samples, side, where):
        """The clone rises away from the edge, to about the icon's size,
        and never moves along the dock or towards the edge."""
        check = self._check
        lifts = self._lifts(samples, side)
        if not check(f"[{where}] the bouncing icon is drawn in the bounce overlay",
                     len(lifts) >= 5, f"{len(lifts)} usable samples of {len(samples)}"):
            return
        size = lifts[0]["size"]
        top = max(lift["away"] for lift in lifts)
        low = min(lift["away"] for lift in lifts)
        drift = max(abs(lift["along"]) for lift in lifts)
        peak = hop_peak(size)
        check(f"[{where}] the icon hops away from the {SIDE_NAMES[side]} edge to about its own size",
              0.76 * peak <= top <= peak + 1.5,
              f"highest {top:.1f}px for a {size:.0f}px icon (peak {peak:.0f}px)")
        check(f"[{where}] the icon never moves towards the edge",
              low >= -0.5, f"lowest {low:.1f}px")
        check(f"[{where}] the icon stays in its slot along the dock",
              drift <= 0.5, f"drifted {drift:.1f}px")
        sizes = {round(lift["clone"][2]) for lift in lifts} | {round(lift["clone"][3]) for lift in lifts}
        check(f"[{where}] the bouncing icon keeps its size",
              all(abs(value - size) <= 1 for value in sizes), f"sizes {sorted(sizes)} for {size:.0f}")
        hidden = [s["item"]["iconOpacity"] for s in samples
                  if s["item"] and s["clones"] and s["item"]["iconOpacity"] != 0]
        check(f"[{where}] the real icon is transparent while its clone bounces",
              not hidden, f"opacities {hidden[:5]}")
        dock = self._dock(samples[-1]["state"])
        overlays = samples[-1]["state"]["bounces"]
        if overlays:
            check(f"[{where}] the bounce overlay sits above the dock",
                  dock["nextSibling"] == BOUNCE or overlays[0]["previousSibling"] in (
                      "dashtodockContainer", "pearup-dock-magnifier"),
                  f"after {overlays[0]['previousSibling']}")

    # -------------------------------------------------------------- the run
    def run(self):
        check = self._check
        d = self._d

        d._pear_up_setting("dock-bounce-on-launch", "true")
        d._dock_setting("dock-position", "'RIGHT'")
        if not check("Dash to Dock is back on the right for the bounce",
                     d._wait_for_dock(RIGHT) is not None, d._last_seen):
            return
        d._away()
        self._record_baseline()
        state = d.state()
        check("nothing bounces while nothing starts", not state["bounces"])

        # The shell itself turns animations off where it renders in software
        # on some releases, and the bounce follows it, as its transitions do.
        if not state.get("animations"):
            print("  note: this shell has animations off (software rendering), "
                  "so nothing may bounce; checking that nothing does")
            app = self._fresh_app(self._dock(state))
            self._hook("ActivateDockApp", (app,), "(s)")
            samples = self._sample(app, 0.8)
            check("with the shell's animations off nothing bounces",
                  not any(s["clones"] for s in samples))
            d._pear_up_setting("dock-bounce-on-launch", "false")
            self.ready = False
            return
        self.ready = True

        # ---- a dock click on a stopped app: bounces while it starts, capped
        dock = self._dock()
        app = self._fresh_app(dock)
        if not check("a dock icon could be clicked", app and self._hook(
                "ActivateDockApp", (app,), "(s)"), f"{app}"):
            return
        samples = self._sample(app, 1.4)
        starting = [s["item"]["appState"] for s in samples if s["item"]]
        check("the clicked app is starting", STARTING in starting, f"states {sorted(set(starting))}")
        self._check_hops(samples, RIGHT, "launch, right")
        d._capture("dock-bounce-right.png")

        # Whether the shell still has it starting is up to the shell; the
        # bounce has to follow it, give or take the hop in the air.
        GLib.usleep(int(4 * 1e6))
        states, bouncing = [], []
        for _ in range(4):
            state = d.state()
            states.append(self._item(state, app)["appState"])
            bouncing.append(bool(state["bounces"]))
            GLib.usleep(int(0.2 * 1e6))
        still = all(value == STARTING for value in states)
        check("it bounces for as long as the app is starting",
              (still and all(bouncing)) or (STARTING not in states and not bouncing[-1]),
              f"states {states}, bouncing {bouncing}")
        gone = self._wait_gone(LAUNCH_LIMIT_S + 2 * HOP_S + 1.5 - 5.4)
        state = d.state()
        check("an app that shows no window stops bouncing after ten seconds at most",
              gone, f"still {len(state['bounces'])} overlays; app state "
              f"{self._item(state, app)['appState']}")
        if still:
            print("  note: the app was still starting at five seconds, so the ten-second limit ended it")
        self._left_nothing("the launch bounce gives up")

        # ---- a real app: bounces until its window appears, then lands. Pinned
        # first: Dash to Dock shows an app that is not a favourite only once it
        # runs, which is when its bounce ends.
        favourites = subprocess.run(["gsettings", "get", "org.gnome.shell", "favorite-apps"],
                                    capture_output=True, text=True, check=False).stdout.strip()
        pinned = favourites.rstrip("]") + f", '{LAUNCH_APP}.desktop']"
        subprocess.run(["gsettings", "set", "org.gnome.shell", "favorite-apps", pinned], check=False)
        GLib.usleep(1500 * 1000)
        launch_state = self._hook("LaunchApp", (f"{LAUNCH_APP}.desktop",), "(s)")
        samples = self._sample(f"{LAUNCH_APP}.desktop", 1.6)
        check("the launched app's icon appears in the dock and bounces",
              any(s["clones"] for s in samples) and launch_state != "missing",
              f"launch state {launch_state}, "
              f"in dock {any(s['item'] for s in samples)}")
        windows = 0
        for _ in range(60):
            windows = self._hook("CountWindows", (LAUNCH_APP,), "(s)")
            if windows:
                break
            GLib.usleep(100 * 1000)
        appeared = GLib.get_monotonic_time()
        landed = self._wait_gone(HOP_S + 0.8)
        took = (GLib.get_monotonic_time() - appeared) / 1e6
        check("the bounce lands within one hop of the first window appearing",
              windows and landed, f"windows {windows}, landed {landed} after {took:.2f}s")
        self._left_nothing("the app's window appears")

        # ---- attention: a covered window of a background app asks for it
        d._pear_up_setting("dock-bounce-on-attention", "true")
        GLib.usleep(300 * 1000)
        other = subprocess.Popen(["gjs", "-m", "/src/tests/integration/test-window.js"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                if self._hook("CountWindows", (OTHER_WINDOW,), "(s)"):
                    break
                GLib.usleep(100 * 1000)
            self._hook("FocusWindowOf", (OTHER_WINDOW,), "(s)")
            GLib.usleep(500 * 1000)
            self._record_baseline()

            how = self._hook("DemandAttention", (LAUNCH_APP,), "(s)")
            samples = self._sample(f"{LAUNCH_APP}.desktop", 1.0)
            check("a background app asking for attention bounces",
                  any(s["clones"] for s in samples), f"asked via {how}")
            self._check_hops(samples, RIGHT, "attention, right")
            gone = self._wait_gone(3 * HOP_S + 1.0 - 1.0)
            check("it bounces three times and stops", gone)
            self._left_nothing("the attention bounce")

            # Brought forward mid-bounce: lands at the end of that hop.
            self._hook("FocusWindowOf", (LAUNCH_APP,), "(s)")
            GLib.usleep(300 * 1000)
            self._hook("FocusWindowOf", (OTHER_WINDOW,), "(s)")
            GLib.usleep(500 * 1000)
            self._hook("DemandAttention", (LAUNCH_APP,), "(s)")
            GLib.usleep(250 * 1000)
            bouncing = bool(d.state()["bounces"])
            self._hook("FocusWindowOf", (LAUNCH_APP,), "(s)")
            landed = self._wait_gone(HOP_S + 0.4)
            check("bringing the app forward stops the bounce after the current hop",
                  bouncing and landed, f"bouncing {bouncing}, landed {landed}")

            # ---- magnified and bouncing at once: the magnifier draws the hop
            self._check_with_magnification()
        finally:
            other.terminate()
            d._pear_up_setting("dock-bounce-on-attention", "false")

        # ---- animations off: nothing bounces
        subprocess.run(["gsettings", "set", "org.gnome.desktop.interface",
                        "enable-animations", "false"], check=False)
        GLib.usleep(400 * 1000)
        app = self._fresh_app(self._dock())
        self._hook("ActivateDockApp", (app,), "(s)")
        samples = self._sample(app, 0.8)
        check("with animations off nothing bounces",
              not any(s["clones"] for s in samples) and
              any(s["item"] and s["item"]["appState"] == STARTING for s in samples))
        subprocess.run(["gsettings", "set", "org.gnome.desktop.interface",
                        "enable-animations", "true"], check=False)
        GLib.usleep(400 * 1000)

        # ---- the other edges, each ended by switching the setting off
        for side, name in ((BOTTOM, "'BOTTOM'"), (LEFT, "'LEFT'"), (TOP, "'TOP'")):
            d._dock_setting("dock-position", name)
            if not check(f"Dash to Dock rebuilt its dock on the {SIDE_NAMES[side]}",
                         d._wait_for_dock(side) is not None, d._last_seen):
                continue
            d._away()
            self._record_baseline()
            app = self._fresh_app(self._dock())
            if not app:
                print(f"  note: no unused favourite left for the {SIDE_NAMES[side]} edge")
                continue
            self._hook("ActivateDockApp", (app,), "(s)")
            samples = self._sample(app, 0.8)
            self._check_hops(samples, side, f"launch, {SIDE_NAMES[side]}")
            if side == BOTTOM:
                d._capture("dock-bounce-bottom.png")
            d._pear_up_setting("dock-bounce-on-launch", "false")
            GLib.usleep(300 * 1000)
            self._left_nothing(f"bouncing is switched off mid-hop ({SIDE_NAMES[side]})")
            d._pear_up_setting("dock-bounce-on-launch", "true")

        # The launched app's window would otherwise stay for the checks after
        # these, which count windows of their own.
        _quit(LAUNCH_APP)

        d._dock_setting("dock-position", "'RIGHT'")
        d._wait_for_dock(RIGHT)
        d._away()
        self._record_baseline()

    def _check_with_magnification(self):
        check = self._check
        d = self._d
        app_id = f"{LAUNCH_APP}.desktop"
        item = self._item(d.state(), app_id)
        if not check("the running app has a dock icon to hover", item is not None):
            return
        # In the background again, so it may ask for attention.
        self._hook("FocusWindowOf", (OTHER_WINDOW,), "(s)")
        GLib.usleep(500 * 1000)
        d.move(*_box_center(item["slot"]))
        GLib.usleep(700 * 1000)
        self._hook("DemandAttention", (LAUNCH_APP,), "(s)")

        gaps, drawn_twice = [], 0
        for sample in self._sample(app_id, 1.0):
            state = sample["state"]
            item = sample["item"]
            if not item or not state["overlays"]:
                continue
            copies = [c for c in state["overlays"][0]["children"]
                      if c["type"] == "icon" and c["visible"] and c["opacity"] > 0]
            if not copies:
                continue
            # The copy of the hovered icon is the one level with it: the pointer
            # is on it, so the swell leaves it in place along the dock.
            iy = _box_center(item["icon"])[1]
            copy = min(copies, key=lambda c: abs(_box_center(c["box"])[1] - iy))
            ix, _, iw, _ = item["icon"]
            gaps.append(((ix + iw) - (copy["box"][0] + copy["box"][2]), copy["box"][2]))
            drawn_twice += sum(1 for c in sample["clones"] if c["visible"] and c["opacity"] > 0)

        top = max((gap for gap, _ in gaps), default=0)
        size = max((width for _, width in gaps), default=0)
        check("a magnified icon bounces too, drawn by the magnifier",
              gaps and 0.6 * hop_peak(size) <= top <= hop_peak(size) + 2,
              f"highest {top:.1f}px for a {size:.0f}px magnified icon over {len(gaps)} samples")
        check("the bounce overlay draws nothing while the magnifier does",
              drawn_twice == 0, f"{drawn_twice} visible clones")
        self._hook("FocusWindowOf", (LAUNCH_APP,), "(s)")
        d._away()
        self._wait_gone(HOP_S * 3)

    def bounce_before_disable(self):
        """Leave an icon in the air, so disabling Pear Up has a bounce to undo."""
        dock = self._dock()
        app = self._fresh_app(dock) if dock else None
        if not app:
            print("  note: no unused favourite left to bounce at disable")
            return False
        self._record_baseline()
        self._hook("ActivateDockApp", (app,), "(s)")
        GLib.usleep(400 * 1000)
        return self._check("an icon is bouncing as Pear Up is disabled",
                           bool(self._d.state()["bounces"]))

    def check_left_nothing(self, what):
        self._left_nothing(what)

"""Low Power Mode's 60 Hz on battery, checked in a live shell.

The container has no battery and no built-in screen: its virtual monitor has a
single mode. So UPower is stood in for on the system bus (fake_upower.py), with
the power switched from here, and Mutter's DisplayConfig is stood in for inside
Pear Up by the test hook, with framy's own monitors as GetCurrentState gives
them: eDP-1 at 2880x1920, 120 Hz with variable refresh, 60 Hz modes beside it.
What is checked is what Pear Up asks mutter to do, and when it leaves the
screen alone. Before the stand-in goes in, the real DisplayConfig is asked
once, to show its answer is read without an error and a virtual monitor is
left as it is.
"""
import json
import os
import signal
import subprocess

from gi.repository import GLib

KEY = "battery-60hz"
FIXTURE = os.path.join(os.path.dirname(__file__), "framy-display-state.json")
VRR_120 = "2880x1920@120.000+vrr"
VRR_60 = "2880x1920@60.000+vrr"
FIXED_120 = "2880x1920@120.000"
FIXED_60 = "2880x1920@60.000"


class BatteryRefreshChecks:
    def __init__(self, hook, check, setting, uuid):
        self._hook = hook
        self._check = check
        self._setting = setting
        self._uuid = uuid
        self._fake = None

    # -------------------------------------------------------------- helpers
    def _state(self):
        return json.loads(self._hook("GetBatteryRefresh"))

    def _settle(self, until=None, timeout=3.0):
        """Until `until(state)` holds, or nothing is left to do."""
        deadline = GLib.get_monotonic_time() + int(timeout * 1e6)
        state = self._state()
        while GLib.get_monotonic_time() < deadline:
            if (until(state) if until else not state.get("busy")):
                break
            GLib.usleep(50 * 1000)
            state = self._state()
        # A pass that a signal queued behind this one.
        GLib.usleep(300 * 1000)
        return self._state()

    def _power(self, on_battery):
        self._fake.send_signal(signal.SIGUSR1 if on_battery else signal.SIGUSR2)

    def _battery(self, on):
        self._power(on)
        return self._settle(lambda s: s.get("onBattery") == on and not s.get("busy"))

    def _modes(self, since):
        """The built-in screen's mode in each configuration applied since."""
        state = self._state()
        modes = []
        for applied in state["applied"][since:]:
            for logical in applied["logical"]:
                for connector, mode, _props in logical[5]:
                    if connector == "eDP-1":
                        modes.append(mode)
        return modes, state

    def _current(self, state):
        return dict(state["current"]).get("eDP-1")

    def _fixture(self, extra_monitor=False):
        state = json.load(open(FIXTURE, encoding="utf-8"))
        if extra_monitor:
            # A monitor at the desk, right of the laptop.
            state[1].append([["DP-1", "DEL", "U2723QE", "0x1"],
                             [["3840x2160@60.000", 3840, 2160, 60.0, 1.5, [1.0, 1.5, 2.0],
                               {"is-current": True, "is-preferred": True}]],
                             {"is-builtin": False, "display-name": "Dell 27"}])
            state[2].append([1728, 0, 1.5, 0, False, [["DP-1", "DEL", "U2723QE", "0x1"]], {}])
        return json.dumps(state)

    # ---------------------------------------------------------- UPower
    def _start_upower(self):
        subprocess.run(["systemctl", "mask", "--runtime", "--now", "upower.service"],
                       capture_output=True, check=False)
        ready = "/tmp/fake-upower.ready"
        if os.path.exists(ready):
            os.remove(ready)
        self._fake = subprocess.Popen(["python3", os.path.join(os.path.dirname(__file__), "fake_upower.py"),
                                       ready], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.path.exists(ready):
                return True
            GLib.usleep(50 * 1000)
        return False

    def _stop_upower(self):
        if self._fake:
            self._fake.terminate()
            try:
                self._fake.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._fake.kill()
            self._fake = None
        subprocess.run(["systemctl", "unmask", "--runtime", "upower.service"], capture_output=True, check=False)
        subprocess.run(["systemctl", "start", "upower.service"], capture_output=True, check=False)

    # ------------------------------------------------------------ checks
    def run(self):
        check = self._check
        if not check("UPower could be stood in for", self._start_upower()):
            self._stop_upower()
            return
        try:
            self._run()
        finally:
            self._setting(KEY, "false")
            self._hook("RestoreDisplayConfig")
            self._stop_upower()

    def _run(self):
        check = self._check
        hook = self._hook

        # Off, which is the default: nothing watched, on battery or not.
        self._battery(True)
        state = self._settle()
        check("with Low Power Mode off, neither UPower nor the monitors are watched",
              state["present"] and not state["watching"] and not state["watchingMonitors"], f"{state}")

        # On, against the real DisplayConfig and its virtual monitor, which
        # is not built in: read without an error, and left alone.
        self._setting(KEY, "true")
        state = self._settle(lambda s: s.get("onBattery") is True and not s.get("busy"))
        check("on battery, the real DisplayConfig is read without an error and a virtual monitor is left alone",
              state["watching"] and state["onBattery"] is True and not state["lastError"] and
              not state["switched"], f"{state}")
        self._battery(False)

        # framy's screen from here on.
        check("Mutter's DisplayConfig could be stood in for", hook("FakeDisplayConfig", (self._fixture(),), "(s)"))

        state = self._battery(True)
        modes, state = self._modes(0)
        applied = state["applied"][-1] if state["applied"] else None
        logical = applied["logical"] if applied else []
        check("on battery, the built-in screen goes to the same mode at 60 Hz, variable refresh kept",
              modes == [VRR_60] and self._current(state) == VRR_60, f"{modes}, now {self._current(state)}")
        check("the rest of the layout is passed back as it was",
              len(logical) == 1 and logical[0][:5] == [0, 0, logical[0][2], 0, True] and
              abs(logical[0][2] - 1.6666666269302368) < 1e-6 and
              logical[0][5][0][2] == {"underscanning": False, "color-mode": 0, "rgb-range": 1} and
              applied["properties"] == {"layout-mode": 1}, f"{applied}")
        check("as a temporary configuration, which mutter does not save",
              applied and applied["method"] == 1, f"{applied and applied['method']}")

        state = self._battery(False)
        modes, state = self._modes(1)
        check("plugged in, it goes back to the mode it had", modes == [VRR_120] and
              self._current(state) == VRR_120 and not state["switched"], f"{modes}, now {self._current(state)}")

        # A rate picked on battery is the user's.
        self._battery(True)
        hook("SetFakeMode", ("eDP-1", FIXED_120), "(ss)")
        state = self._settle(lambda s: s.get("heldOff") and not s.get("busy"))
        count = len(state["applied"])
        check("a mode changed by someone else on battery is left alone",
              state["heldOff"] and not state["switched"] and self._current(state) == FIXED_120, f"{state}")
        state = self._battery(False)
        check("and plugging in does not touch it either",
              len(state["applied"]) == count and self._current(state) == FIXED_120 and not state["heldOff"],
              f"{state['applied'][count:]}, now {self._current(state)}")

        # A fixed rate stays fixed.
        state = self._battery(True)
        modes, state = self._modes(count)
        check("a screen at a fixed 120 Hz goes to the fixed 60 Hz mode", modes == [FIXED_60], f"{modes}")
        state = self._battery(False)
        modes, state = self._modes(count)
        check("and back to the fixed 120 Hz", modes == [FIXED_60, FIXED_120], f"{modes}")
        hook("SetFakeMode", ("eDP-1", VRR_120), "(ss)")
        self._settle()

        # Already at 60 Hz: nothing to do either way.
        hook("SetFakeMode", ("eDP-1", VRR_60), "(ss)")
        count = len(self._settle()["applied"])
        self._battery(True)
        state = self._battery(False)
        check("a screen already at 60 Hz is left at it",
              len(state["applied"]) == count and self._current(state) == VRR_60, f"{state['applied'][count:]}")

        # At a desk: a second monitor connected.
        check("a second monitor could be stood in", hook("FakeDisplayConfig", (self._fixture(True),), "(s)"))
        state = self._battery(True)
        check("with another monitor connected, nothing is changed on battery",
              not state["applied"] and self._current(state) == VRR_120, f"{state['applied']}")
        self._battery(False)

        # Turned off on battery, and Pear Up switched off on battery.
        hook("FakeDisplayConfig", (self._fixture(),), "(s)")
        self._battery(True)
        self._setting(KEY, "false")
        state = self._settle(lambda s: not s.get("switched") and not s.get("busy"))
        modes, state = self._modes(0)
        check("turning Low Power Mode off on battery puts the rate back", modes == [VRR_60, VRR_120] and
              not state["watching"], f"{modes}")

        self._setting(KEY, "true")
        state = self._settle(lambda s: s.get("switched") and not s.get("busy"))
        count = len(state["applied"])
        cycled = hook("SwitchPearUp", (False, False), "(bb)") and hook("SwitchPearUp", (True, False), "(bb)")
        state = self._settle(lambda s: s.get("switched") and not s.get("busy"))
        modes, state = self._modes(count)
        check("switching Pear Up off on battery puts the rate back, and back on brings 60 Hz again",
              cycled and modes == [VRR_120, VRR_60], f"{modes}")

        # The lock screen switches Pear Up off and the unlock on: no mode change.
        count = len(state["applied"])
        cycled = hook("SwitchPearUp", (False, True), "(bb)") and hook("SwitchPearUp", (True, False), "(bb)")
        state = self._settle(lambda s: s.get("onBattery") is True and not s.get("busy"))
        check("locking and unlocking on battery changes no mode",
              cycled and len(state["applied"]) == count and state["switched"] and self._current(state) == VRR_60,
              f"{state['applied'][count:]}, now {self._current(state)}")

        # Plugged in while locked: the unlock goes back.
        cycled = hook("SwitchPearUp", (False, True), "(bb)")
        self._power(False)
        GLib.usleep(300 * 1000)
        cycled = cycled and hook("SwitchPearUp", (True, False), "(bb)")
        state = self._settle(lambda s: not s.get("switched") and not s.get("busy"))
        modes, state = self._modes(count)
        check("plugged in while locked, the unlock puts the rate back", cycled and modes == [VRR_120], f"{modes}")

        # Changes while mutter is still answering. Each call held back.
        self._races()

    def _held(self, timeout=3.0):
        """Until a held call is waiting; whether one is."""
        deadline = GLib.get_monotonic_time() + int(timeout * 1e6)
        while GLib.get_monotonic_time() < deadline:
            if self._state()["held"]:
                return True
            GLib.usleep(20 * 1000)
        return False

    def _release_all(self, timeout=6.0):
        """Releases held calls one at a time, as each comes, until the passes
        are done; then holds nothing more."""
        deadline = GLib.get_monotonic_time() + int(timeout * 1e6)
        while GLib.get_monotonic_time() < deadline:
            state = self._state()
            if state["held"]:
                self._hook("ReleaseFakeCall")
            elif not state["busy"]:
                break
            GLib.usleep(50 * 1000)
        self._hook("HoldFakeCalls", ("", False), "(sb)")
        return self._settle()

    def _races(self):
        check = self._check
        hook = self._hook
        hook("FakeDisplayConfig", (self._fixture(),), "(s)")
        self._battery(True)

        # Plugged in, and the user picks a rate while the restore's read of the
        # monitors is on its way: what it read must not be applied.
        count = len(self._state()["applied"])
        hook("HoldFakeCalls", ("GetCurrentState", False), "(sb)")
        self._power(False)
        reading = self._held()
        hook("SetFakeMode", ("eDP-1", FIXED_120), "(ss)")
        state = self._release_all()
        modes, state = self._modes(count)
        check("a rate picked while the restore reads the monitors is not overwritten",
              reading and modes == [] and self._current(state) == FIXED_120 and not state["switched"],
              f"read held {reading}, {modes}, now {self._current(state)}")

        # A lock while the read for a switch to 60 Hz is on its way, and the
        # power plugged in before the unlock: the screen ends at its own rate.
        hook("SetFakeMode", ("eDP-1", VRR_120), "(ss)")
        self._settle()
        count = len(self._state()["applied"])
        hook("HoldFakeCalls", ("GetCurrentState", False), "(sb)")
        self._power(True)
        reading = self._held()
        cycled = hook("SwitchPearUp", (False, True), "(bb)")
        self._power(False)
        GLib.usleep(200 * 1000)
        cycled = cycled and hook("SwitchPearUp", (True, False), "(bb)")
        self._settle(lambda s: s.get("onBattery") is False)
        state = self._release_all()
        modes, state = self._modes(count)
        check("a switch on its way over a lock, plugged in before the unlock, ends at the screen's own rate",
              reading and cycled and self._current(state) == VRR_120 and not state["switched"],
              f"read held {reading}, {modes}, now {self._current(state)}")

        # Pear Up switched off and on again on battery while its restore reads
        # the monitors; each read answered as it is when released. The new
        # instance must not take the old one's restore for the user's.
        self._battery(True)
        self._settle(lambda s: s.get("switched") and not s.get("busy"))
        count = len(self._state()["applied"])
        hook("HoldFakeCalls", ("GetCurrentState", True), "(sb)")
        cycled = hook("SwitchPearUp", (False, False), "(bb)")
        reading = self._held()
        cycled = cycled and hook("SwitchPearUp", (True, False), "(bb)")
        self._settle(lambda s: s.get("onBattery") is True)
        state = self._release_all()
        modes, state = self._modes(count)
        check("Pear Up switched off and on during a restore ends at 60 Hz, not held off",
              reading and cycled and self._current(state) == VRR_60 and not state["heldOff"],
              f"read held {reading}, {modes}, now {self._current(state)}, held off {state['heldOff']}")
        self._battery(False)

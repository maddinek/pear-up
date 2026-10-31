#!/usr/bin/env python3
"""Replays touchpad gestures through real libinput with the scroll plugin, the
Mac scroll engine on or off, and returns what libinput hands the compositor.

Shared by check-engine-with-libinput.py (the checks) and by
tests/scroll-e2e/ (the end-to-end test). Container only, like
check-with-libinput.py, whose made-up touchpad (framy's PIXA3854) and kernel
it uses.
"""
import importlib.util
import os
import re
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('cwl', os.path.join(HERE, 'check-with-libinput.py'))
cwl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cwl)

PLUGIN = os.path.join(HERE, '..', '..', 'libinput', '10-pear-up-scroll-acceleration.lua')
INSTALLED = os.path.join(cwl.PLUGIN_DIR, os.path.basename(PLUGIN))
TROUBLE = ('missing SYN_REPORT', 'libevdev:')


def install(engine, speed=None):
    """The plugin into libinput's directory, with ENGINE (and SPEED) set."""
    with open(PLUGIN) as source:
        text = source.read()
    text = re.sub(r'^local ENGINE = (true|false)$', f'local ENGINE = {"true" if engine else "false"}', text, flags=re.M)
    if speed is not None:
        text = re.sub(r'^local SPEED = [0-9.]+$', f'local SPEED = {speed}', text, flags=re.M)
    os.makedirs(cwl.PLUGIN_DIR, exist_ok=True)
    with open(INSTALLED, 'w') as out:
        out.write(text)


class Fingers(cwl.Kernel):
    """The kernel, with frames at chosen times rather than every 8 ms. Times
    are in seconds from the start of the gesture.

    umockdev replays a recording with its own timestamps, from when libinput
    opens the device, while the plugin's timer runs on the clock. On a real
    touchpad the two agree to a millisecond or so, and libinput runs a plugin's
    timer by whichever it was given last, so they have to agree here too:
    `lead` is how far ahead of the clock the recording is made to start, which
    run() finds by trying."""

    def __init__(self, lead=0.035):
        super().__init__()
        self.lines = []
        self.t = time.monotonic() + lead
        self.event(cwl.EV_MSC, cwl.MSC_TIMESTAMP, 0)
        self.event(cwl.EV_SYN, 0, 0)
        self.t += 0.5
        self.t0 = self.t

    def at(self, t, fingers, button=False):
        self.t = self.t0 + t
        self.frame(fingers, button)


def scroll_track(kernel, track, start=0.0, x=(45.0, 61.0), y0=20.0):
    """Two fingers following `track`, a list of (seconds, mm moved down),
    starting `start` s into the gesture, then lifting together 7 ms after the
    last point. Returns the time of the lift."""
    t = start
    kernel.at(t, {0: (x[0], y0)})
    t += 0.007
    for _ in range(3):
        kernel.at(t, {0: (x[0], y0), 1: (x[1], y0)})
        t += 0.007
    base = t
    for ts, mm in track:
        kernel.at(base + ts, {0: (x[0], y0 + mm), 1: (x[1], y0 + mm)})
    lift = base + track[-1][0] + 0.007
    kernel.at(lift, {})
    return lift


def flick_track(peak, accel=0.08, cruise=0.04, rate=0.007, decel=0.0):
    """Fingers that speed up to `peak` mm/s over `accel` s (smoothly), hold it
    for `cruise` s and lift (after slowing for `decel` s), sampled every
    `rate` s as the touchpad reports."""
    pts, y, t = [], 0.0, 0.0
    total = accel + cruise + decel
    while t <= total + 1e-9:
        if t < accel:
            s = t / accel
            v = peak * s * s * (3 - 2 * s)
        elif t < accel + cruise:
            v = peak
        else:
            s = (t - accel - cruise) / decel
            v = peak * (1 - s * s * (3 - 2 * s))
        y += v * rate
        pts.append((t, y))
        t += rate
    return pts


LEAD = [0.035]
CLOCK = re.compile(r'touchpad clock (-?\d+) us behind')


def run(workdir, gesture, seconds=None, tries=8, extra_args=(), skew=0.004):
    """Runs `gesture(kernel)` (which returns its last time, in s from its
    start) through libinput. Returns [(seconds, line)], the log. With the
    engine on, a run whose touchpad clock is off the plugin's by more than
    `skew` s is run again with the start moved."""
    for _ in range(tries):
        kernel = Fingers(LEAD[0])
        end = gesture(kernel)
        path = os.path.join(workdir, 'gesture.events')
        with open(path, 'w') as out:
            out.write('\n'.join(kernel.lines) + '\n')
        span = (kernel.t0 + end) - time.monotonic() + 1.5
        args = ['libinput', 'debug-events', '--verbose', '--device', cwl.DEV, '--enable-plugins', *extra_args]
        inner = (
            'mkdir -p "$UMOCKDEV_DIR/run/udev/data" && '
            'printf "I:1\\nE:ID_INPUT=1\\nE:ID_INPUT_TOUCHPAD=1\\n" > "$UMOCKDEV_DIR/run/udev/data/c13:72" && '
            f'exec timeout -s INT {max(seconds or 0, span, 3.0):.1f} ' + ' '.join(args)
        )
        result = subprocess.run(
            ['umockdev-run', '-d', os.path.join(workdir, 'touchpad.umockdev'),
             '-i', f'{cwl.DEV}={os.path.join(workdir, "touchpad.ioctl")}',
             '-e', f'{cwl.DEV}={path}', '--', 'sh', '-c', inner],
            cwd=workdir, capture_output=True, text=True, timeout=max(span, 3.0) + 30)
        log = result.stdout + result.stderr
        if any(sign in log for sign in TROUBLE):
            continue
        clock = CLOCK.search(log)
        if clock:
            behind = int(clock.group(1)) / 1e6
            # Aim for a millisecond behind, as a touchpad is.
            if abs(behind - 0.001) > skew:
                LEAD[0] += behind - 0.001
                continue
        lines = []
        for line in result.stdout.splitlines():
            stamp = re.search(r'\+(\d+\.\d+)s', line)
            text = re.sub(r'\+\d+\.\d+s\s*', '', line)
            text = re.sub(r'^\s*\S+\s+', '', text).strip()
            lines.append((float(stamp.group(1)) if stamp else None, text))
        return lines, log
    raise RuntimeError('the replay never came through whole:\n' + log[-1500:])


SCROLL = re.compile(r'vert\s+(-?\d+\.\d+)(\*?)')


def scrolls(lines):
    """[(seconds, vertical units, stop?)] of the finger scroll events."""
    out = []
    for stamp, text in lines:
        if text.startswith('POINTER_SCROLL_FINGER'):
            m = SCROLL.search(text)
            if m:
                value = float(m.group(1))
                out.append((stamp, value, value == 0.0))
    return out


def setup():
    if not (os.path.exists('/run/.containerenv') or os.path.exists('/.dockerenv')):
        raise SystemExit('Container only: this installs a plugin into /etc/libinput/plugins.')
    import tempfile
    workdir = tempfile.mkdtemp(prefix='pear-up-engine-')
    cwl.write_device(workdir)
    return workdir


def cleanup(workdir):
    shutil.rmtree(workdir, ignore_errors=True)
    if os.path.exists(INSTALLED):
        os.remove(INSTALLED)

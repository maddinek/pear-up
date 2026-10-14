#!/usr/bin/env python3
"""The scroll plugin live inside the libinput on this machine: a gesture's
frames are written to a uinput touchpad (framy's PIXA3854, made up the same
way each time), the kernel hands them on as it does a real touchpad's (a
slot named only when it changes, a value only when it changed), and a
libinput path context that loads the plugin the way mutter does (its own
directory first, then libinput's defaults) turns them into the events a
compositor gets. Nothing is simulated: the plugin's timer runs on libinput's.

Host only, as root (uinput and /dev/input). The touchpad is grabbed
(EVIOCGRAB) the moment libinput opens it, so the desktop's own compositor,
which sees a new touchpad come and go, never gets a single event from it.

    from live import Live
    with Live(engine=True) as li:
        scrolls, lines, log = li.run(frames, t0_us)

frames: [(µs, [(type, code, value)])] at the times planned for them (any
clock); t0_us: the moment the result's times count from, on that clock.
scrolls: [(ms, vertical units, stop)]; lines: libinput's events, worded as
`libinput debug-events` words them; log: libinput's log. After a run,
`jumps` holds when libinput discarded a touch's move as a jump (ms), and
`cpu_share` and `wakeups_per_s` what the run cost (a spinning timer shows),
and `hscroll` the horizontal scrolls and stops ([(ms, units, stop)]).
"""
import ctypes
import faulthandler
import fcntl
import os
import re
import select
import shutil
import tempfile
import time

import libevdev

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.abspath(os.path.join(HERE, '..', '..', 'libinput', '10-pear-up-scroll-acceleration.lua'))
NAME = 'PIXA3854:00 093A:1343 Touchpad'
RES, XMAX, YMAX, SLOTS = 24, 2830, 1720, 5
EVIOCGRAB = 0x40044590

# libinput's event types (libinput.h).
DEVICE_ADDED = 1
MOTION, BUTTON, SCROLL_FINGER = 400, 402, 405
GESTURE = {800: 'GESTURE_SWIPE_BEGIN', 801: 'GESTURE_SWIPE_UPDATE', 802: 'GESTURE_SWIPE_END',
           803: 'GESTURE_PINCH_BEGIN', 804: 'GESTURE_PINCH_UPDATE', 805: 'GESTURE_PINCH_END',
           806: 'GESTURE_HOLD_BEGIN', 807: 'GESTURE_HOLD_END'}
BUTTONS = {0x110: 'BTN_LEFT', 0x111: 'BTN_RIGHT', 0x112: 'BTN_MIDDLE'}

li = ctypes.CDLL('libinput.so.10')
libc = ctypes.CDLL('libc.so.6')
P = ctypes.c_void_p
for name, res in (('libinput_path_create_context', P), ('libinput_path_add_device', P),
                  ('libinput_get_event', P), ('libinput_event_get_pointer_event', P),
                  ('libinput_event_get_gesture_event', P), ('libinput_event_get_device', P),
                  ('libinput_event_pointer_get_scroll_value', ctypes.c_double),
                  ('libinput_event_pointer_get_dx', ctypes.c_double),
                  ('libinput_event_pointer_get_dy', ctypes.c_double),
                  ('libinput_event_pointer_get_time_usec', ctypes.c_uint64),
                  ('libinput_event_gesture_get_time_usec', ctypes.c_uint64),
                  ('libinput_event_gesture_get_finger_count', ctypes.c_int),
                  ('libinput_event_pointer_get_button', ctypes.c_uint32),
                  ('libinput_event_pointer_get_button_state', ctypes.c_int),
                  ('libinput_event_pointer_has_axis', ctypes.c_int),
                  ('libinput_event_get_type', ctypes.c_int), ('libinput_get_fd', ctypes.c_int),
                  ('libinput_unref', P)):
    getattr(li, name).restype = res

LOGH = ctypes.CFUNCTYPE(None, P, ctypes.c_int, ctypes.c_char_p, P)
OPEN = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, P)
CLOSE = ctypes.CFUNCTYPE(None, ctypes.c_int, P)


class Interface(ctypes.Structure):
    _fields_ = [('open_restricted', OPEN), ('close_restricted', CLOSE)]


def _open(path, flags, _):
    try:
        fd = os.open(path, flags)
    except OSError as e:
        return -e.errno
    try:
        fcntl.ioctl(fd, EVIOCGRAB, 1)
    except OSError:
        os.close(fd)
        return -16
    return fd


def _close(fd, _):
    try:
        fcntl.ioctl(fd, EVIOCGRAB, 0)
    except OSError:
        pass
    os.close(fd)


_LOG = []


def _log(_ctx, priority, fmt, args):
    buf = ctypes.create_string_buffer(4096)
    libc.vsnprintf(buf, 4096, fmt, P(args))
    _LOG.append((time.monotonic(), buf.value.decode(errors='replace').rstrip()))


_callbacks = (LOGH(_log), OPEN(_open), CLOSE(_close))
_interface = Interface(_callbacks[1], _callbacks[2])


def plugin_text(engine, speed='0.7', source=PLUGIN, tick_hz=None):
    with open(source) as f:
        text = f.read()
    if tick_hz:
        text = re.sub(r'^local TICK = 1000000 / 480', f'local TICK = 1000000 / {tick_hz}', text, count=1, flags=re.M)
    text = re.sub(r'^local ENGINE = (true|false)$', f'local ENGINE = {"true" if engine else "false"}', text,
                  count=1, flags=re.M)
    return re.sub(r'^local SPEED = [0-9.]+$', f'local SPEED = {speed}', text, count=1, flags=re.M)


def touchpad():
    """A new uinput PIXA3854, and its node once udev has called it a touchpad."""
    d = libevdev.Device()
    d.name = NAME
    d.id = {'bustype': 0x18, 'vendor': 0x93a, 'product': 0x1343, 'version': 0x100}
    for key in ('BTN_LEFT', 'BTN_TOOL_FINGER', 'BTN_TOOL_QUINTTAP', 'BTN_TOUCH', 'BTN_TOOL_DOUBLETAP',
                'BTN_TOOL_TRIPLETAP', 'BTN_TOOL_QUADTAP'):
        d.enable(getattr(libevdev.EV_KEY, key))
    axes = {'ABS_X': (XMAX, RES), 'ABS_Y': (YMAX, RES), 'ABS_MT_SLOT': (SLOTS - 1, 0),
            'ABS_MT_POSITION_X': (XMAX, RES), 'ABS_MT_POSITION_Y': (YMAX, RES),
            'ABS_MT_TOOL_TYPE': (2, 0), 'ABS_MT_TRACKING_ID': (65535, 0)}
    for axis, (maximum, res) in axes.items():
        d.enable(getattr(libevdev.EV_ABS, axis), libevdev.InputAbsInfo(minimum=0, maximum=maximum, resolution=res))
    d.enable(libevdev.EV_MSC.MSC_TIMESTAMP)
    d.enable(libevdev.INPUT_PROP_POINTER)
    d.enable(libevdev.INPUT_PROP_BUTTONPAD)
    ui = d.create_uinput_device()
    rdev = os.stat(ui.devnode).st_rdev
    data = f'/run/udev/data/c{os.major(rdev)}:{os.minor(rdev)}'
    end = time.monotonic() + 3
    while time.monotonic() < end:
        try:
            if 'ID_INPUT_TOUCHPAD=1' in open(data).read():
                return ui
        except OSError:
            pass
        time.sleep(0.01)
    raise RuntimeError(f'udev never tagged {ui.devnode} as a touchpad')


def prime_frames(t_us, slot=SLOTS - 1):
    """One finger resting 250 ms in `slot`, then lifted: the kernel is left on
    that slot, as after a touchpad's ordinary use, so the gesture's first slot
    is named (start a gesture on a fresh touchpad without it, and the kernel
    does not name slot 0, which it is already on)."""
    x, y = 70 * RES, 40 * RES
    frames = [(t_us, [(3, 0x2f, slot), (3, 0x39, 9000), (3, 0x35, x), (3, 0x36, y), (1, 0x14a, 1),
                      (1, 0x145, 1), (3, 0, x), (3, 1, y), (4, 5, 0)])]
    for i in range(1, 36):
        frames.append((t_us + i * 7000, [(4, 5, i * 7000)]))
    frames.append((t_us + 36 * 7000, [(3, 0x39, -1), (1, 0x14a, 0), (1, 0x145, 0), (4, 5, 36 * 7000)]))
    return frames


def _writer(ui, schedule):
    """In a child: each frame at its moment, to well under a millisecond."""
    for at, events in schedule:
        while True:
            left = at - time.monotonic()
            if left <= 0:
                break
            time.sleep(left - 0.0015 if left > 0.002 else 0)
        ui.send_events(events)


class Live:
    def __init__(self, engine, speed='0.7', source=PLUGIN, tick_hz=None):
        self.dir = tempfile.mkdtemp(prefix='pear-up-live-')
        plugins = os.path.join(self.dir, 'libinput', 'plugins')
        os.makedirs(plugins)
        with open(os.path.join(plugins, os.path.basename(PLUGIN)), 'w') as out:
            out.write(plugin_text(engine, speed, source, tick_hz))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run(self, frames, t0_us, extra=(), prime=True, tail=1.5, lead=0.3):
        ui = touchpad()
        ctx = li.libinput_path_create_context(ctypes.byref(_interface), None)
        _LOG.clear()
        li.libinput_log_set_handler(P(ctx), _callbacks[0])
        li.libinput_log_set_priority(P(ctx), 10 if '--verbose' in extra else 20)
        li.libinput_plugin_system_append_path(P(ctx), os.path.join(self.dir, 'libinput', 'plugins').encode())
        li.libinput_plugin_system_append_default_paths(P(ctx))
        li.libinput_plugin_system_load_plugins(P(ctx), 0)
        dev = li.libinput_path_add_device(P(ctx), ui.devnode.encode())
        if not dev:
            li.libinput_unref(P(ctx))
            raise RuntimeError('libinput did not take the touchpad:\n' + '\n'.join(m for _, m in _LOG[-5:]))
        for arg in extra:
            if arg == '--enable-tap':
                li.libinput_device_config_tap_set_enabled(P(dev), 1)
            elif arg.startswith('--set-click-method='):
                method = {'buttonareas': 1, 'clickfinger': 2, 'none': 0}[arg.split('=', 1)[1]]
                li.libinput_device_config_click_set_method(P(dev), method)
        fd = li.libinput_get_fd(P(ctx))

        # When each frame goes out, on this clock.
        start = time.monotonic() + lead
        plan = []
        first = frames[0][0]
        if prime:
            plan += [(start + (t - first) / 1e6, ev) for t, ev in prime_frames(first)]
            start += 0.6
        shift_us = int(start * 1e6) - first
        plan += [(start + (t - first) / 1e6, ev) for t, ev in frames]
        schedule = [(at, [libevdev.InputEvent(libevdev.evbit(ty, code), value) for ty, code, value in ev]
                     + [libevdev.InputEvent(libevdev.EV_SYN.SYN_REPORT, 0)]) for at, ev in plan]
        gesture_from = int(start * 1e6)
        end = plan[-1][0] + tail

        pid = os.fork()
        if pid == 0:
            try:
                _writer(ui, schedule)
            finally:
                os._exit(0)
        got = []
        # A plugin that keeps libinput's timer loop spinning never returns
        # from libinput_dispatch(): then this process says where it was and
        # ends (exit 1) rather than hang the test.
        faulthandler.dump_traceback_later(end - time.monotonic() + 10, exit=True)
        cpu0, wall0, wakeups = time.process_time(), time.monotonic(), 0
        while True:
            now = time.monotonic()
            if now >= end:
                break
            if select.select([fd], [], [], min(end - now, 0.05))[0]:
                wakeups += 1
                li.libinput_dispatch(P(ctx))
            while True:
                ev = li.libinput_get_event(P(ctx))
                if not ev:
                    break
                got.append(self._read(ev))
                li.libinput_event_destroy(P(ev))
        faulthandler.cancel_dump_traceback_later()
        # What libinput (and the plugin in it) cost: CPU time of this loop and
        # how often libinput's fd woke it (each touchpad frame and each run of
        # a timer), per second of the run.
        wall = time.monotonic() - wall0
        self.cpu_share = (time.process_time() - cpu0) / wall
        self.wakeups_per_s = wakeups / wall
        os.waitpid(pid, 0)
        li.libinput_path_remove_device(P(dev))
        li.libinput_dispatch(P(ctx))
        while True:
            ev = li.libinput_get_event(P(ctx))
            if not ev:
                break
            li.libinput_event_destroy(P(ev))
        li.libinput_unref(P(ctx))
        del ui
        log = '\n'.join(m for _, m in _LOG)
        # When libinput threw a touch's move away as a jump (logged as it
        # processed the frame, within a dispatch of it), on the result's clock.
        self.jumps = [(at * 1e6 - shift_us - t0_us) / 1000 for at, m in _LOG
                      if 'Touch jump detected' in m and at * 1e6 >= gesture_from]

        scrolls, lines = [], []
        self.hscroll = []    # [(ms, horizontal units, stop)]
        for item in got:
            if item is None or item[0] < gesture_from:
                continue   # the priming touch (and the device's arrival)
            t_us, kind, text, value = item
            ms = (t_us - shift_us - t0_us) / 1000
            lines.append(f'event0  {kind:<24s} +{ms / 1000:.3f}s\t{text}')
            if kind == 'POINTER_SCROLL_FINGER':
                what, v, h = value
                if what == 'stop':
                    if v is not None:
                        scrolls.append((ms, 0.0, True))
                    else:
                        self.hscroll.append((ms, 0.0, True))
                else:
                    if v:
                        scrolls.append((ms, v, False))
                    if h:
                        self.hscroll.append((ms, h, False))
        return scrolls, lines, log

    @staticmethod
    def _read(ev):
        kind = li.libinput_event_get_type(P(ev))
        if kind in (MOTION, BUTTON, SCROLL_FINGER):
            p = li.libinput_event_get_pointer_event(P(ev))
            t = li.libinput_event_pointer_get_time_usec(P(p))
            if kind == MOTION:
                dx, dy = li.libinput_event_pointer_get_dx(P(p)), li.libinput_event_pointer_get_dy(P(p))
                return t, 'POINTER_MOTION', f'{dx:6.2f}/{dy:6.2f}', None
            if kind == BUTTON:
                b = li.libinput_event_pointer_get_button(P(p))
                state = 'pressed' if li.libinput_event_pointer_get_button_state(P(p)) else 'released'
                return t, 'POINTER_BUTTON', f'{BUTTONS.get(b, hex(b))} ({b}) {state}', None
            # libinput sends only the axes that moved, and a stop as the
            # axes it ends with a value of 0 (evdev.c, evdev_post_scroll()).
            v = h = None
            if li.libinput_event_pointer_has_axis(P(p), 0):
                v = li.libinput_event_pointer_get_scroll_value(P(p), 0)
            if li.libinput_event_pointer_has_axis(P(p), 1):
                h = li.libinput_event_pointer_get_scroll_value(P(p), 1)
            if all(a is None or a == 0.0 for a in (v, h)):
                return t, 'POINTER_SCROLL_FINGER', 'vert 0.00/0.0* horiz 0.00/0.0*', ('stop', v, h)
            text = (f'vert {v or 0.0:.2f}/0.0 ' if v is not None else 'vert 0.00/0.0 ') + \
                   (f'horiz {h:.2f}/0.0' if h is not None else 'horiz 0.00/0.0')
            return t, 'POINTER_SCROLL_FINGER', text, ('move', v, h)
        if kind in GESTURE:
            g = li.libinput_event_get_gesture_event(P(ev))
            t = li.libinput_event_gesture_get_time_usec(P(g))
            return t, GESTURE[kind], str(li.libinput_event_gesture_get_finger_count(P(g))), None
        return None


def scrolls_of(lines):
    """[(ms, units, stop)] of lines run() returned (or debug-events')."""
    out = []
    for line in lines:
        if 'POINTER_SCROLL_FINGER' in line:
            ms = float(re.search(r'\+(-?\d+\.\d+)s', line).group(1)) * 1000
            v = float(re.search(r'vert (-?\d+\.\d+)', line).group(1))
            out.append((ms, v, v == 0.0))
    return out


if __name__ == '__main__':
    # A quick look: a 150 mm/s flick, engine off and on.
    import sys
    sys.path.insert(0, os.path.join(HERE, '..', 'libinput'))
    import gestures as G
    events, _ = G.load(os.path.join(HERE, 'gestures', sys.argv[1] if len(sys.argv) > 1 else 'flick.yaml'))
    frames, cur, last = [], [], None
    for t, ty, code, value in events:
        if ty == 0:
            frames.append((int(t * 1e6), cur))
            cur = []
        else:
            cur.append((ty, code, value))
    for engine in (False, True):
        for prime in (True, False):
            with Live(engine) as run:
                s, lines, log = run.run(frames, frames[0][0], prime=prime)
            moves = [t for t, v, stop in s if not stop]
            gaps = sorted(b - a for a, b in zip(moves, moves[1:]))
            print(f'engine {engine!s:5s} primed {prime!s:5s}: {len(moves)} scrolls, '
                  f'{moves[-1] - moves[0] if moves else 0:.0f} ms, median gap {gaps[len(gaps) // 2] if gaps else 0:.2f} ms, '
                  f'{sum(1 for _, _, stop in s if stop)} stop, {abs(sum(v for _, v, _ in s)):.1f} units')

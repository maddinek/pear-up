#!/usr/bin/env python3
"""Run the scroll acceleration plugin inside real libinput, against a touchpad
that only exists in a umockdev testbed.

    python3 tests/libinput/check-with-libinput.py <plugin.lua>

Only for a container (tests/lib/check-libinput-here.sh sets one up), and it
refuses to run anywhere else: it installs the plugin into /etc/libinput/plugins,
which on a desktop is a directory the compositor loads plugins from at login.
It needs libinput 1.30 or later with its tools, umockdev and nothing else.

`libinput replay` would be the obvious tool, but it creates the touchpad with
uinput, as a real kernel device, and every libinput on the machine picks that up
— a desktop session included, which then scrolls to the replay. umockdev
instead fakes the device node, its ioctls and its udev entry for the one process
it runs, by preloading itself: no kernel device exists, so nothing else can see
it. The touchpad described here is framy's, a PIXA3854 at 24 units per mm, and
the gestures are written the way its kernel driver would send them.

Every gesture is replayed twice, once with the plugin installed and once
without, and the two outputs are compared.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

PLUGIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'libinput', '10-pear-up-scroll-acceleration.lua')

DEV = '/dev/input/event8'
NAME = 'PIXA3854:00 093A:1343 Touchpad'
RES = 24
XMAX, YMAX = 2830, 1720
SLOTS = 5
FRAME = 0.008
PLUGIN_DIR = '/etc/libinput/plugins'

EV_SYN, EV_KEY, EV_ABS, EV_MSC = 0, 1, 3, 4
ABS_X, ABS_Y = 0x00, 0x01
ABS_MT_SLOT, ABS_MT_X, ABS_MT_Y, ABS_MT_TOOL, ABS_MT_ID = 0x2f, 0x35, 0x36, 0x37, 0x39
BTN_LEFT, BTN_TOOL_FINGER, BTN_TOOL_QUINTTAP, BTN_TOUCH = 0x110, 0x145, 0x148, 0x14a
BTN_TOOL_DOUBLETAP, BTN_TOOL_TRIPLETAP, BTN_TOOL_QUADTAP = 0x14d, 0x14e, 0x14f
MSC_TIMESTAMP = 0x05


def hexs(data):
    return data.hex().upper()


def bits(size, *numbers):
    mask = bytearray(size)
    for number in numbers:
        mask[number // 8] |= 1 << (number % 8)
    return bytes(mask)


def absinfo(minimum, maximum, resolution=0, value=0):
    return struct.pack('<6i', value, minimum, maximum, 0, 0, resolution)


def write_device(directory):
    """The udev entry and the ioctl answers of the touchpad, in umockdev's
    formats (see umockdev's devices/input/ for recorded ones). libevdev asks
    for the name, phys and uniq with 255-byte buffers, and umockdev only
    answers a request of the size recorded."""
    with open(os.path.join(directory, 'touchpad.umockdev'), 'w') as out:
        out.write(f'''P: /devices/platform/i2c-PIXA3854:00/input/input10/event8
N: input/event8
E: DEVNAME={DEV}
E: ID_INPUT=1
E: ID_INPUT_TOUCHPAD=1
E: ID_INPUT_WIDTH_MM=118
E: ID_INPUT_HEIGHT_MM=71
E: MAJOR=13
E: MINOR=72
E: SUBSYSTEM=input
A: dev=13:72

P: /devices/platform/i2c-PIXA3854:00/input/input10
E: NAME="{NAME}"
E: PRODUCT=18/93a/1343/100
E: PROP=5
E: EV=1b
E: KEY=e520 10000 0 0 0 0
E: ABS=2e0800000000003
E: MSC=20
E: SUBSYSTEM=input
A: name={NAME}
A: properties=5

P: /devices/platform/i2c-PIXA3854:00
E: SUBSYSTEM=platform
''')

    name = NAME.encode() + b'\0'
    phys = b'i2c-PIXA3854:00\0'
    lines = [
        f'@DEV {DEV}',
        f'EVIOCGBIT(0) 8 {hexs(bits(8, EV_SYN, EV_KEY, EV_ABS, EV_MSC))}',
        f'EVIOCGNAME(0) {len(name)} {hexs(name.ljust(255, bytes(1)))}',
        f'EVIOCGPHYS(0) {len(phys)} {hexs(phys.ljust(255, bytes(1)))}',
        f'EVIOCGUNIQ(0) 1 {hexs(bytes(255))}',
        f'EVIOCGID 0 {hexs(struct.pack("<4H", 0x18, 0x093a, 0x1343, 0x0100))}',
        'EVIOCGVERSION 0 01000100',
        # INPUT_PROP_POINTER and INPUT_PROP_BUTTONPAD: a clickpad.
        f'EVIOCGPROP(0) 8 {hexs(bits(8, 0, 2))}',
        f'EVIOCGBIT(1) 96 {hexs(bits(96, BTN_LEFT, BTN_TOOL_FINGER, BTN_TOOL_QUINTTAP, BTN_TOUCH, BTN_TOOL_DOUBLETAP, BTN_TOOL_TRIPLETAP, BTN_TOOL_QUADTAP))}',
        f'EVIOCGBIT(2) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(3) 8 {hexs(bits(8, ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_X, ABS_MT_Y, ABS_MT_TOOL, ABS_MT_ID))}',
        f'EVIOCGBIT(4) 8 {hexs(bits(8, MSC_TIMESTAMP))}',
        f'EVIOCGBIT(5) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(17) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(18) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(21) 16 {hexs(bytes(16))}',
        f'EVIOCGKEY(0) 96 {hexs(bytes(96))}',
        f'EVIOCGLED(0) 8 {hexs(bytes(8))}',
        f'EVIOCGSW(0) 8 {hexs(bytes(8))}',
        f'EVIOCGABS 0 {hexs(absinfo(0, XMAX, RES))}',
        f'EVIOCGABS(1) 0 {hexs(absinfo(0, YMAX, RES))}',
        # The kernel has the last slot selected, as it does once more than one
        # finger has been used. Just after boot it would be slot 0, which no
        # frame names until a second finger comes, and the plugin leaves a touch
        # alone whose start it did not see.
        f'EVIOCGABS(47) 0 {hexs(absinfo(0, SLOTS - 1, value=SLOTS - 1))}',
        f'EVIOCGABS(53) 0 {hexs(absinfo(0, XMAX, RES))}',
        f'EVIOCGABS(54) 0 {hexs(absinfo(0, YMAX, RES))}',
        f'EVIOCGABS(55) 0 {hexs(absinfo(0, 2))}',
        f'EVIOCGABS(57) 0 {hexs(absinfo(0, 65535))}',
    ]
    for code, value in ((ABS_MT_X, 0), (ABS_MT_Y, 0), (ABS_MT_TOOL, 0), (ABS_MT_ID, -1)):
        lines.append(f'EVIOCGMTSLOTS(0) 0 {hexs(struct.pack("<I5i", code, *[value] * SLOTS))}')
    with open(os.path.join(directory, 'touchpad.ioctl'), 'w') as out:
        out.write('\n'.join(lines) + '\n')


class Kernel:
    """What the kernel sends for fingers at given places: only what changed, a
    slot selected only when an event for another one follows, timestamps in
    CLOCK_MONOTONIC as libinput expects them."""

    def __init__(self):
        # A little ahead of now, so the replay starts before its timestamps
        # and libinput's timers are not set in the past.
        self.t = time.monotonic() + 1.0
        self.slot = SLOTS - 1
        self.axes = {}
        self.down = set()
        self.keys = {}
        self.ids = 0
        self.lines = []
        # libinput drains what is pending when it opens the device: a frame
        # for it to throw away, then the gesture half a second later.
        self.event(EV_MSC, MSC_TIMESTAMP, 0)
        self.event(EV_SYN, 0, 0)
        self.t += 0.5

    def event(self, type_, code, value):
        sec = int(self.t)
        usec = int(round((self.t - sec) * 1e6))
        if usec == 1000000:
            sec, usec = sec + 1, 0
        self.lines.append(f'E: {sec}.{usec:06d} {type_:04x} {code:04x} {value}')

    def frame(self, fingers, button=False):
        """fingers: {slot: (x_mm, y_mm)}."""
        for slot in sorted(self.down | set(fingers)):
            changes = []
            if slot not in fingers:
                changes.append((ABS_MT_ID, -1))
                self.down.discard(slot)
            else:
                x, y = (round(v * RES) for v in fingers[slot])
                x, y = min(max(x, 0), XMAX), min(max(y, 0), YMAX)
                if slot not in self.down:
                    self.ids += 1
                    changes.append((ABS_MT_ID, self.ids))
                    self.down.add(slot)
                old = self.axes.get(slot, (None, None))
                if old[0] != x:
                    changes.append((ABS_MT_X, x))
                if old[1] != y:
                    changes.append((ABS_MT_Y, y))
                self.axes[slot] = (x, y)
            if changes and slot != self.slot:
                self.event(EV_ABS, ABS_MT_SLOT, slot)
                self.slot = slot
            for code, value in changes:
                self.event(EV_ABS, code, value)
        count = len(fingers)
        for key, on in ((BTN_TOUCH, count > 0), (BTN_TOOL_FINGER, count == 1),
                        (BTN_TOOL_DOUBLETAP, count == 2), (BTN_TOOL_TRIPLETAP, count == 3),
                        (BTN_LEFT, button)):
            if self.keys.get(key, False) != on:
                self.event(EV_KEY, key, int(on))
                self.keys[key] = on
        if fingers:
            first = self.axes[min(fingers)]
            self.event(EV_ABS, ABS_X, first[0])
            self.event(EV_ABS, ABS_Y, first[1])
        self.event(EV_MSC, MSC_TIMESTAMP, int(self.t * 1e6) & 0x7fffffff)
        self.event(EV_SYN, 0, 0)
        self.t += FRAME


def two_finger_swipe(kernel, speed, distance, apart=0.0, lift_one_and_move=0.0):
    """Two fingers 16 mm apart rest, then move down `distance` mm at `speed`
    mm/s, each also moving `apart` mm/s away from the other, then rest and
    lift. With `lift_one_and_move`, the second finger lifts first and the
    first one moves on alone that many mm, as a pointer."""
    a, b = [45.0, 15.0], [61.0, 15.0]
    kernel.frame({0: tuple(a)})
    for _ in range(4):
        kernel.frame({0: tuple(a), 1: tuple(b)})
    steps = int(round(distance / (speed * FRAME))) if speed else int(round(0.6 / FRAME))
    for _ in range(steps):
        a[1] += speed * FRAME
        b[1] += speed * FRAME
        a[0] -= apart * FRAME
        b[0] += apart * FRAME
        kernel.frame({0: tuple(a), 1: tuple(b)})
    for _ in range(4):
        kernel.frame({0: tuple(a), 1: tuple(b)})
    if lift_one_and_move:
        kernel.frame({0: tuple(a)})
        for _ in range(4):
            kernel.frame({0: tuple(a)})
        for _ in range(int(round(lift_one_and_move / (40 * FRAME)))):
            a[0] += 40 * FRAME * 0.6
            a[1] += 40 * FRAME * 0.8
            kernel.frame({0: tuple(a)})
    kernel.frame({})
    return kernel.t


def one_finger(kernel, distance):
    a = [40.0, 30.0]
    for _ in range(4):
        kernel.frame({0: tuple(a)})
    for _ in range(int(round(distance / (30 * FRAME)))):
        a[0] += 30 * FRAME
        a[1] += 10 * FRAME
        kernel.frame({0: tuple(a)})
    kernel.frame({})
    return kernel.t


def replay(workdir, gesture, plugins):
    """The libinput events debug-events prints for the gesture, without their
    timestamps, and its log."""
    kernel = Kernel()
    end = gesture(kernel)
    events = os.path.join(workdir, 'gesture.events')
    with open(events, 'w') as out:
        out.write('\n'.join(kernel.lines) + '\n')

    # umockdev keeps udev's properties in the device's uevent file, but libudev
    # counts a device as initialized only when udev's database has an entry for
    # it, and libinput's path backend waits for that. The entry goes into the
    # testbed, where umockdev points /run/udev/data.
    seconds = max(3.0, end - time.monotonic() + 1.5)
    # Fedora builds libinput with autoload-plugins, which loads the default
    # directories at the first device unless the caller set up plugins itself,
    # so --disable-plugins would not keep the plugin out. Whether it is in the
    # directory is what decides.
    installed = os.path.join(PLUGIN_DIR, os.path.basename(PLUGIN))
    if plugins:
        shutil.copy(PLUGIN, installed)
    elif os.path.exists(installed):
        os.remove(installed)
    args = ['libinput', 'debug-events', '--verbose', '--device', DEV]
    if plugins:
        args += ['--enable-plugins']
    inner = (
        'mkdir -p "$UMOCKDEV_DIR/run/udev/data" && '
        'printf "I:1\\nE:ID_INPUT=1\\nE:ID_INPUT_TOUCHPAD=1\\n" > "$UMOCKDEV_DIR/run/udev/data/c13:72" && '
        f'exec timeout -s INT {seconds:.1f} ' + ' '.join(args)
    )
    result = subprocess.run(
        ['umockdev-run', '-d', os.path.join(workdir, 'touchpad.umockdev'),
         '-i', f'{DEV}={os.path.join(workdir, "touchpad.ioctl")}',
         '-e', f'{DEV}={events}', '--', 'sh', '-c', inner],
        # From the root directory umockdev resolves nothing, so not from there.
        cwd=workdir, capture_output=True, text=True, timeout=seconds + 30)
    lines = []
    for line in result.stdout.splitlines():
        line = re.sub(r'\+\d+\.\d+s\s*', '', line)
        line = re.sub(r'^\s*\S+\s+', '', line)       # the device column
        lines.append(line.strip())
    return lines, result.stdout + result.stderr


def total(lines, kind, pattern):
    value = 0.0
    for line in lines:
        if line.startswith(kind):
            match = re.search(pattern, line)
            if match:
                value += abs(float(match.group(1)))
    return value


def of_kind(lines, kind):
    """The numbers of each event of a kind: deltas, scale and angle. The repeat
    count debug-events puts before them has no decimal point."""
    return [tuple(float(v) for v in re.findall(r'[-+]?\d+\.\d+', line))
            for line in lines if line.startswith(kind)]


def unaccelerated(lines):
    return [numbers[2:4] for numbers in of_kind(lines, 'POINTER_MOTION')]


SCROLL = r'vert\s+(-?\d+\.\d+)'

TRIES = 6
TRANSPORT_TROUBLE = ('missing SYN_REPORT', 'Touch jump detected', 'libevdev:')

failures = []
passes = []
retries = [0]


def check(label, ok, detail=''):
    if ok:
        passes.append(label)
        print(f'  ok   {label}')
    else:
        failures.append(label)
        print(f'  FAIL {label}' + (f'\n       {detail}' if detail else ''))


def main():
    workdir = tempfile.mkdtemp(prefix='pear-up-libinput-')
    # The plugin goes into one of libinput's default directories: the tools'
    # --set-plugin-path adds those instead of the one given (tools/shared.c,
    # add_path(), in 1.31.3). The compositor calls the library directly and is
    # not affected.
    if not (os.path.exists('/run/.containerenv') or os.path.exists('/.dockerenv')):
        sys.exit('This installs the plugin into /etc/libinput/plugins and only runs in a container; '
                 'use tests/run-libinput-tests.sh.')
    os.makedirs(PLUGIN_DIR, exist_ok=True)
    write_device(workdir)

    version = subprocess.run(['libinput', '--version'], capture_output=True, text=True).stdout.strip()
    print(f'  libinput {version}, plugin {os.path.basename(PLUGIN)}')

    def clean(gesture, plugins):
        """A replay that arrived whole. umockdev's device node is a pty, which
        now and then hands libevdev part of an event; libevdev drops the read,
        and libinput then reports frames without their end and fingers that
        jumped. Neither can come from the plugin — it returns whole frames, and
        moves a finger by a fraction of a unit per frame — so such a run is
        replayed again. A plugin that made fingers jump would do so every time,
        and fail after the last try."""
        for _ in range(TRIES):
            lines, log = replay(workdir, gesture, plugins)
            if not any(sign in log for sign in TRANSPORT_TROUBLE):
                return lines, log
            retries[0] += 1
        check(f'{"with" if plugins else "without"} the plugin, the gesture reaches libinput intact',
              False, '\n'.join(l for l in log.splitlines() if any(s in l for s in TRANSPORT_TROUBLE))[:1500])
        return lines, log

    def both(gesture):
        with_plugin, log = clean(gesture, True)
        without, _ = clean(gesture, False)
        if 'unloading after error' in log or 'Failed to load' in log:
            check('the plugin loads and runs without an error', False, log[-2000:])
        return with_plugin, without, log

    plugged, plain, log = both(lambda k: two_finger_swipe(k, 15, 30))
    check('libinput saw the touchpad', any(line.startswith('DEVICE_ADDED') for line in plain), log[-1500:])
    check('the plugin was loaded and took the touchpad', 'Pear Up scroll acceleration: ' + NAME in log, log[-1500:])
    slow, slow_plain = total(plugged, 'POINTER_SCROLL_FINGER', SCROLL), total(plain, 'POINTER_SCROLL_FINGER', SCROLL)
    ratio = slow / slow_plain if slow_plain else 0
    check(f'a slow scroll, 15 mm/s over 30 mm: {slow:.1f} against {slow_plain:.1f}, {ratio:.2f} of it',
          slow_plain > 250 and 0.30 <= ratio <= 0.45)

    plugged, plain, _ = both(lambda k: two_finger_swipe(k, 150, 30))
    fast, fast_plain = total(plugged, 'POINTER_SCROLL_FINGER', SCROLL), total(plain, 'POINTER_SCROLL_FINGER', SCROLL)
    ratio = fast / fast_plain if fast_plain else 0
    check(f'a quick scroll, 150 mm/s over 30 mm: {fast:.1f} against {fast_plain:.1f}, {ratio:.2f} of it',
          fast_plain > 250 and 0.90 <= ratio <= 1.20)

    plugged, plain, _ = both(lambda k: two_finger_swipe(k, 0, 0, apart=25))
    pinch, pinch_plain = of_kind(plugged, 'GESTURE_PINCH_UPDATE'), of_kind(plain, 'GESTURE_PINCH_UPDATE')
    check(f'a pinch is the same pinch ({len(pinch_plain)} updates, last {pinch_plain[-1] if pinch_plain else "none"})',
          len(pinch_plain) > 10 and pinch == pinch_plain,
          f'with the plugin: {pinch[-3:]}\n       without: {pinch_plain[-3:]}')

    plugged, plain, _ = both(lambda k: one_finger(k, 30))
    # Pointer motion is compared by the deltas libinput read off the fingers,
    # its "unaccelerated" ones: those are what the plugin could change. The
    # accelerated ones also depend on when libinput's timers fire, and a replay
    # runs to the wall clock, so they differ a little between two runs without
    # the plugin as well.
    motion, motion_plain = unaccelerated(plugged), unaccelerated(plain)
    check(f'one finger moves the pointer exactly as before ({len(motion_plain)} events)',
          len(motion_plain) > 20 and motion == motion_plain,
          f'with the plugin: {motion[:4]}\n       without: {motion_plain[:4]}')

    # When the second finger lifts, libinput holds the pointer back for a
    # moment that its timers decide, so how many of the first motion events
    # are dropped differs from run to run, plugin or not. A jump by the offset
    # the scroll left behind (some 300 units here) would show as one large
    # delta, or as libinput discarding a touch jump; after the hand-over the
    # motion has to be the very same.
    plugged, plain, _ = both(lambda k: two_finger_swipe(k, 15, 20, lift_one_and_move=20))
    after, after_plain = unaccelerated(plugged), unaccelerated(plain)
    largest = max((max(abs(x), abs(y)) for x, y in after_plain), default=0)
    check(f'after a slow scroll, lifting a finger and pointing with the other: no delta larger than '
          f'without the plugin ({max((max(abs(x), abs(y)) for x, y in after), default=0):.0f} against {largest:.0f})',
          after and all(max(abs(x), abs(y)) <= largest + 1 for x, y in after))
    check('and the pointer then moves exactly as before',
          len(after_plain) > 30 and after[-30:] == after_plain[-30:],
          f'with the plugin: {after[-4:]}\n       without: {after_plain[-4:]}')

    shutil.rmtree(workdir, ignore_errors=True)
    if retries[0]:
        print(f'  ({retries[0]} replays came through the pty broken and were run again)')
    print()
    if failures:
        print(f'{len(failures)} of {len(failures) + len(passes)} checks failed')
        sys.exit(1)
    print(f'All {len(passes)} checks passed')


if __name__ == '__main__':
    main()

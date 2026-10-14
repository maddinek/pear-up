#!/usr/bin/env python3
"""The touchpad gestures the end-to-end test replays, as `libinput record`
YAML files in gestures/.

    python3 gestures.py write [dir]     # (re)make the synthetic ones
    python3 gestures.py list [dir]

Until Martin records real ones on framy (record-gestures.sh), these are made
up, and say so in their first lines (`# synthetic: ...`). They are made the
way framy's touchpad reports: a PIXA3854 at 24 units per mm, 118 x 72 mm, a
report every 7 ms (the interval in the GTK probe's timestamps), two fingers
16 mm apart, positions in whole units with a little sensor noise. The
`martin-NN` ones are Martin's own flicks from the GTK probe log
(fixtures/framy-gtk4-medium.log): GTK's scroll deltas turned back into finger
travel through the plugin's curve at Medium, put back on the 7 ms beat.

A recording from `libinput record` reads the same way (load()); only its
evdev events are used, and its device should be the same touchpad.
"""
import math
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = 24
XMAX, YMAX = 2830, 1720
REPORT = 0.007
NAME = 'PIXA3854:00 093A:1343 Touchpad'
EV_SYN, EV_KEY, EV_ABS, EV_MSC = 0, 1, 3, 4
ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_X, ABS_MT_Y, ABS_MT_ID = 0x00, 0x01, 0x2f, 0x35, 0x36, 0x39
BTN_TOOL_FINGER, BTN_TOUCH, BTN_TOOL_DOUBLETAP = 0x145, 0x14a, 0x14d
MSC_TIMESTAMP = 0x05


class Pad:
    """What the kernel sends for fingers at given places and times (s): only
    what changed, a slot selected only when an event for another follows."""

    def __init__(self, seed=1):
        self.events, self.slot, self.axes, self.down, self.keys, self.ids = [], -1, {}, set(), {}, 0
        self.noise = random.Random(seed)

    def ev(self, t, ty, code, value):
        self.events.append((t, ty, code, value))

    def frame(self, t, fingers, noise=0.02):
        for slot in sorted(self.down | set(fingers)):
            changes = []
            if slot not in fingers:
                changes.append((ABS_MT_ID, -1))
                self.down.discard(slot)
            else:
                x, y = (round((v + self.noise.gauss(0, noise)) * RES) for v in fingers[slot])
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
                self.ev(t, EV_ABS, ABS_MT_SLOT, slot)
                self.slot = slot
            for code, value in changes:
                self.ev(t, EV_ABS, code, value)
        n = len(fingers)
        for key, on in ((BTN_TOUCH, n > 0), (BTN_TOOL_FINGER, n == 1), (BTN_TOOL_DOUBLETAP, n == 2)):
            if self.keys.get(key, False) != on:
                self.ev(t, EV_KEY, key, int(on))
                self.keys[key] = on
        if fingers:
            first = self.axes[min(fingers)]
            self.ev(t, EV_ABS, ABS_X, first[0])
            self.ev(t, EV_ABS, ABS_Y, first[1])
        self.ev(t, EV_MSC, MSC_TIMESTAMP, int(t * 1e6) & 0x7fffffff)
        self.ev(t, EV_SYN, 0, 0)


def speed_profile(peak, accel, cruise, decel, end=0.0):
    """Finger speed (mm/s) at t: smooth up to `peak` over `accel` s, held for
    `cruise`, then smoothly down to `end` over `decel`."""
    def ss(x):
        x = min(max(x, 0.0), 1.0)
        return x * x * (3 - 2 * x)

    def v(t):
        if t < accel:
            return peak * ss(t / accel)
        if t < accel + cruise:
            return peak
        return peak + (end - peak) * ss((t - accel - cruise) / decel) if decel else peak
    return v, accel + cruise + decel


def scroll(pad, start, profile, y0, up=True, x=(45.0, 61.0)):
    """Two fingers down at `start`, scrolling by `profile`, lifting together.
    Returns (time of the lift, where they were)."""
    v, length = profile
    t = start
    pad.frame(t, {0: (x[0], y0)})
    for _ in range(3):
        t += REPORT
        pad.frame(t, {0: (x[0], y0), 1: (x[1], y0)})
    y, s = y0, 0.0
    while s < length - 1e-9:
        s += REPORT
        y += (-1 if up else 1) * v(s) * REPORT
        pad.frame(t + s, {0: (x[0], y), 1: (x[1], y)})
    lift = t + s + REPORT
    pad.frame(lift, {})
    return lift, y


def synthetic():
    """name -> (description, Pad)."""
    out = {}

    def make(name, text, build):
        pad = Pad(seed=len(out) + 1)
        build(pad)
        out[name] = (text, pad)

    make('slow-scroll', 'Two fingers at 15 mm/s for 0.6 s, slowing to rest before they lift.',
         lambda p: scroll(p, 0.0, speed_profile(15, 0.1, 0.6, 0.15), 55))
    make('medium-scroll', 'Two fingers at 60 mm/s for 0.3 s, lifting while still moving at 40 mm/s.',
         lambda p: scroll(p, 0.0, speed_profile(60, 0.1, 0.3, 0.06, end=40), 58))
    make('flick', 'A flick: up to 150 mm/s in 80 ms, held 40 ms, lifted moving.',
         lambda p: scroll(p, 0.0, speed_profile(150, 0.08, 0.04, 0), 58))
    make('fast-flick', 'A fast flick: up to 300 mm/s in 80 ms, held 40 ms, lifted moving.',
         lambda p: scroll(p, 0.0, speed_profile(300, 0.08, 0.04, 0), 58))

    def double(p):
        lift, _ = scroll(p, 0.0, speed_profile(150, 0.08, 0.04, 0), 58)
        scroll(p, lift + 0.25, speed_profile(150, 0.08, 0.04, 0), 58)
    make('double-flick', 'Two 150 mm/s flicks, the second starting 250 ms after the first lifts.', double)

    def reflick(p):
        lift, _ = scroll(p, 0.0, speed_profile(150, 0.08, 0.04, 0), 58)
        scroll(p, lift + 0.08, speed_profile(150, 0.08, 0.04, 0), 58)
    make('quick-reflick', 'A 150 mm/s flick, and the next one 80 ms after the lift, as repeated flicks go.',
         reflick)

    def touch_stop(p):
        lift, _ = scroll(p, 0.0, speed_profile(150, 0.08, 0.04, 0), 58)
        t = lift + 0.2
        for i in range(22):
            p.frame(t + i * REPORT, {0: (50.0, 35.0)}, noise=0.01)
        p.frame(t + 22 * REPORT, {})
    make('flick-touch-stop', 'A 150 mm/s flick, then one finger rests on the pad 200 ms after the lift, '
         'for 150 ms, to stop the glide.', touch_stop)
    make('tiny-move', 'A precise nudge: two fingers move 2 mm at 5 mm/s and rest before lifting.',
         lambda p: scroll(p, 0.0, speed_profile(5, 0.1, 0.3, 0.1), 40, x=(45.0, 61.0)))
    return out


def martin_flicks(level=0.7):
    """Martin's flicks from the GTK probe log, as finger tracks."""
    path = os.path.join(HERE, 'fixtures', 'framy-gtk4-medium.log')
    curve = [(0, 0.08), (3, 0.13), (5, 0.19), (8, 0.37), (10, 0.43), (15, 0.56), (20, 0.64), (30, 0.76),
             (40, 0.84), (60, 0.94), (80, 1.0), (120, 1.06), (160, 1.08)]

    def share(s):
        for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
            if s <= x1:
                return y0 + (y1 - y0) * (s - x0) / (x1 - x0)
        return curve[-1][1]
    tracks, cur = [], None
    for line in open(path):
        p = line.split()
        if len(p) < 2:
            continue
        if p[1] == 'BEGIN':
            cur = []
            tracks.append(cur)
        elif p[1] == 'scroll' and cur is not None:
            cur.append((int(re.search(r' t=(\d+)', line).group(1)), float(re.search(r'dy=(-?[\d.]+)', line).group(1))))
        elif p[1] == 'DECELERATE' and cur is not None:
            if abs(float(re.search(r'vy=(-?[\d.]+)', line).group(1))) < 300:
                tracks.pop()
            cur = None
    out = []
    for ev in tracks:
        if len(ev) < 4:
            continue
        t0 = ev[0][0]
        mm = [dy / 10.5 for _, dy in ev]
        speed = [0.0] * len(ev)
        for _ in range(4):
            raw = [m / max(level * share(s), 0.05) for m, s in zip(mm, speed)]
            for i in range(len(ev)):
                j = i
                while j > 0 and ev[i][0] - ev[j - 1][0] <= 70:
                    j -= 1
                speed[i] = abs(sum(raw[j:i + 1])) / (max(ev[i][0] - ev[j][0], 7) / 1000)
        y, pts = 0.0, [(0.0, 0.0)]
        for (t, _), r in zip(ev, raw):
            y += r
            pts.append(((t - t0) / 1000 + REPORT, y))
        track, ts, i = [], REPORT, 0
        while ts <= pts[-1][0] + 1e-9:
            while pts[i + 1][0] < ts:
                i += 1
            (a, ya), (b, yb) = pts[i], pts[i + 1]
            track.append((ts, ya + (yb - ya) * (ts - a) / (b - a)))
            ts += REPORT
        out.append(track)
    return out


def martin():
    out = {}
    for i, track in enumerate(martin_flicks()):
        pad = Pad(seed=100 + i)
        travel = track[-1][1]
        y0 = 36 + abs(travel) / 2
        up = travel < 0
        if not up:
            y0 = 36 - abs(travel) / 2
        t = 0.0
        pad.frame(t, {0: (45.0, y0)})
        for _ in range(3):
            t += REPORT
            pad.frame(t, {0: (45.0, y0), 1: (61.0, y0)})
        for ts, mm in track:
            y = y0 - abs(mm) if up else y0 + abs(mm)
            pad.frame(t + ts, {0: (45.0, y), 1: (61.0, y)})
        pad.frame(t + track[-1][0] + REPORT, {})
        out[f'martin-{i:02d}'] = (f'Martin\'s flick #{i} from the GTK probe on framy (Medium), turned back into '
                                  'finger travel.', pad)
    return out


def to_yaml(name, text, pad):
    lines = [
        f'# synthetic: {text}',
        '# Made by tests/scroll-e2e/gestures.py, not recorded. Replace with `libinput record` output',
        '# from framy (record-gestures.sh) to test against the real touchpad.',
        'version: 1', 'ndevices: 1', 'libinput:', '  version: "1.31.3"', 'devices:',
        '- node: /dev/input/event8', '  evdev:', f'    name: "{NAME}"', '    id: [24, 2362, 4931, 256]',
        '    absinfo:',
        f'      0: [0, {XMAX}, 0, 0, {RES}]', f'      1: [0, {YMAX}, 0, 0, {RES}]',
        '      47: [0, 4, 0, 0, 0]', f'      53: [0, {XMAX}, 0, 0, {RES}]', f'      54: [0, {YMAX}, 0, 0, {RES}]',
        '      57: [0, 65535, 0, 0, 0]',
        '    properties: [0, 2]', '  events:',
    ]
    frame = []
    for t, ty, code, value in pad.events:
        sec, usec = int(t), int(round((t - int(t)) * 1e6))
        if usec >= 1000000:
            sec, usec = sec + 1, usec - 1000000
        frame.append(f'    - [{sec:3d}, {usec:6d}, {ty:3d}, {code:3d}, {value:6d}]')
        if ty == EV_SYN:
            lines.append('  - evdev:')
            lines.extend(frame)
            frame = []
    return '\n'.join(lines) + '\n'


EVENT = re.compile(r'^\s*-\s*\[\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(-?\d+)\s*\]')


def load(path):
    """[(seconds from the first event, type, code, value)] of a recording, and
    whether it says it is synthetic."""
    events, synthetic, t0 = [], False, None
    with open(path) as f:
        for line in f:
            if line.startswith('# synthetic'):
                synthetic = True
            m = EVENT.match(line)
            if m:
                sec, usec, ty, code, value = (int(g) for g in m.groups())
                t = sec + usec / 1e6
                t0 = t if t0 is None else t0
                events.append((t - t0, ty, code, value))
    return events, synthetic


def evemu_lines(events, start):
    """umockdev's evemu lines for `events`, the first at monotonic `start`."""
    out = []
    for t, ty, code, value in events:
        a = start + t
        sec = int(a)
        usec = int(round((a - sec) * 1e6))
        if usec == 1000000:
            sec, usec = sec + 1, 0
        out.append(f'E: {sec}.{usec:06d} {ty:04x} {code:04x} {value}')
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    target = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'gestures')
    if cmd == 'write':
        os.makedirs(target, exist_ok=True)
        made = {**synthetic(), **martin()}
        for name, (text, pad) in made.items():
            path = os.path.join(target, f'{name}.yaml')
            if os.path.exists(path) and not load(path)[1]:
                print(f'  {name}: a real recording, kept')
                continue
            with open(path, 'w') as out:
                out.write(to_yaml(name, text, pad))
            print(f'  {name}: {len(pad.events)} events')
    else:
        for name in sorted(os.listdir(target)):
            if name.endswith('.yaml'):
                events, synthetic_ = load(os.path.join(target, name))
                print(f'  {name}: {len(events)} events, {"synthetic" if synthetic_ else "recorded"}')


if __name__ == '__main__':
    main()

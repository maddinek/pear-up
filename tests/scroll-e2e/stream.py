#!/usr/bin/env python3
"""Stage 1 of the scroll end-to-end test: each recorded gesture through Pear
Up's libinput plugin and real libinput 1.31, as the compositor gets it.

    python3 stream.py <gestures-dir> <out.json> [mode ...]      (container only)

Modes (default all): now (the plugin as framy has it, Medium, engine off),
engine (the same with the Mac scroll engine on), engine-mac (engine on at the
"As on a MacBook" speed).

How: the plugin runs over the recording in simulate.lua, its own code in
libinput's sandbox with a timer that fires exactly when asked; what it hands on
is then replayed into real libinput, without a plugin, on a umockdev touchpad
(framy's PIXA3854), so libinput's own two-finger scrolling, jump detection and
stops decide what comes out. The stream is kept with the frames' own times, to
the microsecond, from scroll_from_frames(), which follows libinput's scroll
arithmetic; libinput's actual output is kept beside it (debug-events prints
milliseconds) and must agree on the distance, less the millimetre or two
libinput holds back at the start (agrees()).

Why not the plugin inside libinput, live: umockdev replays through a pty, late
and in bursts on a loaded machine ("event processing lagging behind"), and the
engine's timer would then pace against that rather than against a touchpad.
tests/libinput/engine_replay.py does run it live, for the hand-off checks that
do not need exact timing.
"""
import json
import math
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'libinput'))
import engine_replay as er  # noqa: E402
import gestures as G  # noqa: E402

PLUGIN = os.path.abspath(os.path.join(HERE, '..', '..', 'libinput', '10-pear-up-scroll-acceleration.lua'))
RES = 24
UNITS_PER_MM = 10.5   # libinput 1.31.3's two-finger scroll, units per mm (no plugin; see agrees())
MODES = {'now': (False, '0.7'), 'engine': (True, '0.7'), 'engine-mac': (True, '0.34')}


def simulate(events_in, engine, events_out, speed):
    subprocess.run(['lua', os.path.join(HERE, 'simulate.lua'), PLUGIN, 'true' if engine else 'false',
                    events_in, events_out, speed], check=True)


def read_frames(path):
    """[(µs, [(type, code, value)])] of an evemu file."""
    frames, cur = [], []
    for line in open(path):
        m = re.match(r'E: (\d+)\.(\d+) (\w+) (\w+) (-?\d+)', line)
        if not m:
            continue
        t = int(m.group(1)) * 1000000 + int(m.group(2))
        ty, code, value = int(m.group(3), 16), int(m.group(4), 16), int(m.group(5))
        if ty == 0:
            frames.append((t, cur))
            cur = []
        else:
            cur.append((ty, code, value))
    return frames


def scroll_from_frames(frames):
    """libinput's two-finger scroll from the frames it is handed: while two
    touches are down, the movement of those that moved, over two, in scroll
    units; a touch moving over 20 mm per 12 ms (normalised as libinput does)
    is a jump and moves nothing; a stop when fewer than two remain.
    [(µs, vertical units, stop)]."""
    slot, down, pos, moved_at = 0, {}, {}, {}
    out, scrolling = [], False
    for t, events in frames:
        before = {s: pos.get(s) for s in down}
        dirty = set()
        for ty, code, value in events:
            if ty == 3 and code == 0x2f:
                slot = value
            elif ty == 3 and code == 0x39:
                if value < 0:
                    down.pop(slot, None)
                else:
                    down[slot] = value
                    before.pop(slot, None)
            elif ty == 3 and code in (0x35, 0x36):
                p = list(pos.get(slot, (0, 0)))
                p[0 if code == 0x35 else 1] = value
                pos[slot] = tuple(p)
                dirty.add(slot)
        if len(down) == 2:
            dy = 0.0
            for s in down:
                if s in dirty and before.get(s) is not None:
                    d = pos[s][1] - before[s][1]
                    dx = pos[s][0] - before[s][0]
                    dt = max(t - moved_at.get(s, t), 1)
                    if math.hypot(dx, d) / RES * 12000 / dt > 20 and dt < 30000:
                        d = 0
                    dy += d
                    moved_at[s] = t
            if dy:
                scrolling = True
                out.append((t, dy / 2 / RES * UNITS_PER_MM, False))
        elif scrolling:
            out.append((t, 0.0, True))
            scrolling = False
        for s in dirty:
            moved_at.setdefault(s, t)
    return out


def fingers(frames):
    """What the fingers did, from the touchpad's own frames (µs): when two
    first moved 0.1 mm, when each two-finger touch lifted, when a touch came
    down after a lift, and the pair's centre over time [(µs, mm)]."""
    slot, down, pos = 0, {}, {}
    start, lifts, touches, track, first_pos = None, [], [], [], None
    count_before = 0
    for t, events in frames:
        for ty, code, value in events:
            if ty == 3 and code == 0x2f:
                slot = value
            elif ty == 3 and code == 0x39:
                if value < 0:
                    down.pop(slot, None)
                else:
                    down[slot] = True
            elif ty == 3 and code in (0x35, 0x36):
                p = list(pos.get(slot, (0, 0)))
                p[0 if code == 0x35 else 1] = value
                pos[slot] = tuple(p)
        n = len(down)
        if n == 2:
            ys = [pos[s][1] / RES for s in down]
            c = sum(ys) / 2
            track.append((t, c))
            if first_pos is None:
                first_pos = c
            elif start is None and abs(c - first_pos) >= 0.1:
                start = t
        if count_before == 2 and n < 2:
            lifts.append(t)
            first_pos = None
        if count_before == 0 and n > 0 and lifts:
            touches.append(t)
        count_before = n
    return {'start': start, 'lifts': lifts, 'touches': touches, 'track': track}


def agrees(real, model):
    """libinput's distance is the model's, less what it holds back at the
    start (up to 45 units, about 4 mm): a replay umockdev's pty broke scrolls
    something else, or nothing."""
    rt = abs(sum(v for _, v, s in real if not s))
    mt = abs(sum(v for _, v, s in model if not s))
    rn = sum(1 for _, _, s in real if not s)
    mn = sum(1 for _, _, s in model if not s)
    if rn == 0:
        return mt <= 45      # all of it held back: a tiny movement libinput never scrolls
    return -2 <= mt - rt <= 45 and rn >= 0.7 * mn - 10


def libinput_scrolls(workdir, events_file, model=None, tries=10):
    """Real libinput, no plugin, on a frames file: [(ms, units, stop)], log."""
    if os.path.exists(er.INSTALLED):
        os.remove(er.INSTALLED)
    lines = open(events_file).read().splitlines()
    first = float(re.match(r'E: (\d+\.\d+)', lines[0]).group(1))
    last = float(re.match(r'E: (\d+\.\d+)', lines[-1]).group(1))
    log = ''
    for _ in range(tries):
        shift = time.monotonic() + 0.035 - first
        shifted = []
        for line in lines:
            m = re.match(r'E: (\d+)\.(\d+) (.*)', line)
            t = int(m.group(1)) + int(m.group(2)) / 1e6 + shift
            sec = int(t)
            usec = int(round((t - sec) * 1e6))
            if usec == 1000000:
                sec, usec = sec + 1, 0
            shifted.append(f'E: {sec}.{usec:06d} {m.group(3)}')
        path = os.path.join(workdir, 'replay.events')
        open(path, 'w').write('\n'.join(shifted) + '\n')
        span = last - first + 2.0
        inner = ('mkdir -p "$UMOCKDEV_DIR/run/udev/data" && '
                 'printf "I:1\\nE:ID_INPUT=1\\nE:ID_INPUT_TOUCHPAD=1\\n" > "$UMOCKDEV_DIR/run/udev/data/c13:72" && '
                 f'exec timeout -s INT {span:.1f} libinput debug-events --device {er.cwl.DEV}')
        try:
            r = subprocess.run(['umockdev-run', '-d', os.path.join(workdir, 'touchpad.umockdev'),
                                '-i', f'{er.cwl.DEV}={os.path.join(workdir, "touchpad.ioctl")}',
                                '-e', f'{er.cwl.DEV}={path}', '--', 'sh', '-c', inner],
                               cwd=workdir, capture_output=True, text=True, timeout=span + 30)
        except subprocess.TimeoutExpired:
            log = 'umockdev-run hung'
            continue
        log = r.stdout + r.stderr
        if any(s in log for s in er.TROUBLE):
            continue
        out = []
        for line in r.stdout.splitlines():
            if 'POINTER_SCROLL_FINGER' in line:
                stamp = float(re.search(r'\+(\d+\.\d+)s', line).group(1))
                v = float(er.SCROLL.search(line).group(1))
                out.append((stamp * 1000, v, v == 0.0))
        if model is not None and not agrees(out, model):
            continue
        return out, log
    return None, log


def main():
    gestures_dir, target = sys.argv[1], sys.argv[2]
    modes = sys.argv[3:] or list(MODES)
    workdir = er.setup()
    results = json.load(open(target)) if os.path.exists(target) else {}
    try:
        for name in sorted(os.listdir(gestures_dir)):
            if not name.endswith('.yaml'):
                continue
            gesture = name[:-5]
            events, synthetic = G.load(os.path.join(gestures_dir, name))
            # A frame for libinput to drain when it opens the device, then the
            # gesture half a second later.
            start = time.monotonic() + 0.535
            kernel = [f'E: {int(start - 0.5)}.{int((start - 0.5) % 1 * 1e6):06d} 0004 0005 0',
                      f'E: {int(start - 0.5)}.{int((start - 0.5) % 1 * 1e6):06d} 0000 0000 0']
            kernel += G.evemu_lines(events, start)
            raw = os.path.join(workdir, 'kernel.events')
            open(raw, 'w').write('\n'.join(kernel) + '\n')
            kframes = read_frames(raw)
            t0 = int(start * 1e6)
            f = fingers(kframes[1:])
            entry = {
                'synthetic': synthetic,
                'fingers': {
                    'start': (f['start'] - t0) / 1000 if f['start'] else None,
                    'lifts': [(t - t0) / 1000 for t in f['lifts']],
                    'touches': [(t - t0) / 1000 for t in f['touches']],
                    'track': [((t - t0) / 1000, mm) for t, mm in f['track']],
                },
            }
            for mode in modes:
                engine, speed = MODES[mode]
                sim = os.path.join(workdir, 'sim.events')
                simulate(raw, engine, sim, speed)
                model = scroll_from_frames(read_frames(sim))
                real, log = libinput_scrolls(workdir, sim, model)
                # libinput holds back the start of a scroll (about a mm) until
                # it has decided on one; take as much off the model's start
                # as it did, or 16 units (1.5 mm) when the replay broke.
                held = (abs(sum(v for _, v, s in model if not s)) - abs(sum(v for _, v, s in real if not s))
                        if real else 16.0)
                starts = 1 + sum(1 for _, _, s in model[:-1] if s)
                per = held / starts if real else 16.0
                kept, gone, fresh = [], 0.0, True
                for t, v, s in model:
                    if s:
                        kept.append((t, v, s))
                        gone, fresh = 0.0, True
                    elif fresh and gone + abs(v) <= per + 1e-6:
                        gone += abs(v)
                    else:
                        fresh = False
                        kept.append((t, v, s))
                model = kept
                entry[mode] = {
                    'stream': [((t - t0) / 1000, v, s) for t, v, s in model],
                    'libinput': real,
                    'libinput_distance': round(abs(sum(v for _, v, s in real if not s)), 1) if real else None,
                    'stream_distance': round(abs(sum(v for _, v, s in model if not s)), 1),
                }
                print(f'  {gesture:18s} {mode:10s} {entry[mode]["stream_distance"]:8.1f} units, libinput '
                      f'{entry[mode]["libinput_distance"] if real else "(replay broken, left out)"}', flush=True)
            results[gesture] = entry
            json.dump(results, open(target, 'w'))
    finally:
        er.cleanup(workdir)


if __name__ == '__main__':
    main()

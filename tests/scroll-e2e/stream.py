#!/usr/bin/env python3
"""Stage 1 of the scroll end-to-end test: each recorded gesture through Pear
Up's libinput plugin running live inside this machine's libinput (1.31), as
the compositor gets it.

    sudo python3 stream.py <gestures-dir> <out.json> [mode ...]   (host, root)

Modes (default both): now (the plugin as framy has it, Medium, engine off),
engine (the same with the Mac scroll engine on).

How (live.py): the gesture's frames go to a uinput copy of framy's PIXA3854,
which the kernel hands on as it does the real touchpad's, and a libinput path
context that loads the plugin as mutter does turns them into the scroll events
a compositor gets, with libinput's own times. Nothing here is simulated: the
plugin's pacing and glide come from its own timer inside libinput. Before
each gesture one finger rests 250 ms in another slot, so the kernel names the
gesture's first slot, as on a touchpad in use; the first gesture on a fresh
touchpad is checked on its own (check-handoffs.py).

Run to run: the engine's beat falls differently against the touchpad's
reports each time, and the host is a live desktop; each gesture is run
REPEATS times with the engine on, and every run is kept.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gestures as G  # noqa: E402
from live import Live  # noqa: E402

RES = 24
MODES = {'now': (False, '0.7'), 'engine': (True, '0.7')}
REPEATS = int(os.environ.get('E2E_REPEATS', '5'))
# The engine's beat, to compare others with 480 Hz (E2E_TICK_HZ=240 ...).
TICK_HZ = int(os.environ.get('E2E_TICK_HZ', '0')) or None


def frames_of(events):
    """[(µs from the gesture's first event, [(type, code, value)])]."""
    frames, cur = [], []
    for t, ty, code, value in events:
        if ty == 0:
            frames.append((int(round(t * 1e6)), cur))
            cur = []
        else:
            cur.append((ty, code, value))
    return frames


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


def distance(stream):
    return round(abs(sum(v for _, v, s in stream if not s)), 1)


def main():
    gestures_dir, target = sys.argv[1], sys.argv[2]
    modes = sys.argv[3:] or list(MODES)
    results = json.load(open(target)) if os.path.exists(target) else {}
    runners = {mode: Live(*MODES[mode], tick_hz=TICK_HZ) for mode in modes}
    try:
        for name in sorted(os.listdir(gestures_dir)):
            if not name.endswith('.yaml'):
                continue
            gesture = name[:-5]
            events, synthetic = G.load(os.path.join(gestures_dir, name))
            frames = frames_of(events)
            f = fingers(frames)
            entry = {
                'synthetic': synthetic,
                'live': True,
                'fingers': {
                    'start': f['start'] / 1000 if f['start'] is not None else None,
                    'lifts': [t / 1000 for t in f['lifts']],
                    'touches': [t / 1000 for t in f['touches']],
                    'track': [(t / 1000, mm) for t, mm in f['track']],
                },
            }
            for mode in modes:
                runs = REPEATS if mode == 'engine' else 1
                streams = []
                for _ in range(runs):
                    stream, _, _ = runners[mode].run(frames, 0)
                    streams.append(stream)
                entry[mode] = {
                    'stream': streams[0],
                    'libinput': streams[0],
                    'libinput_distance': distance(streams[0]),
                    'stream_distance': distance(streams[0]),
                }
                if mode == 'engine':
                    entry[mode]['repeats'] = streams
                spread = ', '.join(f'{distance(s):.0f}' for s in streams)
                print(f'  {gesture:18s} {mode:7s} {len(streams[0]):4d} events, units {spread}', flush=True)
            results[gesture] = entry
            json.dump(results, open(target, 'w'))
    finally:
        for runner in runners.values():
            runner.__exit__()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Checks the Mac scroll engine's hand-offs through real libinput: each gesture
is run through the plugin by simulate.lua (engine on) and what the plugin hands
on is replayed into libinput 1.31 without a plugin, through umockdev. Container
only (tests/run-libinput-tests.sh runs it).

  1. a flick glides after the lift, and the stop comes 200+ ms after the last
     scroll, so GTK, Chromium and Firefox add no glide of their own
  2. a slow lift does not glide, and its stop comes as late
  3. one finger put down during the glide stops it at once, then points: the
     pointer moves and no scroll follows
  4. two fingers put down during the glide take it over: the scroll goes on
     with no stop in between, and ends with one
  5. a tap during the glide only stops it: no click, no pointer motion
  6. two fingers resting without moving pass through untouched
  7. a fast flick runs further than the touchpad is long, and nothing jumps
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'libinput'))
import engine_replay as er  # noqa: E402
import stream as R  # noqa: E402

failures, passes = [], []
UP150 = [(ts, -mm) for ts, mm in er.flick_track(150)]


def check(label, ok, detail=''):
    (passes if ok else failures).append(label)
    print(f'  {"ok  " if ok else "FAIL"} {label}' + ('' if ok or not detail else f'\n       {detail}'))


def through(workdir, gesture, engine=True):
    """libinput's events for the gesture, [(ms, line)], and the model's
    scrolls [(ms, units, stop)], both from the start of the gesture."""
    k = er.Fingers()
    gesture(k)
    raw = os.path.join(workdir, 'k.events')
    open(raw, 'w').write('\n'.join(k.lines) + '\n')
    sim = os.path.join(workdir, 's.events')
    R.simulate(raw, engine, sim, "0.7")
    frames = R.read_frames(sim)
    scale = R.SCALE if engine else 1
    model = [((t - k.t0 * 1e6) / 1000, v, s) for t, v, s in R.scroll_from_frames(frames, R.RES * scale)]
    lines = None
    for _ in range(8):
        got, log = R.libinput_scrolls(workdir, sim, scale=scale)
        if got is None:
            continue
        # libinput_scrolls keeps scroll events only; take the rest from its log.
        lines = [ln for ln in log.splitlines() if ' event8 ' in ln or ln.startswith('event8')]
        break
    return model, lines or []


def kinds(lines, kind):
    return [ln for ln in lines if kind in ln]


def flick_then(kernel, extra):
    lift = er.scroll_track(kernel, UP150, y0=60)
    return extra(kernel, lift)


def main():
    workdir = er.setup()
    try:
        # 1
        model, lines = through(workdir, lambda k: er.scroll_track(k, UP150, y0=60) + 2)
        lift = er.scroll_track(er.Fingers(), UP150, y0=60) * 1000
        moves = [t for t, v, s in model if not s]
        stops = [t for t, v, s in model if s]
        check(f'a 150 mm/s flick glides {moves[-1] - lift:.0f} ms after the lift', moves[-1] - lift > 600)
        check(f'one stop, {stops[-1] - moves[-1]:.0f} ms after the last scroll (apps glide from 0 after 200)',
              len(stops) == 1 and stops[-1] - moves[-1] >= 200)
        check('libinput scrolls it too, and stops once', len(kinds(lines, 'POINTER_SCROLL_FINGER')) > 300
              and sum(1 for ln in kinds(lines, 'POINTER_SCROLL_FINGER') if 'vert 0.00/0.0* horiz 0.00/0.0*' in ln) == 1,
              f'{len(kinds(lines, "POINTER_SCROLL_FINGER"))} scroll events')

        # 2
        slow = [(ts, -mm) for ts, mm in er.flick_track(15, accel=0.1, cruise=0.4, decel=0.15)]
        model, _ = through(workdir, lambda k: er.scroll_track(k, slow, y0=50) + 1)
        lift = er.scroll_track(er.Fingers(), slow, y0=50) * 1000
        after = sum(abs(v) for t, v, s in model if t > lift + 10 and not s)
        stops = [t for t, v, s in model if s]
        check(f'a slow lift does not glide ({after:.1f} units after it)', after < 1)
        check(f'and its stop comes {stops[-1] - lift:.0f} ms after the lift', stops and stops[-1] - lift >= 200)

        # 3
        def one_finger(k, lift):
            t = lift + 0.15
            for i in range(40):
                k.at(t + i * 0.007, {0: (40 + i * 0.4, 30 + i * 0.2)})
            k.at(t + 40 * 0.007, {})
            return t + 0.6
        model, lines = through(workdir, lambda k: flick_then(k, one_finger))
        touch = (er.scroll_track(er.Fingers(), UP150, y0=60) + 0.15) * 1000
        late = [t for t, v, s in model if t > touch + 16 and not s]
        motion = kinds(lines, 'POINTER_MOTION')
        check(f'one finger during the glide stops it ({len(late)} scroll events after the touch)', not late)
        check(f'then points: {len(motion)} pointer motions in libinput', len(motion) > 20)
        check('and the glide ends with a stop before the pointer moves',
              any(s for t, v, s in model if t <= touch + 12 + 120))

        # 4
        def two_fingers(k, lift):
            t = lift + 0.15
            k.at(t, {0: (45, 50)})
            k.at(t + 0.007, {0: (45, 50), 1: (61, 50)})
            for i in range(1, 30):
                k.at(t + 0.007 + i * 0.007, {0: (45, 50 - i * 0.5), 1: (61, 50 - i * 0.5)})
            k.at(t + 0.007 + 30 * 0.007, {})
            return t + 1.5
        model, lines = through(workdir, lambda k: flick_then(k, two_fingers))
        stops = [t for t, v, s in model if s]
        resumed = [t for t, v, s in model if touch + 30 < t < touch + 250 and not s]
        check(f'two fingers during the glide take it over: one stop in all ({len(stops)})', len(stops) == 1)
        check(f'and scroll on ({len(resumed)} events while they move)', len(resumed) > 20)

        # 5
        def tap(k, lift):
            t = lift + 0.15
            k.at(t, {0: (50, 30)})
            k.at(t + 0.06, {})
            return t + 1.0
        model, lines = through(workdir, lambda k: flick_then(k, tap))
        late = [t for t, v, s in model if t > touch + 16 and not s]
        check(f"a tap during the glide stops it ({len(late)} scroll events after)", not late, str([(round(t - touch, 1), v) for t, v, s in model if t > touch - 20]))
        check('and neither clicks nor moves the pointer',
              not kinds(lines, 'POINTER_BUTTON') and not kinds(lines, 'POINTER_MOTION'))

        # 6
        def rest(k):
            k.at(0, {0: (45, 30)})
            for i in range(1, 30):
                k.at(i * 0.007, {0: (45, 30), 1: (61, 30)})
            k.at(30 * 0.007, {})
            return 1.0
        model_on, lines_on = through(workdir, rest, True)
        model_off, lines_off = through(workdir, rest, False)
        check('two fingers resting: the same as without the engine',
              model_on == model_off and len(kinds(lines_on, 'GESTURE_HOLD')) == len(kinds(lines_off, 'GESTURE_HOLD'))
              and not kinds(lines_on, 'POINTER_SCROLL'))

        # 7
        model, lines = through(workdir, lambda k: er.scroll_track(k, [(ts, -mm) for ts, mm in er.flick_track(300)],
                                                                    y0=60) + 2.2)
        values = [abs(v) for t, v, s in model if not s]
        biggest = max(values)
        check(f'a 300 mm/s flick: largest single scroll {biggest:.1f} units (no jump through)', biggest < 25)
        real = [ln for ln in kinds(lines, 'POINTER_SCROLL_FINGER')]
        check(f'libinput: {len(real)} scroll events, none over 25 units',
              len(real) > 300 and all(abs(float(er.SCROLL.search(ln).group(1))) < 25 for ln in real))
    finally:
        er.cleanup(workdir)
    print()
    if failures:
        print(f'{len(failures)} of {len(failures) + len(passes)} checks failed')
        sys.exit(1)
    print(f'All {len(passes)} checks passed')


if __name__ == '__main__':
    main()

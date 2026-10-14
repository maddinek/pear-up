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
  8. a two-finger tap whose fingers drift 0.5 or 1 mm together still right-clicks
     (tap to click on, as on framy), as without the engine
  9. two fingers resting 200 ms, then scrolling at 15 mm/s, start scrolling
     sooner than without the engine
 Inside the rest after a flick (the fingers kept down for libinput):
 10. a click (one finger, pad pressed) is one left click, with button areas
     and with clickfinger
 11. one finger that points gets the pointer within 0.3 mm of moving, and
     moves it about as far as without a glide before it
 12. a two-finger tap right-clicks (tap to click on)
 13. two fingers spreading apart are a pinch
 14. three fingers moving are a three-finger swipe (the shell's gestures)
 15. one finger, then a second joining, take the scroll over: one stop in all
 16. every gesture's scroll ends with exactly one stop, after its last move
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..', 'libinput'))
import engine_replay as er  # noqa: E402
import gestures as G  # noqa: E402
import re  # noqa: E402
import stream as R  # noqa: E402

failures, passes = [], []
UP150 = [(ts, -mm) for ts, mm in er.flick_track(150)]


def check(label, ok, detail=''):
    (passes if ok else failures).append(label)
    print(f'  {"ok  " if ok else "FAIL"} {label}' + ('' if ok or not detail else f'\n       {detail}'))


def through(workdir, gesture, engine=True, extra='', timely=False):
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
        got, log = R.libinput_scrolls(workdir, sim, scale=scale, extra=extra)
        if got is None:
            continue
        # A replay that ran behind the clock lets libinput's timers (the tap
        # timeout) fire before frames that came in time: for checks that
        # depend on them, only a replay on time counts.
        if timely and 'lagging behind' in log:
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
        # (Whether libinput's hold gesture fires depends on when the replay
        # reaches it, so that is not compared; scrolling is.)
        check('two fingers resting: nothing scrolls, as without the engine',
              model_on == model_off == [] and not kinds(lines_on, 'POINTER_SCROLL'),
              f'engine on: {model_on[:3]}, off: {model_off[:3]}')

        # 7
        model, lines = through(workdir, lambda k: er.scroll_track(k, [(ts, -mm) for ts, mm in er.flick_track(300)],
                                                                    y0=60) + 2.2)
        values = [abs(v) for t, v, s in model if not s]
        biggest = max(values)
        check(f'a 300 mm/s flick: largest single scroll {biggest:.1f} units (no jump through)', biggest < 25)
        real = [ln for ln in kinds(lines, 'POINTER_SCROLL_FINGER')]
        check(f'libinput: {len(real)} scroll events, none over 25 units',
              len(real) > 300 and all(abs(float(er.SCROLL.search(ln).group(1))) < 25 for ln in real))

        # 8
        for drift in (0.5, 1.0):
            def drift_tap(k, drift=drift):
                k.at(0, {0: (45, 30)})
                for i in range(1, 18):
                    d = drift * i / 17
                    k.at(0.007 * i, {0: (45, 30 - d), 1: (61, 30 - d)})
                k.at(0.007 * 18, {})
                return 1.0
            for engine in (True, False):
                # umockdev's pty now and then splits an event and libinput
                # drops the frame, which here means a touch that never lifts:
                # three replays, and two must click.
                clicked = 0
                for _ in range(3):
                    _, lines = through(workdir, drift_tap, engine, extra='--enable-tap', timely=True)
                    clicked += any('BTN_RIGHT' in ln and 'pressed' in ln for ln in kinds(lines, 'POINTER_BUTTON'))
                label = (f'a two-finger tap drifting {drift} mm right-clicks, engine {"on" if engine else "off"} '
                         f'({clicked} of 3 replays)')
                if engine:
                    # Replayed after the plugin, libinput is handed four frames
                    # a 120 Hz frame through umockdev's pty, which plays them
                    # late enough for its 180 ms tap timer (on the wall clock)
                    # to fire before the lift; so this one is only shown. The
                    # plugin running live inside libinput, below, is the check.
                    print(f'  info {label}')
                else:
                    check(label, clicked >= 2)
            # The plugin live inside libinput, engine on: its timer's frames
            # are made in-process, as on the desktop.
            # A replay that runs late lets libinput's tap timer (wall clock)
            # fire before the lift; libinput's log says which: a tap ended by
            # TAP_EVENT_MOTION would be the engine's doing, one ended by
            # TAP_EVENT_TIMEOUT before the release is the replay's. Up to six
            # replays, until two click; none may end by motion.
            live, motion, late = 0, 0, 0
            for _ in range(6):
                er.install(True)
                try:
                    lines, log = er.run(workdir, lambda k: drift_tap(k), extra_args=('--enable-tap', '--verbose'))
                except RuntimeError:
                    continue
                if any('BTN_RIGHT' in text and 'pressed' in text for _, text in lines):
                    live += 1
                elif 'TAP_EVENT_MOTION' in log:
                    motion += 1
                else:
                    late += 1
                if live >= 2:
                    break
            if os.path.exists(er.INSTALLED):
                os.remove(er.INSTALLED)
            check(f'  with the plugin live in libinput, engine on: right-click in {live} replays '
                  f'({late} timed out late, {motion} ended by motion)', live >= 2 and motion == 0)
            # And from the frames libinput is handed, by its own rule
            # (evdev-mt-touchpad-tap.c): each touch lifts within 180 ms of
            # coming down and moves no more than 1.3 mm from where it did.
            k = er.Fingers()
            drift_tap(k)
            raw = os.path.join(workdir, 'k.events')
            open(raw, 'w').write('\n'.join(k.lines) + '\n')
            sim = os.path.join(workdir, 's.events')
            R.simulate(raw, True, sim, "0.7")
            slot, down, worst, longest = 0, {}, 0.0, 0.0
            pos = {}
            for t, events in R.read_frames(sim):
                for ty, code, value in events:
                    if ty == 3 and code == 0x2f:
                        slot = value
                    elif ty == 3 and code == 0x39:
                        if value >= 0:
                            down[slot] = [t, None]
                        elif slot in down:
                            longest = max(longest, (t - down.pop(slot)[0]) / 1000)
                    elif ty == 3 and code in (0x35, 0x36):
                        p = list(pos.get(slot, (0, 0)))
                        p[0 if code == 0x35 else 1] = value
                        pos[slot] = tuple(p)
                for s_, d in down.items():
                    if d[1] is None and s_ in pos:
                        d[1] = pos[s_]
                    if d[1] is not None and s_ in pos:
                        worst = max(worst, ((pos[s_][0] - d[1][0]) ** 2 + (pos[s_][1] - d[1][1]) ** 2) ** 0.5 / 24)
            check(f'  libinput is handed a tap: down {longest:.0f} ms (< 180), moved {worst:.2f} mm (< 1.3)',
                  longest < 180 and worst < 1.3)

        # 9
        def rest_then_scroll(k):
            k.at(0, {0: (45, 50)})
            t = 0.007
            while t < 0.2:
                k.at(t, {0: (45, 50), 1: (61, 50)})
                t += 0.007
            y = 50.0
            for i in range(60):
                y -= 15 * 0.007
                k.at(t + i * 0.007, {0: (45, y), 1: (61, y)})
            k.at(t + 60 * 0.007, {})
            return 1.5
        first = {}
        for engine in (True, False):
            model, _ = through(workdir, rest_then_scroll, engine)
            moves = [t for t, v, s in model if not s and t > 0]
            first[engine] = (moves[0] - 200) if moves else None
        check(f'fingers resting 200 ms, then 15 mm/s: first scroll {first[True]:.0f} ms after they move with the '
              f'engine, {first[False]:.0f} ms without', first[True] is not None and first[False] is not None
              and first[True] < first[False] and first[True] <= 50)

        lift150 = er.scroll_track(er.Fingers(), UP150, y0=60) * 1000

        # 10
        def click(k, lift):
            t = lift + 0.1
            for i in range(6):
                k.at(t + i * 0.007, {0: (60, 35)})
            k.at(t + 0.042, {0: (60, 35)}, button=True)
            for i in range(1, 8):
                k.at(t + 0.042 + i * 0.007, {0: (60, 35)}, button=True)
            k.at(t + 0.1, {0: (60, 35)})
            k.at(t + 0.13, {})
            return t + 1.0
        for method in ('buttonareas', 'clickfinger'):
            _, lines = through(workdir, lambda k: flick_then(k, click), True, extra=f'--set-click-method={method}')
            presses = [ln for ln in kinds(lines, 'POINTER_BUTTON') if 'pressed' in ln]
            check(f'a click in the rest after a flick ({method}): {len(presses)} press, left',
                  len(presses) == 1 and 'BTN_LEFT' in presses[0], '\n'.join(presses))

        # 11
        def point(k, lift, rest=0.1):
            t = lift + rest
            k.at(t, {0: (40, 30)})
            for i in range(1, 36):
                k.at(t + i * 0.007, {0: (40 + i * 0.28, 30)})
            k.at(t + 36 * 0.007, {})
            return t + 1.0
        def motion_of(lines):
            xs = [float(v) for ln in kinds(lines, 'POINTER_MOTION')
                  for v in re.findall(r'(-?\d+\.\d+)/', ln)[:1]]
            return len(xs), sum(xs)
        _, lines_on = through(workdir, lambda k: flick_then(k, point), True)
        _, lines_off = through(workdir, lambda k: point(k, 0.0, 0.3), False)
        n_on, x_on = motion_of(lines_on)
        n_off, x_off = motion_of(lines_off)
        check(f'one finger in the rest points: {n_on} motions moving {x_on:.0f} px, without a glide '
              f'{n_off} moving {x_off:.0f} px', n_on >= n_off - 3 and x_on >= 0.85 * x_off)

        # 12
        def two_tap(k, lift):
            t = lift + 0.1
            k.at(t, {0: (45, 40), 1: (61, 40)})
            for i in range(1, 9):
                k.at(t + i * 0.007, {0: (45, 40), 1: (61, 40)})
            k.at(t + 0.07, {})
            return t + 1.0
        _, lines = through(workdir, lambda k: flick_then(k, two_tap), True, extra='--enable-tap')
        presses = [ln for ln in kinds(lines, 'POINTER_BUTTON') if 'pressed' in ln]
        check(f'a two-finger tap in the rest: {len(presses)} press, right', len(presses) == 1 and 'BTN_RIGHT' in presses[0],
              '\n'.join(presses))

        # 13
        def pinch(k, lift):
            t = lift + 0.1
            for i in range(0, 45):
                d = i * 0.35
                k.at(t + i * 0.007, {0: (45 - d / 2, 40), 1: (65 + d / 2, 40)})
            k.at(t + 45 * 0.007, {})
            return t + 1.0
        _, lines = through(workdir, lambda k: flick_then(k, pinch), True)
        check('two fingers spreading in the rest: a pinch', bool(kinds(lines, 'GESTURE_PINCH_BEGIN')),
              '\n'.join(kinds(lines, 'GESTURE')[:4]))

        # 14
        def swipe3(k, lift):
            t = lift + 0.1
            for i in range(0, 45):
                d = i * 0.6
                k.at(t + i * 0.007, {0: (35 + d, 40), 1: (50 + d, 40), 2: (65 + d, 40)})
            k.at(t + 45 * 0.007, {})
            return t + 1.0
        _, lines = through(workdir, lambda k: flick_then(k, swipe3), True)
        begins = [ln for ln in kinds(lines, 'GESTURE_SWIPE_BEGIN')]
        check(f'three fingers in the rest: a three-finger swipe ({begins[0].split()[-1] if begins else "none"})',
              bool(begins) and begins[0].split()[-1] == '3', '\n'.join(kinds(lines, 'GESTURE')[:4]))

        # 15
        def one_then_two(k, lift):
            t = lift + 0.1
            k.at(t, {0: (45, 50)})
            k.at(t + 0.021, {0: (45, 50), 1: (61, 50)})
            for i in range(1, 30):
                k.at(t + 0.021 + i * 0.007, {0: (45, 50 - i * 0.5), 1: (61, 50 - i * 0.5)})
            k.at(t + 0.021 + 30 * 0.007, {})
            return t + 1.5
        model, _ = through(workdir, lambda k: flick_then(k, one_then_two), True)
        stops = [t for t, v, s in model if s]
        moving = [t for t, v, s in model if lift150 + 150 < t < lift150 + 300 and not s]
        check(f'one finger then a second in the rest: they scroll on ({len(moving)} events), one stop ({len(stops)})',
              len(stops) == 1 and len(moving) > 20)

        # 16
        for name in sorted(os.listdir(os.path.join(HERE, 'gestures'))):
            events, _ = G.load(os.path.join(HERE, 'gestures', name))
            def replay(k, events=events):
                for t, ty, code, value in events:
                    pass
                return 0.0
            k = er.Fingers()
            raw = os.path.join(workdir, 'k.events')
            open(raw, 'w').write('\n'.join(k.lines[:2] + G.evemu_lines(events, k.t0)) + '\n')
            sim = os.path.join(workdir, 's.events')
            R.simulate(raw, True, sim, "0.7")
            model = R.scroll_from_frames(R.read_frames(sim))
            stops = [t for t, v, s in model if s]
            moves = [t for t, v, s in model if not s]
            ok = (not moves and not stops) or (len(stops) == 1 and stops[0] > moves[-1])
            check(f'{name[:-5]}: {len(stops)} stop, after the last of {len(moves)} scrolls', ok)
    finally:
        er.cleanup(workdir)
    print()
    if failures:
        print(f'{len(failures)} of {len(failures) + len(passes)} checks failed')
        sys.exit(1)
    print(f'All {len(passes)} checks passed')


if __name__ == '__main__':
    main()

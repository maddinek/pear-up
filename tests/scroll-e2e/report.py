#!/usr/bin/env python3
"""The scroll end-to-end test's measurements and report.

    python3 report.py <stream.json> <mac-events.log> <clients-dir> <out-dir>

Every gesture becomes a series of (ms, distance moved) with the times of the
lift and of any touch after it, for each view there is of it:

  mac            the Air's AppKit events (fixture), one per 60 Hz frame
  <mode>/stream  libinput's stream (stage 1), as an app is handed it
  <mode>/gtk-model  that stream through GTK 4's own glide, worked out from its
                 source (gtkeventcontrollerscroll.c: velocity of the last
                 150 ms at the stop; gtkscrolledwindow.c: x(t) = v/4 (1-e^-4t),
                 x2.5 for touchpad units)
  <mode>/gtk     what the GTK 4 probe drew, frame by frame (stage 2)
  <mode>/chromium  what Chromium drew, frame by frame (stage 2)

and the same measurements (measure()) are taken of each, the Mac included.
Exit status 1 when the engine modes fail a limit; the baseline ("now") is
expected to fail and is reported, not counted.
"""
import json
import math
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import thresholds as TH  # noqa: E402

GTK_FACTOR = 2.5      # GtkScrolledWindow's MAGIC_SCROLL_FACTOR for touchpad units
MAC_PT_PER_MM = 8.8   # IOHIDPointerScrollFilter, the Air's table, at 80 mm/s
CURVE = [(0, 0.08), (3, 0.13), (5, 0.19), (8, 0.37), (10, 0.43), (15, 0.56), (20, 0.64), (30, 0.76),
         (40, 0.84), (60, 0.94), (80, 1.0), (120, 1.06), (160, 1.08)]


def share(speed):
    for (x0, y0), (x1, y1) in zip(CURVE, CURVE[1:]):
        if speed <= x1:
            return y0 + (y1 - y0) * (speed - x0) / (x1 - x0)
    return CURVE[-1][1]


# ------------------------------------------------------------ the views
def mac_series(path):
    """[{'name', 'moves': [(ms, d)], 'lift', 'touch', 'hz'}] from the probe."""
    out, cur, ev = [], None, []
    for line in open(path):
        p = line.split()
        d = dict(x.split('=') for x in p[1:])
        ev.append((float(p[0]), int(d['phase']), int(d['momentum']), abs(float(d['dy']))))
    for t, ph, mo, dy in ev:
        # The next touch ("may begin", or straight "began") ends the glide.
        if ph in (32, 1) and out and out[-1]['lift'] is not None and out[-1]['touch'] is None \
                and out[-1]['glide']:
            out[-1]['touch'] = t
        if ph == 1:
            cur = {'name': f'mac-{len(out):02d}', 'moves': [(t, dy)], 'lift': None, 'touch': None, 'hz': 60,
                   'start': None, 'glide': False}
            out.append(cur)
        elif cur is None:
            continue
        elif ph == 4:
            cur['moves'].append((t, dy))
        elif ph == 8:
            cur['lift'] = t
        elif mo in (1, 4):
            cur['moves'].append((t, dy))
            cur['glide'] = True
    for s in out:
        t0 = s['lift'] or 0
        s['moves'] = [(t - t0, d) for t, d in s['moves']]
        s['touch'] = s['touch'] - t0 if s['touch'] else None
        s['lift'] = 0.0
    return out


def stream_series(entry, mode, gtk_model=False):
    st = entry[mode]['stream']
    lifts = entry['fingers']['lifts']
    lift = lifts[0] if lifts else st[-1][0]
    moves = [(t - lift, abs(v) * GTK_FACTOR) for t, v, s in st if not s]
    stops = [t - lift for t, v, s in st if s]
    added = 0.0
    touches_ = [t - lift for t in entry['fingers']['touches']]
    if gtk_model and stops:
        stop = stops[0]
        # A finger down stops GTK's glide: libinput's quick hold after 40 ms
        # (evdev-mt-touchpad-gestures.c), GTK's HOLD_TIMEOUT_MS 50 after that.
        cut = min([t + 90 for t in touches_ if t > stop] + [stop + 3000])
        win = [(t, d) for t, d in moves if stop - 150 <= t <= stop]
        first = min([t for t, _ in win] + [stop])
        v = sum(d for _, d in win) / ((stop - first) / 1000) if stop > first else 0.0
        added = v
        prev = 0.0
        for k in range(1, int(cut - stop)):
            x = v / 4 * (1 - math.exp(-4 * k / 1000))
            if x - prev > 1e-3:
                moves.append((stop + k, x - prev))
            prev = x
        moves.sort()
    touches = [t - lift for t in entry['fingers']['touches']]
    start = entry['fingers']['start']
    reflick = len(lifts) > 1
    return {'moves': moves, 'lift': 0.0, 'touch': touches[0] if touches and not reflick else None, 'hz': 120,
            # The engine draws the fingers 9 ms behind the touchpad (its DELAY):
            # what they moved up to the lift is on screen 9 ms later.
            'contact_end': 9.0 if mode == 'engine' else 0.0,
            'touch2': touches[0] if touches and reflick else None,
            'start': start - lift if start is not None else None, 'stops': stops, 'app_velocity': added,
            'track': [(t - lift, mm) for t, mm in entry['fingers']['track']]}


def client_series(entry, mode, path, fed_path, kind):
    """What a client drew: frame times and positions, put on the stream's
    clock through the feeder's log (when it sent each stream event)."""
    if not (os.path.exists(path) and os.path.exists(fed_path)):
        return None
    fed = [json.loads(x) for x in open(fed_path) if x.strip()]
    rows = [json.loads(x) for x in open(path) if x.strip()]
    if not fed or not rows:
        return None
    lifts = entry['fingers']['lifts']
    lift = lifts[0] if lifts else fed[-1]['t']
    events = None
    if kind in ('gtk', 'gtk-events'):
        offset = fed[0]['sent'] / 1000 - fed[0]['t']     # monotonic ms - stream ms
        frames = [(r['frame'] / 1000 - offset, r['y']) for r in rows if r['k'] == 'frame']
        events = [(r['mono'] / 1000 - offset, abs(r['dy']) * GTK_FACTOR) for r in rows
                  if r['k'] == 'scroll' and 'mono' in r and r['dy']]
        # GTK's "decelerate" is in touchpad units a second; its window
        # multiplies it by 2.5 like the scroll itself.
        added = GTK_FACTOR * max([abs(r['vy']) for r in rows if r['k'] == 'decelerate'] or [0.0])
    else:
        wheels = [r for r in rows if r['k'] == 'wheel']
        if not wheels:
            return None
        offset = wheels[0]['t'] - fed[0]['t']             # page ms - stream ms
        frames = [(r['t'] - offset, r['y']) for r in rows if r['k'] == 'frame']
        added = None
        events = [(r['t'] - offset, abs(r['dy'])) for r in wheels if r['dy']]
    # Only from the first scroll fed on: before it the probe set its page to
    # the middle, which is no scroll.
    frames = [(t, y) for t, y in frames if t >= fed[0]['t'] - 20]
    dts = sorted(b - a for (a, _), (b, _) in zip(frames, frames[1:]) if b > a)
    hz = round(1000 / dts[len(dts) // 2]) if dts else 120
    period = 1000 / hz
    late = sum(1 for d in dts if d > period * 1.5) / max(len(dts), 1)
    moves = []
    for (t1, y1), (t2, y2) in zip(frames, frames[1:]):
        if y2 != y1:
            moves.append((t2, abs(y2 - y1)))
    # What the app scrolled after the stop that ended the gesture: its own glide.
    stops = [f['t'] for f in fed if f['stop']]
    total = sum(d for _, d in moves)
    fling = sum(d for t, d in moves if stops and t > stops[-1] + 30)
    base = stream_series(entry, mode)
    if kind.endswith('-events'):
        # The events the app was handed, when it got them, and GTK's own glide
        # from the velocity it reported: not tied to when the headless shell
        # managed to draw.
        moves = list(events or [])
        if added and stops:
            v = added
            stop = stops[-1]
            prev = 0.0
            for k in range(1, 3000):
                x = v / 4 * (1 - math.exp(-4 * k / 1000))
                if x - prev > 1e-3:
                    moves.append((stop + k, x - prev))
                prev = x
        # Both toolkits hand their events on once a frame (GDK compresses
        # scroll events, Chromium coalesces wheel events), so these come in
        # frame-sized batches too: the drawn frames' lateness applies.
    # What is drawn comes a frame or so after the event: find that delay by
    # lining the drawn distance up with the stream's, report it, and measure
    # the rest on the lined-up series, so the shape is not blurred by it.
    def cum(ms):
        out, c, i = [], 0.0, 0
        ms = sorted(ms)
        for t in range(-300, 1500, 2):
            while i < len(ms) and ms[i][0] <= t:
                c += ms[i][1]
                i += 1
            out.append(c)
        return out
    ref = cum(base['moves'])
    best = (float('inf'), 0)
    for shift in range(0, 60):
        got = cum([(t - lift - shift, d) for t, d in moves])
        err = sum((a - b) ** 2 for a, b in zip(ref, got))
        best = min(best, (err, shift))
    delay = best[1]
    moves = [(t - lift - delay, d) for t, d in moves]
    if kind.startswith('gtk'):
        # The stops GTK's scroll controller saw (its "scroll-end"), from the
        # first scroll fed on.
        base['stops'] = [r for r in rows if r['k'] == 'end' and r['mono'] / 1000 - offset >= fed[0]['t'] - 20]
    elif kind.startswith('chromium'):
        base['stops'] = None
    base.update({'moves': moves, 'app_velocity': added, 'hz': hz, 'draw_delay_ms': delay, 'late_frames': late,
                 'fling_share': fling / total if total and not kind.endswith('-events') else None,
                 # Chromium 154 scales touchpads 12x (no WaylandUnscaledTouchpadScrolling yet): no distance check.
                 'track': None if kind.startswith('chromium') else base.get('track'),
                 'track_for_start': base.get('track'),
                 'frames': [(t - lift - delay, y) for t, y in frames]})
    return base


# ------------------------------------------------------------ measurements
def bins(moves, t0, t1, width):
    n = max(int((t1 - t0) // width), 0)
    b = [0.0] * n
    for t, d in moves:
        if t0 <= t < t0 + n * width:
            b[int((t - t0) // width)] += d
    return b


# What depends on when each frame came, including the ratios to the speed in
# the 50 ms before the lift, which a late frame's batch of events distorts.
TIMING = ('contact_jitter', 'start_latency_ms', 'handoff_ratio', 'glide_hold_ms', 'glide_tau_ms', 'handover_jump',
          'handover_dip', 'glide_over_lift_s')


def measure(s, name):
    """The same numbers for any series. A drawn series whose frames came
    late too often (the headless shell renders in software) gives only the
    numbers that do not depend on when each frame came: distances, what the
    app added, whether the glide stopped."""
    m = measure_all(s)
    if s.get('late_frames', 0) > 0.05:
        for key in TIMING:
            m.pop(key, None)
    return m


def measure_all(s):
    m = {}
    if not s['moves']:
        return m
    # Everything about the lift is measured from when it is on screen: the
    # engine draws the fingers DELAY behind the touchpad (contact_end).
    shift = s.get('contact_end', 0.0)
    moves = [(t - shift, d) for t, d in s['moves']]
    first = moves[0][0]
    # Contact jitter: the steady middle half of the touch, per frame.
    width = 1000 / s['hz']
    a = first + (0 - first) * 0.25
    b = first + (0 - first) * 0.75
    fr = bins(moves, a, b, width)
    # Only where a frame moves at least 1.5 px (3 a 60 Hz frame, as the Mac
    # contacts it is taken on): slower, both sides step by whole points or
    # units every few frames, which says nothing about pacing.
    if len(fr) >= 8 and sum(fr) / len(fr) >= 1.5 * 120 / s['hz']:
        res = []
        for i in range(2, len(fr) - 2):
            avg = sum(fr[i - 2:i + 3]) / 5
            res.append(fr[i] - avg)
        mean = sum(fr) / len(fr)
        m['contact_jitter'] = math.sqrt(sum(r * r for r in res) / len(res)) / mean
    if s.get('start') is not None:
        # Against when a Mac would show its first point for the same fingers:
        # the curve with the Air's table summed until it reaches one point.
        mac_first = None
        track = s.get('track') or s.get('track_for_start') or []
        total = 0.0
        for (t1, y1), (t2, y2) in zip(track, track[1:]):
            if t2 < s['start'] - shift:
                continue
            mm = abs(y2 - y1)
            speed = mm / max((t2 - t1) / 1000, 1e-3)
            total += mm * MAC_PT_PER_MM * share(speed)
            if total >= 1.0:
                mac_first = t2
                break
        if mac_first is not None:
            m['start_latency_ms'] = (first + shift) - max(mac_first, s['start'])
    before = sum(d for t, d in moves if -50 <= t <= 0) / 0.05
    contact = sum(d for t, d in moves if t <= s.get('contact_end', 0.0))
    after = [(t, d) for t, d in moves if t > 0 and (s['touch'] is None or t <= s['touch'])]
    if before > 0:
        m['lift_speed'] = before
        early = sum(d for t, d in after if t <= 33) / 0.033
        m['handoff_ratio'] = early / before
        sp = bins(after, 0, 2000, 16.67)
        raw = [x / 0.01667 for x in sp]
        # Over three frames: a slow glide steps by whole units, and a single
        # frame a unit short would end its "hold" early.
        speeds = [sum(raw[max(0, i - 1):i + 2]) / len(raw[max(0, i - 1):i + 2]) for i in range(len(raw))]
        if speeds and max(speeds) > 0:
            peak = max(speeds)
            ip = speeds.index(peak)
            hold_end = next((i for i in range(ip, len(speeds)) if speeds[i] < 0.9 * peak), None)
            if hold_end is not None:
                m['glide_hold_ms'] = hold_end * 16.67
                pts = [(i * 16.67, math.log(v)) for i, v in enumerate(raw)
                       if i >= hold_end and v >= 0.1 * peak]
                if len(pts) >= 3:
                    xs = [p[0] for p in pts]
                    ys = [p[1] for p in pts]
                    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
                    den = sum((x - mx) ** 2 for x in xs)
                    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else 0
                    if slope < 0:
                        m['glide_tau_ms'] = -1 / slope
        glided = sum(d for _, d in after)
        if s['touch'] is None:
            m['glide_over_lift_s'] = glided / before
            last = [t for t, d in after]
            m['glide_ms'] = max(last) if last else 0.0
        if contact > 0:
            m['slow_lift_glide_share'] = glided / contact
        if s.get('app_velocity') is not None:
            m['app_added_velocity_share'] = s['app_velocity'] / before
    if s['touch'] is not None:
        late = [t + shift for t, d in moves if t + shift > s['touch']]
        m['cancel_latency_ms'] = (max(late) - s['touch']) if late else 0.0
    if s.get('stops') is not None:
        m['stop_count'] = len(s['stops'])
    if s.get('fling_share') is not None:
        m['app_fling_share'] = s['fling_share']
    # How far the page slows where new fingers take over a glide: the slowest
    # 16.7 ms within 300 ms of their touch over the speed just before it.
    if s.get('touch2') is not None:
        pre = sum(d for t, d in moves if s['touch2'] - 50 <= t < s['touch2']) / 0.05
        after = bins(moves, s['touch2'], s['touch2'] + 300, 16.67)
        if pre > 0 and after:
            m['handover_dip'] = min(after) / 0.01667 / pre
    # Continuity across a second gesture's touch: the largest frame within
    # 100 ms of it over the largest anywhere else in the gesture. A jump where
    # the glide and the new fingers meet stands out above both.
    if s.get('touch2') is not None:
        width = 1000 / 120
        t0 = moves[0][0]
        fr = bins(moves, t0, moves[-1][0] + width, width)
        near = [v for i, v in enumerate(fr) if abs(t0 + i * width - s['touch2']) <= 100]
        far = [v for i, v in enumerate(fr) if abs(t0 + i * width - s['touch2']) > 100]
        if near and far and max(far) > 0:
            m['handover_jump'] = max(near) / max(far)
    # Distance under the fingers against a Mac's for the same movement.
    track = s.get('track')
    if track:
        expect = 0.0
        for (t1, y1), (t2, y2) in zip(track, track[1:]):
            if t2 > 0:
                break
            mm = abs(y2 - y1)
            speed = mm / max((t2 - t1) / 1000, 1e-3)
            expect += mm * MAC_PT_PER_MM * share(speed)
        # Under 10 points a Mac's own rounding to whole points (and libinput's
        # to its steps) is a third of it: no verdict on so short a nudge.
        if expect > 10:
            m['distance_vs_mac'] = contact / expect
    return m


def applies(gesture, key):
    if key in ('handoff_ratio', 'glide_hold_ms', 'glide_tau_ms', 'glide_over_lift_s'):
        # A second flick during the glide makes the glide's shape the second
        # gesture's; those are judged on the hand-over alone.
        return (gesture.startswith(TH.GLIDES) and not gesture.startswith(TH.CANCELS)
                and not gesture.startswith(TH.REFLICKS))
    if key == 'slow_lift_glide_share':
        return gesture.startswith(TH.SLOW)
    if key == 'cancel_latency_ms':
        return gesture.startswith(TH.CANCELS)
    if key in ('handover_jump', 'handover_dip'):
        return gesture.startswith(TH.REFLICKS)
    if key == 'app_fling_share':
        return gesture.startswith(TH.GLIDES)
    if key == 'app_added_velocity_share':
        return gesture.startswith(TH.GLIDES)
    return True


def verdict(key, value):
    low, high = TH.LIMITS[key]
    return (low is None or value >= low) and (high is None or value <= high)


# ------------------------------------------------------------ report
def main():
    stream = json.load(open(sys.argv[1]))
    mac = mac_series(sys.argv[2])
    clients = sys.argv[3]
    out = sys.argv[4]
    os.makedirs(out, exist_ok=True)
    keys = list(TH.LIMITS)

    mac_m = []
    for s in mac:
        m = measure(s, s['name'])
        # The Mac's numbers are each taken where they mean something: the
        # glide's on flicks that glided, its distance on the one not cut
        # short by the next touch, the slow-lift share on those that did not.
        for key in ('handoff_ratio', 'glide_hold_ms', 'glide_tau_ms', 'app_added_velocity_share'):
            if not s['glide']:
                m.pop(key, None)
        if not s['glide'] or s['touch'] is not None:
            m.pop('glide_over_lift_s', None)
        if s['glide']:
            m.pop('slow_lift_glide_share', None)
        mac_m.append(m)

    def agg(ms, key):
        v = [m[key] for m in ms if key in m]
        return (min(v), sorted(v)[len(v) // 2], max(v), len(v)) if v else None

    views = {}
    for g, entry in stream.items():
        for mode in ('now', 'engine'):
            if mode not in entry:
                continue
            views[(g, mode, 'stream')] = stream_series(entry, mode)
            views[(g, mode, 'gtk-model')] = stream_series(entry, mode, gtk_model=True)
            for kind in ('gtk-events', 'gtk', 'chromium-events', 'chromium'):
                app = kind.split('-')[0]
                c = client_series(entry, mode, os.path.join(clients, f'{g}.{mode}.{app}.jsonl'),
                                  os.path.join(clients, f'{g}.{mode}.{"fed" if app == "gtk" else "cfed"}.jsonl'),
                                  kind)
                if c:
                    views[(g, mode, kind)] = c
    results = {k: measure(v, k[0]) for k, v in views.items()}
    for k, v in views.items():
        if 'draw_delay_ms' in v:
            results[k]['draw_delay_ms'] = v['draw_delay_ms']
            results[k]['late_frames'] = v['late_frames']

    lines = ['# Scroll end-to-end report', '',
             'MacBook Air reference: fixtures/mac-air-events.log. Gestures: tests/scroll-e2e/gestures '
             f'({sum(1 for e in stream.values() if e.get("synthetic"))} of {len(stream)} synthetic). '
             'Limits: thresholds.py.', '',
             '## The Mac, measured the same way', '',
             'Every Mac glide in the log was cut short by the next touch (or by closing the window), so '
             'glide_over_lift_s has no uncut Mac flick; its limit comes from the glide fitted to all 9 '
             '(1.30 x lift speed, held 120 ms, tau 200 ms: 0.45 s uncut). glide_tau_ms on short, cut '
             'glides is noisy; the fit over all of them gives 200.', '',
             '| measure | limit | Mac min | median | max | n |', '|---|---|---|---|---|---|']
    for key in keys:
        a = agg(mac_m, key)
        low, high = TH.LIMITS[key]
        lim = f'{"" if low is None else low} .. {"" if high is None else high}'
        lines.append(f'| {key} | {lim} | ' + (' | '.join(f'{x:.3g}' for x in a[:3]) + f' | {a[3]}' if a else '— | — | — | 0') + ' |')

    failed = {}
    for mode in ('now', 'engine'):
        for view in ('gtk-events', 'gtk', 'chromium-events', 'chromium', 'gtk-model', 'stream'):
            rows = [(g, results[(g, mode, view)]) for g in stream if (g, mode, view) in results]
            if not rows:
                continue
            note = {
                'stream': 'what libinput hands every app, binned at 120 Hz: a client drawing every frame on time',
                'gtk-model': 'that stream through GTK 4\'s own glide, from its source',
                'gtk-events': 'the scroll events the GTK 4 probe received, when it received them, plus the '
                              'glide GTK started itself (its decelerate velocity). GDK hands scroll events on once '
                              'a frame, so with late frames only distances and the app\'s own glide count',
                'gtk': 'what the GTK 4 probe drew in the headless shell; timing measures left out when over 5% '
                       'of its frames came late (software rendering)',
                'chromium-events': 'the wheel events Chromium\'s page received (Chromium 154, without the '
                                   'WaylandUnscaledTouchpadScrolling flag: 12x scale, so no distance check)',
                'chromium': 'what Chromium drew (scrollY each animation frame), its own fling included',
            }[view]
            lates = [results[(g, mode, view)].get('late_frames') for g, _ in rows]
            lates = [x for x in lates if x is not None]
            if lates:
                note += f' — late frames {min(lates):.0%}–{max(lates):.0%}'
            lines += ['', f'## {mode} — {view}', '', f'_{note}_', '',
                      '| gesture | ' + ' | '.join(keys) + ' |', '|---|' + '---|' * len(keys)]
            for g, m in rows:
                cells = []
                for key in keys:
                    if key not in m or not applies(g, key):
                        cells.append('')
                        continue
                    ok = verdict(key, m[key])
                    if not ok:
                        failed.setdefault((mode, view), []).append((g, key))
                    cells.append(f'{m[key]:.3g}{"" if ok else " **FAIL**"}')
                lines.append(f'| {g} | ' + ' | '.join(cells) + ' |')
    # Run to run, engine stream: the same gestures at other phases of the
    # engine's beat against the touchpad's reports.
    spread = {}
    for g, entry in stream.items():
        reps = entry.get('engine', {}).get('repeats') or []
        for run in reps:
            series = stream_series(entry, 'engine')
            lifts = entry['fingers']['lifts']
            lift = lifts[0] if lifts else 0
            series['moves'] = [(t - lift, abs(v) * GTK_FACTOR) for t, v, s_ in run if not s_]
            for key, value in measure(series, g).items():
                if key in TH.LIMITS and applies(g, key):
                    spread.setdefault((g, key), []).append(value)
    if spread:
        n = max(len(v) for v in spread.values())
        lines += ['', f'## Run to run: engine stream at {n} phases of its beat', '',
                  'Each gesture replayed with the engine\'s 480 Hz beat falling elsewhere against the touchpad\'s '
                  'reports. A measure that moves a lot here is that phase, not the engine; failures counted per '
                  'phase.', '', '| gesture | measure | min | max | fails |', '|---|---|---|---|---|']
        for (g, key), vals in sorted(spread.items()):
            fails = sum(1 for v in vals if not verdict(key, v))
            if fails:
                # The engine has to pass at every phase of its beat, not on
                # one lucky one.
                failed.setdefault(('engine', 'stream at every phase'), []).append((g, key))
            if max(vals) - min(vals) > 0.05 * max(abs(max(vals)), 1e-9) or fails:
                lines.append(f'| {g} | {key} | {min(vals):.3g} | {max(vals):.3g} | {fails}/{len(vals)} |')
    lines += ['', '## Failures by mode and view', '']
    for (mode, view), items in sorted(failed.items()):
        by = {}
        for g, key in items:
            by.setdefault(key, []).append(g)
        lines.append(f'- **{mode} / {view}**: ' + '; '.join(f'{k} ({len(v)})' for k, v in by.items()))
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')
    json.dump({'mac': mac_m, 'framy': {'|'.join(k): v for k, v in results.items()}},
              open(os.path.join(out, 'metrics.json'), 'w'), indent=1)

    # Plots: displacement over time, Mac vs framy, per gesture (best view).
    colors = {'now': '#d1495b', 'engine': '#2e86ab'}
    for g in stream:
        fig, ax = plt.subplots(figsize=(8.5, 4.6))
        for s, mm in zip(mac, mac_m):
            if 'lift_speed' not in mm or not s['moves']:
                continue
            cum, xs, ys = 0.0, [], []
            for t, d in s['moves']:
                cum += d
                xs.append(t)
                ys.append(cum)
            base = next((y for x, y in zip(xs, ys) if x >= 0), ys[-1])
            ax.plot(xs, [(y - base) / mm['lift_speed'] for y in ys], color='0.6', lw=0.8)
        for mode in ('now', 'engine'):
            for view in ('gtk-events', 'gtk-model', 'chromium'):
                k = (g, mode, view)
                if k not in views:
                    continue
                s, mm = views[k], results[k]
                if 'lift_speed' not in mm:
                    continue
                cum, xs, ys = 0.0, [], []
                for t, d in sorted(s['moves']):
                    cum += d
                    xs.append(t)
                    ys.append(cum)
                base = next((y for x, y in zip(xs, ys) if x >= 0), ys[-1] if ys else 0)
                ax.plot(xs, [(y - base) / mm['lift_speed'] for y in ys], color=colors[mode],
                        ls={'gtk-events': '-', 'chromium': '--', 'gtk-model': ':'}[view], lw=1.6,
                        label=f'framy {mode}, {view}')
                break
        ax.plot([], [], color='0.6', lw=0.8, label='MacBook Air flicks')
        ax.axvline(0, color='k', lw=0.5)
        ax.set_xlim(-300, 1600)
        ax.set_ylim(-0.6, 0.7)
        ax.set_xlabel('ms from the lift')
        ax.set_ylabel('distance / speed at lift (s)')
        ax.set_title(f'{g}: page movement, scaled by the speed at lift')
        ax.grid(alpha=0.3)
        ax.legend(fontsize=7, loc='upper left')
        fig.tight_layout()
        fig.savefig(os.path.join(out, f'mac-scroll-{g}.png'), dpi=110)
        plt.close(fig)
    print('\n'.join(lines))
    engine_failed = [k for k in failed if k[0] != 'now' and k[1] in ('stream', 'stream at every phase')]
    return 1 if engine_failed else 0


if __name__ == '__main__':
    sys.exit(main())

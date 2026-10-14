# Scroll end-to-end test

Measures two-finger scrolling on framy against a MacBook Air, by numbers. Each gesture goes from
the touchpad to what an app draws on screen, and the same measurements are taken of the Mac's own
recorded stream.

```bash
tests/run-scroll-e2e.sh                       # everything; report in tests/scroll-e2e/out/
E2E_STAGES=1 tests/run-scroll-e2e.sh          # libinput only (a minute or two)
E2E_GESTURES="flick quick-reflick" tests/run-scroll-e2e.sh
E2E_CHROMIUM=0 tests/run-scroll-e2e.sh        # GTK 4 only
```

Nothing touches the desktop it runs on. The touchpad is a umockdev one inside a container, never
uinput, which the session's own libinput would pick up. The shell is a headless one in the same
container.

## The pipeline

1. **Gesture** (`gestures/*.yaml`, the `libinput record` format).
2. **Pear Up's plugin** in `simulate.lua`: the plugin's own code in libinput's Lua sandbox, with
   its timer fired exactly when asked.
3. **Real libinput 1.31.3** without a plugin, on a umockdev PIXA3854 (`stream.py`). libinput's own
   two-finger scroll, jump detection and stop produce the scroll stream. The stream keeps the
   frames' own microsecond times. libinput's printed output (millisecond times) must agree with it
   on distance.
4. **Headless GNOME Shell 50 at 120 Hz with Pear Up enabled** (`clients/session.sh`). The stream
   goes in through mutter's RemoteDesktop `NotifyPointerAxis` with the finger source and finish
   flag (`clients/feed.py`). Headless mutter runs without libinput, but this call ends in the same
   function libinput's axis events do (`meta_seat_impl_notify_scroll_continuous_in_impl`), so
   clients get the same `wl_pointer` axis, axis_source finger and axis_stop.
5. **Clients**:
   - `clients/gtk-probe.js`: a GTK 4 scrolled window. It logs each scroll event, GTK's
     `decelerate` velocity and, every frame, the frame-clock time and the page position.
   - `clients/chromium-probe.html`: wheel events, and `scrollY` on every `requestAnimationFrame`.
6. **`report.py`** takes the same measurements of every view and of the Mac. The limits are in
   `thresholds.py`, each with a comment saying where it comes from. Output: `report.md`,
   `metrics.json` and `mac-scroll-<gesture>.png` (distance over time, scaled by the speed at lift,
   Mac flicks in grey).

Why the plugin runs in `simulate.lua` rather than live inside libinput: umockdev replays through a
pty, late and in bursts on a busy machine, and the engine's timer would then pace against that
rather than against a touchpad. The live path is checked separately for function, not timing:
`check-handoffs.py` and `../libinput/engine_replay.py`, run by `tests/run-libinput-tests.sh`.
`fuzz.lua` (also run there) throws random frames at the engine and checks three things: it never
errors (libinput would unload the plugin), it never reports a place off the pad, and it never
leaves a finger down.

## Modes

| mode | what it is |
|---|---|
| `now` | the plugin as framy has it: Medium (0.7), engine off; apps glide on their own |
| `engine` | the Mac scroll engine on, Medium |
| `engine-mac` | engine on, As on a MacBook (0.34): the distances a Mac scrolls |

## Fixtures

- `fixtures/mac-air-events.log`: Martin's MacBook Air, 13 two-finger gestures, one line per
  `NSEvent`: ms, `phase`, `momentumPhase`, `scrollingDeltaY`.
  - To record it again on a Mac:
    `swiftc fixtures/ScrollProbe.swift -o /tmp/scroll-probe && /tmp/scroll-probe ~/mac-events.log`.
  - Flick in the window that opens, with slow ones and quick ones, some cut short by the next
    touch, then close it.
- `fixtures/framy-gtk4-medium.log`, `framy-gtk4-macbook.log`: the GTK 4 probe on framy at Medium
  and at MacBook speed, before the engine.
  - These are where the `martin-NN` gestures come from: GTK's deltas turned back into finger travel.

## Gestures

`gestures.py write` makes the synthetic ones, and each says so in its first line. They follow
framy's touchpad: 24 units per mm, 118 x 72 mm, a report every 7 ms, two fingers 16 mm apart, and
a little sensor noise. A real recording replaces them: run `record-gestures.sh` at framy, which
asks for sudo once to read the touchpad. `gestures.py write` keeps any file that is not marked
synthetic.

## Known limits

- The gestures are synthetic until recorded on framy; the `martin-NN` ones are reconstructions.
- In stage 2 no libinput hold gesture reaches the clients, because RemoteDesktop has no call for
  one. So when a finger stops an app's own glide (engine off), this test cannot see it.
  `report.py` models it for GTK from source as 90 ms (40 ms quick hold plus GTK's 50 ms).
- In the headless shell, Chromium draws frames but got no pointer input in the runs so far, so its
  rows are empty. Its fling with the engine is shown to be zero from source:
  `kFlingStartTimeoutMs` is 200 ms, and the engine rests 260 ms before the stop.
- How it feels is for fingers on framy's real touchpad to say.

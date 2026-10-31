# Scroll end-to-end test

Measures two-finger scrolling on framy against a MacBook Air, by numbers. Each gesture goes from
the touchpad to what an app draws on screen, and the same measurements are taken of the Mac's own
recorded stream.

```bash
tests/run-scroll-e2e.sh                       # everything; report in tests/scroll-e2e/out/
E2E_STAGES=1 tests/run-scroll-e2e.sh          # libinput only, and the hand-offs
E2E_GESTURES="flick quick-reflick" tests/run-scroll-e2e.sh
E2E_CHROMIUM=0 tests/run-scroll-e2e.sh        # GTK 4 only
E2E_HANDOFFS=0 tests/run-scroll-e2e.sh        # without the hand-off checks
```

Stage 1 and the hand-off checks run on the host, as root (`sudo -n`), with the plugin live inside
the host's libinput: nothing is simulated. The touchpad is a uinput one, grabbed (`EVIOCGRAB`) the
moment libinput opens it, so the desktop's compositor sees a touchpad come and go but never gets an
event from it. The shell is a headless one in a container.

## The pipeline

1. **Gesture** (`gestures/*.yaml`, the `libinput record` format).
2. **The kernel** (`live.py`): the gesture's frames are written to a uinput PIXA3854 (framy's
   touchpad: 24 units per mm, 5 slots, a buttonpad), which hands them on as it does a real
   touchpad's: a slot named only when it changes, a value only when it changed. Before each
   gesture one finger rests 250 ms in slot 4, so the kernel names the gesture's first slot, as
   on a touchpad in use; check 17 runs a gesture on a touchpad libinput has just opened.
3. **Pear Up's plugin inside libinput** (the host's, 1.31.3): a path context that loads the plugin
   as mutter does (its own directory first, then libinput's defaults). The plugin's timer runs on
   libinput's clock, its frames go through libinput's two-finger scroll, jump detection and stop,
   and the stream keeps libinput's own microsecond event times (`stream.py`).
4. **Headless GNOME Shell 50 at 120 Hz with Pear Up enabled** (`clients/session.sh`). The stream
   goes in through mutter's RemoteDesktop `NotifyPointerAxis` with the finger source and finish
   flag (`clients/feed.py`). Headless mutter runs without libinput, but this call ends in the same
   function libinput's axis events do (`meta_seat_impl_notify_scroll_continuous_in_impl`), so
   clients get the same `wl_pointer` axis, axis_source finger and axis_stop.
5. **Clients**:
   - `clients/gtk-probe.js`: a GTK 4 scrolled window. It logs each scroll event, GTK's
     `decelerate` velocity and, every frame, the frame-clock time and the page position.
   - `clients/chromium-probe.html`: wheel events, and `scrollY` on every `requestAnimationFrame`.
   - Chromium runs with `--password-store=basic`: otherwise a keyring dialog takes the pointer.
   - The integration tests' hook extension puts the pointer on the window.
6. **`report.py`** takes the same measurements of every view and of the Mac. The limits are in
   `thresholds.py`, each with a comment saying where it comes from. Output: `report.md`,
   `metrics.json` and `mac-scroll-<gesture>.png` (distance over time, scaled by the speed at lift,
   Mac flicks in grey).

`check-handoffs.py` (live, on the host) checks the engine's hand-offs: glide and stop, a touch
stopping it, two fingers taking it over, taps, clicks, pinches and swipes in its rest, the first
gesture on a just-opened touchpad, jumps only while no finger is down, and that no run spins
libinput's timer (its CPU time and wake-ups are bounded; a run that never comes back from libinput
is ended by `faulthandler` and fails). `fuzz.lua` (in the container, `tests/run-libinput-tests.sh`)
throws random frames at the engine and checks that it never errors, never reports a place off the
pad, never leaves a finger down, and never asks for its timer at or before now. `simulate.lua`
runs the plugin's arithmetic outside libinput; nothing passes or fails on it.

## Modes

| mode | what it is |
|---|---|
| `now` | the plugin as framy has it: Medium (0.7), engine off; apps glide on their own |
| `engine` | the Mac scroll engine on; it scrolls at a MacBook's speed (0.34) whatever the speed line says |

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
- Stage 1 runs on a live desktop: its timing is the host's, as the compositor's would be, and
  varies a little from run to run (the engine is run 5 times a gesture).
- In stage 2 no libinput hold gesture reaches the clients, because RemoteDesktop has no call for
  one. So when a finger stops an app's own glide (engine off), this test cannot see it.
  `report.py` models it for GTK from source as 90 ms (40 ms quick hold plus GTK's 50 ms).
- The headless shell renders in software. Up to half of GTK's frames come late, and GDK hands
  scroll events on once a frame. So GTK views with more than 5 % late frames report distances and
  GTK's own glide only; the stream is the timing reference.
  - Chromium's frames come on time (≤ 2 % late) and are measured in full.
- Chromium 154 predates the WaylandUnscaledTouchpadScrolling flag Pear Up sets on Brave. It
  still multiplies touchpad scrolling by 12, so its distances are not judged.
- How it feels is for fingers on framy's real touchpad to say.

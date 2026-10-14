"""Pass/fail limits for the scroll end-to-end test, against the MacBook Air's
own stream (fixtures/mac-air-events.log, 13 gestures, 9 with a glide).

Every limit is (low, high); None leaves a side open. Each comment says where
the Mac's number comes from and why the tolerance is what it is. report.py
measures the Mac and framy the same way; the Mac's own values are printed next
to every limit, so a limit that the Mac itself fails is visible at once.
"""

LIMITS = {
    # Unevenness while touching: how much the distance per frame wanders
    # around its own 5-frame average, over that average (coefficient of
    # variation), in the steady middle half of the touch, where a frame moves
    # at least 1.5 px (3 a Mac frame): slower, both step by whole points. The Mac sends one
    # event a frame and measures about 0.07-0.12 at 60 Hz, mostly its rounding
    # to whole points. framy draws at 120 Hz, where whole-unit rounding weighs
    # twice as much, so up to 0.20.
    'contact_jitter': (None, 0.20),

    # How much later than a Mac the page starts to move: ms from the first
    # scroll to when a Mac would show its first point for the same fingers
    # (the Air's curve summed over the finger track until it reaches one
    # point; at 5 mm/s that alone takes about 120 ms). libinput waits for a
    # millimetre before it scrolls (15-40 ms at a normal start, far more when
    # slow); the engine helps it past that and adds its DELAY (9 ms). 40 ms
    # allowed.
    'start_latency_ms': (None, 40),

    # The hand-off: speed in the first 33 ms after the lift over the speed in
    # the 50 ms before it. Mac: 1.11-1.45, fit 1.30 (9 flicks). +-0.2.
    'handoff_ratio': (1.1, 1.5),

    # How long the glide keeps its speed: ms from the lift until it first
    # drops below 90% of its peak. Mac: fit 120 ms, flicks 100-170.
    'glide_hold_ms': (80, 180),

    # The glide's slowing down after that, a time constant in ms (exponential
    # fit to the speed from the end of the hold to 10% of the peak). Mac: fit
    # 200, flicks 180-240; GTK's own glide is 250 from the start, Firefox's
    # default 500. 150-280.
    'glide_tau_ms': (150, 280),

    # Distance glided after the lift over the speed at the lift, in seconds
    # (so units cancel: a page that glides as a Mac's does scores the same at
    # any scale). Mac: the fitted glide gives 0.45 uncut; every measured flick
    # was cut short by the next touch, so this comes from the fit. +-0.1.
    'glide_over_lift_s': (0.35, 0.55),

    # A lift slower than about 25 mm/s does not glide on a Mac (4 such
    # gestures in the log, lift at 60-140 pt/s: no momentum events at all).
    # Distance after the lift over distance before it.
    'slow_lift_glide_share': (None, 0.03),

    # ms from a finger touching during a glide to the last movement it
    # causes. On the Mac the glide has already ended when the touch is
    # reported (momentum end 54-104 ms before the next "may begin"); one
    # 120 Hz frame plus the engine's DELAY is allowed.
    'cancel_latency_ms': (None, 20),

    # What an app adds after the stop, over the speed at the lift: GTK's
    # "decelerate" velocity (or the model of it from the stream), Chromium's
    # fling. On a Mac apps add nothing to the system's momentum. 5% allowed.
    'app_added_velocity_share': (None, 0.05),

    # Distance under the fingers against a Mac's for the same finger movement
    # (IOHIDPointerScrollFilter's curve with the Air's table, 8.8 pt per mm at
    # 80 mm/s; GTK's logical pixel is about a Mac point on framy's 2x screen).
    # "As on a MacBook" is meant to be 1.0; Medium is twice that on purpose
    # (scroll-feel.md), so it fails here by design and the line says so.
    'distance_vs_mac': (0.75, 1.33),

    # Continuity when the next flick comes during the glide: the largest
    # 120 Hz frame within 100 ms of the new touch over the largest anywhere
    # else in the gesture. On a Mac the touch ends the momentum and the new
    # contact starts from rest, so nothing there is bigger than the flicks
    # themselves; a jump where glide and fingers meet would be. 1.2 allowed.
    'handover_jump': (None, 1.2),

    # The other side of the hand-over: the slowest 16.7 ms within 300 ms of
    # the new touch over the glide's speed just before it. A glide that stops
    # dead under new fingers and only resumes once they get going is the
    # hitch to avoid; 60% allowed.
    'handover_dip': (0.6, None),

    # What a drawn page moved after the stop that ended the gesture, over all
    # it moved: the app's own fling (Chromium's from the last 200 ms, GTK's
    # from the last 150 ms). The Mac's apps add none; 3% allowed.
    'app_fling_share': (None, 0.03),
}

# Which checks apply to which gesture (by name prefix).
GLIDES = ('flick', 'fast-flick', 'medium-scroll', 'martin-', 'double-flick', 'quick-reflick')
REFLICKS = ('double-flick', 'quick-reflick')
SLOW = ('slow-scroll', 'tiny-move')
CANCELS = ('flick-touch-stop',)

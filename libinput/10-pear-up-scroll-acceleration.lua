-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Pear Up: scrolling with two fingers on a touchpad, accelerated as macOS does.
--
-- libinput scrolls by a fixed amount for every millimetre two fingers travel,
-- about 10.5 scroll units, however slowly or quickly they go. macOS scrolls a
-- slow movement much less than a quick one, so a page can be nudged a line at a
-- time and still be flung to the end. This plugin gives libinput macOS's curve.
--
-- A libinput plugin (libinput 1.30 and later, see "Lua Plugins" in its
-- documentation) sees each frame of events the touchpad sends before libinput
-- does, and may rewrite it. While exactly two fingers move together, this one
-- scales the movement they share by a gain that depends on how fast they go,
-- and moves both fingers' reported positions by the difference. libinput's
-- two-finger scrolling follows the average movement of the fingers, so it
-- follows the gain; nothing else in libinput is changed or reimplemented.
--
-- The curve is macOS's own. Its trackpad scrolling runs through
-- IOHIDPointerScrollFilter (IOHIDFamily, open source): a speed from the last
-- nine events looked up in the acceleration table the trackpad driver
-- publishes. Played through that code with a MacBook Air's table at its default
-- setting (HIDTrackpadScrollAcceleration 0.3125), the scroll for each
-- millimetre of finger travel, as a share of what it is at 80 mm/s, is
--
--   mm/s    3    5    8    10   15   20   30   40   60   80   120  160+
--   share  .13  .19  .37  .43  .56  .64  .76  .84  .94   1   1.06 1.08
--
-- which CURVE below holds. (macOS's table flattens out past 160 mm/s, where its
-- momentum takes over; this curve stays at 1.08 there.) SPEED is how far that
-- is at 80 mm/s, as a share of libinput's own rate: on a MacBook Air the page
-- moves about 8.8 points per millimetre there, and GNOME's apps on a 13-inch 2x
-- screen move 26 pixels of about the same size, so 0.34 scrolls as far as on a
-- Mac. Pear Up's preferences write the speed chosen there into its line.
--
-- What is left alone:
--   - one finger, three or more, a palm, and anything while the touchpad is
--     pressed down: pointer motion, swipes and click-dragging are as libinput
--     makes them;
--   - fingers in the bottom 10 mm (or 15%, if taller), where the clickpad's
--     button areas and libinput's thumb detection are;
--   - the first START_MM of a two-finger touch. libinput waits for a finger to
--     move a millimetre before it decides between scrolling and a pinch, and
--     scrolls none of that; slowed down, that millimetre would take longer to
--     cover and a slow scroll would start late;
--   - movement the fingers do not share. Only the common part is scaled, and
--     only as far as the fingers move alike, so a pinch, a rotation or one
--     finger resting while the other moves are passed through as they are;
--   - a touch that began before libinput opened the touchpad, and the first
--     finger after it until its slot is named (the kernel names a slot only
--     when it changes; a second finger names it within a frame or two);
--   - anything but a touchpad.
--
-- Momentum after the fingers lift is the apps' own (GTK, Chromium and Firefox
-- each run one), and starts from the speed the fingers had, so this curve
-- shapes it too. Unless the Mac scroll engine below is switched on (ENGINE),
-- which paces the fingers and glides itself, the same for every app.
--
-- A finger keeps the offset it has gathered until it lifts, so that when the
-- second finger lifts first the pointer does not jump. Fractions of a device
-- unit are carried in the offset rather than rounded away, and no position is
-- ever reported outside the touchpad's range.
--
-- If anything here raises an error, libinput unloads the plugin and the
-- touchpad scrolls as it would without it until the next login.
--
-- Installed by Pear Up's preferences (Keyboard page, Trackpad group) into
-- ~/.config/libinput/plugins, where GNOME 50's compositor loads it at login.
-- Switching it off there removes this file.

-- The speed chosen in Pear Up's preferences: the gain at 80 mm/s, where the
-- curve is 1. 1 is libinput's own rate there, 0.34 a MacBook's.
local SPEED = 0.7

-- Whether the Mac scroll engine is on (see "The Mac scroll engine" below), as
-- Pear Up's preferences write it. Experimental. With it on, SPEED rests and
-- the plugin scrolls at a MacBook's speed (ENGINE_SPEED).
local ENGINE = false

-- { mm/s, share of the 80 mm/s rate }, from the table above; linear between,
-- the last value beyond the last point.
local CURVE = {
    { 0, 0.08 }, { 3, 0.13 }, { 5, 0.19 }, { 8, 0.37 }, { 10, 0.43 }, { 15, 0.56 },
    { 20, 0.64 }, { 30, 0.76 }, { 40, 0.84 }, { 60, 0.94 }, { 80, 1 }, { 120, 1.06 },
    { 160, 1.08 },
}
local WINDOW = 70000        -- µs the speed is measured over: macOS's nine events
local START_MM = 1.2        -- see "What is left alone"
local SWIPE_TIMEOUT = 150000 -- µs: libinput's DEFAULT_GESTURE_SWIPE_TIMEOUT (accelerate())
local DECIDE_MARGIN = 0.05   -- mm past libinput's 1.5 mm, for its own rounding
local BOTTOM_MM = 10        -- the clickpad's button areas...
local BOTTOM_SHARE = 0.15   -- ...or libinput's thumb zone, whichever is taller
local ALIKE_FROM = 0.3      -- see together()
local ALIKE_FULLY = 0.8
local MAX_EVENTS = 64       -- libinput drops events past this many in a frame
local MT_TOOL_PALM = 2

local ABS_MT_SLOT = evdev.ABS_MT_SLOT
local ABS_MT_TRACKING_ID = evdev.ABS_MT_TRACKING_ID
local ABS_MT_POSITION_X = evdev.ABS_MT_POSITION_X
local ABS_MT_POSITION_Y = evdev.ABS_MT_POSITION_Y
local ABS_MT_TOOL_TYPE = evdev.ABS_MT_TOOL_TYPE
local BTN_LEFT = evdev.BTN_LEFT
-- These say three, four or five fingers are down, also on a touchpad with
-- fewer slots than that.
local MORE_FINGERS = {
    [evdev.BTN_TOOL_TRIPLETAP] = true,
    [evdev.BTN_TOOL_QUADTAP] = true,
    [evdev.BTN_TOOL_QUINTTAP] = true,
}

-- The arithmetic is kept apart from libinput, in this table, so that
-- tests/libinput/check-scroll-acceleration.lua can drive it with frames of its
-- own.
local M = {}

local function smoothstep(t)
    if t <= 0 then
        return 0
    elseif t >= 1 then
        return 1
    end
    return t * t * (3 - 2 * t)
end

-- The gain for fingers moving at `speed` mm/s, at the speed setting `level`.
function M.gain(speed, level)
    local share = CURVE[#CURVE][2]
    for i = 2, #CURVE do
        local x1, y1 = CURVE[i][1], CURVE[i][2]
        if speed <= x1 then
            local x0, y0 = CURVE[i - 1][1], CURVE[i - 1][2]
            share = y0 + (y1 - y0) * math.max(speed - x0, 0) / (x1 - x0)
            break
        end
    end
    return (level or SPEED) * share
end

-- How far two fingers that moved by (ax, ay) and (bx, by) mm moved as one,
-- from 0 to 1. It is their dot product over the longer movement's square: 1
-- for the same movement, falling with the angle between them and with the
-- shorter one's length, and below 0 for opposite ones. Fingers scrolling
-- together are never quite alike, so from ALIKE_FULLY up it counts as fully
-- together, and below ALIKE_FROM — a finger resting, or moving across or
-- against the other — not at all.
function M.together(ax, ay, bx, by)
    local longest = math.max(ax * ax + ay * ay, bx * bx + by * by)
    if longest < 0.0025 then
        return 0 -- neither moved 0.05 mm: nothing to judge by
    end
    local alike = (ax * bx + ay * by) / longest
    return smoothstep((alike - ALIKE_FROM) / (ALIKE_FULLY - ALIKE_FROM))
end

-- The state of one touchpad, from the absinfo of its two position axes.
-- Without a resolution there are no millimetres to measure speed in, and the
-- touchpad is left alone.
function M.touchpad(absx, absy, level)
    if not absx or not absy or (absx.resolution or 0) <= 0 or (absy.resolution or 0) <= 0 then
        return nil
    end
    local height = (absy.maximum - absy.minimum) / absy.resolution
    local zone = math.max(BOTTOM_MM, height * BOTTOM_SHARE)
    return {
        xmin = absx.minimum, xmax = absx.maximum, xres = absx.resolution,
        ymin = absy.minimum, ymax = absy.maximum, yres = absy.resolution,
        bottom = absy.maximum - zone * absy.resolution,
        level = level or SPEED,
        -- The slot the kernel last selected. Frames only say when it changes,
        -- so until one has, which finger an event belongs to is not known
        -- (unnamed_event()).
        slot = nil,
        unnamed = nil,   -- the finger in that slot, until it is named
        slots = {},
        button = false,
        more = {},
        touches = 0,     -- counts touches, so a finger can be told from the next
        pair = nil,      -- the two touches the history belongs to
        history = {},
        start = nil,     -- where they were when they came down together
        started = false, -- whether they have moved START_MM since
        speed = 0,       -- how fast the two moved together last, mm/s
        keys = {},       -- the kernel's keys, as last sent
    }
end

local function slot_state(tp, slot)
    local f = tp.slots[slot]
    if not f then
        -- x, y: where the kernel says the finger is. ox, oy: what this plugin
        -- adds to that. sentx, senty: what libinput was last told.
        f = { down = false, touch = 0, ox = 0, oy = 0 }
        tp.slots[slot] = f
    end
    return f
end

-- The first finger after libinput opens the touchpad. The kernel names a slot
-- only when it changes and starts where it last was, so the first touch (just
-- after login, or on a new device) often comes without one. It is followed
-- here, apart from the slots, and left alone. Once a slot is named, an event
-- for a finger already down in a slot never seen to begin a touch is that
-- finger (the kernel has come back to its slot, naming it): it joins the
-- slots and is shaped like any other from then on. A new touch is not it.
local function unnamed_event(tp, usage, value)
    if usage == ABS_MT_TRACKING_ID then
        if value >= 0 then
            tp.touches = tp.touches + 1
            tp.unnamed = { down = true, touch = tp.touches, ox = 0, oy = 0, id = value }
        else
            tp.unnamed = nil
        end
    elseif tp.unnamed then
        tp.unnamed[usage == ABS_MT_POSITION_X and "x" or "y"] = value
    end
end

local function name_unnamed(tp, slot, new_touch)
    local u = tp.unnamed
    if not u or new_touch then
        return
    end
    local f = tp.slots[slot]
    if f and f.id ~= nil then
        return
    end
    tp.unnamed = nil
    tp.slots[slot] = u
end

local function clamp_offset(f, axis, low, high)
    local want = f[axis] + f["o" .. axis]
    if want < low then
        f["o" .. axis] = low - f[axis]
    elseif want > high then
        f["o" .. axis] = high - f[axis]
    end
end

-- Scales what the two fingers a and b moved in this frame together. a0 and b0
-- are where they were before it.
local function accelerate(tp, a, b, a0, b0, time)
    local history = tp.history
    history[#history + 1] = { time, a.x / tp.xres, a.y / tp.yres, b.x / tp.xres, b.y / tp.yres }
    -- One sample at or before the start of the window stays, to measure from.
    while #history > 2 and history[2][1] <= time - WINDOW do
        table.remove(history, 1)
    end
    local first, last = history[1], history[#history]
    local span = time - first[1]
    if span <= 0 then
        return -- just put down: no speed yet
    end

    local ax, ay = last[2] - first[2], last[3] - first[3]
    local bx, by = last[4] - first[4], last[5] - first[5]
    local cx, cy = (ax + bx) / 2, (ay + by) / 2
    local speed = math.sqrt(cx * cx + cy * cy) / span * 1000000
    tp.speed = speed
    tp.vel = { cx / span * 1000000, cy / span * 1000000 } -- mm/s, the fingers alone
    -- Until one finger has moved START_MM, libinput is still deciding what
    -- the fingers do, and is left to.
    if not tp.started then
        local s = tp.start
        if tp.engine then
            -- With the engine, exactly as long as libinput takes to decide
            -- (evdev-mt-touchpad-gestures.c, tp_gesture_detect_motion_gestures):
            -- a finger 1 mm from where it came down once 150 ms have passed
            -- since the two did (DEFAULT_GESTURE_SWIPE_TIMEOUT), and before
            -- that both 1.5 mm, the same way. Scaled down sooner, the fingers
            -- would take that much longer to get there and the scroll start
            -- late (5-14 ms on a flick); what passes unscaled is given back
            -- through the curve (engine_frame()), as libinput never scrolls it.
            local da = math.sqrt(((a.x - s[1]) / tp.xres) ^ 2 + ((a.y - s[2]) / tp.yres) ^ 2)
            local db = math.sqrt(((b.x - s[3]) / tp.xres) ^ 2 + ((b.y - s[4]) / tp.yres) ^ 2)
            local early = time - (tp.since or time) < SWIPE_TIMEOUT
            if (early and math.min(da, db) < 1.5 + DECIDE_MARGIN) or (not early and math.max(da, db) < 1.0) then
                return
            end
        else
            local da = math.max(math.abs(a.x - s[1]) / tp.xres, math.abs(a.y - s[2]) / tp.yres)
            local db = math.max(math.abs(b.x - s[3]) / tp.xres, math.abs(b.y - s[4]) / tp.yres)
            if math.max(da, db) < START_MM then
                return
            end
        end
        tp.started = true
    end
    local gain = 1 + (M.gain(speed, tp.level) - 1) * M.together(ax, ay, bx, by)

    -- This frame's movement, shared out evenly: the scroll libinput makes is
    -- their average, and the distance and angle between them stay the same.
    local dx, dy = 0, 0
    if a0 and a0.touch == a.touch then
        dx, dy = dx + a.x - a0.x, dy + a.y - a0.y
    end
    if b0 and b0.touch == b.touch then
        dx, dy = dx + b.x - b0.x, dy + b.y - b0.y
    end
    local shiftx, shifty = (gain - 1) * dx / 2, (gain - 1) * dy / 2
    a.ox, a.oy = a.ox + shiftx, a.oy + shifty
    b.ox, b.oy = b.ox + shiftx, b.oy + shifty
end

-- The Mac scroll engine (experimental, ENGINE above; off unless switched on in
-- Pear Up's preferences). macOS makes the whole scroll stream itself, the same
-- for every app: while the fingers touch, one smooth step per screen frame;
-- after they lift, a glide of its own (its "momentum phase"); and only then is
-- the gesture over. On Linux libinput hands on whatever the touchpad reports,
-- about every 7 ms, which against a 120 Hz screen lands one report in most
-- frames and two in every fifth, and each app then glides on its own terms
-- (GTK from a 150 ms average, Chromium from the speed before its scale, Electron
-- and GTK 3 hardly). The engine makes the stream here instead, below every app:
--
--   - Paced: while two fingers scroll, libinput is told where they are on a
--     fixed beat of TICK, four times a 120 Hz frame, at a point DELAY behind
--     the touchpad and drawn between its last two reports, so every frame gets
--     the same share of the movement. Places stay whole touchpad units, as
--     the touchpad's own absinfo says; what rounding takes from one step is
--     carried into the next, and the second finger makes up what it took
--     from the first. (Finer units declared through set_absinfo would be
--     smoother at a crawl, but libinput keeps a changed absinfo if it ever
--     unloads the plugin, and the pointer would then move at a fraction of
--     its speed until the next login: not worth it.)
--   - Start: libinput scrolls nothing until a finger has moved a millimetre;
--     once both have moved KICK_FROM alike they are shown to have moved
--     KICK_TO, which libinput spends on that decision, so a slow scroll
--     starts nearly at once, as on a Mac. Only once the fingers have been
--     down longer than libinput's tap timeout, so a two-finger tap that
--     drifts still clicks; a scroll that starts at once starts as libinput's.
--   - Speed: with the engine on the plugin scrolls as far as a MacBook
--     (ENGINE_SPEED), whatever the speed line says: the faster speeds were
--     there to make up for the apps' short glides.
--   - Glide: when the fingers lift at MOMENTUM_FROM or faster, libinput is
--     told they are still there, moving on as a MacBook Air glides (measured
--     on one with an AppKit probe, 9 flicks, fitted): from GLIDE_START times
--     the speed of the last LIFT_WINDOW, rising GLIDE_RISE over
--     GLIDE_RISE_TIME, held until GLIDE_HOLD, then slowing with a time
--     constant of GLIDE_TAU, until GLIDE_END.
--   - Stop: then they rest STILL before libinput is told they lifted. Every
--     app works out its own glide from the last 100 to 200 ms of scrolling
--     before the stop (GTK 150 ms, Chromium 200 ms, Firefox 100 ms), so after
--     a rest longer than that each of them adds nothing: the glide is the engine's
--     alone, and the same in every app. A slow lift rests too, for the same
--     reason, so no app glides where a Mac would not.
--   - Touch: a finger put down during the glide or the rest stops it (within
--     GRACE), as on a Mac, and is not shown to libinput yet. If it becomes two fingers
--     in the same slots, they take over the resting ones and the scroll goes
--     on as one gesture: the glide runs on under the first finger for GRACE,
--     and under the two it fades with CARRY_TAU while they get going, so the
--     page does not stall between them. A finger that points (POINTER_MM) or presses ends
--     the resting fingers and is handed to libinput as it is at once (its
--     quick hold then stops whatever glide an app starts); one that only
--     rests is handed over once the resting fingers have been still STILL.
--     A tap that only stops the glide reaches no app.
--   - Edges: a glide goes further than the touchpad is long. When the resting
--     fingers come within EDGE_MM of an edge they are moved back across it in
--     one frame that carries nothing else. libinput takes a move that large as
--     the touchpad jumping and scrolls nothing for it (evdev-mt-touchpad.c,
--     tp_detect_jumps: over 20 mm in 12 ms), and logs it as a kernel bug, at
--     most five times a day (its own rate limit).
--
-- Rubber-banding at the end of a page is left to the apps: they see fingers
-- scrolling past the end, as they would with real ones.
local TICK = 1000000 / 480   -- µs: 4 reports a frame at 120 Hz, 8 at 60
local DELAY = 9000           -- µs the paced fingers trail the touchpad's reports
local DELAY_RAMP = 100000    -- µs over which they fall back to DELAY once scrolling (catch_up())
local LIFT_WINDOW = 50000    -- µs the speed at lift is measured over
local MOMENTUM_FROM = 28     -- mm/s of the fingers (before the curve) for a glide
local GLIDE_START = 1.30     -- the glide's speed as it starts, over the lift speed
local GLIDE_RISE = 0.10      -- how much faster it gets...
local GLIDE_RISE_TIME = 50000 -- ...over this many µs
local GLIDE_HOLD = 120000    -- µs after the lift it holds its speed
local GLIDE_TAU = 200000     -- µs, the time constant it slows down with after
local GLIDE_END = 1.5        -- mm/s at which it ends
local STILL = 260000         -- µs the fingers rest before libinput lets them lift (Chromium: 200)
local FROZEN_MAX = 100000    -- µs a new finger has to become a scroll
local POINT_MM = 0.3         -- a new single finger moved this far points: the pad is its at once
local ADOPT_MM = 0.3         -- two new fingers moved this far alike take a glide over
local DECIDE = 50000         -- µs a glide runs on under two new fingers before they hold it
local TAP_MM = 1.3           -- libinput's tap motion limit (DEFAULT_TAP_MOVE_THRESHOLD)
local POINTER_MM = 1.5       -- a finger moved this far points
local LEFTOVER_MAX = 300000  -- µs a finger left down after a lift is ignored
local EDGE_MM = 6            -- how near an edge the resting fingers go
local JUMP_MIN_MM = 20       -- the smallest move back libinput surely ignores
local JUMP_FRESH = 10000     -- µs: a finger moved longer ago than this is not moved back
local STEP_GROWTH = 0.8      -- mm a paced step may be longer than the one before
local STEP_MAX = 3           -- mm a paced step may be at most
local JUMP_SAFE = 0.7        -- share of libinput's jump limits a paced step may use (pace())
local ENGINE_SPEED = 0.34    -- the engine scrolls as far as a MacBook (the speed setting is for apps that glide on their own)
local CARRY_TAU = 220000     -- µs: a glide carried into new fingers fades with this
local KICK_FROM = 0.5        -- mm two fingers move alike before libinput is helped past its millimetre
local TAP_TIMEOUT = 190000   -- µs: libinput's tap timeout (180 ms) and a margin; no help before
local KICK_TO = 1.05         -- mm a finger is shown to have moved, past libinput's 1 mm but within its
                             -- 1.3 mm tap limit (evdev-mt-touchpad-tap.c), so a two-finger tap still clicks
local GRACE = 8000           -- µs a glide runs on under a new touch, for a second finger to join it
M.ENGINE_SPEED = ENGINE_SPEED

local EV_KEY = 1

-- The next tick on the beat after `t`: the beat is kept, whatever arrives in
-- between, so that each frame gets the same number of steps.
local function grid(t)
    local g = math.floor(t / TICK + 1) * TICK
    -- TICK is not a whole number of µs: on a beat, t / TICK can round down.
    if g <= t then
        g = g + TICK
    end
    return g
end

-- A place on a finger's path at time `t`, drawn between the points either side.
local function at(path, t)
    local n = #path
    if n == 0 then
        return nil
    end
    if t <= path[1][1] then
        return path[1][2], path[1][3]
    end
    for i = n - 1, 1, -1 do
        local p, q = path[i], path[i + 1]
        if t >= p[1] then
            if t >= q[1] then
                return q[2], q[3]
            end
            local s = (t - p[1]) / (q[1] - p[1])
            return p[2] + (q[2] - p[2]) * s, p[3] + (q[3] - p[3]) * s
        end
    end
    return path[n][2], path[n][3]
end

-- Drops the points of a path that are no longer needed to draw time `t`.
local function trim(path, t)
    while #path > 2 and path[2][1] <= t do
        table.remove(path, 1)
    end
end

-- How fast the glide goes `t` µs after the lift, as a share of where it began.
function M.glide(t)
    if t < GLIDE_HOLD then
        return 1 + GLIDE_RISE * smoothstep(t / GLIDE_RISE_TIME)
    end
    return (1 + GLIDE_RISE * smoothstep(GLIDE_HOLD / GLIDE_RISE_TIME)) * math.exp(-(t - GLIDE_HOLD) / GLIDE_TAU)
end

function M.engine(tp)
    tp.engine = {
        mode = "idle",   -- idle, contact (paced), glide, still, frozen
        slots = nil,     -- the two slots libinput is told about
        path = {},       -- slot: { {time, x, y}, ... } in device units
        outf = {},       -- slot: { x, y } paced so far, before rounding
        delay = DELAY,   -- µs the paced fingers are drawn behind (catch_up())
        lastframe = nil, -- when libinput last had a frame from the touchpad
        lastnorm = {},   -- slot: its last paced step as libinput measures it (mm per 12 ms)
        view = {},       -- slot: { x, y } as libinput was last told
        moved = {},      -- slot: when libinput last saw it move
        keys = {},       -- the keys libinput was last told about
        prepend = {},    -- frames to go before the current one
        timer = nil,     -- when the plugin wants its timer
    }
    return tp.engine
end

local function copy(t)
    local c = {}
    for k, v in pairs(t) do
        c[k] = v
    end
    return c
end

local function mm_speed(tp, vx, vy)
    return math.sqrt((vx / tp.xres) ^ 2 + (vy / tp.yres) ^ 2) * 1000000
end

local function clampv(v, low, high)
    return math.max(low, math.min(high, v))
end

-- How far behind the touchpad's reports the paced fingers are drawn. A touch
-- starts with none: until libinput has decided the fingers scroll, every
-- millisecond behind would be a millisecond later to the first scroll, and
-- nothing is on screen to be smoothed. From the touchpad's report after
-- libinput's decision (the one its first scroll comes with: the report it
-- decides on only starts the scroll) the fingers fall back to DELAY over
-- DELAY_RAMP, drawn 9 % slower for that
-- tenth of a second, and stay there. It never shrinks within a touch, so the
-- paced fingers never go back.
local function catch_up(tp, e, now)
    if e.ramp and e.delay < DELAY then
        e.delay = math.min(DELAY, e.delay + (now - (e.delay_t or now)) * DELAY / DELAY_RAMP)
    end
    e.delay_t = now
end

-- Appends what libinput should be told now about the paced fingers to
-- `events`, and returns whether anything moved.
local function pace(tp, e, now, events)
    local q = now - e.delay
    local a, b = e.slots[1], e.slots[2]
    local ax, ay = at(e.path[a], q)
    local bx, by = at(e.path[b], q)
    if not ax or not bx then
        return false
    end
    trim(e.path[a], q - LIFT_WINDOW)
    trim(e.path[b], q - LIFT_WINDOW)
    -- Not faster than libinput takes for real movement: it drops a step of
    -- more than 20 mm per 12 ms, or 7 mm per 12 ms more than the one before,
    -- as the touchpad jumping. Should the touchpad's reports come late, the
    -- fingers catch up over a few steps.
    local fa, fb = e.outf[a], e.outf[b]
    local dax, day, dbx, dby = ax - fa[1], ay - fa[2], bx - fb[1], by - fb[2]
    local la = math.sqrt((dax / tp.xres) ^ 2 + (day / tp.yres) ^ 2)
    local lb = math.sqrt((dbx / tp.xres) ^ 2 + (dby / tp.yres) ^ 2)
    local len = math.max(la, lb)
    local limit = math.min((e.step or 0) + STEP_GROWTH, STEP_MAX)
    local share = len > limit and limit / len or 1
    -- And as libinput measures it (tp_detect_jumps): a touch's move over the
    -- time since the last frame libinput had from this touchpad, any frame,
    -- the touchpad's own included, scaled to 12 ms. A step just after a
    -- touchpad report is measured over that sliver of time, so it may only
    -- be as long as the sliver allows.
    local dt = now - (e.lastframe or 0)
    if dt > 0 and dt <= 30000 then
        for _, f in ipairs({ { la, a }, { lb, b } }) do
            local l, slot = f[1], f[2]
            if l > 0 then
                local nmax = math.min(20, (e.lastnorm[slot] or 0) + 7) * JUMP_SAFE
                local lmax = nmax * dt / 12000
                if l * share > lmax then
                    share = lmax / l
                end
            end
        end
    end
    local jumped = e.jumped
    if e.jumped then
        share, e.jumped = 0, nil
    end
    e.step = len * share
    fa[1], fa[2] = fa[1] + dax * share, fa[2] + day * share
    fb[1], fb[2] = fb[1] + dbx * share, fb[2] + dby * share
    ax, ay, bx, by = fa[1], fa[2], fb[1], fb[2]
    -- As in M.frame: the second finger makes up what rounding took from the
    -- first, so their sum, which libinput scrolls by, is within half a unit.
    -- (From the first finger's rounded place before it is held inside the
    -- touchpad: should it reach an edge, the second must not make up for
    -- that too, or it leaps by as much.)
    local out = {}
    local rx, ry = math.floor(ax + 0.5), math.floor(ay + 0.5)
    out[a] = { clampv(rx, tp.xmin, tp.xmax), clampv(ry, tp.ymin, tp.ymax) }
    out[b] = {
        clampv(math.floor(ax + bx + 0.5) - rx, tp.xmin, tp.xmax),
        clampv(math.floor(ay + by + 0.5) - ry, tp.ymin, tp.ymax),
    }
    local moved = false
    for _, slot in ipairs(e.slots) do
        local v = e.view[slot]
        local o = out[slot]
        -- What libinput will measure this step as (what it was let through,
        -- held at the edges), for the next step's limit; it measures only a
        -- finger that moved. (After a recentring, a jump to it, 0 is the
        -- safe side.)
        if jumped then
            e.lastnorm[slot] = 0
        elseif dt > 0 and dt <= 30000 and (v[1] ~= o[1] or v[2] ~= o[2]) then
            e.lastnorm[slot] = math.sqrt(((o[1] - v[1]) / tp.xres) ^ 2 + ((o[2] - v[2]) / tp.yres) ^ 2) * 12000 / dt
        end
        if v[1] ~= o[1] or v[2] ~= o[2] then
            events[#events + 1] = { usage = ABS_MT_SLOT, value = slot }
            if v[1] ~= o[1] then
                events[#events + 1] = { usage = ABS_MT_POSITION_X, value = o[1] }
            end
            if v[2] ~= o[2] then
                events[#events + 1] = { usage = ABS_MT_POSITION_Y, value = o[2] }
            end
            v[1], v[2] = o[1], o[2]
            e.moved[slot] = now
            moved = true
        end
    end
    return moved
end

-- Moves the resting fingers' paths back across the touchpad when the next
-- step would bring one within EDGE_MM of an edge. Only while both moved in
-- the last JUMP_FRESH, so that libinput measures the move over a few ms.
local function recentre(tp, e, now, vx, vy)
    local lo = { x = tp.xmin + EDGE_MM * tp.xres, y = tp.ymin + EDGE_MM * tp.yres }
    local hi = { x = tp.xmax - EDGE_MM * tp.xres, y = tp.bottom - EDGE_MM * tp.yres }
    local v = { x = vx, y = vy }
    local res = { x = tp.xres, y = tp.yres }
    for axis, index in pairs({ x = 2, y = 3 }) do
        if v[axis] ~= 0 then
            local least, most = math.huge, -math.huge
            for _, slot in ipairs(e.slots) do
                local path = e.path[slot]
                local p = path[#path][index]
                least, most = math.min(least, p), math.max(most, p)
            end
            local shift = 0
            if v[axis] < 0 and least < lo[axis] then
                shift = hi[axis] - most
            elseif v[axis] > 0 and most > hi[axis] then
                shift = lo[axis] - least
            end
            local fresh = true
            for _, slot in ipairs(e.slots) do
                fresh = fresh and (e.moved[slot] or 0) >= now - JUMP_FRESH
            end
            if math.abs(shift) >= JUMP_MIN_MM * res[axis] and fresh then
                for _, slot in ipairs(e.slots) do
                    for _, p in ipairs(e.path[slot]) do
                        p[index] = p[index] + shift
                    end
                    e.outf[slot][index - 1] = e.outf[slot][index - 1] + shift
                end
                -- libinput drops the whole frame of the jump, so it carries
                -- nothing else: the step it would have made comes after.
                e.jumped = true
            end
        end
    end
end

-- The frame that lifts the resting fingers for libinput.
local function lift_frame(tp, e)
    local frame = {}
    for _, slot in ipairs(e.slots) do
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = slot }
        frame[#frame + 1] = { usage = ABS_MT_TRACKING_ID, value = -1 }
    end
    for usage, value in pairs(e.keys) do
        if value ~= 0 then
            frame[#frame + 1] = { usage = usage, value = 0 }
        end
    end
    if tp.slot then
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
    end
    e.keys, e.slots, e.path, e.view, e.moved = {}, nil, {}, {}, {}
    e.mode = "idle"
    return frame
end

-- The frame that puts down for libinput the fingers that are on the touchpad
-- now, where they are, with the keys the kernel has down.
local function touch_frame(tp, e)
    local frame = {}
    local order = {}
    for slot, f in pairs(tp.slots) do
        if f.down and f.x and f.y and f.id then
            order[#order + 1] = slot
        end
    end
    table.sort(order)
    for _, slot in ipairs(order) do
        local f = tp.slots[slot]
        f.ox, f.oy = 0, 0
        f.sentx, f.senty = f.x, f.y
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = slot }
        frame[#frame + 1] = { usage = ABS_MT_TRACKING_ID, value = f.id }
        frame[#frame + 1] = { usage = ABS_MT_POSITION_X, value = f.x }
        frame[#frame + 1] = { usage = ABS_MT_POSITION_Y, value = f.y }
    end
    -- The pad's button comes in a frame of its own, after the fingers: with
    -- button areas libinput decides which button by where the fingers are,
    -- so they must be down first.
    local press = nil
    for usage, value in pairs(tp.keys) do
        if value ~= 0 then
            if usage == BTN_LEFT then
                press = { { usage = BTN_LEFT, value = value } }
            else
                frame[#frame + 1] = { usage = usage, value = value }
            end
        end
    end
    if tp.slot then
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
    end
    e.keys = copy(tp.keys)
    tp.pair, tp.history = nil, {}
    return frame, press
end

-- libinput scrolls nothing until a finger has moved about a millimetre
-- (evdev-mt-touchpad-gestures.c: "both touches moved less than a mm"), which a
-- slow scroll takes 60 ms and more to cover; a Mac moves the page in the first
-- frame. Once both fingers have moved KICK_FROM alike, libinput is shown them
-- moved KICK_TO at once, which it spends on that decision and scrolls nothing
-- for; what they really moved is then given back through the curve. KICK_TO
-- is under libinput's tap limit (DEFAULT_TAP_MOVE_THRESHOLD, 1.3 mm from where
-- each touch came down), so a two-finger tap that drifts is still a tap.
local function kick(tp, e, time)
    local a, b = tp.slots[e.slots[1]], tp.slots[e.slots[2]]
    local s = tp.start
    if not s or not a.x or not b.x then
        return
    end
    local ax, ay = (a.x - s[1]) / tp.xres, (a.y - s[2]) / tp.yres
    local bx, by = (b.x - s[3]) / tp.xres, (b.y - s[4]) / tp.yres
    local la, lb = math.sqrt(ax * ax + ay * ay), math.sqrt(bx * bx + by * by)
    -- Not while libinput may still take the touch for a tap: a two-finger tap
    -- lifts within its tap timeout (DEFAULT_TAP_TIMEOUT_PERIOD, 180 ms), and
    -- a kick, added to a finger drifting on, could carry it past the tap's
    -- 1.3 mm. Fingers down longer than that are a scroll or a rest.
    if la < KICK_FROM or lb < KICK_FROM or time - e.since < TAP_TIMEOUT then
        return
    end
    e.kicked = true
    if (ax * bx + ay * by) / (la * lb) < 0.8 then
        return -- not alike: a pinch or a turn, libinput's to decide
    end
    local dx, dy = (ax + bx) / 2, (ay + by) / 2
    local l = math.sqrt(dx * dx + dy * dy)
    local more = KICK_TO - math.max(la, lb)
    if more <= 0 then
        return -- libinput has decided already
    end
    local kx, ky = dx / l * more * tp.xres, dy / l * more * tp.yres
    -- What the fingers moved before libinput decided, which it will never
    -- scroll: given again after it, through the curve, over the next steps.
    local g = M.gain(tp.speed or 0, tp.level)
    local px, py = dx * g * tp.xres, dy * g * tp.yres
    for _, slot in ipairs(e.slots) do
        for _, p in ipairs(e.path[slot] or {}) do
            p[2], p[3] = p[2] + kx, p[3] + ky
        end
    end
    e.coff = { e.coff[1] + kx + px, e.coff[2] + ky + py }
    -- libinput scrolls from here on, so the curve applies from here on.
    tp.started = true
end

-- A glide that new fingers took over keeps going under them, fading with
-- CARRY_TAU, less what the fingers themselves already move along it, so the
-- page does not stall while they get going. Fingers moving against it end it.
local function carry(tp, e, now)
    local c = e.carry
    local dt = now - c.last
    c.last = now
    local len = math.sqrt(c[1] * c[1] + c[2] * c[2])
    if len <= 0 or dt <= 0 then
        return
    end
    local ux, uy = c[1] / len, c[2] / len
    -- How fast the fingers themselves go along it, after the curve, in
    -- units a µs (their path also holds the carry, so not from that).
    local along = 0
    if tp.vel then
        local g = M.gain(tp.speed or 0, tp.level)
        along = (tp.vel[1] * tp.xres * ux + tp.vel[2] * tp.yres * uy) * g / 1000000
    elseif c.fingers then
        along = c.fingers[1] * ux + c.fingers[2] * uy
    end
    local fading = len * math.exp(-(now - c.t0) / CARRY_TAU)
    if along < -0.2 * fading or mm_speed(tp, ux * fading, uy * fading) < GLIDE_END then
        e.carry = nil
        return
    end
    local rate = math.max(0, fading - math.max(along, 0))
    e.coff = { e.coff[1] + ux * rate * dt, e.coff[2] + uy * rate * dt }
end

-- Stops the resting fingers where libinput was last told they are.
local function halt(e, time)
    if e.halted or not e.slots then
        return
    end
    e.halted = true
    for _, slot in ipairs(e.slots) do
        local o = e.outf[slot]
        e.path[slot] = { { time - e.delay, o[1], o[2] } }
    end
    e.step = 0
end

-- Ends the resting fingers and hands libinput the real ones.
local function release(tp, e)
    e.carry = nil
    local lifted = lift_frame(tp, e)
    local touched, press = touch_frame(tp, e)
    if #touched > (tp.slot and 1 or 0) then
        e.prepend[#e.prepend + 1] = lifted
        if press then
            e.prepend[#e.prepend + 1] = touched
            return press
        end
        return touched
    end
    if press then
        e.prepend[#e.prepend + 1] = lifted
        return press
    end
    return lifted
end

-- Two fingers that tapped while the glide ran: libinput is told the resting
-- fingers lifted, then shown the two coming down and lifting where they were,
-- in this frame, which its tap code takes as the tap it was.
local function tap_release(tp, e)
    local two = e.two
    local lifted = lift_frame(tp, e)
    local down, up = {}, {}
    local order = {}
    for slot in pairs(two) do
        order[#order + 1] = slot
    end
    table.sort(order)
    for _, slot in ipairs(order) do
        local f = two[slot]
        down[#down + 1] = { usage = ABS_MT_SLOT, value = slot }
        down[#down + 1] = { usage = ABS_MT_TRACKING_ID, value = f[1] }
        down[#down + 1] = { usage = ABS_MT_POSITION_X, value = f[2] }
        down[#down + 1] = { usage = ABS_MT_POSITION_Y, value = f[3] }
        up[#up + 1] = { usage = ABS_MT_SLOT, value = slot }
        up[#up + 1] = { usage = ABS_MT_TRACKING_ID, value = -1 }
    end
    down[#down + 1] = { usage = evdev.BTN_TOUCH, value = 1 }
    down[#down + 1] = { usage = evdev.BTN_TOOL_DOUBLETAP, value = 1 }
    up[#up + 1] = { usage = evdev.BTN_TOUCH, value = 0 }
    up[#up + 1] = { usage = evdev.BTN_TOOL_DOUBLETAP, value = 0 }
    if tp.slot then
        down[#down + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
        up[#up + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
    end
    e.prepend[#e.prepend + 1] = lifted
    e.prepend[#e.prepend + 1] = down
    e.keys = {}
    return up
end

-- The fingers on the touchpad that came after the lift (not left over from it).
local function newcomers(tp, e, time)
    local list, all = {}, 0
    for slot, f in pairs(tp.slots) do
        if f.down then
            all = all + 1
            local seen = e.seen[f.touch]
            if not seen and f.x and f.y then
                seen = { f.x, f.y, time }
                e.seen[f.touch] = seen
            end
            local new = not e.leftover[f.touch]
            if not new and seen and f.x and f.y then
                local d = math.max(math.abs(f.x - seen[1]) / tp.xres, math.abs(f.y - seen[2]) / tp.yres)
                if d > POINTER_MM or time - e.lifted > LEFTOVER_MAX then
                    e.leftover[f.touch] = nil
                    new = true
                end
            end
            if new then
                list[#list + 1] = slot
            end
        end
    end
    return list, all
end

-- While the fingers glide or rest: what a frame from the touchpad, or the
-- timer (frame nil), does. Returns the frame for libinput.
local function resting(tp, e, time, tick)
    local more = tp.button
    for _, on in pairs(tp.more) do
        more = more or on
    end
    local new, all = newcomers(tp, e, time)
    if #new > 0 and (e.mode == "glide" or e.mode == "still") then
        -- What the glide was doing, for fingers that take it over.
        e.carry = nil
        if e.mode == "glide" then
            -- As it is on screen: e.delay behind.
            local g = M.glide(time - e.delay - e.start)
            e.carry = { e.vx * g, e.vy * g }
        end
        e.mode, e.frozen, e.halted, e.window = "frozen", time, false, GRACE
        e.two, e.twosince, e.twomoved, e.twolast, e.twov = nil, nil, 0, nil, nil
        if not e.carry then
            halt(e, time)
        end
        -- Otherwise the glide runs on under the touch for a while (M.tick):
        -- GRACE for one finger, so a second landing a report later takes it
        -- over without a stall; DECIDE for two, until they move (a re-flick)
        -- or turn out to rest (a hold, which stops it) or lift (a tap).
    end
    if e.mode ~= "frozen" then
        return {}
    end
    -- Not yet halted, the glide is still being drawn: keep the beat going.
    if not e.halted then
        e.timer = math.min(e.timer or math.huge, grid(time))
    end
    if more or #new >= 3 then
        -- A click, or three fingers and more (the shell's swipes): libinput's,
        -- with the real fingers where they are.
        return release(tp, e)
    end
    if all == 0 then
        -- Lifted again. Two fingers that came down together and lifted within
        -- libinput's tap time, hardly moving, are handed to it as the tap they
        -- were (a right click with tap to click); anything else only stopped
        -- the glide.
        if e.two and time - e.twosince < TAP_TIMEOUT - 10000 and e.twomoved < TAP_MM then
            return tap_release(tp, e)
        end
        halt(e, time)
        e.mode, e.still = "still", e.frozen
        return {}
    end
    if all == 2 then
        local slots = {}
        for slot, f in pairs(tp.slots) do
            if f.down then
                slots[#slots + 1] = slot
            end
        end
        table.sort(slots)
        local a, b = tp.slots[slots[1]], tp.slots[slots[2]]
        if a.x and a.y and b.x and b.y then
            local sa = e.seen[a.touch] or { a.x, a.y, time }
            local sb = e.seen[b.touch] or { b.x, b.y, time }
            if not e.two then
                e.two, e.twosince, e.window = {}, time, DECIDE
            end
            local ax, ay = (a.x - sa[1]) / tp.xres, (a.y - sa[2]) / tp.yres
            local bx, by = (b.x - sb[1]) / tp.xres, (b.y - sb[2]) / tp.yres
            local la, lb = math.sqrt(ax * ax + ay * ay), math.sqrt(bx * bx + by * by)
            e.twomoved = math.max(e.twomoved, la, lb)
            -- Their speed over the last report, for taking a glide over.
            local cx, cy = (a.x + b.x) / 2, (a.y + b.y) / 2
            local prev = e.twolast
            if tick then
                prev = nil -- the timer: no new report, nothing to measure
            elseif prev and time > prev[1] then
                e.twov = { (cx - prev[2]) / (time - prev[1]), (cy - prev[3]) / (time - prev[1]) }
            end
            if not tick then
                e.twolast = { time, cx, cy }
            end
            for _, slot in ipairs(slots) do
                local f = tp.slots[slot]
                e.two[slot] = { f.id, f.x, f.y }
            end
            local fits = not a.palm and not b.palm and a.y < tp.bottom and b.y < tp.bottom
                and slots[1] == e.slots[1] and slots[2] == e.slots[2]
            if not fits then
                return release(tp, e)
            end
            if math.max(la, lb) < ADOPT_MM then
                -- Not moving (yet): the glide runs on for DECIDE, then stops
                -- under fingers that hold it. M.tick halts it.
                return {}
            end
            if la < ADOPT_MM / 2 or lb < ADOPT_MM / 2 or (ax * bx + ay * by) / (la * lb) < 0.8 then
                -- Not moving alike: a pinch or a turn, libinput's to tell.
                return release(tp, e)
            end
            -- They take over the resting fingers: libinput goes on seeing the
            -- same two touches, now moved by these from where the glide's
            -- path has got to, which the paced places are still catching up
            -- with.
            for _, slot in ipairs(slots) do
                local f, v = tp.slots[slot], e.view[slot]
                local path = e.path[slot]
                local last = path[#path]
                f.ox, f.oy = last[2] - f.x, last[3] - f.y
                f.sentx, f.senty = v[1], v[2]
            end
            tp.pair, tp.history, tp.vel = a.touch .. ":" .. b.touch, {}, nil
            tp.start, tp.started = { a.x, a.y, b.x, b.y }, true
            e.mode, e.pair, e.since = "contact", tp.pair, time
            e.coff, e.kicked = { 0, 0 }, true
            e.lastnorm = {}   -- libinput measured them itself until now (pace())
            e.direct = false  -- new fingers in the old ones' slots: only paced (M.frame)
            if e.carry and not e.halted then
                e.carry.t0, e.carry.last = e.frozen, time
                -- How fast they already go, until libinput's own measure of
                -- them (tp.vel) has samples: so the glide under them is not
                -- added on top of their first steps in full.
                local v = e.twov or { 0, 0 }
                local mm = math.sqrt((v[1] / tp.xres) ^ 2 + (v[2] / tp.yres) ^ 2) * 1000000
                local g = M.gain(mm, tp.level)
                e.carry.fingers = { v[1] * g, v[2] * g }
            else
                e.carry = nil
            end
            e.timer = math.min(e.timer or math.huge, grid(time))
            return {}
        end
    end
    if #new == 1 and all == 1 then
        local seen = e.seen[tp.slots[new[1]].touch]
        local f = tp.slots[new[1]]
        local d = 0
        if seen and f.x and f.y then
            d = math.max(math.abs(f.x - seen[1]) / tp.xres, math.abs(f.y - seen[2]) / tp.yres)
        end
        -- A finger that points is handed over at once (libinput's quick hold
        -- then stops what glide an app starts from the last moments of ours).
        -- One that only rests waits until the resting fingers have been still
        -- for STILL, so that no app glides at all.
        local last = e.frozen
        for _, slot in ipairs(e.slots) do
            last = math.max(last, e.moved[slot] or 0)
        end
        if d > POINT_MM or (time - e.frozen >= FROZEN_MAX and time >= last + STILL) then
            return release(tp, e)
        end
        e.timer = math.min(e.timer or math.huge, math.max(e.frozen + FROZEN_MAX, last + STILL))
        return {}
    end
    if e.frozen + FROZEN_MAX > time then
        e.timer = math.min(e.timer or math.huge, e.frozen + FROZEN_MAX)
    end
    return {}
end

-- The engine's part of M.frame, after the kernel's frame has been followed and
-- the curve applied. Returns true and the frame for libinput when it decides
-- it, or false to let M.frame write the frame (with the paced fingers' places).
local function engine_frame(tp, e, frame, time, known)
    e.prepend = {}
    if e.mode == "glide" or e.mode == "still" or e.mode == "frozen" then
        return true, resting(tp, e, time)
    end
    if e.mode == "contact" and tp.pair ~= e.pair then
        local lifted = false
        for _, slot in ipairs(e.slots) do
            lifted = lifted or not tp.slots[slot].down
        end
        local more = tp.button
        for _, on in pairs(tp.more) do
            more = more or on
        end
        if lifted and not more and tp.started and not tp.pair then
            -- The fingers lifted after scrolling: libinput is told they stay.
            local a, b = e.slots[1], e.slots[2]
            local pa, pb = e.path[a], e.path[b]
            local t1 = pa[#pa][1]
            local x1a, y1a = at(pa, t1)
            local x1b, y1b = at(pb, t1)
            local x0a, y0a = at(pa, t1 - LIFT_WINDOW)
            local x0b, y0b = at(pb, t1 - LIFT_WINDOW)
            local span = math.min(LIFT_WINDOW, t1 - e.since)
            e.leftover, e.seen, e.lifted = {}, {}, time
            for _, f in pairs(tp.slots) do
                if f.down then
                    e.leftover[f.touch] = true
                end
            end
            if span > 0 and (tp.speed or 0) >= MOMENTUM_FROM then
                local vx = (x1a + x1b - x0a - x0b) / 2 / span
                local vy = (y1a + y1b - y0a - y0b) / 2 / span
                e.vx, e.vy = vx * GLIDE_START, vy * GLIDE_START
                e.mode, e.start = "glide", time
                e.timer = math.min(e.timer or math.huge, grid(time))
            else
                e.mode, e.still = "still", time
                e.timer = time + e.delay + TICK
            end
            return true, resting(tp, e, time)
        end
        -- Anything else ends the pacing; the fingers left are libinput's,
        -- from where it was last told they are.
        for _, slot in ipairs(e.slots) do
            local f = tp.slots[slot]
            if f.down then
                f.sentx, f.senty = e.view[slot][1], e.view[slot][2]
            end
        end
        e.mode, e.slots, e.path, e.view, e.pair = "idle", nil, {}, {}, nil
        e.keys = copy(tp.keys)
        return false
    end
    if tp.pair and e.mode == "idle" then
        -- Two fingers came down together: from here they are paced.
        e.mode, e.pair, e.since, e.fresh = "contact", tp.pair, time, true
        e.delay, e.delay_t, e.ramp, e.direct = 0, time, false, true
        e.coff, e.kicked, e.carry, e.given = { 0, 0 }, false, nil, false
        e.slots = { known[1], known[2] }
        e.path, e.view, e.moved = {}, {}, {}
        e.outf, e.step, e.lastnorm = {}, 0, {}
        for _, slot in ipairs(e.slots) do
            local f = tp.slots[slot]
            e.view[slot] = { f.outx, f.outy }
            e.outf[slot] = { f.outx, f.outy }
        end
    end
    if e.mode == "contact" then
        if not e.kicked then
            kick(tp, e, time)
        end
        if tp.started and not e.kicked and not e.given then
            -- libinput decided by itself at its millimetre, which it never
            -- scrolls; a Mac scrolls from the first frame. Given back through
            -- the curve, over the next steps.
            e.given = true
            local a, b = tp.slots[e.slots[1]], tp.slots[e.slots[2]]
            local st = tp.start
            if st and a.x and b.x then
                local dx = ((a.x - st[1]) / tp.xres + (b.x - st[3]) / tp.xres) / 2
                local dy = ((a.y - st[2]) / tp.yres + (b.y - st[4]) / tp.yres) / 2
                local g = M.gain(tp.speed or 0, tp.level)
                e.coff = { e.coff[1] + dx * g * tp.xres, e.coff[2] + dy * g * tp.yres }
            end
        end
        local c = e.coff or { 0, 0 }
        for _, slot in ipairs(e.slots) do
            local f = tp.slots[slot]
            local path = e.path[slot] or {}
            e.path[slot] = path
            path[#path + 1] = {
                time,
                clampv(f.x + f.ox + c[1], tp.xmin, tp.xmax),
                clampv(f.y + f.oy + c[2], tp.ymin, tp.ymax),
            }
        end
        e.timer = math.min(e.timer or math.huge, grid(time))
    end
    e.keys = copy(tp.keys)
    return false
end

-- The timer: the paced fingers' places, and the glide. Returns the frames for
-- libinput (perhaps none).
local tick

function M.tick(tp, now)
    local frames = tick(tp, now)
    -- libinput takes the frames of the timer at now.
    if tp.engine and #frames > 0 then
        tp.engine.lastframe = now
    end
    return frames
end

tick = function(tp, now)
    local e = tp.engine
    e.timer = nil
    e.prepend = {}
    if not e.slots then
        return {}
    end
    local frames = {}
    if e.mode == "frozen" then
        local frame = resting(tp, e, now, true)
        for _, f in ipairs(e.prepend) do
            frames[#frames + 1] = f
        end
        e.prepend = {}
        if #frame > 0 then
            frames[#frames + 1] = frame
        end
        if e.mode ~= "frozen" and e.mode ~= "contact" then
            return frames
        end
    end
    if e.mode == "contact" and e.carry then
        carry(tp, e, now)
    end
    if e.mode == "frozen" and not e.halted then
        if e.carry and now < e.frozen + (e.window or GRACE) then
            for _, slot in ipairs(e.slots) do
                local path = e.path[slot]
                local last = path[#path]
                local dt = now - last[1]
                if dt > 0 then
                    path[#path + 1] = {
                        now,
                        clampv(last[2] + e.carry[1] * dt, tp.xmin, tp.xmax),
                        clampv(last[3] + e.carry[2] * dt, tp.ymin, tp.ymax),
                    }
                end
            end
        else
            halt(e, now)
        end
    end
    if e.mode == "glide" then
        local f = M.glide(now - e.start)
        local vx, vy = e.vx * f, e.vy * f
        if mm_speed(tp, vx, vy) < GLIDE_END then
            e.mode, e.still = "still", now
        else
            recentre(tp, e, now, vx, vy)
            for _, slot in ipairs(e.slots) do
                local path = e.path[slot]
                local last = path[#path]
                local dt = now - last[1]
                if dt > 0 then
                    path[#path + 1] = {
                        now,
                        clampv(last[2] + vx * dt, tp.xmin, tp.xmax),
                        clampv(last[3] + vy * dt, tp.ymin, tp.ymax),
                    }
                end
            end
        end
    end
    if e.mode == "contact" then
        catch_up(tp, e, now)
    end
    local events = {}
    pace(tp, e, now, events)
    if #events > 0 then
        if tp.slot then
            events[#events + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
        end
        frames[#frames + 1] = events
    end
    -- When to come back.
    local pending = false
    for _, slot in ipairs(e.slots or {}) do
        local path = e.path[slot]
        pending = pending or (#path > 0 and path[#path][1] > now - e.delay)
    end
    if e.mode == "contact" or e.mode == "glide" or pending then
        e.timer = math.max(grid(now), now + TICK / 2)
    elseif e.mode == "still" then
        -- Lift once both have rested STILL, and not before the glide or the
        -- rest began.
        local last = e.still
        for _, slot in ipairs(e.slots) do
            last = math.max(last, e.moved[slot] or 0)
        end
        if now >= last + STILL then
            frames[#frames + 1] = lift_frame(tp, e)
            return frames
        end
        e.timer = last + STILL
    end
    -- Back when the touch is to be decided, unless that has passed (resting()
    -- then asked for the moment the fingers will have rested STILL). Never at
    -- or before now: libinput runs an expired timer again at once, with the
    -- same now, and a timer that always asks for the past would hold its
    -- input thread in that loop for good (libinput timer.c, goto restart).
    if e.mode == "frozen" and e.frozen + FROZEN_MAX > now then
        e.timer = math.min(e.timer or math.huge, e.frozen + FROZEN_MAX)
    end
    e.asked_past = false
    -- (libinput's timer is whole µs: a moment less than 1 µs ahead is now.)
    if e.timer and e.timer < now + 1 then
        e.timer = now + TICK / 4
        e.asked_past = true    -- a bug: counted by the fail-safe (registration)
    end
    return frames
end

-- When the engine fails: the resting or paced fingers lift for libinput and the
-- real ones are handed to it as they are. Returns the frames, in order.
function M.give_up(tp)
    local e = tp.engine
    tp.engine = nil
    -- Plain acceleration from here, at the speed the apps' own glides expect.
    tp.level = SPEED
    if not e or not e.slots then
        return {}
    end
    return { lift_frame(tp, e), touch_frame(tp, e) }
end


local frame_of

-- Takes one evdev frame and returns it rewritten, or nil when libinput may
-- have it as it is.
function M.frame(tp, frame, time, now)
    local slot, decided = tp.slot, tp.started
    local result = frame_of(tp, frame, time, now)
    local e = tp.engine
    if e and decided and e.mode == "contact" then
        e.ramp = true
    end
    -- libinput takes the touchpad's frame at the touchpad's time, even when
    -- that is before the timer's last frame (a report that came in late),
    -- and measures the next move from it; a frame taken out entirely it
    -- never sees.
    if e and (result == nil or #result > 0 or #e.prepend > 0) then
        e.lastframe = time
    end
    if e and e.lastnorm then
        -- A finger whose place goes to libinput in this frame is measured
        -- by libinput from it: its next paced step starts from no move at
        -- all, the safe side of libinput's "7 mm more than the last"
        -- (pace()).
        for _, ev in ipairs(result or frame) do
            if ev.usage == ABS_MT_SLOT then
                slot = ev.value
            elseif (ev.usage == ABS_MT_POSITION_X or ev.usage == ABS_MT_POSITION_Y) and slot then
                e.lastnorm[slot] = 0
            end
        end
    end
    return result
end

frame_of = function(tp, frame, time, now)
    local slots = tp.slots

    -- Where each finger was before this frame.
    local before = {}
    for slot, f in pairs(slots) do
        if f.down and f.x and f.y then
            before[slot] = { x = f.x, y = f.y, touch = f.touch }
        end
    end

    -- Follow the kernel through the frame, and note the events that carry a
    -- finger's position.
    local positions = {}
    for index, e in ipairs(frame) do
        local usage, value = e.usage, e.value
        if usage == ABS_MT_SLOT then
            tp.slot = value
        elseif not tp.slot and (usage == ABS_MT_TRACKING_ID or usage == ABS_MT_POSITION_X
                or usage == ABS_MT_POSITION_Y) then
            -- Before the kernel has named any slot (unnamed_event()).
            unnamed_event(tp, usage, value)
        elseif usage == ABS_MT_TRACKING_ID then
            if tp.slot then
                name_unnamed(tp, tp.slot, value >= 0)
                local f = slot_state(tp, tp.slot)
                f.ox, f.oy, f.palm = 0, 0, false
                f.id = value
                if value >= 0 then
                    tp.touches = tp.touches + 1
                    f.down, f.touch = true, tp.touches
                else
                    f.down = false
                end
            end
        elseif usage == ABS_MT_POSITION_X or usage == ABS_MT_POSITION_Y then
            if tp.slot then
                name_unnamed(tp, tp.slot, false)
                local f = slot_state(tp, tp.slot)
                local axis = usage == ABS_MT_POSITION_X and "x" or "y"
                f[axis] = value
                positions[#positions + 1] = { index, tp.slot, axis }
            end
        elseif usage == ABS_MT_TOOL_TYPE then
            if tp.slot then
                slot_state(tp, tp.slot).palm = value == MT_TOOL_PALM
            end
        elseif usage == BTN_LEFT then
            tp.button = value ~= 0
        elseif MORE_FINGERS[usage] then
            tp.more[usage] = value ~= 0
        end
        if usage >> 16 == EV_KEY then
            tp.keys[usage] = value
        end
    end

    -- Exactly two fingers, both known, neither a palm nor low on the pad,
    -- and the pad not pressed.
    local down, known = 0, {}
    for slot, f in pairs(slots) do
        if f.down then
            down = down + 1
            if f.x and f.y and not f.palm and f.y < tp.bottom then
                known[#known + 1] = slot
            end
        end
    end
    local more = false
    for _, on in pairs(tp.more) do
        more = more or on
    end
    if down == 2 and #known == 2 and not tp.button and not more then
        table.sort(known)
        local a, b = slots[known[1]], slots[known[2]]
        local pair = a.touch .. ":" .. b.touch
        if tp.pair ~= pair then
            tp.pair, tp.history = pair, {}
            -- With the engine, the curve applies once libinput has decided
            -- (accelerate()), or from the kick (kick()).
            tp.start, tp.started, tp.since = { a.x, a.y, b.x, b.y }, false, time
        end
        accelerate(tp, a, b, before[known[1]], before[known[2]], time)
    elseif tp.pair then
        tp.pair, tp.history = nil, {}
    end

    -- Where libinput is to see each finger.
    for _, f in pairs(slots) do
        if f.down and f.x and f.y then
            clamp_offset(f, "x", tp.xmin, tp.xmax)
            clamp_offset(f, "y", tp.ymin, tp.ymax)
            f.outx = math.floor(f.x + f.ox + 0.5)
            f.outy = math.floor(f.y + f.oy + 0.5)
        end
    end
    -- libinput scrolls by the fingers' average, so while two are scrolled
    -- their sum is what has to be right. Rounded each on its own, both shifts
    -- round the same way, and the scroll steps by whole units: at a slow gain
    -- one frame moves twice as far as the next, and the page judders. The
    -- second finger instead makes up what rounding took from the first, which
    -- halves the step and keeps the sum within half a unit of the exact one.
    if tp.pair then
        local a, b = slots[known[1]], slots[known[2]]
        for _, axis in ipairs({ "x", "y" }) do
            local o = "o" .. axis
            local sum = math.floor(a[axis] + a[o] + b[axis] + b[o] + 0.5)
            local low, high = tp[axis .. "min"], tp[axis .. "max"]
            local out = sum - a["out" .. axis]
            if out >= low and out <= high then
                b["out" .. axis] = out
            end
        end
    end

    -- With the engine on, it decides about this frame, or tells where the
    -- fingers it paces are to be.
    local e = tp.engine
    if e then
        -- The engine keeps time by libinput's clock, which its timer runs on;
        -- a frame's time is when the touchpad measured it, a little earlier.
        -- The least difference over a gesture is how much earlier (followed slowly
        -- upwards, should the two clocks drift).
        if now then
            local lag = now - time
            if e.mode == "idle" or not e.lag or lag < e.lag then
                e.lag = lag
            else
                e.lag = e.lag + (lag - e.lag) * 0.1
            end
            if e.mode == "idle" and tp.pair and libinput then
                libinput:log_debug(string.format("Pear Up scroll engine: touchpad clock %d us behind", math.floor(lag)))
            end
        end
        local decided, result = engine_frame(tp, e, frame, time + (e.lag or 0), known)
        if decided then
            return result
        end
    end
    local paced = (e and e.mode == "contact") and e.view or {}

    -- The positions in the frame, rewritten. Those of the fingers the engine
    -- paces are taken out: its timer moves them, and the touchpad's own
    -- reports, a little earlier by their timestamps, would only make libinput
    -- measure the timer's next step over too short a time.
    local changed = false
    local carried = {}
    local drop = {}
    for _, p in ipairs(positions) do
        local index, slot, axis = p[1], p[2], p[3]
        local f = slots[slot]
        local value = frame[index].value
        if paced[slot] and f.down and not e.fresh and e.direct and e.delay == 0 and f["out" .. axis] then
            -- Until libinput has decided the fingers scroll (and in the frame
            -- it decides on), they are drawn with no delay (catch_up()), and
            -- their places go to libinput in the touchpad's own frame, at
            -- once, rather than on the next beat: the first scroll comes as
            -- soon as without the engine.
            local i = axis == "x" and 1 or 2
            value = f["out" .. axis]
            paced[slot][i], e.outf[slot][i] = value, value
            if value ~= frame[index].value then
                frame[index].value = value
                changed = true
            end
        elseif paced[slot] and f.down and not e.fresh then
            drop[index] = true
            changed = true
        elseif paced[slot] and f.down then
            -- The frame the pair came down in: libinput needs their places.
            value = paced[slot][axis == "x" and 1 or 2]
            if value ~= frame[index].value then
                frame[index].value = value
                changed = true
            end
        elseif f.down and f["out" .. axis] then
            value = f["out" .. axis]
            if value ~= frame[index].value then
                frame[index].value = value
                changed = true
            end
        end
        if not drop[index] then
            f["sent" .. axis] = value
        end
        carried[slot .. axis] = true
    end

    -- And those of fingers whose offset changed though the kernel had nothing
    -- new about them, added at the end. The kernel's slot is selected again
    -- afterwards, as the next frame assumes it. Past libinput's limit they are
    -- left for the next frame.
    local selected = tp.slot
    local order = {}
    for slot in pairs(slots) do
        order[#order + 1] = slot
    end
    table.sort(order)
    for _, slot in ipairs(order) do
        local f = slots[slot]
        if f.down and f.outx and f.outy and not paced[slot] then
            local add = {}
            for _, axis in ipairs({ "x", "y" }) do
                if not carried[slot .. axis] and f["out" .. axis] ~= f["sent" .. axis] then
                    add[#add + 1] = axis
                end
            end
            local needed = #add + (slot ~= selected and 1 or 0) + (slot ~= tp.slot and 1 or 0)
            if #add > 0 and #frame + needed <= MAX_EVENTS then
                if slot ~= selected then
                    frame[#frame + 1] = { usage = ABS_MT_SLOT, value = slot }
                    selected = slot
                end
                for _, axis in ipairs(add) do
                    local usage = axis == "x" and ABS_MT_POSITION_X or ABS_MT_POSITION_Y
                    frame[#frame + 1] = { usage = usage, value = f["out" .. axis] }
                    f["sent" .. axis] = f["out" .. axis]
                end
                changed = true
            end
        end
    end
    if selected ~= tp.slot then
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
    end
    if e then
        e.fresh = nil
    end
    if next(drop) then
        local kept = {}
        for index, ev in ipairs(frame) do
            if not drop[index] then
                kept[#kept + 1] = ev
            end
        end
        frame = kept
    end

    if changed then
        return frame
    end
    return nil
end

if libinput then
    libinput:register({ 1 })
    -- The engine runs for the first touchpad only: the plugin has one timer.
    local engine_tp, engine_device = nil, nil
    -- Never at or before now (see the end of M.tick): an expired timer that
    -- asks for the past again would keep libinput's timer loop, and with it
    -- the compositor's input, spinning.
    local function want_timer(e, now)
        if e and e.timer then
            libinput:timer_set_absolute(math.max(math.floor(e.timer), now + 500))
        end
    end
    -- The fail-safe. Any error in the engine, or its timer misbehaving, and
    -- the engine is off until the next login: the fingers it holds are let
    -- go, its timer is cancelled, one line goes to the log, and the touchpad
    -- keeps plain acceleration. The timer misbehaves when it asks for the
    -- past (M.tick, asked_past), when libinput runs it again at the same
    -- moment (its expired-timer loop), or when it runs more than TIMER_RATE
    -- times within a second (twice its beat): STRIKES of the first two, or
    -- the third, within a second. libinput's input thread can then not be
    -- kept spinning by this plugin, whatever the engine's own code does.
    local STRIKES, TIMER_RATE = 3, 1000
    local engine_off = false
    local strikes, last_now, window, calls = {}, nil, nil, 0
    local function give_up(err)
        engine_off = true
        libinput:timer_cancel()
        libinput:log_error("Pear Up scroll engine: " .. tostring(err) .. "; scrolling without it until the next login")
        local ok, frames = pcall(M.give_up, engine_tp)
        return ok and frames or {}
    end
    local function misbehaving(now, e)
        if not window or now - window >= 1000000 then
            window, calls = now, 0
        end
        calls = calls + 1
        if calls > TIMER_RATE then
            return string.format("its timer ran %d times within a second", calls)
        end
        if (e and e.asked_past) or (last_now and now <= last_now) then
            strikes[#strikes + 1] = now
        end
        last_now = now
        while strikes[1] and strikes[1] < now - 1000000 do
            table.remove(strikes, 1)
        end
        if #strikes >= STRIKES then
            return string.format("its timer asked for the past %d times within a second", #strikes)
        end
        return nil
    end
    libinput:connect("timer-expired", function(now)
        if engine_off or not engine_tp or not engine_tp.engine then
            return
        end
        local ok, frames = pcall(M.tick, engine_tp, now)
        if not ok then
            frames = give_up(frames)
        else
            local why = misbehaving(now, engine_tp.engine)
            if why then
                for _, frame in ipairs(give_up(why)) do
                    frames[#frames + 1] = frame
                end
            end
        end
        for _, frame in ipairs(frames) do
            engine_device:append_frame(frame)
        end
        if not engine_off then
            want_timer(engine_tp.engine, now)
        end
    end)
    libinput:connect("new-evdev-device", function(device)
        if not device:udev_properties().ID_INPUT_TOUCHPAD then
            return
        end
        local usages = device:usages()
        for _, usage in ipairs({ ABS_MT_SLOT, ABS_MT_TRACKING_ID, ABS_MT_POSITION_X, ABS_MT_POSITION_Y }) do
            if not usages[usage] then
                return
            end
        end
        local absinfos = device:absinfos()
        local engine = ENGINE and not engine_tp and not engine_off
        local tp = M.touchpad(absinfos[ABS_MT_POSITION_X], absinfos[ABS_MT_POSITION_Y],
            engine and ENGINE_SPEED or SPEED)
        if not tp then
            libinput:log_info("Pear Up scroll acceleration: " .. device:name() .. " reports no resolution, left as it is")
            return
        end
        if engine then
            M.engine(tp)
            engine_tp, engine_device = tp, device
            libinput:log_info("Pear Up scroll acceleration with the Mac scroll engine: " .. device:name())
        else
            libinput:log_info("Pear Up scroll acceleration: " .. device:name())
        end
        device:connect("evdev-frame", function(_, frame, time)
            if not tp then
                return nil
            end
            if not tp.engine then
                return M.frame(tp, frame, time)
            end
            local ok, result = pcall(M.frame, tp, frame, time, libinput:now())
            if not ok then
                local frames = give_up(result)
                for i = 1, #frames - 1 do
                    device:prepend_frame(frames[i])
                end
                return frames[#frames]
            end
            for _, before in ipairs(tp.engine.prepend) do
                device:prepend_frame(before)
            end
            tp.engine.prepend = {}
            want_timer(tp.engine, libinput:now())
            return result
        end)
        device:connect("device-removed", function()
            if tp == engine_tp then
                engine_tp, engine_device = nil, nil
                libinput:timer_cancel()
            end
            tp = nil
        end)
    end)
end

return M

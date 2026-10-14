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
--   - a touch that began before the plugin could tell which slot it is in.
--     The kernel names a slot only when it changes, so just after login the
--     first finger is often unnamed until a second one comes, and that one
--     gesture is libinput's own;
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
function M.touchpad(absx, absy, level, scale)
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
        scale = scale or 1, -- what positions are multiplied by (see M.scaled)
        -- The slot the kernel last selected. Frames only say when it changes,
        -- so until one has, which finger an event belongs to is not known and
        -- nothing is touched.
        slot = nil,
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
        local da = math.max(math.abs(a.x - s[1]) / tp.xres, math.abs(a.y - s[2]) / tp.yres)
        local db = math.max(math.abs(b.x - s[3]) / tp.xres, math.abs(b.y - s[4]) / tp.yres)
        if math.max(da, db) < START_MM then
            return
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
--     the same share of the movement. Places are told in eighths of a
--     touchpad unit (SCALE: libinput is given the finer absinfo, the same
--     millimetres), so a slow scroll does not step by whole units.
--   - Start: libinput scrolls nothing until a finger has moved a millimetre;
--     once both have moved KICK_FROM alike it is shown them KICK further,
--     which it spends on that decision, so a slow scroll starts nearly at
--     once, as on a Mac. The curve then applies from the start.
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
local POINTER_MM = 1.5       -- a finger moved this far points
local LEFTOVER_MAX = 300000  -- µs a finger left down after a lift is ignored
local EDGE_MM = 6            -- how near an edge the resting fingers go
local JUMP_MIN_MM = 20       -- the smallest move back libinput surely ignores
local JUMP_FRESH = 10000     -- µs: a finger moved longer ago than this is not moved back
local STEP_GROWTH = 0.8      -- mm a paced step may be longer than the one before
local STEP_MAX = 3           -- mm a paced step may be at most
local SCALE = 8              -- the engine tells libinput places in eighths of a touchpad unit
local ENGINE_SPEED = 0.34    -- the engine scrolls as far as a MacBook (the speed setting is for apps that glide on their own)
local CARRY_TAU = 220000     -- µs: a glide carried into new fingers fades with this
local KICK_FROM = 0.5        -- mm two fingers move alike before libinput is helped past its millimetre
local KICK = 1.1             -- mm it is helped by
local GRACE = 8000           -- µs a glide runs on under a new touch, for a second finger to join it
M.SCALE, M.ENGINE_SPEED = SCALE, ENGINE_SPEED

local EV_KEY = 1

-- The next tick on the beat after `t`: the beat is kept, whatever arrives in
-- between, so that each frame gets the same number of steps.
local function grid(t)
    return math.floor(t / TICK + 1) * TICK
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

-- Appends what libinput should be told now about the paced fingers to
-- `events`, and returns whether anything moved.
local function pace(tp, e, now, events)
    local q = now - DELAY
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
    local len = math.max(math.sqrt((dax / tp.xres) ^ 2 + (day / tp.yres) ^ 2),
        math.sqrt((dbx / tp.xres) ^ 2 + (dby / tp.yres) ^ 2))
    local limit = math.min((e.step or 0) + STEP_GROWTH, STEP_MAX)
    local share = len > limit and limit / len or 1
    if e.jumped then
        share, e.jumped = 0, nil
    end
    e.step = len * share
    fa[1], fa[2] = fa[1] + dax * share, fa[2] + day * share
    fb[1], fb[2] = fb[1] + dbx * share, fb[2] + dby * share
    ax, ay, bx, by = fa[1], fa[2], fb[1], fb[2]
    -- As in M.frame: the second finger makes up what rounding took from the
    -- first, so their sum, which libinput scrolls by, is within half a unit.
    local out = {}
    out[a] = { clampv(math.floor(ax + 0.5), tp.xmin, tp.xmax), clampv(math.floor(ay + 0.5), tp.ymin, tp.ymax) }
    out[b] = {
        clampv(math.floor(ax + bx + 0.5) - out[a][1], tp.xmin, tp.xmax),
        clampv(math.floor(ay + by + 0.5) - out[a][2], tp.ymin, tp.ymax),
    }
    local moved = false
    for _, slot in ipairs(e.slots) do
        local v = e.view[slot]
        local o = out[slot]
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
    for usage, value in pairs(tp.keys) do
        if value ~= 0 then
            frame[#frame + 1] = { usage = usage, value = value }
        end
    end
    if tp.slot then
        frame[#frame + 1] = { usage = ABS_MT_SLOT, value = tp.slot }
    end
    e.keys = copy(tp.keys)
    tp.pair, tp.history = nil, {}
    return frame
end

-- Ends the resting fingers and hands libinput the real ones.
-- libinput scrolls nothing until a finger has moved about a millimetre
-- (evdev-mt-touchpad-gestures.c: "both touches moved less than a mm"), which a
-- slow scroll takes 60 ms and more to cover; a Mac moves the page in the first
-- frame. Once both fingers have moved KICK_FROM alike, libinput is shown them
-- KICK further at once, which it spends on that decision and scrolls nothing
-- for; from there on the fingers scroll it from where they really are.
local function kick(tp, e, time)
    local a, b = tp.slots[e.slots[1]], tp.slots[e.slots[2]]
    local s = tp.start
    if not s or not a.x or not b.x then
        return
    end
    local ax, ay = (a.x - s[1]) / tp.xres, (a.y - s[2]) / tp.yres
    local bx, by = (b.x - s[3]) / tp.xres, (b.y - s[4]) / tp.yres
    local la, lb = math.sqrt(ax * ax + ay * ay), math.sqrt(bx * bx + by * by)
    if la < KICK_FROM or lb < KICK_FROM or time - e.since < 20000 then
        return
    end
    e.kicked = true
    if (ax * bx + ay * by) / (la * lb) < 0.8 then
        return -- not alike: a pinch or a turn, libinput's to decide
    end
    local dx, dy = (ax + bx) / 2, (ay + by) / 2
    local l = math.sqrt(dx * dx + dy * dy)
    local kx, ky = dx / l * KICK * tp.xres, dy / l * KICK * tp.yres
    -- What the fingers moved before libinput decided (after the curve), which
    -- it will never scroll: given again after it, over the next steps.
    local px, py = 0, 0
    for _, slot in ipairs(e.slots) do
        local path = e.path[slot] or {}
        if #path >= 2 then
            px = px + (path[#path][2] - path[1][2]) / 2
            py = py + (path[#path][3] - path[1][3]) / 2
        end
    end
    for _, slot in ipairs(e.slots) do
        for _, p in ipairs(e.path[slot] or {}) do
            p[2], p[3] = p[2] + kx, p[3] + ky
        end
    end
    e.coff = { e.coff[1] + kx + px, e.coff[2] + ky + py }
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
        e.path[slot] = { { time - DELAY, o[1], o[2] } }
    end
    e.step = 0
end

local function release(tp, e)
    e.carry = nil
    local lifted = lift_frame(tp, e)
    local touched = touch_frame(tp, e)
    if #touched > (tp.slot and 1 or 0) then
        e.prepend[#e.prepend + 1] = lifted
        return touched
    end
    return lifted
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
local function resting(tp, e, time)
    local more = tp.button
    for _, on in pairs(tp.more) do
        more = more or on
    end
    local new, all = newcomers(tp, e, time)
    if #new > 0 and (e.mode == "glide" or e.mode == "still") then
        -- What the glide was doing, for fingers that take it over.
        e.carry = nil
        if e.mode == "glide" then
            -- As it is on screen: DELAY behind.
            local g = M.glide(time - DELAY - e.start)
            e.carry = { e.vx * g, e.vy * g }
        end
        e.mode, e.frozen, e.halted = "frozen", time, false
        if not e.carry then
            halt(e, time)
        end
        -- Otherwise the glide runs on for GRACE (M.tick), so that a second
        -- finger landing a report later takes it over without a stall; a
        -- lone finger stops it after that.
    end
    if e.mode ~= "frozen" then
        return {}
    end
    if more or #new >= 3 then
        return release(tp, e)
    end
    if all == 0 then
        -- Touched and lifted: the glide only stopped.
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
            local fits = not a.palm and not b.palm and a.y < tp.bottom and b.y < tp.bottom
                and slots[1] == e.slots[1] and slots[2] == e.slots[2]
            if not fits then
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
            if e.carry then
                e.carry.t0, e.carry.last = e.frozen, time
            end
            e.timer = math.min(e.timer or math.huge, grid(time))
            return {}
        end
    end
    if #new == 1 then
        local seen = e.seen[tp.slots[new[1]].touch]
        local f = tp.slots[new[1]]
        local d = 0
        if seen and f.x and f.y then
            d = math.max(math.abs(f.x - seen[1]) / tp.xres, math.abs(f.y - seen[2]) / tp.yres)
        end
        -- A finger that points is handed over at once: libinput's quick hold
        -- (40 ms) then stops what glide the apps start from the last moments
        -- of ours. One that only rests waits until the resting fingers have
        -- been still for STILL, so that no app glides at all.
        local last = e.frozen
        for _, slot in ipairs(e.slots) do
            last = math.max(last, e.moved[slot] or 0)
        end
        if d > POINTER_MM or (time - e.frozen >= FROZEN_MAX and time >= last + STILL) then
            return release(tp, e)
        end
        e.timer = math.max(e.timer or 0, math.max(e.frozen + FROZEN_MAX, last + STILL))
        return {}
    end
    e.timer = math.max(e.timer or 0, e.frozen + FROZEN_MAX)
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
                e.timer = time + DELAY + TICK
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
        e.coff, e.kicked, e.carry = { 0, 0 }, false, nil
        e.slots = { known[1], known[2] }
        e.path, e.view, e.moved = {}, {}, {}
        e.outf, e.step = {}, 0
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
function M.tick(tp, now)
    local e = tp.engine
    e.timer = nil
    e.prepend = {}
    if not e.slots then
        return {}
    end
    local frames = {}
    if e.mode == "frozen" then
        local frame = resting(tp, e, now)
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
        if e.carry and now < e.frozen + GRACE then
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
        pending = pending or (#path > 0 and path[#path][1] > now - DELAY)
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
    if e.mode == "frozen" then
        e.timer = math.min(e.timer or math.huge, e.frozen + FROZEN_MAX)
    end
    return frames
end

-- When the engine fails: the resting or paced fingers lift for libinput and the
-- real ones are handed to it as they are. Returns the frames, in order.
function M.give_up(tp)
    local e = tp.engine
    tp.engine = nil
    if not e or not e.slots then
        return {}
    end
    return { lift_frame(tp, e), touch_frame(tp, e) }
end


-- The absinfo of a position axis with `scale` times its units: the same
-- millimetres to libinput, finer steps. With the engine on, the plugin tells
-- libinput this (EvdevDevice:set_absinfo) and multiplies every position, so
-- a slow scroll moves in quarters of a touchpad unit, not whole ones.
function M.scaled(absinfo, scale)
    if not absinfo then
        return nil
    end
    local out = {}
    for k, v in pairs(absinfo) do
        out[k] = v
    end
    for _, k in ipairs({ "minimum", "maximum", "resolution", "fuzz", "flat" }) do
        if out[k] then
            out[k] = out[k] * scale
        end
    end
    return out
end

local SCALED = {
    [ABS_MT_POSITION_X] = true, [ABS_MT_POSITION_Y] = true,
    [evdev.ABS_X] = true, [evdev.ABS_Y] = true,
}

-- The touchpad's positions in the scaled units, in place.
function M.scale_frame(tp, frame)
    if tp.scale == 1 then
        return false
    end
    local any = false
    for _, e in ipairs(frame) do
        if SCALED[e.usage] then
            e.value = e.value * tp.scale
            any = true
        end
    end
    return any
end

-- Takes one evdev frame and returns it rewritten, or nil when libinput may
-- have it as it is.
function M.frame(tp, frame, time, now)
    local slots = tp.slots
    local scaled = M.scale_frame(tp, frame)

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
        elseif usage == ABS_MT_TRACKING_ID then
            if tp.slot then
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
            -- With the engine, libinput's millimetre is its kick's business
            -- (kick()), and the curve applies from the start.
            tp.start, tp.started = { a.x, a.y, b.x, b.y }, tp.engine ~= nil
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
        if paced[slot] and f.down and not e.fresh then
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

    if changed or scaled then
        return frame
    end
    return nil
end

if libinput then
    libinput:register({ 1 })
    -- The engine runs for the first touchpad only: the plugin has one timer.
    local engine_tp, engine_device = nil, nil
    local function want_timer(e)
        if e and e.timer then
            libinput:timer_set_absolute(math.floor(e.timer))
        end
    end
    local function give_up(err)
        libinput:log_error("Pear Up scroll engine: " .. tostring(err) .. "; scrolling without it until the next login")
        local ok, frames = pcall(M.give_up, engine_tp)
        return ok and frames or {}
    end
    libinput:connect("timer-expired", function(now)
        if not engine_tp or not engine_tp.engine then
            return
        end
        local ok, frames = pcall(M.tick, engine_tp, now)
        if not ok then
            frames = give_up(frames)
        end
        for _, frame in ipairs(frames) do
            engine_device:append_frame(frame)
        end
        want_timer(engine_tp.engine)
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
        local engine = ENGINE and not engine_tp
        local scale = engine and SCALE or 1
        local absx = M.scaled(absinfos[ABS_MT_POSITION_X], scale)
        local absy = M.scaled(absinfos[ABS_MT_POSITION_Y], scale)
        local tp = M.touchpad(absx, absy, engine and ENGINE_SPEED or SPEED, scale)
        if not tp then
            libinput:log_info("Pear Up scroll acceleration: " .. device:name() .. " reports no resolution, left as it is")
            return
        end
        if engine then
            -- Finer positions, the same millimetres: see M.scaled.
            for usage, info in pairs(absinfos) do
                if SCALED[usage] then
                    device:set_absinfo(usage, M.scaled(info, scale))
                end
            end
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
                if tp.scale == 1 then
                    return M.frame(tp, frame, time)
                end
                -- Scaled positions must stay scaled whatever happens: libinput
                -- was told so, and would otherwise take every place as a
                -- quarter of where it is.
                local original = {}
                for i, ev in ipairs(frame) do
                    original[i] = { usage = ev.usage, value = ev.value }
                end
                local ok, result = pcall(M.frame, tp, frame, time)
                if ok then
                    return result
                end
                tp.slots, tp.pair, tp.history = {}, nil, {}
                M.scale_frame(tp, original)
                return original
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
            want_timer(tp.engine)
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

#!/usr/bin/env lua5.4
-- Drive the scroll acceleration plugin's arithmetic with frames of our own,
-- shaped the way the kernel sends them, and check what libinput would be told.
--
--   lua tests/libinput/check-scroll-acceleration.lua [plugin.lua]
--
-- The plugin is loaded the way libinput loads it: in a sandbox holding only the
-- globals libinput's documentation lists, so a call that works here and not
-- there fails here too. libinput itself is left out (its `libinput` global is
-- absent, which the plugin takes as "do not register"), and then stood in for
-- by a fake at the end, to check the registration as well.

local here = arg[0]:match("^(.*)/[^/]*$") or "."
local plugin_path = arg[1] or (here .. "/../../libinput/10-pear-up-scroll-acceleration.lua")

local function usage(type, code)
    return (type << 16) | code
end

local EV_KEY, EV_ABS, EV_MSC = 1, 3, 4
local evdev = {
    ABS_X = usage(EV_ABS, 0x00),
    ABS_Y = usage(EV_ABS, 0x01),
    ABS_MT_SLOT = usage(EV_ABS, 0x2f),
    ABS_MT_POSITION_X = usage(EV_ABS, 0x35),
    ABS_MT_POSITION_Y = usage(EV_ABS, 0x36),
    ABS_MT_TOOL_TYPE = usage(EV_ABS, 0x37),
    ABS_MT_TRACKING_ID = usage(EV_ABS, 0x39),
    BTN_LEFT = usage(EV_KEY, 0x110),
    BTN_TOOL_FINGER = usage(EV_KEY, 0x145),
    BTN_TOOL_QUINTTAP = usage(EV_KEY, 0x148),
    BTN_TOUCH = usage(EV_KEY, 0x14a),
    BTN_TOOL_DOUBLETAP = usage(EV_KEY, 0x14d),
    BTN_TOOL_TRIPLETAP = usage(EV_KEY, 0x14e),
    BTN_TOOL_QUADTAP = usage(EV_KEY, 0x14f),
    MSC_TIMESTAMP = usage(EV_MSC, 0x05),
}

-- What libinput's sandbox offers (doc/user/lua-plugins.rst, "Limitations").
local function sandbox(extra)
    local env = {
        assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs,
        tonumber = tonumber, pcall = pcall, select = select, print = print,
        tostring = tostring, type = type, xpcall = xpcall, table = table,
        string = string, math = math, _VERSION = _VERSION, evdev = evdev,
    }
    for k, v in pairs(extra or {}) do
        env[k] = v
    end
    return env
end

local function load_plugin(extra, source)
    local chunk, err
    if source then
        chunk, err = load(source, "=plugin", "t", sandbox(extra))
    else
        chunk, err = loadfile(plugin_path, "t", sandbox(extra))
    end
    assert(chunk, err)
    return chunk()
end

local P = load_plugin()

local failed, passed = 0, 0
local function check(label, ok, detail)
    if ok then
        passed = passed + 1
        print("  ok   " .. label)
    else
        failed = failed + 1
        print("  FAIL " .. label .. (detail and ("\n       " .. detail) or ""))
    end
end
local function near(a, b, tolerance)
    return math.abs(a - b) <= tolerance
end

-- framy's touchpad, a PIXA3854: 118 x 72 mm at 24 units per mm, five slots.
local RES = 24
local ABSX = { minimum = 0, maximum = 2830, resolution = RES }
local ABSY = { minimum = 0, maximum = 1720, resolution = RES }
local FRAME_US = 8000

---------------------------------------------------------------------------
-- A kernel: given where the fingers are, the frame it sends. Like the real
-- one it sends only what changed, and selects a slot only when an event for
-- another one follows.
local Kernel = {}
Kernel.__index = Kernel

-- `slot` is the slot the kernel has selected to begin with: after boot that is
-- 0, after any use of two fingers usually another.
local function new_kernel(slot)
    return setmetatable({ t = 1000000, slot = slot or 0, slots = {}, axes = {}, keys = {}, ids = 0 }, Kernel)
end

-- fingers: { [slot] = { x, y } } in device units, or { x, y, palm = true }.
-- self.slots holds the fingers that are down; self.axes what each slot last
-- reported, which outlives the touch, as the kernel's does.
function Kernel:frame(fingers, opts)
    opts = opts or {}
    local frame = {}
    local function ev(u, v)
        frame[#frame + 1] = { usage = u, value = v }
    end
    local all = {}
    for s in pairs(self.slots) do all[s] = true end
    for s in pairs(fingers) do all[s] = true end
    local order = {}
    for s in pairs(all) do order[#order + 1] = s end
    table.sort(order)
    for _, s in ipairs(order) do
        local new = fingers[s]
        local changes = {}
        if new == nil then
            changes[#changes + 1] = { evdev.ABS_MT_TRACKING_ID, -1 }
            self.slots[s] = nil
        else
            local x, y = math.floor(new[1] + 0.5), math.floor(new[2] + 0.5)
            local axes = self.axes[s] or { palm = false }
            if not self.slots[s] then
                self.ids = self.ids + 1
                changes[#changes + 1] = { evdev.ABS_MT_TRACKING_ID, self.ids }
            end
            if axes.palm ~= (new.palm or false) then
                changes[#changes + 1] = { evdev.ABS_MT_TOOL_TYPE, new.palm and 2 or 0 }
            end
            if axes.x ~= x then changes[#changes + 1] = { evdev.ABS_MT_POSITION_X, x } end
            if axes.y ~= y then changes[#changes + 1] = { evdev.ABS_MT_POSITION_Y, y } end
            self.axes[s] = { x = x, y = y, palm = new.palm or false }
            self.slots[s] = self.axes[s]
        end
        if #changes > 0 then
            if s ~= self.slot then
                ev(evdev.ABS_MT_SLOT, s)
                self.slot = s
            end
            for _, c in ipairs(changes) do ev(c[1], c[2]) end
        end
    end
    local n = 0
    for _ in pairs(fingers) do n = n + 1 end
    local keys = {
        { evdev.BTN_TOUCH, n > 0 },
        { evdev.BTN_TOOL_FINGER, n == 1 },
        { evdev.BTN_TOOL_DOUBLETAP, n == 2 },
        { evdev.BTN_TOOL_TRIPLETAP, n == 3 },
        { evdev.BTN_LEFT, opts.button or false },
    }
    for _, k in ipairs(keys) do
        if (self.keys[k[1]] or false) ~= k[2] then
            ev(k[1], k[2] and 1 or 0)
            self.keys[k[1]] = k[2]
        end
    end
    ev(evdev.MSC_TIMESTAMP, self.t & 0x7fffffff)
    local t = self.t
    self.t = self.t + (opts.dt or FRAME_US)
    return frame, t
end

---------------------------------------------------------------------------
-- libinput's side: what it believes about each slot after a frame.
local function new_view(slot)
    return { slot = slot, slots = {} }
end

local function apply(view, frame)
    local count = 0
    for _, e in ipairs(frame) do
        count = count + 1
        local s = view.slots[view.slot] or {}
        view.slots[view.slot] = s
        if e.usage == evdev.ABS_MT_SLOT then
            view.slot = e.value
        elseif e.usage == evdev.ABS_MT_TRACKING_ID then
            s.down = e.value >= 0
        elseif e.usage == evdev.ABS_MT_POSITION_X then
            s.x = e.value
        elseif e.usage == evdev.ABS_MT_POSITION_Y then
            s.y = e.value
        end
    end
    return count
end

local function copy(frame)
    local out = {}
    for i, e in ipairs(frame) do
        out[i] = { usage = e.usage, value = e.value }
    end
    return out
end

-- A rig: kernel, plugin state and libinput's view, plus what the raw kernel
-- would have told libinput without the plugin, for comparison. The kernel
-- starts on slot 4 unless told otherwise, so the first finger's slot is named;
-- libinput reads the starting slot from the device.
local function new_rig(level, slot)
    slot = slot or 4
    local rig = {
        kernel = new_kernel(slot),
        tp = P.touchpad(ABSX, ABSY, level),
        view = new_view(slot),
        raw = new_view(slot),
        max_events = 0,
        out_of_range = false,
        slot_mismatch = false,
        rewritten = 0,
    }
    return rig
end

local function step(rig, fingers, opts)
    local frame, t = rig.kernel:frame(fingers, opts)
    apply(rig.raw, frame)
    local out = P.frame(rig.tp, copy(frame), t)
    if out then
        rig.rewritten = rig.rewritten + 1
    end
    local n = apply(rig.view, out or frame)
    rig.max_events = math.max(rig.max_events, n)
    for _, s in pairs(rig.view.slots) do
        if s.x and (s.x < ABSX.minimum or s.x > ABSX.maximum) then rig.out_of_range = true end
        if s.y and (s.y < ABSY.minimum or s.y > ABSY.maximum) then rig.out_of_range = true end
    end
    if rig.view.slot ~= rig.kernel.slot then
        rig.slot_mismatch = true
    end
    return out
end

local function mm(v) return v * RES end

-- Two fingers 16 mm apart; first they rest, then move down `distance` mm at
-- `speed` mm/s, then rest again. Returns the scroll libinput would make, as
-- the movement of the fingers' average, with and without the plugin, in mm,
-- counted from `lead` mm into the movement (2 by default): the plugin leaves
-- the first START_MM alone, as libinput scrolls none of it.
-- With `apart`, they move apart sideways at that speed each, a pinch.
local function centroid(view)
    local a, b = view.slots[0], view.slots[1]
    return (a.x + b.x) / 2, (a.y + b.y) / 2
end

local function two_fingers(rig, opts)
    opts = opts or {}
    local ax, bx, y = mm(opts.x or 45), mm((opts.x or 45) + 16), mm(opts.y or 15)
    local fingers = function()
        return { [0] = { ax, y }, [1] = { bx, y } }
    end
    step(rig, { [0] = { ax, y } }, opts)
    for _ = 1, 3 do step(rig, fingers(), opts) end
    local per_frame = (opts.speed or 0) * FRAME_US / 1000000
    if opts.speed and opts.speed > 0 then
        for _ = 1, math.ceil((opts.lead or 2) / per_frame) do
            y = y + mm(per_frame)
            step(rig, fingers(), opts)
        end
    end
    local x0, y0 = centroid(rig.view)
    local rx0, ry0 = centroid(rig.raw)
    local frames = opts.speed and opts.speed > 0 and math.floor((opts.distance or 0) / per_frame) or (opts.frames or 0)
    for _ = 1, frames do
        y = y + mm(per_frame)
        if opts.apart then
            ax = ax - mm(opts.apart * FRAME_US / 1000000)
            bx = bx + mm(opts.apart * FRAME_US / 1000000)
        end
        step(rig, fingers(), opts)
    end
    for _ = 1, 3 do step(rig, fingers(), opts) end
    local x1, y1 = centroid(rig.view)
    local rx1, ry1 = centroid(rig.raw)
    return (y1 - y0) / RES, (ry1 - ry0) / RES, (x1 - x0) / RES, (rx1 - rx0) / RES
end

---------------------------------------------------------------------------
-- The speed the tests run at: Pear Up's default, "Balanced".
local L = 0.7

print("The gain curve")
do
    check("80 mm/s is the speed setting itself", near(P.gain(80, 1), 1, 1e-9) and near(P.gain(80, 0.34), 0.34, 1e-9))
    -- macOS's own curve (IOHIDPointerScrollFilter with a MacBook Air's table),
    -- as a share of the 80 mm/s rate.
    local mac = { { 3, 0.13 }, { 5, 0.19 }, { 10, 0.43 }, { 20, 0.64 }, { 40, 0.84 }, { 60, 0.94 }, { 120, 1.06 }, { 160, 1.08 } }
    local all = true
    for _, point in ipairs(mac) do
        all = all and near(P.gain(point[1], 1), point[2], 1e-9)
    end
    check("it is macOS's curve: 0.13 at 3 mm/s, 0.43 at 10, 0.64 at 20, 1.08 from 160", all)
    check("and stays at 1.08 past 160 mm/s", near(P.gain(400, 1), 1.08, 1e-9) and near(P.gain(5000, 1), 1.08, 1e-9))
    check("halfway between two points, halfway between their gains", near(P.gain(50, 1), (0.84 + 0.94) / 2, 1e-9))
    local rising, last = true, -1
    for speed = 0, 300 do
        local g = P.gain(speed, L)
        rising = rising and g >= last
        last = g
    end
    check("it never falls as the speed rises", rising)
    check("the speed setting scales all of it alike",
        near(P.gain(10, 0.34) / P.gain(10, 1), 0.34, 1e-9) and near(P.gain(200, 0.5) / P.gain(200, 1), 0.5, 1e-9))
    check("still fingers get a little, not nothing", P.gain(0, 1) > 0 and P.gain(0, 1) < 0.13)
end

print("Moving together")
do
    check("the same movement is together", near(P.together(0, 3, 0, 3), 1, 1e-9))
    check("a little apart in length and angle still is",
        near(P.together(0, 3, 0.3, 2.6), 1, 1e-9))
    check("opposite movements are not", P.together(0, 3, 0, -3) == 0)
    check("one finger resting is not", P.together(0, 3, 0, 0) == 0)
    check("movements across each other are not", P.together(0, 3, 3, 0) == 0)
    check("nothing to judge when neither moved", P.together(0.01, 0, 0.01, 0) == 0)
end

print("Two fingers scrolling")
do
    local rig = new_rig(L)
    local out, raw = two_fingers(rig, { speed = 10, distance = 20 })
    local ratio = out / raw
    check(string.format("slowly (10 mm/s), the scroll is the curve's %.3f of libinput's (%.3f)", P.gain(10, L), ratio),
        near(ratio, P.gain(10, L), 0.03))
    check("no position outside the touchpad", not rig.out_of_range)
    check("the kernel's slot is selected again after every frame", not rig.slot_mismatch)
    check("frames stay within libinput's 64 events", rig.max_events <= 64)

    rig = new_rig(L)
    out, raw = two_fingers(rig, { speed = 150, distance = 30 })
    ratio = out / raw
    check(string.format("quickly (150 mm/s), %.3f (%.3f)", P.gain(150, L), ratio), near(ratio, P.gain(150, L), 0.04))

    rig = new_rig(L)
    out, raw = two_fingers(rig, { speed = 40, distance = 30 })
    ratio = out / raw
    check(string.format("in between (40 mm/s), %.3f (%.3f)", P.gain(40, L), ratio), near(ratio, P.gain(40, L), 0.04))

    -- A slow start: libinput needs a finger to move a millimetre before it
    -- scrolls at all. The plugin lets that millimetre through as it is, so
    -- libinput is told of it as soon as without the plugin.
    rig = new_rig(L)
    local ax, bx, y = mm(45), mm(61), mm(15)
    step(rig, { [0] = { ax, y } })
    for _ = 1, 3 do step(rig, { [0] = { ax, y }, [1] = { bx, y } }) end
    local first_mm
    for i = 1, 200 do
        y = y + mm(3 * FRAME_US / 1e6)
        step(rig, { [0] = { ax, y }, [1] = { bx, y } })
        if not first_mm and math.abs(rig.view.slots[0].y - y) < 1 and (y - mm(15)) >= mm(1) then
            first_mm = i
        end
    end
    check(string.format("at 3 mm/s the first millimetre reaches libinput unscaled (after %s frames)", tostring(first_mm)),
        first_mm ~= nil and first_mm <= 45)

    -- A slow scroll steps evenly. libinput scrolls by the fingers' average,
    -- and positions are whole units: rounded alike, both fingers' shifts round
    -- the same way and the average moves in whole units, at 0.35 a step of one
    -- frame twice the next. Rounded together, their sum stays within half a
    -- unit of the exact one, and no frame's step strays further than that.
    rig = new_rig(L)
    ax, bx = mm(45), mm(61)
    local ay, by = mm(15), mm(15)
    step(rig, { [0] = { ax, ay } })
    for _ = 1, 3 do step(rig, { [0] = { ax, ay }, [1] = { bx, by } }) end
    local worst_sum, steps, last = 0, {}, nil
    for i = 1, 120 do
        ay, by = ay + mm(25 * FRAME_US / 1e6), by + mm(25.5 * FRAME_US / 1e6)
        step(rig, { [0] = { ax, ay }, [1] = { bx, by } })
        local a, b = rig.tp.slots[0], rig.tp.slots[1]
        local exact = a.y + a.oy + b.y + b.oy
        local sent = rig.view.slots[0].y + rig.view.slots[1].y
        worst_sum = math.max(worst_sum, math.abs(sent - exact))
        if last and i > 20 then steps[#steps + 1] = sent / 2 - last end
        last = sent / 2
    end
    local mean = 0
    for _, s in ipairs(steps) do mean = mean + s / #steps end
    local worst_step = 0
    for _, s in ipairs(steps) do worst_step = math.max(worst_step, math.abs(s - mean)) end
    check(string.format("slowly, the fingers' sum is within half a unit of the exact one (%.2f)", worst_sum),
        worst_sum <= 0.5 + 1e-9)
    check(string.format("and each frame's step within half a unit of the mean %.2f (%.2f)", mean, worst_step),
        worst_step <= 0.5 + 1e-9)

    -- Touchpads do not always report both fingers in every frame: here each
    -- frame carries one of them, by twice the step. Measured over a window
    -- they still move together.
    rig = new_rig(L)
    ax, bx, y = mm(45), mm(61), mm(15)
    ay, by = y, y
    step(rig, { [0] = { ax, ay } })
    for _ = 1, 3 do step(rig, { [0] = { ax, ay }, [1] = { bx, by } }) end
    local _, v0 = centroid(rig.view)
    local _, r0 = centroid(rig.raw)
    for i = 1, 250 do
        if i % 2 == 0 then ay = ay + mm(0.16) else by = by + mm(0.16) end
        step(rig, { [0] = { ax, ay }, [1] = { bx, by } })
    end
    local _, v1 = centroid(rig.view)
    local _, r1 = centroid(rig.raw)
    ratio = (v1 - v0) / (r1 - r0)
    -- 10 mm/s; the first 1.2 mm of the 20 pass as they are.
    local expect = (1.2 + 18.8 * P.gain(10, L)) / 20
    check(string.format("with the fingers reported in turn, still about %.3f (%.3f)", expect, ratio),
        near(ratio, expect, 0.05))

    for _, speed in ipairs({ { 0.34, "MacBook" }, { 1, "GNOME" } }) do
        rig = new_rig(speed[1])
        out, raw = two_fingers(rig, { speed = 10, distance = 20 })
        ratio = out / raw
        check(string.format("the %s speed scales slow scrolling to %.3f (%.3f)",
            speed[2], P.gain(10, speed[1]), ratio), near(ratio, P.gain(10, speed[1]), 0.03))
    end
end

print("What is left alone")
do
    local rig = new_rig(L)
    local _, _, out_x, raw_x = two_fingers(rig, { frames = 60, apart = 20 })
    local a, b = rig.view.slots[0], rig.view.slots[1]
    local ra, rb = rig.raw.slots[0], rig.raw.slots[1]
    check("a pinch reaches libinput exactly as the kernel sent it",
        a.x == ra.x and a.y == ra.y and b.x == rb.x and b.y == rb.y,
        string.format("plugin %d,%d %d,%d; kernel %d,%d %d,%d", a.x, a.y, b.x, b.y, ra.x, ra.y, rb.x, rb.y))
    check("and its centre does not move either", out_x == raw_x)

    rig = new_rig(L)
    local touched = 0
    local x, y = mm(40), mm(20)
    for _ = 1, 100 do
        y = y + mm(0.08)
        if step(rig, { [0] = { x, y } }) then touched = touched + 1 end
    end
    check("one finger is never touched", touched == 0)

    rig = new_rig(L)
    local out, raw = two_fingers(rig, { speed = 10, distance = 10, button = true })
    check("two fingers while the pad is pressed down are not touched", out == raw)

    rig = new_rig(L)
    -- The second finger rests in the bottom 10.75 mm (15% of 71.7 mm).
    step(rig, { [0] = { mm(40), mm(20) } })
    local resting = { mm(70), mm(66) }
    local fy = mm(20)
    for _ = 1, 3 do step(rig, { [0] = { mm(40), fy }, [1] = resting }) end
    for _ = 1, 100 do
        fy = fy + mm(0.08)
        step(rig, { [0] = { mm(40), fy }, [1] = { resting[1], resting[2] - mm(0.0) } })
    end
    check("a finger in the button area keeps the other one untouched",
        rig.view.slots[0].y == rig.raw.slots[0].y)

    rig = new_rig(L)
    step(rig, { [0] = { mm(40), mm(20) } })
    fy = mm(20)
    for _ = 1, 60 do
        fy = fy + mm(0.08)
        step(rig, { [0] = { mm(40), fy }, [1] = { mm(56), fy, palm = true } })
    end
    check("nor is anything while one of them is a palm",
        rig.view.slots[0].y == rig.raw.slots[0].y and rig.view.slots[1].y == rig.raw.slots[1].y)

    rig = new_rig(L)
    step(rig, { [0] = { mm(40), mm(20) } })
    fy = mm(20)
    for _ = 1, 60 do
        fy = fy + mm(0.08)
        step(rig, { [0] = { mm(40), fy }, [1] = { mm(56), fy }, [2] = { mm(72), fy } })
    end
    check("three fingers are not touched",
        rig.view.slots[0].y == rig.raw.slots[0].y and rig.view.slots[2].y == rig.raw.slots[2].y)

    rig = new_rig(L)
    -- One finger resting while the other moves: libinput's own call, scroll or
    -- thumb, is made on what the kernel sent.
    step(rig, { [0] = { mm(40), mm(20) } })
    for _ = 1, 3 do step(rig, { [0] = { mm(40), mm(20) }, [1] = { mm(56), mm(20) } }) end
    fy = mm(20)
    for _ = 1, 60 do
        fy = fy + mm(0.08)
        step(rig, { [0] = { mm(40), mm(20) }, [1] = { mm(56), fy } })
    end
    check("one finger resting while the other moves is not touched",
        rig.view.slots[1].y == rig.raw.slots[1].y and rig.view.slots[0].y == rig.raw.slots[0].y)
end

print("Fingers lifting")
do
    local rig = new_rig(L)
    two_fingers(rig, { speed = 10, distance = 20 })
    local before = rig.view.slots[0].y
    local offset = rig.view.slots[0].y - rig.raw.slots[0].y
    check(string.format("a slow scroll leaves the fingers behind where they are (%d units)", offset), offset < -100)
    -- The second finger lifts; the first moves on alone.
    local y = rig.kernel.slots[0].y
    step(rig, { [0] = { rig.kernel.slots[0].x, y } })
    check("lifting the second finger does not move the first", rig.view.slots[0].y == before)
    local jumps = false
    local last_view, last_raw = rig.view.slots[0].y, rig.raw.slots[0].y
    for _ = 1, 30 do
        y = y + mm(0.5)
        step(rig, { [0] = { rig.kernel.slots[0].x, y } })
        jumps = jumps or (rig.view.slots[0].y - last_view) ~= (rig.raw.slots[0].y - last_raw)
        last_view, last_raw = rig.view.slots[0].y, rig.raw.slots[0].y
    end
    check("and it then moves exactly as the kernel says", not jumps)
    step(rig, {})
    step(rig, { [0] = { mm(30), mm(30) } })
    check("its next touch starts without an offset", rig.view.slots[0].y == rig.raw.slots[0].y
        and rig.view.slots[0].x == rig.raw.slots[0].x)

    -- A new touch at exactly where the last one in its slot left off: the
    -- kernel sends no position for it, and libinput must still be told.
    rig = new_rig(L)
    two_fingers(rig, { speed = 10, distance = 20 })
    local kx, ky = rig.kernel.slots[1].x, rig.kernel.slots[1].y
    step(rig, { [0] = { rig.kernel.slots[0].x, rig.kernel.slots[0].y } })
    step(rig, { [0] = { rig.kernel.slots[0].x, rig.kernel.slots[0].y }, [1] = { kx, ky } })
    check("a finger put down where the last one in its slot lifted is reported where it is",
        rig.view.slots[1].y == ky and rig.view.slots[1].x == kx,
        string.format("libinput has %d,%d, the kernel %d,%d", rig.view.slots[1].x, rig.view.slots[1].y, kx, ky))
end

print("Remainders")
do
    local rig = new_rig(L)
    local x, y = mm(45), mm(15)
    step(rig, { [0] = { x, y } })
    for _ = 1, 3 do step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } }) end
    -- One device unit per frame, 5.2 mm/s: every frame's share is a seventh
    -- of a unit, and only by keeping the fractions does that add up. Counted
    -- once the first START_MM is past.
    for _ = 1, 60 do
        y = y + 1
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    local _, y0 = centroid(rig.view)
    for _ = 1, 300 do
        y = y + 1
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    local _, y1 = centroid(rig.view)
    local want = 300 * P.gain(1e6 / FRAME_US / RES, L)
    check(string.format("300 single units at the slow end make %.1f (%.1f)", want, y1 - y0), near(y1 - y0, want, 2))
end

print("The edges of the touchpad")
do
    local rig = new_rig(L)
    local x, y = mm(45), mm(60)
    step(rig, { [0] = { x, y } })
    for _ = 1, 3 do step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } }) end
    -- Slowly up, gathering an offset downwards, then fast up to the very top.
    for _ = 1, 400 do
        y = y - mm(0.08)
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    for _ = 1, 40 do
        y = math.max(0, y - mm(1.5))
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    for _ = 1, 400 do
        y = y + mm(0.08)
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    for _ = 1, 40 do
        y = math.min(ABSY.maximum, y + mm(1.5))
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
    end
    check("no position is ever outside the touchpad", not rig.out_of_range)
end

print("Before the kernel has named a slot")
do
    local tp = P.touchpad(ABSX, ABSY, L)
    local frame = {
        { usage = evdev.ABS_MT_TRACKING_ID, value = 7 },
        { usage = evdev.ABS_MT_POSITION_X, value = 1000 },
        { usage = evdev.ABS_MT_POSITION_Y, value = 500 },
        { usage = evdev.BTN_TOUCH, value = 1 },
    }
    check("frames are passed through as they are", P.frame(tp, frame, 1000) == nil)

    -- Just after login: the kernel is still on slot 0 from boot and never
    -- names it for the first finger. The second finger names its own slot,
    -- the first one's next move names slot 0, and from there on the pair is
    -- shaped like any other (unnamed_event()); a touch that began before
    -- libinput opened the touchpad is left alone (below).
    local rig = new_rig(L, 0)
    local x, y = mm(45), mm(15)
    step(rig, { [0] = { x, y } })
    for _ = 1, 3 do step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } }) end
    local untouched = true
    for _ = 1, 100 do
        x, y = x + 1, y + mm(0.08)
        step(rig, { [0] = { x, y }, [1] = { x + mm(16), y } })
        untouched = untouched and rig.view.slots[0].y == rig.raw.slots[0].y
            and rig.view.slots[1].y == rig.raw.slots[1].y
    end
    check("from a cold start, the first two fingers (slot 0 never named) are shaped", not untouched)
    check("and the plugin never names a slot the kernel is not on",
        not rig.slot_mismatch and not rig.out_of_range)

    -- The kernel left on slot 3 by the last session, the first finger in it.
    rig = new_rig(L, 3)
    x, y = mm(45), mm(15)
    step(rig, { [3] = { x, y } })
    for _ = 1, 3 do step(rig, { [3] = { x, y }, [0] = { x + mm(16), y } }) end
    untouched = true
    for _ = 1, 100 do
        x, y = x + 1, y + mm(0.08)
        step(rig, { [3] = { x, y }, [0] = { x + mm(16), y } })
        untouched = untouched and rig.view.slots[3].y == rig.raw.slots[3].y
    end
    check("from slot 3, its first finger unnamed: shaped once named, no slot mixed up",
        not untouched and not rig.slot_mismatch and not rig.out_of_range)
    step(rig, {})
    step(rig, {})
    local out, raw = two_fingers(rig, { speed = 10, distance = 20 })
    check(string.format("and the next two-finger touch is slowed (%.3f)", out / raw), near(out / raw, P.gain(10, L), 0.03))
    check("without a position outside the touchpad or a slot left selected",
        not rig.out_of_range and not rig.slot_mismatch)
    check("a touchpad without a resolution is left alone",
        P.touchpad({ minimum = 0, maximum = 100, resolution = 0 }, ABSY, L) == nil)
end

print("Registering with libinput")
do
    local calls = {}
    local fake = {}
    function fake:register(versions) calls.register = versions; return 1 end
    function fake:connect(name, fn) calls[name] = fn end
    function fake:log_info(_) end
    function fake:log_error(_) end
    load_plugin({ libinput = fake })
    check("it registers for version 1 of the plugin API",
        calls.register and calls.register[1] == 1 and #calls.register == 1)
    check("and listens for new devices", type(calls["new-evdev-device"]) == "function")

    local function device(props, absinfos)
        local d = { handlers = {} }
        function d:udev_properties() return props end
        function d:usages()
            return {
                [evdev.ABS_MT_SLOT] = true, [evdev.ABS_MT_TRACKING_ID] = true,
                [evdev.ABS_MT_POSITION_X] = true, [evdev.ABS_MT_POSITION_Y] = true,
            }
        end
        function d:absinfos() return absinfos end
        function d:name() return "Fake Touchpad" end
        function d:connect(name, fn) self.handlers[name] = fn end
        return d
    end
    local touchpad = device({ ID_INPUT = "1", ID_INPUT_TOUCHPAD = "1" },
        { [evdev.ABS_MT_POSITION_X] = ABSX, [evdev.ABS_MT_POSITION_Y] = ABSY })
    calls["new-evdev-device"](touchpad)
    check("a touchpad gets a frame handler", type(touchpad.handlers["evdev-frame"]) == "function")
    check("and is let go of when it is removed", type(touchpad.handlers["device-removed"]) == "function")
    local mouse = device({ ID_INPUT = "1", ID_INPUT_MOUSE = "1" }, {})
    calls["new-evdev-device"](mouse)
    check("a mouse does not", mouse.handlers["evdev-frame"] == nil)
    local blind = device({ ID_INPUT = "1", ID_INPUT_TOUCHPAD = "1" },
        { [evdev.ABS_MT_POSITION_X] = { minimum = 0, maximum = 100, resolution = 0 },
          [evdev.ABS_MT_POSITION_Y] = ABSY })
    calls["new-evdev-device"](blind)
    check("nor a touchpad without a resolution", blind.handlers["evdev-frame"] == nil)
end

print("The engine's fail-safe")
do
    -- A libinput with one plugin timer that behaves as libinput's does: an
    -- expired timer is run again at once, with the same now, while it keeps
    -- asking for a moment not after now (timer.c, goto restart).
    local function harness(misbehave)
        local f = assert(io.open(plugin_path))
        local source = f:read("a"):gsub("\nlocal ENGINE = %a+\n", "\nlocal ENGINE = true\n", 1)
        f:close()
        local h = { errors = {}, infos = {}, calls = 0, expiry = nil, cancelled = 0 }
        local fake = {}
        function fake:register() return 1 end
        function fake:connect(name, fn) h[name] = fn end
        function fake:log_info(m) h.infos[#h.infos + 1] = m end
        function fake:log_error(m) h.errors[#h.errors + 1] = m end
        function fake:log_debug(_) end
        function fake:now() return h.now end
        function fake:timer_set_absolute(t) h.expiry = t end
        function fake:timer_cancel() h.expiry = nil; h.cancelled = h.cancelled + 1 end
        h.M = load_plugin({ libinput = fake }, source)
        if misbehave then
            h.M.tick = misbehave
        end
        local d = { handlers = {}, appended = 0 }
        function d:udev_properties() return { ID_INPUT_TOUCHPAD = "1" } end
        function d:usages()
            return { [evdev.ABS_MT_SLOT] = true, [evdev.ABS_MT_TRACKING_ID] = true,
                     [evdev.ABS_MT_POSITION_X] = true, [evdev.ABS_MT_POSITION_Y] = true }
        end
        function d:absinfos() return { [evdev.ABS_MT_POSITION_X] = ABSX, [evdev.ABS_MT_POSITION_Y] = ABSY } end
        function d:name() return "Fake Touchpad" end
        function d:connect(name, fn) self.handlers[name] = fn end
        function d:append_frame(_) self.appended = self.appended + 1 end
        function d:prepend_frame(_) end
        h["new-evdev-device"](d)
        h.device = d
        -- Run libinput's timers up to `until_us`, as its dispatch does; how
        -- many times the plugin's timer ran, and the most at one moment.
        function h.run(until_us)
            local most = 0
            while h.expiry and h.expiry <= until_us do
                local now = math.max(h.expiry, h.now or 0)
                h.now = now
                local here = 0
                while h.expiry and h.expiry <= now and here < 100000 do
                    h.expiry = nil
                    h.calls = h.calls + 1
                    here = here + 1
                    h["timer-expired"](now)
                end
                most = math.max(most, here)
                if here >= 100000 then return most end
                if h.expiry and h.expiry <= now then h.expiry = now + 1 end
            end
            h.now = until_us
            return most
        end
        return h
    end
    -- A flick on the fake touchpad, so the engine has fingers and a glide.
    local function flick(h)
        local kernel = new_kernel(4)
        local t0 = 1000000
        local y = mm(15)
        for i = 0, 30 do
            local fingers = i < 30 and { [0] = { mm(45), y }, [1] = { mm(61), y } } or {}
            local frame = kernel:frame(fingers)
            h.now = t0 + i * 7000
            h.device.handlers["evdev-frame"](h.device, copy(frame), h.now - 1000)
            h.run(h.now)
            y = y + mm(0.8)
        end
        return h.now
    end

    local h = harness()
    local t = flick(h)
    h.run(t + 3000000)
    check(string.format("as written: the flick glides and comes to rest (%d timer runs, no error)", h.calls),
        h.calls > 100 and #h.errors == 0)

    -- The bug of 2026-10-14, put back: asking for the past forever.
    local real_tick
    h = harness(function(tp, now)
        local frames = real_tick(tp, now)
        tp.engine.timer, tp.engine.asked_past = now - 20000, true
        return frames
    end)
    real_tick = load_plugin().tick
    t = flick(h)
    local most = h.run(t + 3000000)
    check(string.format("a timer that asks for the past: engine off after %d runs, at most %d at one moment",
        h.calls, most), h.calls <= 40 and most <= 2 and #h.errors == 1 and h.errors[1]:find("asked for the past"),
        table.concat(h.errors, " | "))
    check("and its fingers let go, its timer cancelled, nothing more from it",
        h.expiry == nil and h.cancelled >= 1 and h.run(t + 6000000) == 0)

    -- A timer that never asks for the past, yet runs far too often.
    h = harness(function(tp, now)
        local frames = real_tick(tp, now)
        tp.engine.timer = now + 1
        return frames
    end)
    t = flick(h)
    h.run(t + 3000000)
    check(string.format("a timer running every 0.5 ms: engine off after %d runs", h.calls),
        h.calls <= 1100 and #h.errors == 1 and h.errors[1]:find("within a second"), table.concat(h.errors, " | "))

    -- An error in the engine.
    h = harness(function() error("boom") end)
    t = flick(h)
    h.run(t + 3000000)
    check("an error in the engine: off, one line in the log", #h.errors == 1 and h.errors[1]:find("boom"))
    -- The touchpad keeps plain acceleration at the speed line's level, and a
    -- touchpad added later (a resume) does not bring the engine back.
    local d2 = { handlers = {} }
    for k, v in pairs(h.device) do d2[k] = v end
    d2.handlers = {}
    h.infos = {}
    h["new-evdev-device"](d2)
    check("a touchpad added after: acceleration only", h.infos[1] and not h.infos[1]:find("engine"),
        tostring(h.infos[1]))
    local before = h.calls
    flick(h)
    check("and the first one scrolls on without the engine (no timer runs)", h.calls == before)
end

print("The speed line Pear Up rewrites")
do
    local f = assert(io.open(plugin_path))
    local source = f:read("a")
    f:close()
    local count = 0
    for _ in source:gmatch("\nlocal SPEED = [%d.]+\n") do count = count + 1 end
    check("there is exactly one SPEED line, as prefs.js expects", count == 1)
    local strong = source:gsub("\nlocal SPEED = [%d.]+\n", "\nlocal SPEED = 0.34\n")
    local calls = {}
    local fake = {}
    function fake:register() return 1 end
    function fake:connect(name, fn) calls[name] = fn end
    function fake:log_info(_) end
    local Q = load_plugin({ libinput = fake }, strong)
    local d = { handlers = {} }
    function d:udev_properties() return { ID_INPUT_TOUCHPAD = "1" } end
    function d:usages()
        return { [evdev.ABS_MT_SLOT] = true, [evdev.ABS_MT_TRACKING_ID] = true,
                 [evdev.ABS_MT_POSITION_X] = true, [evdev.ABS_MT_POSITION_Y] = true }
    end
    function d:absinfos() return { [evdev.ABS_MT_POSITION_X] = ABSX, [evdev.ABS_MT_POSITION_Y] = ABSY } end
    function d:name() return "Fake Touchpad" end
    function d:connect(name, fn) self.handlers[name] = fn end
    calls["new-evdev-device"](d)
    -- Drive the handler the way libinput would and measure the slow gain.
    local kernel, view, raw = new_kernel(4), new_view(4), new_view(4)
    local function feed(fingers)
        local frame, t = kernel:frame(fingers)
        apply(raw, frame)
        apply(view, d.handlers["evdev-frame"](d, copy(frame), t) or frame)
    end
    local y = mm(15)
    feed({ [0] = { mm(45), y } })
    for _ = 1, 3 do feed({ [0] = { mm(45), y }, [1] = { mm(61), y } }) end
    for _ = 1, 30 do
        y = y + mm(0.08)
        feed({ [0] = { mm(45), y }, [1] = { mm(61), y } })
    end
    local _, v0 = centroid(view)
    local _, r0 = centroid(raw)
    for _ = 1, 250 do
        y = y + mm(0.08)
        feed({ [0] = { mm(45), y }, [1] = { mm(61), y } })
    end
    local _, v1 = centroid(view)
    local _, r1 = centroid(raw)
    local ratio = (v1 - v0) / (r1 - r0)
    check(string.format("a copy with 0.34 written in scrolls 10 mm/s at %.3f (%.3f)", P.gain(10, 0.34), ratio),
        near(ratio, P.gain(10, 0.34), 0.03))
    check("the module it returns is the same arithmetic, at 0.34", near(Q.gain(80), 0.34, 1e-9))
end

print()
if failed > 0 then
    print(string.format("%d of %d checks failed", failed, failed + passed))
    os.exit(1)
end
print(string.format("All %d checks passed", passed))

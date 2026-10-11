-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Pear Up: scrolling with two fingers on a touchpad, accelerated as macOS does.
--
-- libinput scrolls by a fixed amount for every millimetre two fingers travel,
-- about 10.5 scroll units, however slowly or quickly they go. macOS scrolls a
-- slow movement less than a quick one, so a page can be nudged a line at a time
-- and still be flung to the end. This plugin gives libinput that curve.
--
-- A libinput plugin (libinput 1.30 and later, see "Lua Plugins" in its
-- documentation) sees each frame of events the touchpad sends before libinput
-- does, and may rewrite it. While exactly two fingers move together, this one
-- scales the movement they share by a gain that depends on how fast they go,
-- and moves both fingers' reported positions by the difference. libinput's
-- two-finger scrolling follows the average movement of the fingers, so it
-- follows the gain; nothing else in libinput is changed or reimplemented.
--
--   finger speed      gain
--   up to 20 mm/s     SLOW_GAIN (0.35 at Pear Up's medium strength)
--   20 to 80 mm/s     rising smoothly to 1, libinput's own rate
--   80 to 200 mm/s    rising smoothly to 1.15, for a flick
--
-- What is left alone:
--   - one finger, three or more, a palm, and anything while the touchpad is
--     pressed down: pointer motion, swipes and click-dragging are as libinput
--     makes them;
--   - fingers in the bottom 10 mm (or 15%, if taller), where the clickpad's
--     button areas and libinput's thumb detection are;
--   - movement the fingers do not share. Only the common part is scaled, and
--     only as far as the fingers move alike, so a pinch, a rotation or one
--     finger resting while the other moves are passed through as they are;
--   - a touch that began before the plugin could tell which slot it is in.
--     The kernel names a slot only when it changes, so just after login the
--     first finger is often unnamed until a second one comes, and that one
--     gesture is libinput's own;
--   - anything but a touchpad.
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

-- Pear Up's preferences write the strength chosen there into the next line when
-- they install this file. It is the gain for slow movement: 1 would change
-- nothing, smaller is a slower start.
local SLOW_GAIN = 0.35

local SLOW_SPEED = 20       -- mm/s; at or below this the gain is SLOW_GAIN
local NORMAL_SPEED = 80     -- mm/s; here the gain is 1, libinput's own rate
local FLICK_SPEED = 200     -- mm/s; from here the gain is FLICK_GAIN
local FLICK_GAIN = 1.15
local WINDOW = 50000        -- µs of movement the speed is measured over
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

-- The gain for fingers moving at `speed` mm/s.
function M.gain(speed, slow_gain)
    if speed <= NORMAL_SPEED then
        local t = (speed - SLOW_SPEED) / (NORMAL_SPEED - SLOW_SPEED)
        return slow_gain + (1 - slow_gain) * smoothstep(t)
    end
    local t = (speed - NORMAL_SPEED) / (FLICK_SPEED - NORMAL_SPEED)
    return 1 + (FLICK_GAIN - 1) * smoothstep(t)
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
function M.touchpad(absx, absy, slow_gain)
    if not absx or not absy or (absx.resolution or 0) <= 0 or (absy.resolution or 0) <= 0 then
        return nil
    end
    local height = (absy.maximum - absy.minimum) / absy.resolution
    local zone = math.max(BOTTOM_MM, height * BOTTOM_SHARE)
    return {
        xmin = absx.minimum, xmax = absx.maximum, xres = absx.resolution,
        ymin = absy.minimum, ymax = absy.maximum, yres = absy.resolution,
        bottom = absy.maximum - zone * absy.resolution,
        slow_gain = slow_gain or SLOW_GAIN,
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
    local gain = 1 + (M.gain(speed, tp.slow_gain) - 1) * M.together(ax, ay, bx, by)

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

-- Takes one evdev frame and returns it rewritten, or nil when libinput may
-- have it as it is.
function M.frame(tp, frame, time)
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
        elseif usage == ABS_MT_TRACKING_ID then
            if tp.slot then
                local f = slot_state(tp, tp.slot)
                f.ox, f.oy, f.palm = 0, 0, false
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

    -- The positions in the frame, rewritten.
    local changed = false
    local carried = {}
    for _, p in ipairs(positions) do
        local index, slot, axis = p[1], p[2], p[3]
        local f = slots[slot]
        local value = frame[index].value
        if f.down and f["out" .. axis] then
            value = f["out" .. axis]
            if value ~= frame[index].value then
                frame[index].value = value
                changed = true
            end
        end
        f["sent" .. axis] = value
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
        if f.down and f.outx and f.outy then
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

    if changed then
        return frame
    end
    return nil
end

if libinput then
    libinput:register({ 1 })
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
        local tp = M.touchpad(absinfos[ABS_MT_POSITION_X], absinfos[ABS_MT_POSITION_Y], SLOW_GAIN)
        if not tp then
            libinput:log_info("Pear Up scroll acceleration: " .. device:name() .. " reports no resolution, left as it is")
            return
        end
        libinput:log_info("Pear Up scroll acceleration: " .. device:name())
        device:connect("evdev-frame", function(_, frame, time)
            if tp then
                return M.frame(tp, frame, time)
            end
        end)
        device:connect("device-removed", function()
            tp = nil
        end)
    end)
end

return M

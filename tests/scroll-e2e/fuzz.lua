#!/usr/bin/env lua5.4
-- Throws random touchpad frames at the scroll plugin with the Mac scroll
-- engine on, its timer firing in between, and checks that it never raises an
-- error (libinput would unload it: libinput-plugin-lua.c, "unloading after
-- error"), only ever hands libinput positions inside the touchpad, and leaves
-- no finger down for libinput once the real ones are all up and the timer has
-- run out. The last is what matters most: a finger left down would turn every
-- later touch into a scroll until the next login.
--
--   lua fuzz.lua <plugin.lua> [runs] [seed]

local plugin_path, runs, seed = arg[1], tonumber(arg[2] or "300"), tonumber(arg[3] or "1")

local function usage(type, code) return (type << 16) | code end
local EV_KEY, EV_ABS, EV_MSC = 1, 3, 4
local evdev = {
    ABS_X = usage(EV_ABS, 0x00), ABS_Y = usage(EV_ABS, 0x01),
    ABS_MT_SLOT = usage(EV_ABS, 0x2f), ABS_MT_POSITION_X = usage(EV_ABS, 0x35),
    ABS_MT_POSITION_Y = usage(EV_ABS, 0x36), ABS_MT_TOOL_TYPE = usage(EV_ABS, 0x37),
    ABS_MT_TRACKING_ID = usage(EV_ABS, 0x39), BTN_LEFT = usage(EV_KEY, 0x110),
    BTN_TOOL_FINGER = usage(EV_KEY, 0x145), BTN_TOOL_QUINTTAP = usage(EV_KEY, 0x148),
    BTN_TOUCH = usage(EV_KEY, 0x14a), BTN_TOOL_DOUBLETAP = usage(EV_KEY, 0x14d),
    BTN_TOOL_TRIPLETAP = usage(EV_KEY, 0x14e), BTN_TOOL_QUADTAP = usage(EV_KEY, 0x14f),
    MSC_TIMESTAMP = usage(EV_MSC, 0x05),
}
local source = assert(io.open(plugin_path)):read("a")
source = source:gsub("\nlocal ENGINE = %a+\n", "\nlocal ENGINE = true\n", 1)
local env = {
    assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs, tonumber = tonumber,
    pcall = pcall, select = select, print = print, tostring = tostring, type = type, xpcall = xpcall,
    table = table, string = string, math = math, _VERSION = _VERSION, evdev = evdev,
}
local M = assert(load(source, "=plugin", "t", env))()
local XMAX, YMAX = 2830, 1720
math.randomseed(seed)

local failures = 0
local seen = {}
local function fail(run, msg)
    failures = failures + 1
    if failures <= 10 then
        print(string.format("  FAIL run %d: %s", run, msg))
    end
end

for run = 1, runs do
    local tp = M.touchpad({ minimum = 0, maximum = XMAX, resolution = 24 },
        { minimum = 0, maximum = YMAX, resolution = 24 }, M.ENGINE_SPEED)
    M.engine(tp)
    -- libinput's side: slot -> tracking id, keys, selected slot.
    -- The kernel starts on any slot (where the last session left it).
    local start_slot = math.random(0, 4)
    local view, vkeys, vslot = {}, {}, start_slot
    local fingers = {}
    -- libinput's jump rule (evdev-mt-touchpad.c, tp_detect_jumps): every
    -- frame records each touch; a touch that moved is a jump when its move,
    -- scaled from the time since the last frame to 12 ms, is over 20 mm, or
    -- 7 mm more than its last move. A frame of the engine's timer that does
    -- this to a finger that is down throws real motion away.
    local hist, lastdelta, vpos = {}, {}, {}
    local function jumps_in(frame, time)
        local moved = {}
        local s = vslot
        for _, e in ipairs(frame) do
            if e.usage == evdev.ABS_MT_SLOT then
                s = e.value
            elseif e.usage == evdev.ABS_MT_TRACKING_ID then
                hist[s], lastdelta[s] = nil, 0
            elseif e.usage == evdev.ABS_MT_POSITION_X or e.usage == evdev.ABS_MT_POSITION_Y then
                local p = vpos[s] or {}
                p[e.usage == evdev.ABS_MT_POSITION_X and 1 or 2] = e.value
                vpos[s] = p
                moved[s] = true
            end
        end
        local found = {}
        for slot in pairs(view) do
            local h, p = hist[slot], vpos[slot]
            if h and p and p[1] and p[2] and moved[slot] then
                local dt = time - h.t
                if dt > 0 and dt <= 30000 then
                    local d = math.sqrt(((p[1] - h.x) / 24) ^ 2 + ((p[2] - h.y) / 24) ^ 2) * 12000 / dt
                    if d > 20 or d - (lastdelta[slot] or 0) > 7 then
                        found[#found + 1] = slot
                        hist[slot] = nil
                    end
                    lastdelta[slot] = d
                end
            end
            if p and p[1] and p[2] then
                hist[slot] = { t = time, x = p[1], y = p[2] }
            end
        end
        return found
    end
    local function feed(frame, time, from_timer)
        if time then
            for _, slot in ipairs(jumps_in(frame, time)) do
                -- Paced fingers carry real motion while in contact; while
                -- they glide or rest they are the engine's own (a finger
                -- left down after a lift is hidden until it moves), and the
                -- glide's recentring is a jump on purpose.
                if from_timer and fingers[slot] and tp.engine and tp.engine.mode == "contact" then
                    fail(run, string.format("a paced step at %d is a jump to libinput for slot %d, a finger down (mode %s)",
                        time, slot, tostring(tp.engine and tp.engine.mode)))
                end
            end
        end
        for _, e in ipairs(frame) do
            if e.usage == evdev.ABS_MT_SLOT then
                vslot = e.value
            elseif e.usage == evdev.ABS_MT_TRACKING_ID then
                view[vslot] = e.value >= 0 and e.value or nil
            elseif e.usage == evdev.ABS_MT_POSITION_X and (e.value < 0 or e.value > XMAX) then
                fail(run, "x out of range: " .. e.value)
            elseif e.usage == evdev.ABS_MT_POSITION_Y and (e.value < 0 or e.value > YMAX) then
                fail(run, "y out of range: " .. e.value)
            elseif e.usage >> 16 == EV_KEY then
                vkeys[e.usage] = e.value
            end
        end
    end
    -- The kernel's side.
    local t, kslot, ids, keys = 1000000, start_slot, 0, {}
    local function tick_until(limit)
        while tp.engine and tp.engine.timer and tp.engine.timer < limit do
            local now = math.floor(tp.engine.timer)
            local ok, frames = pcall(M.tick, tp, now)
            if not ok then
                fail(run, "tick: " .. tostring(frames))
                return false
            end
            for _, f in ipairs(frames) do feed(f, now, true) end
            -- libinput runs an expired timer again at once with the same now:
            -- a tick that asks for the past would spin its input thread.
            if tp.engine and tp.engine.timer and tp.engine.timer <= now then
                fail(run, string.format("tick at %d asked for its timer at %d (mode %s)", now,
                    math.floor(tp.engine.timer), tostring(tp.engine.mode)))
                return false
            end
        end
        return true
    end
    local alive = true
    run_vy = 0
    local steps = math.random(20, 400)
    for _ = 1, steps do
        if not alive then break end
        t = t + (math.random(1, 4) == 1 and math.random(1, 300000) or 7000)
        -- Change the fingers now and then; move them always.
        local frame = {}
        local function ev(u, v) frame[#frame + 1] = { usage = u, value = v } end
        local r = math.random()
        local count = 0
        for _ in pairs(fingers) do count = count + 1 end
        if count == 0 and math.random() < 0.3 then
            -- Two fingers come down together, to scroll: the way to a glide.
            -- Often the first in the slot the kernel is on, unnamed.
            local pair = { 0, 1 }
            if math.random() < 0.5 then pair = { kslot, kslot == 0 and 1 or 0 } end
            for _, s in ipairs(pair) do
                ids = ids + 1
                if s ~= kslot then ev(evdev.ABS_MT_SLOT, s); kslot = s end
                ev(evdev.ABS_MT_TRACKING_ID, ids)
                fingers[s] = { 900 + (s % 2) * 400, math.random(600, 1300) }
                ev(evdev.ABS_MT_POSITION_X, fingers[s][1])
                ev(evdev.ABS_MT_POSITION_Y, fingers[s][2])
            end
        elseif count == 2 and math.random() < 0.06 then
            -- Both lift at once, or one.
            for s in pairs(fingers) do
                if math.random() < 0.8 then
                    if s ~= kslot then ev(evdev.ABS_MT_SLOT, s); kslot = s end
                    ev(evdev.ABS_MT_TRACKING_ID, -1)
                    fingers[s] = nil
                end
            end
        elseif r < 0.04 then
            local s = math.random(0, 4)
            if fingers[s] then
                if s ~= kslot then ev(evdev.ABS_MT_SLOT, s); kslot = s end
                ev(evdev.ABS_MT_TRACKING_ID, -1)
                fingers[s] = nil
            else
                ids = ids + 1
                if s ~= kslot then ev(evdev.ABS_MT_SLOT, s); kslot = s end
                ev(evdev.ABS_MT_TRACKING_ID, ids)
                fingers[s] = { math.random(0, XMAX), math.random(0, YMAX) }
                ev(evdev.ABS_MT_POSITION_X, fingers[s][1])
                ev(evdev.ABS_MT_POSITION_Y, fingers[s][2])
                if math.random() < 0.05 then ev(evdev.ABS_MT_TOOL_TYPE, 2) end
            end
        elseif r < 0.1 then
            ev(evdev.BTN_LEFT, (keys[evdev.BTN_LEFT] or 0) == 1 and 0 or 1)
            keys[evdev.BTN_LEFT] = frame[#frame].value
        end
        run_vy = (math.random() < 0.1) and (math.random() - 0.5) * 500 or run_vy
        local vy = run_vy
        for s, f in pairs(fingers) do
            if math.random() < 0.9 then
                f[1] = math.max(0, math.min(XMAX, f[1] + math.random(-20, 20)))
                f[2] = math.max(0, math.min(YMAX, math.floor(f[2] + vy * 0.007 * 24 + math.random(-3, 3))))
                if s ~= kslot then ev(evdev.ABS_MT_SLOT, s); kslot = s end
                ev(evdev.ABS_MT_POSITION_X, f[1])
                ev(evdev.ABS_MT_POSITION_Y, f[2])
            end
        end
        local n = 0
        for _ in pairs(fingers) do n = n + 1 end
        for u, on in pairs({ [evdev.BTN_TOUCH] = n > 0, [evdev.BTN_TOOL_FINGER] = n == 1,
                             [evdev.BTN_TOOL_DOUBLETAP] = n == 2, [evdev.BTN_TOOL_TRIPLETAP] = n == 3,
                             [evdev.BTN_TOOL_QUADTAP] = n == 4 }) do
            local v = on and 1 or 0
            if (keys[u] or 0) ~= v then ev(u, v); keys[u] = v end
        end
        ev(evdev.MSC_TIMESTAMP, t & 0x7fffffff)
        alive = tick_until(t + 1000)
        if alive then
            local copy = {}
            for i, e in ipairs(frame) do copy[i] = { usage = e.usage, value = e.value } end
            local ok, result = pcall(M.frame, tp, copy, t, t + 1000)
            if not ok then
                fail(run, "frame: " .. tostring(result))
                alive = false
            else
                for _, f in ipairs(tp.engine.prepend) do feed(f, t) end
                tp.engine.prepend = {}
                if result == nil then feed(frame, t) elseif #result > 0 then feed(result, t) end
                seen[tp.engine.mode] = (seen[tp.engine.mode] or 0) + 1
            end
        end
    end
    -- All fingers up, the button too, then let the timer run out.
    if alive then
        local frame = {}
        for s in pairs(fingers) do
            frame[#frame + 1] = { usage = evdev.ABS_MT_SLOT, value = s }
            frame[#frame + 1] = { usage = evdev.ABS_MT_TRACKING_ID, value = -1 }
        end
        for u, v in pairs(keys) do
            if v ~= 0 then frame[#frame + 1] = { usage = u, value = 0 } end
        end
        t = t + 7000
        tick_until(t + 1000)
        local ok, result = pcall(M.frame, tp, frame, t, t + 1000)
        if not ok then
            fail(run, "last frame: " .. tostring(result))
        else
            for _, f in ipairs(tp.engine.prepend) do feed(f) end
            if result == nil then feed(frame) elseif #result > 0 then feed(result) end
            tick_until(t + 5000000)
            for s, id in pairs(view) do fail(run, string.format("libinput left with a finger in slot %d (id %d)", s, id)) end
            for u, v in pairs(vkeys) do
                if v ~= 0 then fail(run, string.format("libinput left with key %x down", u & 0xffff)) end
            end
            if tp.engine.mode ~= "idle" then fail(run, "engine not idle: " .. tp.engine.mode) end
        end
    end
end
if failures > 0 then
    print(string.format("  %d failures in %d random runs", failures, runs))
    os.exit(1)
end
local modes = {}
for k, v in pairs(seen) do modes[#modes + 1] = k .. " " .. v end
table.sort(modes)
print(string.format("  ok   %d random runs (seed %d): no error, positions in range, nothing left down (frames by mode: %s)",
    runs, seed, table.concat(modes, ", ")))

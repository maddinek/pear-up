#!/usr/bin/env lua5.4
-- Runs the scroll plugin over a recording of what a touchpad sends, with a
-- clock of its own, and writes what libinput would be handed: the touchpad's
-- frames as the plugin rewrote them and the frames its timer adds, each at the
-- time libinput would have it. The timer fires exactly when asked, as a
-- timerfd does on an idle machine; everything else is the plugin's own code,
-- loaded in the sandbox libinput gives it.
--
--   lua simulate.lua <plugin.lua> <engine:true|false> <in.events> <out.events> [speed]
--
-- Both files are umockdev's evemu format ("E: <sec>.<usec> <type> <code>
-- <value>", hex type and code), so the output can be replayed into real
-- libinput without the plugin (tests/scroll-e2e/stream.py does).

local plugin_path, engine, input, output, speed = arg[1], arg[2] == "true", arg[3], arg[4], arg[5]
local LAG = 1000 -- µs the touchpad's timestamps run behind the clock

local function usage(type, code)
    return (type << 16) | code
end
local EV_SYN, EV_KEY, EV_ABS, EV_MSC = 0, 1, 3, 4
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
source = source:gsub("\nlocal ENGINE = %a+\n", "\nlocal ENGINE = " .. tostring(engine) .. "\n", 1)
if speed then
    source = source:gsub("\nlocal SPEED = [%d.]+\n", "\nlocal SPEED = " .. speed .. "\n", 1)
end
local env = {
    assert = assert, error = error, ipairs = ipairs, next = next, pairs = pairs,
    tonumber = tonumber, pcall = pcall, select = select, print = print,
    tostring = tostring, type = type, xpcall = xpcall, table = table,
    string = string, math = math, _VERSION = _VERSION, evdev = evdev,
}
local M = assert(load(source, "=plugin", "t", env))()

-- framy's touchpad, as tests/libinput/check-with-libinput.py makes it up.
local absx = { minimum = 0, maximum = 2830, resolution = 24 }
local absy = { minimum = 0, maximum = 1720, resolution = 24 }
local tp
if engine then
    -- As the plugin registers itself with the engine on: finer positions
    -- (libinput is told the scaled absinfo) and the Mac's speed.
    tp = M.touchpad(M.scaled(absx, M.SCALE), M.scaled(absy, M.SCALE), M.ENGINE_SPEED, M.SCALE)
    M.engine(tp)
else
    tp = M.touchpad(absx, absy)
end

-- The recording, as frames.
local frames, current = {}, {}
for line in io.lines(input) do
    local sec, usec, t, c, v = line:match("^E: (%d+)%.(%d+) (%x+) (%x+) (%-?%d+)")
    if sec then
        local time = tonumber(sec) * 1000000 + tonumber(usec)
        local type, code, value = tonumber(t, 16), tonumber(c, 16), tonumber(v)
        if type == EV_SYN then
            frames[#frames + 1] = { time = time, events = current }
            current = {}
        else
            current[#current + 1] = { usage = usage(type, code), value = value }
        end
    end
end

local out = assert(io.open(output, "w"))
local function write(time, events)
    local sec, usec = time // 1000000, time % 1000000
    for _, e in ipairs(events) do
        out:write(string.format("E: %d.%06d %04x %04x %d\n", sec, usec, e.usage >> 16, e.usage & 0xffff, e.value))
    end
    out:write(string.format("E: %d.%06d 0000 0000 0\n", sec, usec))
end
local function timer_due()
    return tp.engine and tp.engine.timer
end

local last_time = frames[#frames] and frames[#frames].time or 0
local function run_timers(before)
    while true do
        local due = timer_due()
        if not due or due >= before then
            return
        end
        local now = math.floor(due)
        for _, f in ipairs(M.tick(tp, now)) do
            write(now, f)
        end
        if tp.engine.timer and tp.engine.timer <= now then
            tp.engine.timer = now + 1
        end
    end
end

for _, f in ipairs(frames) do
    run_timers(f.time + LAG)
    local result = M.frame(tp, f.events, f.time, f.time + LAG)
    if tp.engine then
        for _, before in ipairs(tp.engine.prepend) do
            write(f.time, before)
        end
        tp.engine.prepend = {}
    end
    if result == nil then
        write(f.time, f.events)
    elseif #result > 0 then
        write(f.time, result)
    end
end
-- And whatever the timer still has to do, up to three seconds on.
run_timers(last_time + 3000000)
out:close()

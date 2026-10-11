#!/usr/bin/env lua5.4
-- Drive the macOS keys plugin with keys of our own, pressed and let go the
-- way a keyboard sends them, and check what libinput would be told.
--
--   lua tests/libinput/check-macos-keys.lua [plugin.lua]
--
-- The plugin is loaded the way libinput loads it: in a sandbox holding only the
-- globals libinput's documentation lists. libinput itself is left out (its
-- `libinput` global is absent, which the plugin takes as "do not register"),
-- and then stood in for by a fake at the end, to check the registration, the
-- lines Pear Up's preferences write, and what happens after an error.

local here = arg[0]:match("^(.*)/[^/]*$") or "."
local plugin_path = arg[1] or (here .. "/../../libinput/10-pear-up-macos-keys.lua")

local EV_KEY, EV_MSC = 1, 4
local CODES = {
    ESC = 1, ["1"] = 2, ["2"] = 3, BACKSPACE = 14, TAB = 15, Q = 16, W = 17, T = 20, Y = 21,
    A = 30, S = 31, F = 33, L = 38, Z = 44, X = 45, C = 46, V = 47, B = 48, N = 49,
    LEFTCTRL = 29, LEFTSHIFT = 42, RIGHTSHIFT = 54, LEFTALT = 56, SPACE = 57,
    RIGHTCTRL = 97, RIGHTALT = 100, UP = 103, LEFT = 105, RIGHT = 106, DOWN = 108,
    LEFTMETA = 125, RIGHTMETA = 126,
}
local evdev, NAME = { MSC_SCAN = (EV_MSC << 16) | 4 }, {}
for name, code in pairs(CODES) do
    evdev["KEY_" .. name] = (EV_KEY << 16) | code
    NAME[(EV_KEY << 16) | code] = name
end
NAME[evdev.MSC_SCAN] = "MSC_SCAN"
local K = setmetatable({}, { __index = function(_, name) return assert(evdev["KEY_" .. name], name) end })

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

local function read_plugin()
    local f = assert(io.open(plugin_path))
    local source = f:read("a")
    f:close()
    return source
end
local SOURCE = read_plugin()

local function load_plugin(extra, source)
    local chunk, err = load(source or SOURCE, "=plugin", "t", sandbox(extra))
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

---------------------------------------------------------------------------
-- A keyboard and libinput's view of it.
--
-- The keyboard sends a frame per key, the scan code first as a real one does.
-- libinput's side keeps what it was told, and complains where it was told
-- something a keyboard never says: a key pressed that it holds, or let go of
-- one it does not. libinput would drop those quietly, so they would not show
-- otherwise.

local function new_rig(options)
    local rig = {
        kb = P.keyboard(options),
        held = {},     -- what the keyboard holds
        view = {},     -- what libinput holds
        told = {},     -- every press and release libinput was told, in order
        sent = {},     -- every key event the keyboard sent, in order
        mistakes = {},
        unchanged = true,
    }
    return rig
end

local function describe(events)
    local parts = {}
    for _, e in ipairs(events) do
        if e.usage ~= evdev.MSC_SCAN then
            parts[#parts + 1] = NAME[e.usage] .. ({ [0] = "-up", [1] = "-down", [2] = "-repeat" })[e.value]
        end
    end
    return table.concat(parts, " ")
end

-- The modifiers libinput holds, as a sorted string, for comparing.
local MODS = { "LEFTCTRL", "RIGHTCTRL", "LEFTSHIFT", "RIGHTSHIFT", "LEFTALT", "RIGHTALT", "LEFTMETA", "RIGHTMETA" }
local function mods(state)
    local held = {}
    for _, name in ipairs(MODS) do
        if state[K[name]] then
            held[#held + 1] = name
        end
    end
    return table.concat(held, "+")
end

local function press(rig, name, value)
    local usage = K[name]
    value = value or 1
    local frame = { { usage = evdev.MSC_SCAN, value = 458752 + (usage & 0xff) }, { usage = usage, value = value } }
    rig.sent[#rig.sent + 1] = { usage = usage, value = value }
    if value == 1 then
        rig.held[usage] = true
    elseif value == 0 then
        rig.held[usage] = nil
    end
    local out = P.frame(rig.kb, frame)
    if out ~= nil then
        rig.unchanged = false
    end
    local before = {}
    for _, e in ipairs(out or frame) do
        if e.usage >> 16 == EV_KEY then
            if e.value == 1 then
                if rig.view[e.usage] then
                    rig.mistakes[#rig.mistakes + 1] = NAME[e.usage] .. " pressed while held"
                end
                -- What was held as it went down: the modifiers an app sees.
                before[#before + 1] = { usage = e.usage, mods = mods(rig.view) }
                rig.view[e.usage] = true
            elseif e.value == 0 then
                if not rig.view[e.usage] then
                    rig.mistakes[#rig.mistakes + 1] = NAME[e.usage] .. " let go while not held"
                end
                rig.view[e.usage] = nil
            elseif not rig.view[e.usage] then
                rig.mistakes[#rig.mistakes + 1] = NAME[e.usage] .. " repeating while not held"
            end
            rig.told[#rig.told + 1] = e
        end
    end
    return out, before
end

-- Keys as a string: "LEFTMETA LEFT -LEFT -LEFTMETA", a minus for a release
-- and a plus for a repeat.
local function play(rig, keys)
    local seen = {}
    for word in keys:gmatch("%S+") do
        local sign, name = word:match("^([-+]?)(.+)$")
        local _, before = press(rig, name, sign == "-" and 0 or sign == "+" and 2 or 1)
        for _, b in ipairs(before) do
            seen[NAME[b.usage]] = b.mods
        end
    end
    return seen
end

local function told(rig)
    return describe(rig.told)
end

local function clean(rig)
    for usage in pairs(rig.view) do
        if not rig.held[usage] then
            return false
        end
    end
    for usage in pairs(rig.held) do
        if not rig.view[usage] then
            return false
        end
    end
    return #rig.mistakes == 0
end

-- The two ways round a PC keyboard has its keys, with Pear Up's swap and
-- without (as an Apple keyboard has them).
for _, layout in ipairs({
    { swapped = true, option = "LEFTMETA", cmd = "LEFTALT", label = "Alt and Cmd swapped (a PC keyboard)" },
    { swapped = false, option = "LEFTALT", cmd = "LEFTMETA", label = "not swapped (an Apple keyboard)" },
}) do
    local O, C = layout.option, layout.cmd
    local function rig(over)
        local options = { swapped = layout.swapped, words = true, desktops = true,
            shortcuts = P.keys("C V X Z A S F T W N") }
        for k, v in pairs(over or {}) do
            options[k] = v
        end
        return new_rig(options)
    end
    local function keys(text)
        return (text:gsub("OPTION", O):gsub("CMD", C))
    end
    local function expect(label, r, input, wanted, extra)
        local seen = play(r, keys(input))
        local got = told(r)
        check(label, got == keys(wanted) and clean(r) and (extra == nil or extra(seen)),
            "keys: " .. keys(input) .. "\n       told: " .. got .. "\n       wanted: " .. keys(wanted) ..
            (#r.mistakes > 0 and ("\n       " .. table.concat(r.mistakes, ", ")) or ""))
        return seen
    end
    local function as_before(label, input, over)
        local r = rig(over)
        play(r, keys(input))
        check(label, r.unchanged and told(r) == describe(r.sent) and clean(r), "told: " .. told(r))
    end

    print(layout.label .. ": Option is " .. O .. ", Cmd is " .. C)

    as_before("Option tapped alone reaches libinput as it is", "OPTION -OPTION")
    as_before("and so does Option with another key, Option+B", "OPTION B -B -OPTION")
    as_before("Cmd tapped alone, which opens the overview", "CMD -CMD")
    as_before("Cmd+Space, Cmd+Tab, Cmd+L and Cmd+1", "CMD SPACE -SPACE TAB -TAB L -L 1 -1 -CMD")
    as_before("Cmd+Q, which Pear Up's own shortcut quits apps with", "CMD Q -Q -CMD")
    as_before("Ctrl+Shift+←, which Linux apps take as select by word", "LEFTCTRL LEFTSHIFT LEFT -LEFT -LEFTSHIFT -LEFTCTRL")
    as_before("Ctrl+C, Ctrl+A", "LEFTCTRL C -C A -A -LEFTCTRL")
    as_before("Option+↑ and Ctrl+↓", "OPTION UP -UP -OPTION LEFTCTRL DOWN -DOWN -LEFTCTRL")
    as_before("Cmd+Option+← and Cmd+←", "CMD OPTION LEFT -LEFT -OPTION LEFT -LEFT -CMD")
    as_before("Ctrl+Option+←, GNOME's own shortcut", "LEFTCTRL OPTION LEFT -LEFT -OPTION -LEFTCTRL")
    as_before("Ctrl+Cmd+C", "LEFTCTRL CMD C -C -CMD -LEFTCTRL")
    as_before("plain arrows and letters, Shift+←", "LEFT -LEFT C -C LEFTSHIFT LEFT -LEFT -LEFTSHIFT")
    as_before("the right-hand Option and Cmd", "RIGHTMETA LEFT -LEFT -RIGHTMETA RIGHTALT C -C -RIGHTALT")
    as_before("an arrow already held when Option goes down", "LEFT OPTION +LEFT -LEFT -OPTION")

    expect("Option+← is Ctrl+←: Ctrl down before Option comes up, and only then the arrow",
        rig(), "OPTION LEFT -LEFT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up",
        function(seen) return seen.LEFT == "LEFTCTRL" end)
    expect("Option+Shift+→ is Ctrl+Shift+→, select by word",
        rig(), "OPTION LEFTSHIFT RIGHT -RIGHT -LEFTSHIFT -OPTION",
        "OPTION-down LEFTSHIFT-down LEFTCTRL-down OPTION-up RIGHT-down RIGHT-up LEFTCTRL-up LEFTSHIFT-up",
        function(seen) return seen.RIGHT == "LEFTCTRL+LEFTSHIFT" end)
    expect("with Shift pressed after Option was lent, it still selects",
        rig(), "OPTION LEFT -LEFT LEFTSHIFT LEFT -LEFT -LEFTSHIFT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up LEFTSHIFT-down LEFTCTRL-down " ..
        "LEFT-down LEFT-up LEFTCTRL-up LEFTSHIFT-up",
        function(seen) return seen.LEFT == "LEFTCTRL+LEFTSHIFT" end)
    expect("held, the arrow repeats as Ctrl+← until it is let go",
        rig(), "OPTION LEFT +LEFT +LEFT +LEFT -LEFT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-repeat LEFT-repeat LEFT-repeat LEFT-up LEFTCTRL-up")
    expect("Option's own repeat while it is lent is not passed on",
        rig(), "OPTION +OPTION LEFT +OPTION +LEFT -LEFT +OPTION -OPTION",
        "OPTION-down OPTION-repeat LEFTCTRL-down OPTION-up LEFT-down LEFT-repeat LEFT-up LEFTCTRL-up")
    expect("word after word without Option going down and up in between",
        rig(), "OPTION LEFT -LEFT LEFT -LEFT RIGHT -RIGHT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up LEFTCTRL-down LEFT-down LEFT-up " ..
        "LEFTCTRL-up LEFTCTRL-down RIGHT-down RIGHT-up LEFTCTRL-up")
    expect("both arrows held at once keep Ctrl down until the last",
        rig(), "OPTION LEFT RIGHT -LEFT -RIGHT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down RIGHT-down LEFT-up RIGHT-up LEFTCTRL-up")
    expect("Option let go before the arrow: Ctrl comes up, the arrow goes on as a plain one",
        rig(), "OPTION LEFT -OPTION +LEFT -LEFT",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFTCTRL-up LEFT-repeat LEFT-up")
    expect("Option+← and then Option+B: Option comes back before the B",
        rig(), "OPTION LEFT -LEFT B -B -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up OPTION-down B-down B-up OPTION-up",
        function(seen) return seen.B == O end)
    expect("Option+← held and then B: Ctrl gives way to Option for the B",
        rig(), "OPTION LEFT B -B -LEFT -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down OPTION-down LEFTCTRL-up B-down B-up LEFT-up OPTION-up",
        function(seen) return seen.B == O end)
    expect("Option+←, then Cmd as well: Cmd+Option as before",
        rig(), "OPTION LEFT -LEFT CMD LEFT -LEFT -CMD -OPTION",
        "OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up OPTION-down CMD-down LEFT-down " ..
        "LEFT-up CMD-up OPTION-up")

    expect("Ctrl+← is Ctrl+Option+←, GNOME's shortcut for the desktop beside",
        rig(), "LEFTCTRL LEFT -LEFT -LEFTCTRL",
        "LEFTCTRL-down " .. O .. "-down LEFT-down LEFT-up " .. O .. "-up LEFTCTRL-up",
        function(seen) return seen.LEFT == mods({ [K.LEFTCTRL] = true, [K[O]] = true }) end)
    expect("and the right Ctrl too, with → and a repeat",
        rig(), "RIGHTCTRL RIGHT +RIGHT -RIGHT -RIGHTCTRL",
        "RIGHTCTRL-down " .. O .. "-down RIGHT-down RIGHT-repeat RIGHT-up " .. O .. "-up RIGHTCTRL-up")
    expect("Ctrl let go before the arrow: Option comes up with it",
        rig(), "LEFTCTRL LEFT -LEFTCTRL -LEFT",
        "LEFTCTRL-down " .. O .. "-down LEFT-down " .. O .. "-up LEFTCTRL-up LEFT-up")
    expect("Ctrl+← held and then Option: libinput, holding it already, hears it pressed again",
        rig(), "LEFTCTRL LEFT OPTION -LEFT -OPTION -LEFTCTRL",
        "LEFTCTRL-down " .. O .. "-down LEFT-down " .. O .. "-up " .. O .. "-down LEFT-up " .. O .. "-up LEFTCTRL-up")
    expect("Cmd+C held and then Ctrl: Cmd comes back, and Ctrl is pressed again after it",
        rig(), "CMD C LEFTCTRL -CMD -C -LEFTCTRL",
        "CMD-down LEFTCTRL-down CMD-up C-down CMD-down LEFTCTRL-up LEFTCTRL-down CMD-up C-up LEFTCTRL-up")
    expect("Ctrl+← held and then C: C gets Ctrl alone",
        rig(), "LEFTCTRL LEFT C -C -LEFT -LEFTCTRL",
        "LEFTCTRL-down " .. O .. "-down LEFT-down " .. O .. "-up C-down C-up LEFT-up LEFTCTRL-up",
        function(seen) return seen.C == "LEFTCTRL" end)

    expect("Cmd+C is Ctrl+C: Ctrl down before Cmd comes up, and only then the C",
        rig(), "CMD C -C -CMD",
        "CMD-down LEFTCTRL-down CMD-up C-down C-up LEFTCTRL-up",
        function(seen) return seen.C == "LEFTCTRL" end)
    expect("Cmd+C, Cmd+V, Cmd+Z with Cmd held throughout",
        rig(), "CMD C -C V -V Z -Z -CMD",
        "CMD-down LEFTCTRL-down CMD-up C-down C-up LEFTCTRL-up LEFTCTRL-down V-down V-up LEFTCTRL-up " ..
        "LEFTCTRL-down Z-down Z-up LEFTCTRL-up")
    expect("Cmd+Shift+Z is Ctrl+Shift+Z, redo",
        rig(), "CMD LEFTSHIFT Z -Z -LEFTSHIFT -CMD",
        "CMD-down LEFTSHIFT-down LEFTCTRL-down CMD-up Z-down Z-up LEFTCTRL-up LEFTSHIFT-up",
        function(seen) return seen.Z == "LEFTCTRL+LEFTSHIFT" end)
    expect("Cmd+Z held repeats as Ctrl+Z",
        rig(), "CMD Z +Z +Z -Z -CMD",
        "CMD-down LEFTCTRL-down CMD-up Z-down Z-repeat Z-repeat Z-up LEFTCTRL-up")
    expect("Cmd+C and then Cmd+Tab: Cmd comes back for the switcher",
        rig(), "CMD C -C TAB -TAB -CMD",
        "CMD-down LEFTCTRL-down CMD-up C-down C-up LEFTCTRL-up CMD-down TAB-down TAB-up CMD-up",
        function(seen) return seen.TAB == C end)
    expect("Cmd+Z and then Option: Cmd comes back before Option goes down, so letting go of Cmd is no tap",
        rig(), "CMD Z -Z OPTION -CMD -OPTION",
        "CMD-down LEFTCTRL-down CMD-up Z-down Z-up LEFTCTRL-up CMD-down OPTION-down CMD-up OPTION-up")
    expect("Cmd let go before the C: the C goes on as a plain one",
        rig(), "CMD C -CMD -C",
        "CMD-down LEFTCTRL-down CMD-up C-down LEFTCTRL-up C-up")

    as_before("with word jumps off, Option+← is Option+←", "OPTION LEFT -LEFT -OPTION", { words = false })
    as_before("with desktops off, Ctrl+← is Ctrl+←", "LEFTCTRL LEFT -LEFT -LEFTCTRL", { desktops = false })
    as_before("with shortcuts off, Cmd+C is Cmd+C", "CMD C -C -CMD", { shortcuts = {} })
    as_before("a key not on the list, Cmd+B", "CMD B -B -CMD")
    expect("a list of one, \"V\", has Cmd+V and not Cmd+C",
        rig({ shortcuts = P.keys("V") }), "CMD C -C V -V -CMD",
        "CMD-down C-down C-up LEFTCTRL-down CMD-up V-down V-up LEFTCTRL-up")
end

-- Any order at all. Keys go down and up at random, repeat at random, and are
-- let go in a random order at the end; the plugin has to keep what libinput
-- is told in step with the keyboard throughout. A seed of its own, so a
-- failure can be run again.
print("Keys in any order, at random")
do
    local seed = tonumber(os.getenv("PEAR_UP_SEED") or "") or 20261011
    math.randomseed(seed)
    local pool = { "LEFTCTRL", "RIGHTCTRL", "LEFTSHIFT", "LEFTALT", "LEFTMETA", "RIGHTALT",
        "LEFT", "RIGHT", "C", "Z", "B", "Q", "SPACE" }
    local plain = { B = true, Q = true, SPACE = true }
    local translatable = { LEFT = true, RIGHT = true, C = true, Z = true }
    local runs, events, problem = 3000, 0, nil
    for run = 1, runs do
        local r = new_rig({ swapped = run % 2 == 0, words = true, desktops = true, shortcuts = P.keys("C Z") })
        local O = run % 2 == 0 and "LEFTMETA" or "LEFTALT"
        local C = run % 2 == 0 and "LEFTALT" or "LEFTMETA"
        local log = {}
        local function fail(what)
            problem = problem or string.format("run %d (seed %d): %s\n       keys: %s\n       told: %s",
                run, seed, what, table.concat(log, " "), told(r))
        end
        local function step(name, value)
            log[#log + 1] = (value == 0 and "-" or value == 2 and "+" or "") .. name
            events = events + 1
            local _, before = press(r, name, value)
            -- A key that is never translated goes down with exactly the
            -- modifiers the keyboard holds, as it would without the plugin.
            for _, b in ipairs(before) do
                local key = NAME[b.usage]
                if plain[key] and b.mods ~= mods(r.held) then
                    fail(key .. " went down with " .. b.mods .. ", the keyboard holds " .. mods(r.held))
                end
                -- One that may be goes down with what the keyboard holds, or
                -- with that translated: Option or Cmd for Ctrl, or Option
                -- added to Ctrl.
                if translatable[key] then
                    local held = {}
                    for usage in pairs(r.held) do held[usage] = true end
                    local as_is = mods(held)
                    local swapped = function(from, to)
                        local t = {}
                        for usage in pairs(held) do t[usage] = true end
                        t[K[from]], t[K[to]] = nil, true
                        return mods(t)
                    end
                    if b.mods ~= as_is and b.mods ~= swapped(O, "LEFTCTRL") and b.mods ~= swapped(C, "LEFTCTRL")
                        and b.mods ~= swapped("ESC", O) then
                        fail(key .. " went down with " .. b.mods .. ", the keyboard holds " .. as_is)
                    end
                end
            end
            -- Keys that are not modifiers are libinput's exactly as the
            -- keyboard has them.
            for usage in pairs(r.held) do
                if not r.view[usage] and NAME[usage] and not NAME[usage]:match("CTRL$")
                    and not NAME[usage]:match("ALT$") and not NAME[usage]:match("META$") then
                    fail(NAME[usage] .. " is held but libinput does not hold it")
                end
            end
            if #r.mistakes > 0 then
                fail(table.concat(r.mistakes, ", "))
            end
        end
        for _ = 1, 24 do
            local name = pool[math.random(#pool)]
            local usage = K[name]
            if r.held[usage] then
                step(name, math.random(3) == 1 and 2 or 0)
            else
                step(name, 1)
            end
        end
        local left = {}
        for usage in pairs(r.held) do
            left[#left + 1] = NAME[usage]
        end
        table.sort(left)
        for i = #left, 2, -1 do
            local j = math.random(i)
            left[i], left[j] = left[j], left[i]
        end
        for _, name in ipairs(left) do
            step(name, 0)
        end
        if next(r.view) ~= nil then
            fail("libinput still holds " .. describe((function()
                local t = {}
                for usage in pairs(r.view) do t[#t + 1] = { usage = usage, value = 1 } end
                return t
            end)()) .. " after every key was let go")
        end
        -- No lone tap of Option, Cmd or Ctrl that the keyboard did not make:
        -- apps open their menu bar for Alt alone, GNOME the overview for
        -- Super, and can show where the pointer is for Ctrl.
        local function taps(list)
            local count, last = 0, nil
            for _, e in ipairs(list) do
                if e.value ~= 2 then
                    if last and last.value == 1 and e.value == 0 and last.usage == e.usage
                        and (e.usage == K[O] or e.usage == K[C] or e.usage == K.LEFTCTRL) then
                        count = count + 1
                    end
                    last = e
                end
            end
            return count
        end
        if taps(r.told) > taps(r.sent) then
            fail(string.format("libinput saw %d lone taps of Option, Cmd or Ctrl, the keyboard made %d",
                taps(r.told), taps(r.sent)))
        end
        if problem then
            break
        end
    end
    check(string.format("%d runs, %d keys: nothing held after the last key is let go, no key pressed twice " ..
        "or let go unpressed, other keys with the modifiers as held and translated ones as translated, " ..
        "no lone Option, Cmd or Ctrl tap made up",
        runs, events), problem == nil, problem)
end

---------------------------------------------------------------------------
-- libinput's side: registration, devices, the lines Pear Up writes.

local function fake_libinput()
    local calls = { errors = {}, info = {} }
    local fake = {}
    function fake:register(versions) calls.register = versions; return 1 end
    function fake:connect(name, fn) calls[name] = fn end
    function fake:log_info(message) calls.info[#calls.info + 1] = message end
    function fake:log_error(message) calls.errors[#calls.errors + 1] = message end
    return fake, calls
end

local function device(props, codes, name)
    local d = { handlers = {} }
    function d:udev_properties() return props end
    function d:usages()
        local usages = {}
        for _, code in ipairs(codes) do
            usages[K[code]] = true
        end
        return usages
    end
    function d:name() return name or "Fake Keyboard" end
    function d:connect(event, fn) self.handlers[event] = fn end
    return d
end

local FULL = { "LEFTCTRL", "RIGHTCTRL", "LEFTSHIFT", "RIGHTSHIFT", "LEFTALT", "RIGHTALT", "LEFTMETA",
    "RIGHTMETA", "LEFT", "RIGHT", "UP", "DOWN", "C", "V", "X", "Z", "A", "S", "F", "T", "W", "N", "Q", "B",
    "TAB", "SPACE", "L", "1" }

local function feed(d, keys)
    local list = {}
    for word in keys:gmatch("%S+") do
        local sign, name = word:match("^([-+]?)(.+)$")
        local frame = { { usage = K[name], value = sign == "-" and 0 or sign == "+" and 2 or 1 } }
        local out = d.handlers["evdev-frame"](d, frame, 0)
        for _, e in ipairs(out or frame) do
            list[#list + 1] = e
        end
    end
    return describe(list)
end

print("Registering with libinput")
do
    local fake, calls = fake_libinput()
    load_plugin({ libinput = fake })
    check("it registers for version 1 of the plugin API",
        calls.register and calls.register[1] == 1 and #calls.register == 1)
    check("and listens for new devices", type(calls["new-evdev-device"]) == "function")

    local keyboard = device({ ID_INPUT = "1", ID_INPUT_KEY = "1", ID_INPUT_KEYBOARD = "1" }, FULL)
    calls["new-evdev-device"](keyboard)
    check("a keyboard gets a frame handler", type(keyboard.handlers["evdev-frame"]) == "function")
    check("and is let go of when it is removed", type(keyboard.handlers["device-removed"]) == "function")

    local mouse = device({ ID_INPUT = "1", ID_INPUT_MOUSE = "1" }, { "LEFT", "RIGHT", "LEFTCTRL", "LEFTALT", "LEFTMETA" })
    calls["new-evdev-device"](mouse)
    check("a mouse does not", mouse.handlers["evdev-frame"] == nil)
    local buttons = device({ ID_INPUT = "1", ID_INPUT_KEY = "1" }, { "LEFT", "RIGHT" }, "Power Button")
    calls["new-evdev-device"](buttons)
    check("nor a device of a few keys that is no keyboard", buttons.handlers["evdev-frame"] == nil)
    local numpad = device({ ID_INPUT = "1", ID_INPUT_KEY = "1", ID_INPUT_KEYBOARD = "1" },
        { "LEFTCTRL", "LEFTALT", "LEFTMETA", "1", "2" }, "Number Pad")
    calls["new-evdev-device"](numpad)
    check("nor a keyboard without arrow keys", numpad.handlers["evdev-frame"] == nil)

    check("the shipped copy is for an Apple keyboard, all three on: Option+← moves by word",
        feed(keyboard, "LEFTALT LEFT -LEFT -LEFTALT") ==
        "LEFTALT-down LEFTCTRL-down LEFTALT-up LEFT-down LEFT-up LEFTCTRL-up")
    keyboard.handlers["device-removed"](keyboard)
    check("a removed keyboard's frames pass as they are",
        feed(keyboard, "LEFTALT LEFT -LEFT -LEFTALT") == "LEFTALT-down LEFT-down LEFT-up LEFTALT-up")
    check("and it said in the log which keyboard it took", calls.info[1] == "Pear Up macOS keys: Fake Keyboard")
end

print("The lines Pear Up's preferences write")
do
    local LINES = {
        { "SWAPPED", "true|false" }, { "WORDS", "true|false" }, { "DESKTOPS", "true|false" },
        { "SHORTCUTS", "true|false" }, { "SHORTCUT_KEYS", '"[^"\n]*"' },
    }
    for _, line in ipairs(LINES) do
        local count = 0
        for _ in SOURCE:gmatch("\nlocal " .. line[1] .. " = [^\n]+\n") do count = count + 1 end
        check("there is exactly one " .. line[1] .. " line, as prefs.js and install.sh expect", count == 1)
    end

    local function with(values)
        local source = SOURCE
        for name, value in pairs(values) do
            source = source:gsub("\nlocal " .. name .. " = [^\n]+\n", "\nlocal " .. name .. " = " .. value .. "\n")
        end
        local fake, calls = fake_libinput()
        local module = load_plugin({ libinput = fake }, source)
        local d = device({ ID_INPUT_KEYBOARD = "1" }, FULL)
        calls["new-evdev-device"](d)
        return d, module, calls
    end

    local d = with({ SWAPPED = "true" })
    check("SWAPPED true: Option is the Windows key, so Win+← moves by word",
        feed(d, "LEFTMETA LEFT -LEFT -LEFTMETA") ==
        "LEFTMETA-down LEFTCTRL-down LEFTMETA-up LEFT-down LEFT-up LEFTCTRL-up")
    check("and Cmd is the Alt key, so Alt+C copies",
        feed(d, "LEFTALT C -C -LEFTALT") == "LEFTALT-down LEFTCTRL-down LEFTALT-up C-down C-up LEFTCTRL-up")
    check("and Ctrl+← sends the Windows key, which xkb then makes Alt",
        feed(d, "LEFTCTRL LEFT -LEFT -LEFTCTRL") ==
        "LEFTCTRL-down LEFTMETA-down LEFT-down LEFT-up LEFTMETA-up LEFTCTRL-up")
    check("and Alt+← is left alone", feed(d, "LEFTALT LEFT -LEFT -LEFTALT") == "LEFTALT-down LEFT-down LEFT-up LEFTALT-up")

    d = with({ WORDS = "false" })
    check("WORDS false: Option+← is left alone", feed(d, "LEFTALT LEFT -LEFT -LEFTALT") ==
        "LEFTALT-down LEFT-down LEFT-up LEFTALT-up")
    check("and the other two still work", feed(d, "LEFTMETA C -C -LEFTMETA LEFTCTRL LEFT -LEFT -LEFTCTRL") ==
        "LEFTMETA-down LEFTCTRL-down LEFTMETA-up C-down C-up LEFTCTRL-up LEFTCTRL-down LEFTALT-down LEFT-down " ..
        "LEFT-up LEFTALT-up LEFTCTRL-up")
    d = with({ DESKTOPS = "false" })
    check("DESKTOPS false: Ctrl+← is left alone", feed(d, "LEFTCTRL LEFT -LEFT -LEFTCTRL") ==
        "LEFTCTRL-down LEFT-down LEFT-up LEFTCTRL-up")
    d = with({ SHORTCUTS = "false" })
    check("SHORTCUTS false: Cmd+C is left alone", feed(d, "LEFTMETA C -C -LEFTMETA") ==
        "LEFTMETA-down C-down C-up LEFTMETA-up")
    d = with({ SHORTCUT_KEYS = '"C q b LEFTCTRL NOSUCHKEY"' })
    check("SHORTCUT_KEYS read as written, any case, unknown names and modifiers left out",
        feed(d, "LEFTMETA Q -Q B -B V -V LEFTCTRL -LEFTCTRL -LEFTMETA") ==
        "LEFTMETA-down LEFTCTRL-down LEFTMETA-up Q-down Q-up LEFTCTRL-up LEFTCTRL-down B-down B-up LEFTCTRL-up " ..
        "LEFTMETA-down V-down V-up LEFTCTRL-down LEFTCTRL-up LEFTMETA-up")
    local _, module, calls = with({ WORDS = "false", DESKTOPS = "false", SHORTCUTS = "false" })
    local idle = device({ ID_INPUT_KEYBOARD = "1" }, FULL)
    calls["new-evdev-device"](idle)
    check("all three false: no keyboard is taken", idle.handlers["evdev-frame"] == nil)
    check("the module it returns is the same logic", type(module.frame) == "function")
end

print("After an error")
do
    local fake, calls = fake_libinput()
    local module = load_plugin({ libinput = fake })
    local d = device({ ID_INPUT_KEYBOARD = "1" }, FULL)
    calls["new-evdev-device"](d)
    -- Option+← held, which has Ctrl down and Option lent; then a frame the
    -- logic fails on.
    local first = feed(d, "LEFTALT LEFT")
    local frame = module.frame
    module.frame = function(kb, f)
        frame(kb, f) -- half the work done, then the failure
        error("a fault of the test's making")
    end
    local after = feed(d, "-LEFT")
    module.frame = frame
    local later = feed(d, "-LEFTALT LEFTALT LEFT -LEFT -LEFTALT")
    check("the error is logged, naming the keyboard", calls.errors[1] ~= nil and calls.errors[1]:match("Fake Keyboard") ~= nil,
        tostring(calls.errors[1]))
    check("libinput is told what the keyboard holds: Ctrl up, Option down, then the frame",
        first == "LEFTALT-down LEFTCTRL-down LEFTALT-up LEFT-down" and after == "LEFTALT-down LEFTCTRL-up LEFT-up",
        "before: " .. first .. "\n       at the error: " .. after)
    check("and from then on the keys pass as they are",
        later == "LEFTALT-up LEFTALT-down LEFT-down LEFT-up LEFTALT-up", later)
end

print()
if failed > 0 then
    print(string.format("%d of %d checks failed", failed, failed + passed))
    os.exit(1)
end
print(string.format("All %d checks passed", passed))

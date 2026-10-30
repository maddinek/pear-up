-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Pear Up: the keys macOS uses inside apps, on a keyboard whose apps are
-- Linux's.
--
-- On a Mac, Option+← and Option+→ move the cursor a word, and with Shift
-- select by word; Ctrl+← and Ctrl+→ go to the next desktop; Cmd+C copies.
-- Linux apps know those as Ctrl+←/→ and Ctrl+C, and since an app reads its
-- own keys, no shortcut set in GNOME can change what they do. The keys have
-- to be different before they reach the app, which is where this plugin is:
--
--   pressed          libinput is told       which does
--   Option+←/→       Ctrl+←/→               a word left or right; with Shift,
--                                           select by word
--   Ctrl+←/→         Ctrl+Option+←/→        the desktop beside, through
--                                           GNOME's own shortcut for it
--   Cmd+C, V, X …    Ctrl+C, V, X …         copy, paste, cut …; with Shift
--                                           too, so Cmd+Shift+Z redoes
--   Cmd+C           Ctrl+Insert            copy, with INSERT_COPY on
--   Cmd+V           Shift+Insert           paste, with INSERT_COPY on
--
-- Each of the three can be switched off, below. Everything else is left as
-- it is: Option, Cmd or Ctrl tapped alone, with any other key, or together
-- (Cmd+Option+←, Ctrl+Shift+←, which Linux apps take as select by word);
-- Cmd+Q, which Pear Up quits apps with in the shell; ↑ and ↓; and any key
-- not on the Cmd list. Without INSERT_COPY, in a terminal Cmd+C is Ctrl+C,
-- which interrupts rather than copies. With it, Ctrl+Insert copies, and
-- Shift+Insert pastes; Pear Up configures Ptyxis to paste the clipboard,
-- since VTE otherwise pastes PRIMARY. Nothing here knows the app in front.
-- Cmd+Shift+C/V still send Ctrl+Shift+C/V, and Cmd+X stays Ctrl+X: the
-- alternative, Shift+Delete, permanently deletes files in file managers.
--
-- Option is the key GNOME takes as Alt and Cmd the one it takes as Super. On
-- an Apple keyboard those are the keys printed so. On a PC keyboard with
-- Pear Up's "Swap Alt and Cmd" (xkb's altwin:swap_alt_win), Option is the
-- Windows key and Cmd the Alt key beside the space bar, which is the order
-- the Mac has them in. The swap happens after libinput, so this plugin sees
-- the keys as the keyboard sends them, and so does whatever it sends: the
-- SWAPPED line below says which raw key is which. Only the left-hand Option
-- and Cmd are translated. The right-hand keys are often AltGr, or absent.
--
-- What makes it work is how the modifiers are handled. When Option goes
-- down, nothing says whether an arrow will follow, so Option reaches
-- libinput at once, as it always would. When an arrow does follow, Option
-- is lent to the translation: libinput is told Ctrl goes down and then that
-- Option comes up, and only then the arrow. Ctrl goes down first so that
-- Option is never seen pressed and released alone, which some apps take as a
-- tap of Alt and open their menu bar for. Cmd+C goes the same way, with Cmd
-- lent, which GNOME would otherwise take as a tap of Super for the overview.
-- While the arrow is held, Ctrl stays down, so libinput sees Ctrl+arrow
-- held, and the key repeat GNOME makes from that keeps moving by word. When
-- the arrow comes up, so does Ctrl, and Option stays lent while it is held:
-- further arrows move by word without it going down and up in between, and
-- when it is let go, libinput hears nothing, since it was told so already.
-- Any other key pressed while it is still held (Shift aside, which selecting
-- needs) gives it back first, so Option+← and then Option+B is Option+B.
--
-- Holding back Option until the next key, with a timer to send it if none
-- comes, was the other way. It is not taken: it delays every Option and Cmd,
-- which an Alt-click with the mouse or Super held for the overview would
-- feel, and after the timer had sent the key, an arrow would need the lending
-- above all the same. Lending alone covers both cases and needs no timer.
--
-- Which modifiers libinput is told are down is worked out again after every
-- key, from the keys really held and the translations under way, and only
-- the difference is sent: downs before ups, and a modifier just pressed
-- after any it gave back. So the keys can be let go in any order — Option
-- before the arrow, Ctrl before the arrow — and libinput ends with what the
-- keyboard holds, never a modifier left down. A translation whose modifier
-- is let go while its key is still held ends there, and the key goes on as
-- a plain one, as it does on macOS. C/V sent as Insert are the exception:
-- letting Cmd go lets go of Insert with it, since a bare Insert held would
-- repeat and toggle overwrite, and the key's own release is then dropped. With INSERT_COPY, left Shift is
-- managed like Ctrl for paste, with a real Shift kept down for as long
-- as the keyboard holds it. A modifier pressed for real while
-- libinput holds it for a translation, Ctrl during Cmd+C, is let go and
-- pressed again, so that the press is seen.
--
-- If anything here raises an error while a key is handled, the modifiers
-- libinput was told about are put back to what the keyboard holds, the
-- error is logged, and the keys pass as they are until the next login. An
-- error anywhere else makes libinput unload the plugin, with the same result.
--
-- Installed by Pear Up's preferences (Keyboard page) into
-- ~/.config/libinput/plugins, where GNOME 50's compositor loads it at login.
-- Switching all three off there removes this file.

-- Pear Up's preferences write the next lines when they install this file:
-- whether the Alt/Cmd swap is on, which of the three translations are,
-- whether plain C/V use Insert, and the keys Cmd turns into Ctrl, by their
-- names in linux/input-event-codes.h
-- without KEY_. Those are key positions, not letters: on a layout where Z and
-- Y trade places, KEY_Z is the key that types Y. install.sh keeps them all
-- when it replaces this file with a newer one.
local SWAPPED = false
local WORDS = true
local DESKTOPS = true
local SHORTCUTS = true
local INSERT_COPY = false
local SHORTCUT_KEYS = "C V X Z A S F T W N"

local EV_KEY = 1
local KEY_LEFTCTRL = evdev.KEY_LEFTCTRL
local KEY_RIGHTCTRL = evdev.KEY_RIGHTCTRL
local KEY_LEFTSHIFT = evdev.KEY_LEFTSHIFT
local KEY_RIGHTSHIFT = evdev.KEY_RIGHTSHIFT
local KEY_LEFTALT = evdev.KEY_LEFTALT
local KEY_RIGHTALT = evdev.KEY_RIGHTALT
local KEY_LEFTMETA = evdev.KEY_LEFTMETA
local KEY_RIGHTMETA = evdev.KEY_RIGHTMETA
local KEY_LEFT = evdev.KEY_LEFT
local KEY_RIGHT = evdev.KEY_RIGHT
local KEY_INSERT = evdev.KEY_INSERT
local KEY_C = evdev.KEY_C
local KEY_V = evdev.KEY_V

local ARROWS = { [KEY_LEFT] = true, [KEY_RIGHT] = true }
local SHIFTS = { [KEY_LEFTSHIFT] = true, [KEY_RIGHTSHIFT] = true }
local CTRLS = { KEY_LEFTCTRL, KEY_RIGHTCTRL }
local ALTS_AND_SUPERS = { KEY_LEFTALT, KEY_RIGHTALT, KEY_LEFTMETA, KEY_RIGHTMETA }
local MODIFIERS = {
    [KEY_LEFTCTRL] = true, [KEY_RIGHTCTRL] = true, [KEY_LEFTSHIFT] = true, [KEY_RIGHTSHIFT] = true,
    [KEY_LEFTALT] = true, [KEY_RIGHTALT] = true, [KEY_LEFTMETA] = true, [KEY_RIGHTMETA] = true,
}

-- The logic is kept apart from libinput, in this table, so that
-- tests/libinput/check-macos-keys.lua can drive it with keys of its own.
local M = {}

-- The usages of the keys named in `names`, a string like SHORTCUT_KEYS. Names
-- evdev does not know are left out, and so are the modifiers.
function M.keys(names)
    local keys = {}
    for name in names:gmatch("[%w_]+") do
        local usage = evdev["KEY_" .. name:upper()]
        if usage and not MODIFIERS[usage] then
            keys[usage] = true
        end
    end
    return keys
end

-- The state of one keyboard. `options` holds swapped, words, desktops, and
-- shortcuts: the usages Cmd turns into Ctrl, as M.keys gives them.
-- insert_copy opts plain C/V into Insert, only on a device that has both
-- Insert and left Shift; registration checks those before passing it in.
function M.keyboard(options)
    local option = options.swapped and KEY_LEFTMETA or KEY_LEFTALT
    local cmd = options.swapped and KEY_LEFTALT or KEY_LEFTMETA
    return {
        option = option,
        cmd = cmd,
        words = options.words and true or false,
        desktops = options.desktops and true or false,
        shortcuts = options.shortcuts or {},
        insert_copy = options.insert_copy and true or false,
        -- The modifiers whose state this plugin tells libinput, rather than
        -- passing on what the keyboard says. The order is the order downs
        -- and ups are sent in.
        -- Left Shift only with insert_copy, which sends it for paste: without,
        -- a real Shift passes as it always has.
        managed = options.insert_copy and { KEY_LEFTCTRL, KEY_LEFTSHIFT, option, cmd }
            or { KEY_LEFTCTRL, option, cmd },
        down = {},     -- usage = true for every key the keyboard holds
        sent = {},     -- usage = true for each managed key libinput holds
        lent = {},     -- option or cmd = true while held and lent
        word = {},     -- arrows held as Ctrl+arrow
        desktop = {},  -- arrows held as Ctrl+Option+arrow
        shortcut = {}, -- keys held as Ctrl+key, including Ctrl+Insert for copy
        paste = {},    -- keys held as Shift+Insert
        insert = {},   -- physical C/V sent as Insert until they come up
        swallow = {},  -- C/V whose Insert ended early: their release is dropped
    }
end

local function any_down(kb, usages, except)
    for _, usage in ipairs(usages) do
        if usage ~= except and kb.down[usage] then
            return true
        end
    end
    return false
end

-- What a key going down now becomes, or nil for itself.
local function translation(kb, usage)
    local ctrl = any_down(kb, CTRLS)
    if ARROWS[usage] then
        if kb.words and kb.down[kb.option] and not ctrl and not any_down(kb, ALTS_AND_SUPERS, kb.option) then
            return "word"
        end
        if kb.desktops and ctrl and not kb.down[KEY_LEFTSHIFT] and not kb.down[KEY_RIGHTSHIFT]
            and not any_down(kb, ALTS_AND_SUPERS) then
            return "desktop"
        end
    elseif kb.shortcuts[usage] then
        if kb.down[kb.cmd] and not ctrl and not any_down(kb, ALTS_AND_SUPERS, kb.cmd) then
            if kb.insert_copy and usage == KEY_V and not kb.down[KEY_LEFTSHIFT] and not kb.down[KEY_RIGHTSHIFT] then
                return "paste"
            end
            return "shortcut"
        end
    end
    return nil
end

-- Whether libinput should hold the managed key `usage` now.
local function wanted(kb, usage)
    if usage == KEY_LEFTCTRL then
        return (kb.down[usage] or next(kb.word) ~= nil or next(kb.shortcut) ~= nil) and true or false
    elseif usage == KEY_LEFTSHIFT then
        return (kb.down[usage] or next(kb.paste) ~= nil) and true or false
    elseif usage == kb.option then
        return (kb.down[usage] and not kb.lent[usage]) or next(kb.desktop) ~= nil
    end
    return (kb.down[usage] and not kb.lent[usage]) and true or false
end

-- Tells libinput, in `out`, of every managed key whose state changed: the
-- downs, then the ups, in the opposite order. `pressed`, the key that has
-- just gone down, goes down after the others: what it gave back is then not
-- left with nothing after it.
local function sync(kb, out, pressed)
    local managed = kb.managed
    for _, usage in ipairs(managed) do
        if usage ~= pressed and wanted(kb, usage) and not kb.sent[usage] then
            out[#out + 1] = { usage = usage, value = 1 }
            kb.sent[usage] = true
        end
    end
    if pressed and wanted(kb, pressed) and not kb.sent[pressed] then
        out[#out + 1] = { usage = pressed, value = 1 }
        kb.sent[pressed] = true
    end
    for i = #managed, 1, -1 do
        local usage = managed[i]
        if kb.sent[usage] and not wanted(kb, usage) then
            out[#out + 1] = { usage = usage, value = 0 }
            kb.sent[usage] = nil
        end
    end
end

-- Ends the translations that lean on `modifier`, Option or Cmd, or with nil
-- every translation: what was lent comes back while it is held, and keys
-- still held go on as plain ones.
local function finish(kb, modifier)
    if modifier == kb.option or modifier == nil then
        kb.lent[kb.option] = nil
        kb.word = {}
    end
    if modifier == kb.cmd or modifier == nil then
        kb.lent[kb.cmd] = nil
        kb.shortcut = {}
        kb.paste = {}
    end
    if modifier == nil then
        kb.desktop = {}
    end
end

local function is_managed(kb, usage)
    return usage == KEY_LEFTCTRL or (usage == KEY_LEFTSHIFT and kb.insert_copy)
        or usage == kb.option or usage == kb.cmd
end

-- C and V, and a real Insert as well, can overlap. libinput has only one
-- Insert to hold: another press is an up/down pair so the new chord is seen,
-- and only the last release lets it go. The physical-to-sent key choice
-- outlives finish(), which ends modifiers but cannot change a held key.
local function insert_held(kb, except)
    for usage in pairs(kb.insert) do
        if usage ~= except then
            return true
        end
    end
    return except ~= KEY_INSERT and kb.down[KEY_INSERT] or false
end

-- Lets go of the Insert of every C/V whose translation is over, or with
-- `all` of every one: Cmd let go, another key, or a new Insert chord. A bare
-- Insert must not stay down, since GNOME repeats a held key itself and each
-- repeat would toggle overwrite in a text editor. The key itself is still
-- held, so its release is dropped later, as it was sent already. `pressed`,
-- a real Insert just going down, is not one that holds it.
local function end_inserts(kb, out, all, pressed)
    local ended = false
    for usage in pairs(kb.insert) do
        if all or not (kb.shortcut[usage] or kb.paste[usage]) then
            kb.insert[usage], kb.shortcut[usage], kb.paste[usage] = nil, nil, nil
            kb.swallow[usage] = true
            ended = true
        end
    end
    if ended and not insert_held(kb, pressed) then
        out[#out + 1] = { usage = KEY_INSERT, value = 0 }
    end
end

-- One key event, with what libinput is to be told of it appended to `out`.
local function key(kb, out, usage, value)
    if value == 2 then
        -- The kernel's key repeat, which libinput ignores and GNOME does
        -- itself. A managed key libinput is not holding has none, and nor
        -- does a C/V whose Insert was let go early.
        if kb.insert[usage] then
            out[#out + 1] = { usage = KEY_INSERT, value = value }
        elseif kb.swallow[usage] then
            return
        elseif not is_managed(kb, usage) or kb.sent[usage] then
            out[#out + 1] = { usage = usage, value = value }
        end
        return
    end

    if value ~= 0 then
        local held = is_managed(kb, usage) and kb.sent[usage]
        kb.down[usage] = true
        local kind = translation(kb, usage)
        if kind then
            kb[kind][usage] = true
            if kind == "paste" or (kind == "shortcut" and kb.insert_copy and usage == KEY_C
                and not kb.down[KEY_LEFTSHIFT] and not kb.down[KEY_RIGHTSHIFT]) then
                -- A new copy or paste ends the one still held, so Cmd+C held
                -- and then V is Shift+Insert alone, not Ctrl+Shift+Insert.
                end_inserts(kb, out, true, usage)
                kb.insert[usage] = true
            end
            if kind == "word" then
                kb.lent[kb.option] = true
            elseif kind == "shortcut" or kind == "paste" then
                kb.lent[kb.cmd] = true
            end
        elseif not SHIFTS[usage] then
            -- Anything but Shift, which selecting needs, gets the keys the
            -- keyboard holds, as it would without this plugin.
            finish(kb)
            end_inserts(kb, out, false, usage)
        end
        sync(kb, out, is_managed(kb, usage) and usage or nil)
        if not is_managed(kb, usage) then
            local sent = kb.insert[usage] and KEY_INSERT or usage
            if sent == KEY_INSERT and insert_held(kb, usage) then
                out[#out + 1] = { usage = sent, value = 0 }
            end
            out[#out + 1] = { usage = sent, value = value }
        elseif held then
            -- libinput held it already, for a translation. It hears the press
            -- all the same, after whatever came back with it: Cmd+C held and
            -- then Ctrl gives Cmd back, and without Ctrl going down after it,
            -- letting go of Cmd would look like a tap of it alone.
            out[#out + 1] = { usage = usage, value = 0 }
            out[#out + 1] = { usage = usage, value = 1 }
        end
        return
    end

    local sent = kb.insert[usage] and KEY_INSERT or usage
    local swallowed = kb.swallow[usage]
    kb.insert[usage], kb.swallow[usage] = nil, nil
    kb.down[usage] = nil
    kb.paste[usage] = nil
    kb.word[usage], kb.desktop[usage], kb.shortcut[usage] = nil, nil, nil
    if usage == kb.option or usage == kb.cmd then
        finish(kb, usage)
        end_inserts(kb, out)
    end
    if not any_down(kb, CTRLS) then
        kb.desktop = {}
    end
    if not is_managed(kb, usage) and not swallowed and (sent ~= KEY_INSERT or not insert_held(kb)) then
        out[#out + 1] = { usage = sent, value = value }
    end
    sync(kb, out)
end

-- Takes one evdev frame and returns it rewritten, or nil when libinput may
-- have it as it is.
function M.frame(kb, frame)
    local out = {}
    for _, e in ipairs(frame) do
        if e.usage >> 16 == EV_KEY then
            key(kb, out, e.usage, e.value)
        else
            out[#out + 1] = e
        end
    end
    if #out == #frame then
        local same = true
        for i, e in ipairs(out) do
            if e.usage ~= frame[i].usage or e.value ~= frame[i].value then
                same = false
                break
            end
        end
        if same then
            return nil
        end
    end
    return out
end

-- Ends every translation and appends to `out` what puts the managed keys
-- back to what the keyboard holds.
function M.release(kb, out)
    finish(kb)
    sync(kb, out)
    -- Before passing keys through after an error, give held C/V back their
    -- own presses, and release the Insert we sent for them. Later physical
    -- releases then match, even though this keyboard has left the plugin.
    for usage in pairs(kb.insert) do
        out[#out + 1] = { usage = usage, value = 1 }
    end
    if next(kb.insert) ~= nil and not kb.down[KEY_INSERT] then
        out[#out + 1] = { usage = KEY_INSERT, value = 0 }
    end
    -- Likewise a C/V whose Insert was let go early, still held.
    for usage in pairs(kb.swallow) do
        out[#out + 1] = { usage = usage, value = 1 }
    end
    kb.insert, kb.swallow = {}, {}
    return out
end

local function copy(t)
    local c = {}
    for k, v in pairs(t) do
        c[k] = v
    end
    return c
end

if libinput then
    libinput:register({ 1 })
    libinput:connect("new-evdev-device", function(device)
        if not (WORDS or DESKTOPS or SHORTCUTS) or not device:udev_properties().ID_INPUT_KEYBOARD then
            return
        end
        -- Real arrow keys, and the modifiers this plugin may send: libinput
        -- drops events for keys a device does not have.
        local usages = device:usages()
        for _, usage in ipairs({ KEY_LEFT, KEY_RIGHT, KEY_LEFTCTRL, KEY_LEFTALT, KEY_LEFTMETA }) do
            if not usages[usage] then
                return
            end
        end
        local shortcuts = {}
        if SHORTCUTS then
            for usage in pairs(M.keys(SHORTCUT_KEYS)) do
                shortcuts[usage] = usages[usage]
            end
        end
        -- A keyboard without either key keeps the ordinary Ctrl translation,
        -- rather than having libinput silently drop half of the chord.
        local kb = M.keyboard({ swapped = SWAPPED, words = WORDS, desktops = DESKTOPS, shortcuts = shortcuts,
            insert_copy = INSERT_COPY and usages[KEY_INSERT] and usages[KEY_LEFTSHIFT] })
        libinput:log_info("Pear Up macOS keys: " .. device:name())
        device:connect("evdev-frame", function(_, frame)
            if not kb then
                return nil
            end
            local down, sent, insert, swallow = copy(kb.down), copy(kb.sent), copy(kb.insert), copy(kb.swallow)
            local ok, out = pcall(M.frame, kb, frame)
            if ok then
                return out
            end
            libinput:log_error("Pear Up macOS keys: " .. tostring(out) .. "; " .. device:name() ..
                " is left as it is until the next login")
            -- Back to before this frame, so that the modifiers libinput holds
            -- are known, and from there to what the keyboard holds.
            kb.down, kb.sent, kb.insert, kb.swallow = down, sent, insert, swallow
            local reset = M.release(kb, {})
            kb = nil
            for _, e in ipairs(frame) do
                reset[#reset + 1] = e
            end
            return reset
        end)
        device:connect("device-removed", function()
            kb = nil
        end)
    end)
end

return M

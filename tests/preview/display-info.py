#!/usr/bin/env python3
"""Print this desktop's primary monitor as "<width>x<height> <scale> <layout>".

Asks mutter for the current display configuration, which only reads. The size
is the monitor's current mode in device pixels (what `gnome-shell
--virtual-monitor` takes), the scale is its logical monitor's, and the layout
is "logical" or "physical". Prints nothing and exits 1 when there is no session
bus or no mutter on it.
"""
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

DISPLAY_CONFIG = "org.gnome.Mutter.DisplayConfig"


def main():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        reply = bus.call_sync(DISPLAY_CONFIG, "/org/gnome/Mutter/DisplayConfig",
                              DISPLAY_CONFIG, "GetCurrentState", None, None,
                              Gio.DBusCallFlags.NONE, 5000, None)
    except GLib.Error:
        return 1
    _serial, monitors, logical_monitors, properties = reply.unpack()
    if not logical_monitors:
        return 1
    # (x, y, scale, transform, primary, [monitor specs], properties)
    primary = next((lm for lm in logical_monitors if lm[4]), logical_monitors[0])
    scale, transform, connector = primary[2], primary[3], primary[5][0][0]
    for spec, modes, _ in monitors:
        if spec[0] != connector:
            continue
        # (id, width, height, refresh, preferred scale, scales, properties)
        mode = next((m for m in modes if m[6].get("is-current")), None)
        if mode is None:
            return 1
        width, height = mode[1], mode[2]
        if transform % 2:  # turned a quarter: the screen is the other way round
            width, height = height, width
        layout = "physical" if properties.get("layout-mode") == 2 else "logical"
        print(f"{width}x{height} {scale:.9g} {layout}")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

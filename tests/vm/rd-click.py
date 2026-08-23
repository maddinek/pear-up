#!/usr/bin/env python3
"""Click at an absolute screen position, through the compositor's own input path.

QEMU's synthetic pointer never reaches GNOME 50's panel buttons: they are driven
by Clutter.ClickGesture, which does not recognise those events. Mutter's
RemoteDesktop interface injects input the way a remote client does, which is
indistinguishable from real hardware as far as Clutter is concerned.

Absolute motion needs a stream to be absolute *within*, so a ScreenCast session
is paired with the remote-desktop one purely to name the monitor.

Usage: rd-click.py <x> <y> [--move-only]
"""
import sys

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

BTN_LEFT = 0x110

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(name, path, iface, method, args=None, sig="()"):
    return bus.call_sync(name, path, iface, method,
                         GLib.Variant(sig, args) if args else None,
                         None, Gio.DBusCallFlags.NONE, 10000, None)


def prop(name, path, iface, key):
    return call(name, path, "org.freedesktop.DBus.Properties", "Get",
                (iface, key), "(ss)").unpack()[0]


def first_connector():
    state = call("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                 "org.gnome.Mutter.DisplayConfig", "GetCurrentState").unpack()
    # (serial, monitors, logical_monitors, properties); a monitor is
    # ((connector, vendor, product, serial), modes, properties)
    return state[1][0][0][0]


x, y = float(sys.argv[1]), float(sys.argv[2])
move_only = "--move-only" in sys.argv

rd_path = call("org.gnome.Mutter.RemoteDesktop", "/org/gnome/Mutter/RemoteDesktop",
               "org.gnome.Mutter.RemoteDesktop", "CreateSession").unpack()[0]
rd_id = prop("org.gnome.Mutter.RemoteDesktop", rd_path,
             "org.gnome.Mutter.RemoteDesktop.Session", "SessionId")

sc_path = call("org.gnome.Mutter.ScreenCast", "/org/gnome/Mutter/ScreenCast",
               "org.gnome.Mutter.ScreenCast", "CreateSession",
               ({"remote-desktop-session-id": GLib.Variant("s", rd_id)},),
               "(a{sv})").unpack()[0]

connector = first_connector()
stream_path = call("org.gnome.Mutter.ScreenCast", sc_path,
                   "org.gnome.Mutter.ScreenCast.Session", "RecordMonitor",
                   (connector, {}), "(sa{sv})").unpack()[0]

# A paired screencast session is started by the remote-desktop one; starting it
# directly fails with "Must be started from remote desktop session".
call("org.gnome.Mutter.RemoteDesktop", rd_path,
     "org.gnome.Mutter.RemoteDesktop.Session", "Start")

# The stream has to be running before absolute motion can be resolved against it.
GLib.usleep(1500 * 1000)

call("org.gnome.Mutter.RemoteDesktop", rd_path,
     "org.gnome.Mutter.RemoteDesktop.Session", "NotifyPointerMotionAbsolute",
     (stream_path, x, y), "(sdd)")
GLib.usleep(400 * 1000)

if not move_only:
    call("org.gnome.Mutter.RemoteDesktop", rd_path,
         "org.gnome.Mutter.RemoteDesktop.Session", "NotifyPointerButton",
         (BTN_LEFT, True), "(ib)")
    GLib.usleep(120 * 1000)
    call("org.gnome.Mutter.RemoteDesktop", rd_path,
         "org.gnome.Mutter.RemoteDesktop.Session", "NotifyPointerButton",
         (BTN_LEFT, False), "(ib)")

GLib.usleep(600 * 1000)
print(f"{'moved to' if move_only else 'clicked'} ({x:.0f}, {y:.0f}) on {connector}")

call("org.gnome.Mutter.RemoteDesktop", rd_path,
     "org.gnome.Mutter.RemoteDesktop.Session", "Stop")

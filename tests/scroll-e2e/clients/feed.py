#!/usr/bin/env python3
"""Plays a libinput scroll stream (stage 1's) into the running GNOME Shell
as a touchpad's scrolling, at its own times, and logs when each went in.

    feed.py <stream.json> <gesture> <mode> <out.jsonl>

Mutter's headless mode runs without libinput (meta-backend-native.c: headless
seats get META_SEAT_NATIVE_FLAG_NO_LIBINPUT), so no made-up touchpad can reach
it. Its RemoteDesktop interface can: NotifyPointerAxis with the finger source
(4) and finish (1) goes into clutter_virtual_input_device_notify_scroll_continuous,
which ends in meta_seat_impl_notify_scroll_continuous_in_impl, the very
function libinput's axis events go into (meta-seat-impl.c, notify_continuous_axis),
and from there to Wayland clients as wl_pointer axis_source finger, axis and
axis_stop. So the clients get what they would from libinput's stream.
"""
import json
import sys
import time

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

RD = 'org.gnome.Mutter.RemoteDesktop'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(path, iface, method, args=None, sig='()'):
    return bus.call_sync(RD, path, iface, method, GLib.Variant(sig, args) if args else None,
                         None, Gio.DBusCallFlags.NONE, 10000, None)


def main():
    stream = json.load(open(sys.argv[1]))[sys.argv[2]][sys.argv[3]]['stream']
    out = open(sys.argv[4], 'w')
    session = call('/org/gnome/Mutter/RemoteDesktop', RD, 'CreateSession').unpack()[0]
    # Absolute motion needs a stream to be absolute in: a screencast of the
    # monitor, paired with the session, as tests/vm/rd-click.py does.
    sid = bus.call_sync(RD, session, 'org.freedesktop.DBus.Properties', 'Get',
                        GLib.Variant('(ss)', (RD + '.Session', 'SessionId')), None,
                        Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
    sc = bus.call_sync('org.gnome.Mutter.ScreenCast', '/org/gnome/Mutter/ScreenCast', 'org.gnome.Mutter.ScreenCast',
                       'CreateSession', GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', sid)},)),
                       None, Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
    state = bus.call_sync('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
                          'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', None, None,
                          Gio.DBusCallFlags.NONE, 10000, None).unpack()
    connector = state[1][0][0][0]
    stream_path = bus.call_sync('org.gnome.Mutter.ScreenCast', sc, 'org.gnome.Mutter.ScreenCast.Session',
                                'RecordMonitor', GLib.Variant('(sa{sv})', (connector, {})), None,
                                Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
    call(session, RD + '.Session', 'Start')
    time.sleep(1.5)
    # The pointer to the middle of the screen, where the maximised window is.
    call(session, RD + '.Session', 'NotifyPointerMotionAbsolute', (stream_path, 720.0, 480.0), '(sdd)')
    time.sleep(0.2)
    call(session, RD + '.Session', 'NotifyPointerMotionAbsolute', (stream_path, 721.0, 481.0), '(sdd)')
    time.sleep(0.5)
    t0 = stream[0][0]
    start = time.monotonic() + 0.2
    for t, v, stop in stream:
        due = start + (t - t0) / 1000
        while True:
            left = due - time.monotonic()
            if left <= 0:
                break
            time.sleep(min(left, 0.0005) if left < 0.002 else left - 0.0015)
        sent = time.monotonic()
        call(session, RD + '.Session', 'NotifyPointerAxis', (0.0, float(v), 4 | (1 if stop else 0)), '(ddu)')
        out.write(json.dumps({'t': t, 'v': v, 'stop': stop, 'sent': sent * 1e6}) + '\n')
    out.close()
    time.sleep(2.5)
    call(session, RD + '.Session', 'Stop')


if __name__ == '__main__':
    main()

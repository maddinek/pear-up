#!/usr/bin/env python3
"""A bare StatusNotifierItem, so the AppIndicator area of the bar is not empty.

No GTK and no libayatana: just the D-Bus object the AppIndicator extension's
StatusNotifierWatcher looks for. Usage: tray-icon.py <icon-name> [<id>]
"""
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

ICON = sys.argv[1] if len(sys.argv) > 1 else "steam"
ITEM_ID = sys.argv[2] if len(sys.argv) > 2 else ICON
PATH = "/StatusNotifierItem"

XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="Activate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="ContextMenu"><arg type="i" direction="in"/><arg type="i" direction="in"/></method>
    <method name="Scroll"><arg type="i" direction="in"/><arg type="s" direction="in"/></method>
    <signal name="NewIcon"/>
    <signal name="NewStatus"><arg type="s"/></signal>
  </interface>
</node>
"""

PROPS = {
    "Category": GLib.Variant("s", "ApplicationStatus"),
    "Id": GLib.Variant("s", ITEM_ID),
    "Title": GLib.Variant("s", ITEM_ID),
    "Status": GLib.Variant("s", "Active"),
    "IconName": GLib.Variant("s", ICON),
    "IconThemePath": GLib.Variant("s", ""),
    "ItemIsMenu": GLib.Variant("b", False),
    "Menu": GLib.Variant("o", "/NO_DBUSMENU"),
}


def on_call(conn, sender, path, iface, method, params, invocation):
    invocation.return_value(None)


def on_get(conn, sender, path, iface, prop):
    return PROPS.get(prop)


bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
node = Gio.DBusNodeInfo.new_for_xml(XML)
bus.register_object(PATH, node.interfaces[0], on_call, on_get, None)

name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"


def register(*_):
    try:
        bus.call_sync("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
                      "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
                      GLib.Variant("(s)", (name,)), None, Gio.DBusCallFlags.NONE,
                      5000, None)
        print(f"tray icon '{ICON}' registered as {name}", flush=True)
        return GLib.SOURCE_REMOVE
    except GLib.Error as exc:
        # The watcher appears once the AppIndicator extension is enabled.
        print(f"waiting for the watcher: {exc.message}", flush=True)
        return GLib.SOURCE_CONTINUE


Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE, None, None)
GLib.timeout_add_seconds(1, register)
GLib.MainLoop().run()

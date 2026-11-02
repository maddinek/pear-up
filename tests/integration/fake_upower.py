"""UPower as far as Pear Up asks it, with a switch for the power.

The container has no battery, so the real daemon always says the power is
plugged in. This stands in for it on the system bus while the battery checks
run: org.freedesktop.UPower with OnBattery, which SIGUSR1 sets and SIGUSR2
clears, sending PropertiesChanged as the daemon does. Signals, because the
system bus lets nobody send UPower's name anything but UPower's interfaces. The display
device the shell's power indicator reads is left out; the checks run after the
power icon's and the real daemon is started again when they are done.

Usage: fake_upower.py <file to write once the name is owned>
"""
import signal
import sys

from gi.repository import Gio, GLib

NAME = "org.freedesktop.UPower"
PATH = "/org/freedesktop/UPower"
XML = """
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices"><arg type="ao" direction="out"/></method>
    <method name="GetDisplayDevice"><arg type="o" direction="out"/></method>
    <method name="GetCriticalAction"><arg type="s" direction="out"/></method>
    <property name="DaemonVersion" type="s" access="read"/>
    <property name="OnBattery" type="b" access="read"/>
    <property name="LidIsClosed" type="b" access="read"/>
    <property name="LidIsPresent" type="b" access="read"/>
  </interface>
</node>
"""

state = {"OnBattery": False}


def main():
    ready = sys.argv[1]
    info = Gio.DBusNodeInfo.new_for_xml(XML)
    bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    loop = GLib.MainLoop()

    def set_on_battery(on):
        state["OnBattery"] = on
        bus.emit_signal(None, PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
                        GLib.Variant("(sa{sv}as)", ("org.freedesktop.UPower",
                                                    {"OnBattery": GLib.Variant("b", on)}, [])))
        return GLib.SOURCE_CONTINUE

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR1, set_on_battery, True)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGUSR2, set_on_battery, False)

    def method(connection, sender, path, interface, name, params, invocation):
        if name == "EnumerateDevices":
            invocation.return_value(GLib.Variant("(ao)", ([],)))
        elif name == "GetDisplayDevice":
            invocation.return_value(GLib.Variant("(o)", (f"{PATH}/devices/DisplayDevice",)))
        else:
            invocation.return_value(GLib.Variant("(s)", ("PowerOff",)))

    def get_property(connection, sender, path, interface, name):
        if name == "OnBattery":
            return GLib.Variant("b", state["OnBattery"])
        if name == "DaemonVersion":
            return GLib.Variant("s", "1.91.5")
        return GLib.Variant("b", False)

    for interface in info.interfaces:
        bus.register_object(PATH, interface, method, get_property, None)

    def acquired(*_):
        with open(ready, "w", encoding="utf-8") as handle:
            handle.write("ready\n")

    Gio.bus_own_name_on_connection(bus, NAME, Gio.BusNameOwnerFlags.NONE, acquired, lambda *_: loop.quit())
    loop.run()


if __name__ == "__main__":
    main()

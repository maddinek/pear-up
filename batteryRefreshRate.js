// On battery, the built-in screen at 60 Hz, as Low Power Mode caps a ProMotion
// display on a Mac; back at the rate it had once the power is plugged in.
//
// A panel with variable refresh already slows to its lowest rate while nothing
// moves, so at rest this saves nothing. What it halves is the frames drawn while
// something does: a page with an animation on it, a spinner, scrolling, the
// shell's own animations. Each of those frames is drawn by the app and then by
// the shell, and a 120 Hz panel asks for twice as many of them.
//
// The switch goes through Mutter's DisplayConfig, the D-Bus interface Settings
// uses. GetCurrentState lists the monitors and their modes; the built-in one's
// current mode is swapped for the mode of the same size closest to 60 Hz with
// the same refresh rate mode (variable stays variable), the rest of the layout
// is passed back as it was, and it is applied as a temporary configuration: one
// mutter does not write to monitors.xml, so a crash or a login finds the rate
// the user chose. On mains power the mode it replaced is applied the same way.
//
// Left alone:
//   - anything but the built-in screen on its own: a monitor plugged in, or
//     only connected, is a desk, and the rates there are the user's;
//   - a screen already at 60 Hz or less, or with no 60 Hz mode of its size;
//   - a mode someone else set after ours, in Settings or by mutter itself when
//     a monitor comes or goes. That holds until the next time the power is
//     plugged in, so a rate the user picked on battery is not taken back.
//
// Pear Up is off on the lock screen, as it has no session modes of its own.
// Going back to 120 Hz for the lock and to 60 at the unlock would be two mode
// changes for nothing, so what was switched is remembered across it, and the
// unlock decides: still on battery, it stays; plugged in meanwhile, it goes back.
//
// Nothing runs while the switch is off: UPower is only watched while it is on,
// and then only its signals are listened to.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const BATTERY_60HZ_KEY = 'battery-60hz';

const TARGET_HZ = 60;
// A 59.94 Hz mode is as good as 60; anything further off is another rate.
const TARGET_SLACK_HZ = 1;
const TEMPORARY = 1;

Gio._promisify(Gio.DBusConnection.prototype, 'call');

// Mutter's DisplayConfig, through the session bus as Settings reaches it: a
// method and its parameters in, the reply out. The tests stand a recording
// one in.
function callDisplayConfig(method, parameters) {
    return Gio.DBus.session.call(
        'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
        'org.gnome.Mutter.DisplayConfig', method, parameters,
        null, Gio.DBusCallFlags.NONE, -1, null);
}

// The state is the module's, not an instance's: the lock screen's disable()
// and enable() make a new instance while the old one's call to mutter may
// still be on its way, and both must agree on what was switched.
//
// What 60 Hz is wanted: true or false, or null to leave things as they are
// (the screen is locking, or UPower has not answered yet).
let wish = null;
// The mode switched from and to, while the screen is at ours.
let switched = null;
// Someone else changed the mode while it was ours; left alone until the power
// is next plugged in.
let heldOff = false;
let display = callDisplayConfig;
// One pass at a time; a change during one means another after it.
let running = false;
let dirty = false;
let lastError = null;
let uuid = 'pear-up';
// Watching for monitor changes while anything is switched, or an instance
// wants to know, so a mode changed by someone else is seen, and a restore that
// failed after Pear Up was switched off is tried again at the next change.
let monitorsId = 0;
let watchers = 0;
// A failed restore is also tried again a few times on its own.
const RETRY_MS = 1000;
const RETRIES = 3;
let retryId = 0;
let retries = 0;

function request() {
    dirty = true;
    if (!running)
        run();
}

async function run() {
    running = true;
    while (dirty) {
        dirty = false;
        try {
            await pass();
            lastError = null;
        } catch (e) {
            lastError = e.message;
            console.warn(`[${uuid}] changing the screen's refresh rate failed:`, e.message);
            if (switched && wish === false)
                retry();
        }
    }
    running = false;
    watchMonitors();
}

function retry() {
    if (retryId || retries >= RETRIES)
        return;
    retries++;
    retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
        retryId = 0;
        request();
        return GLib.SOURCE_REMOVE;
    });
}

function watchMonitors() {
    const needed = switched !== null || watchers > 0;
    if (needed && !monitorsId) {
        monitorsId = Main.layoutManager.connect('monitors-changed', () => request());
    } else if (!needed && monitorsId) {
        Main.layoutManager.disconnect(monitorsId);
        monitorsId = 0;
    }
    if (!switched) {
        if (retryId)
            GLib.source_remove(retryId);
        retryId = 0;
        retries = 0;
    }
}

async function pass() {
    const want = wish;
    if (want === null || (!want && !switched))
        return;

    const state = readState((await display('GetCurrentState', null)).recursiveUnpack());
    // The monitors changed while they were being read: mutter does not move
    // the serial on for a mode change, so only this tells the answer is old.
    if (dirty)
        return;

    if (switched) {
        const monitor = state.monitors.find(m => m.connector === switched.connector);
        if (currentMode(monitor)?.id !== switched.to) {
            // Not ours any more: Settings, or mutter after a hotplug.
            switched = null;
            heldOff = want;
            return;
        }
        if (want)
            return;
        // Forgotten only once it is back, so a failure is tried again.
        if (monitor.modes.some(mode => mode.id === switched.from))
            await applyMode(state, switched.connector, switched.from);
        switched = null;
        return;
    }

    if (!want || heldOff)
        return;
    const monitor = soleBuiltin(state);
    const mode = currentMode(monitor);
    if (!mode || mode.refresh <= TARGET_HZ + TARGET_SLACK_HZ)
        return;
    const target = sixtyHertzFor(monitor, mode);
    if (!target)
        return;
    await applyMode(state, monitor.connector, target.id);
    switched = { connector: monitor.connector, from: mode.id, to: target.id };
}

// A mode picked in Settings in the moment between this call leaving and mutter
// taking it is overwritten, as two apps changing the monitors at once would
// overwrite each other. Mutter answers its own process within a turn of the
// main loop, so that moment is short.
async function applyMode(state, connector, modeId) {
    const [logical, properties] = layoutWith(state, connector, modeId);
    await display('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [state.serial, TEMPORARY, logical, properties]));
}

// The parts of GetCurrentState this needs, by name.
function readState([serial, monitors, logicalMonitors, properties]) {
    return {
        serial,
        properties,
        monitors: monitors.map(([[connector], modes, props]) => ({
            connector,
            builtin: props['is-builtin'] === true,
            props,
            modes: modes.map(([id, width, height, refresh, , , modeProps]) => ({
                id, width, height, refresh,
                current: modeProps['is-current'] === true,
                rateMode: modeProps['refresh-rate-mode'] ?? null,
            })),
        })),
        logical: logicalMonitors.map(([x, y, scale, transform, primary, specs]) => ({
            x, y, scale, transform, primary,
            connectors: specs.map(([connector]) => connector),
        })),
    };
}

function currentMode(monitor) {
    return monitor?.modes.find(mode => mode.current) ?? null;
}

// The built-in screen, when it is the only monitor there is and it is on.
function soleBuiltin(state) {
    if (state.monitors.length !== 1 || !state.monitors[0].builtin)
        return null;
    const monitor = state.monitors[0];
    const on = state.logical.length === 1 && state.logical[0].connectors.includes(monitor.connector);
    return on && currentMode(monitor) ? monitor : null;
}

// The mode of the same size as `mode` that is closest to 60 Hz, refreshing the
// same way, or null if there is none.
export function sixtyHertzFor(monitor, mode) {
    let best = null;
    for (const other of monitor.modes) {
        if (other.width !== mode.width || other.height !== mode.height ||
            other.rateMode !== mode.rateMode ||
            Math.abs(other.refresh - TARGET_HZ) > TARGET_SLACK_HZ)
            continue;
        if (!best || Math.abs(other.refresh - TARGET_HZ) < Math.abs(best.refresh - TARGET_HZ))
            best = other;
    }
    return best;
}

// The layout as it is, with `connector` in mode `modeId`, in the shape
// ApplyMonitorsConfig takes. Each monitor keeps the properties it has.
function layoutWith(state, connector, modeId) {
    const monitors = new Map(state.monitors.map(monitor => [monitor.connector, monitor]));
    const logical = state.logical.map(({ x, y, scale, transform, primary, connectors }) => [
        x, y, scale, transform, primary,
        connectors.map(name => {
            const monitor = monitors.get(name);
            const props = {};
            if (typeof monitor?.props['is-underscanning'] === 'boolean')
                props.underscanning = GLib.Variant.new_boolean(monitor.props['is-underscanning']);
            for (const key of ['color-mode', 'rgb-range']) {
                if (typeof monitor?.props[key] === 'number')
                    props[key] = GLib.Variant.new_uint32(monitor.props[key]);
            }
            return [name, name === connector ? modeId : currentMode(monitor)?.id ?? '', props];
        }),
    ]);
    const properties = {};
    if (state.properties['supports-changing-layout-mode'] === true &&
        typeof state.properties['layout-mode'] === 'number')
        properties['layout-mode'] = GLib.Variant.new_uint32(state.properties['layout-mode']);
    return [logical, properties];
}

export class BatteryRefreshRate {
    constructor(extensionUuid, settings) {
        this._uuid = uuid = extensionUuid;
        this._settings = settings;
        this._upower = null;
        this._cancellable = null;
        this.sync();
    }

    // On or off to match the switch. Safe to call at any time.
    sync() {
        if (!this._settings)
            return;
        if (this._settings.get_boolean(BATTERY_60HZ_KEY)) {
            this._watch();
        } else {
            this._unwatch();
            heldOff = false;
        }
        this._wish();
    }

    // Puts the rate back, unless the screen is only locking.
    destroy() {
        this._unwatch();
        this._settings = null;
        wish = Main.sessionMode.isLocked ? null : false;
        request();
    }

    // For the tests: what it knows and has done, and a stand-in for mutter.
    get state() {
        return {
            watching: !!this._upower,
            onBattery: this._onBattery(),
            wish, switched, heldOff, lastError,
            busy: running,
            watchingMonitors: !!monitorsId,
        };
    }

    static _useDisplayConfig(call) {
        display = call ?? callDisplayConfig;
    }

    // What this instance wants, from the switch and the power.
    _wish() {
        if (!this._settings?.get_boolean(BATTERY_60HZ_KEY)) {
            wish = false;
        } else {
            const onBattery = this._onBattery();
            if (onBattery === false)
                heldOff = false;
            // Until UPower has answered there is nothing to go by: a 60 Hz
            // kept over the lock screen stays until it says.
            wish = onBattery;
        }
        request();
    }

    _watch() {
        if (this._cancellable)
            return;
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower',
            this._cancellable, (_source, result) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[${this._uuid}] UPower is not answering; staying at the screen's own rate:`, e.message);
                    return;
                }
                this._upower.connectObject(
                    'g-properties-changed', () => this._wish(),
                    'notify::g-name-owner', () => this._wish(),
                    this);
                this._wish();
            });
        watchers++;
        watchMonitors();
    }

    _unwatch() {
        if (!this._cancellable)
            return;
        this._cancellable.cancel();
        this._cancellable = null;
        this._upower?.disconnectObject(this);
        this._upower = null;
        watchers--;
        watchMonitors();
    }

    // True on battery, false on mains power, null when UPower has not said.
    _onBattery() {
        const value = this._upower?.get_cached_property('OnBattery');
        return value ? value.get_boolean() : null;
    }
}

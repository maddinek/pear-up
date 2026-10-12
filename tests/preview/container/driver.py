#!/usr/bin/env python3
"""Walk the throwaway shell through the shot list and write the PNGs.

Runs inside the container's session bus, once the shell is up. Every shot is a
function in SHOTS: it puts the shell in some state, captures the whole stage at
device resolution (2880x1920 for a 1440x960 stage at scale 2, say) and saves
crops of it. To add a shot, write another function with the @shot decorator;
they run in file order.

Usage: driver.py <out-dir> [shot-name ...]   (no names: all shots)
"""
import json
import os
import sys
import time

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, Gio, GLib

OUT = sys.argv[1]
ONLY = set(sys.argv[2:])

PEAR_UP = "pear-up@maddinek.github.io"
FRONT_APP = os.environ.get("PREVIEW_FRONT_APP", "org.gnome.Nautilus.desktop")

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
written = []


# ---------------------------------------------------------------- plumbing
def call(name, path, iface, method, args=None, sig="()", timeout=30000):
    return bus.call_sync(name, path, iface, method,
                         GLib.Variant(sig, args) if args is not None else None,
                         None, Gio.DBusCallFlags.NONE, timeout, None)


def js(code):
    """Run JavaScript in the shell (unsafe mode is on via the hook) and return
    its JSON result. `pv` holds the modules the hook exported for this."""
    ok, result = call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell",
                      "Eval", (code,), "(s)").unpack()
    if not ok:
        raise RuntimeError(f"Eval failed: {result}\n--- code ---\n{code}")
    return json.loads(result) if result else None


def wait(seconds):
    time.sleep(seconds)


def shell_set(prop, variant):
    call("org.gnome.Shell", "/org/gnome/Shell", "org.freedesktop.DBus.Properties",
         "Set", ("org.gnome.Shell", prop, variant), "(ssv)")


JS_HELPERS = """
const box = a => {
    const [x, y] = a.get_transformed_position();
    const [w, h] = a.get_transformed_size();
    return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
};
const pearUpButtons = () => Object.entries(pv.Main.panel.statusArea)
    .filter(([role]) => role === 'pearup-logo' || role.startsWith('%s-'));
""" % PEAR_UP


def jsfn(body):
    return js(f"(() => {{ {JS_HELPERS}\n{body} }})()")


# ---------------------------------------------------------------- pointer
class RemotePointer:
    """A pointer driven through mutter's RemoteDesktop, the way Pear Up's
    tests/vm/rd-click.py clicks: on GNOME 50 panel buttons react through
    Clutter.ClickGesture, which ignores synthetic Clutter events but takes
    these like real hardware. One session for the whole run; the
    screen-sharing icon it would put in the bar is hidden by the hook."""

    RD = "org.gnome.Mutter.RemoteDesktop"
    SC = "org.gnome.Mutter.ScreenCast"
    BTN_LEFT = 0x110
    # Over bare wallpaper: clear of the windows, the bar and the dock. This far
    # from the bottom right corner of the stage.
    PARK_FROM_CORNER = (140, 50)

    def __init__(self):
        self.rd = call(self.RD, "/org/gnome/Mutter/RemoteDesktop", self.RD,
                       "CreateSession").unpack()[0]
        sid = call(self.RD, self.rd, "org.freedesktop.DBus.Properties", "Get",
                   (f"{self.RD}.Session", "SessionId"), "(ss)").unpack()[0]
        self.sc = call(self.SC, "/org/gnome/Mutter/ScreenCast", self.SC,
                       "CreateSession",
                       ({"remote-desktop-session-id": GLib.Variant("s", sid)},),
                       "(a{sv})").unpack()[0]
        state = call("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                     "org.gnome.Mutter.DisplayConfig", "GetCurrentState").unpack()
        connector = state[1][0][0][0]
        self.stream = call(self.SC, self.sc, f"{self.SC}.Session", "RecordMonitor",
                           (connector, {}), "(sa{sv})").unpack()[0]
        # A paired screencast is started by the remote-desktop session.
        call(self.RD, self.rd, f"{self.RD}.Session", "Start")
        time.sleep(1.5)
        # Absolute motion is in the stream's pixels, which are device pixels
        # (2880x1920), while the stage and everything read from it is logical
        # (1440x960). The stream's own "size" parameter reports the logical
        # size, so the factor comes from the monitor's scale instead.
        logical_scale = state[2][0][2]
        logical_layout = state[3].get("layout-mode", 1) == 1
        self.factor = logical_scale if logical_layout else 1.0
        width, height = js("[global.stage.width, global.stage.height]")
        self.park_at = (width - self.PARK_FROM_CORNER[0], height - self.PARK_FROM_CORNER[1])

    def move(self, x, y, settle=0.4):
        call(self.RD, self.rd, f"{self.RD}.Session", "NotifyPointerMotionAbsolute",
             (self.stream, x * self.factor, y * self.factor), "(sdd)")
        time.sleep(settle)

    def click(self, x, y):
        self.move(x, y)
        for pressed in (True, False):
            call(self.RD, self.rd, f"{self.RD}.Session", "NotifyPointerButton",
                 (self.BTN_LEFT, pressed), "(ib)")
            time.sleep(0.12)
        time.sleep(0.6)

    def park(self):
        """Out of the way, so nothing is left in its hover state."""
        self.move(*self.park_at, settle=0.6)

    def stop(self):
        try:
            call(self.RD, self.rd, f"{self.RD}.Session", "Stop")
        except GLib.Error:
            pass


_pointer = None


def pointer():
    global _pointer
    if _pointer is None:
        _pointer = RemotePointer()
        _pointer.park()
    return _pointer


# ---------------------------------------------------------------- capture
def capture(name, crops=None, keep_full=True):
    """Save the whole stage as <name>.png, then each crop (logical x, y, w, h)
    as <name>-<crop>.png at device resolution. keep_full=False keeps only the
    crops (for follow-up pictures where the rest of the screen is unchanged)."""
    path = os.path.join(OUT, f"{name}.png")
    scale = call("org.gnome.Shell", "/io/github/maddinek/PearUpPreview",
                 "io.github.maddinek.PearUpPreview", "SaveStage", (path,), "(s)",
                 timeout=60000).unpack()[0]
    if not scale or not os.path.exists(path):
        print(f"  !! capture of {name} failed")
        return
    full = GdkPixbuf.Pixbuf.new_from_file(path)
    if keep_full:
        written.append(path)
        print(f"  {name}.png  {full.get_width()}x{full.get_height()} (scale {scale:g})")
    else:
        os.unlink(path)
    for crop_name, rect in (crops or {}).items():
        if not rect:
            continue
        x, y, w, h = (round(v * scale) for v in rect)
        x, y = max(0, x), max(0, y)
        w = min(w, full.get_width() - x)
        h = min(h, full.get_height() - y)
        if w <= 0 or h <= 0:
            continue
        sub = full.new_subpixbuf(x, y, w, h)
        crop_path = os.path.join(OUT, f"{name}-{crop_name}.png")
        sub.savev(crop_path, "png", [], [])
        written.append(crop_path)
        print(f"  {name}-{crop_name}.png  {w}x{h}")


def pad(rect, by):
    if not rect:
        return None
    x, y, w, h = rect
    return [x - by, y - by, w + 2 * by, h + 2 * by]


def panel_crops():
    g = jsfn("""
        const p = pv.Main.panel;
        return {panel: box(p), left: box(p._leftBox), center: box(p._centerBox),
                right: box(p._rightBox)};""")
    px, py, pw, ph = g["panel"]
    left_end = g["left"][0] + g["left"][2]
    right_start = g["right"][0]
    return {
        "topbar": g["panel"],
        "topbar-left": [0, 0, min(pw, left_end + 24), ph],
        "topbar-right": [max(0, right_start - 24), 0, pw - max(0, right_start - 24), ph],
    }


def dock_rect():
    return jsfn("""
        const dock = pv.Main.layoutManager.uiGroup.get_children()
            .find(a => a.name === 'dashtodockContainer' && a.visible);
        if (!dock) return null;
        const bg = dock.dash?._background;
        return box(bg && bg.width > 0 ? bg : dock);""")


def focused_window_rect():
    return jsfn("""
        const w = global.display.get_focus_window();
        if (!w) return null;
        const r = w.get_frame_rect();
        return [r.x, r.y, r.width, r.height];""")


def close_menus():
    jsfn("""
        for (const [, b] of pearUpButtons()) b.menu?.close?.();
        pv.Main.panel.statusArea.quickSettings?.menu?.close?.();
        pv.Main.panel.statusArea.dateMenu?.menu?.close?.();
        return true;""")
    wait(0.4)
    if _pointer is not None:
        _pointer.park()


def clear_notifications():
    jsfn("""
        for (const s of pv.Main.messageTray.getSources()) s.destroy();
        return true;""")
    wait(0.5)


def focus_app(app_id):
    ok = jsfn(f"""
        const app = pv.Shell.AppSystem.get_default().lookup_app('{app_id}');
        const win = app?.get_windows?.()[0];
        if (!win) return false;
        win.activate(global.get_current_time());
        return true;""")
    wait(1.0)
    return ok


# ---------------------------------------------------------------- shots
SHOTS = []


def shot(fn):
    SHOTS.append(fn)
    return fn


def opt_in_shot(fn):
    """A shot taken only when PREVIEW_SHOTS names it: a frame sequence of an
    animation, say, which is slow and only wanted by whoever is changing it."""
    fn.opt_in = True
    return shot(fn)


@shot
def desktop():
    """1 + 2 + 3: an app in front, its menus in the bar, window buttons, dock."""
    shell_set("OverviewActive", GLib.Variant("b", False))
    wait(1.0)
    focus_app(FRONT_APP)
    wait(1.0)
    crops = panel_crops()
    crops["dock"] = pad(dock_rect(), 12)
    win = focused_window_rect()
    if win:
        x, y, w, h = win
        crops["window-titlebar"] = [x - 8, y - 8, min(w, 520) + 16, 70]
    capture("01-desktop", crops)


@shot
def overview():
    """4: the overview (Ctrl+Up), with the desktops strip."""
    shell_set("OverviewActive", GLib.Variant("b", True))
    wait(2.5)
    strip = jsfn("""
        const t = pv.Main.overview._overview?._controls?._thumbnailsBox;
        return t && t.visible && t.width > 0 ? box(t) : null;""")
    capture("02-overview", {"desktops-strip": pad(strip, 16), "topbar": panel_crops()["topbar"]})
    shell_set("OverviewActive", GLib.Variant("b", False))
    wait(1.5)


def click_bar_item(predicate_js, label):
    target = jsfn(f"""
        for (const [role, b] of pearUpButtons()) {{
            if (!({predicate_js})(role, b)) continue;
            return box(b);
        }}
        return null;""")
    if not target:
        print(f"  !! no {label} in the bar")
        return None
    x, y, w, h = target
    pointer().click(x + w / 2, y + h / 2)
    wait(0.8)
    return target


def open_menu_rect():
    return jsfn("""
        for (const [, b] of pearUpButtons())
            if (b.menu?.isOpen) return box(b.menu._boxPointer ?? b.menu.actor);
        return null;""")


@shot
def pear_menu():
    """5a: the pear (System) menu, opened by a real click."""
    focus_app(FRONT_APP)
    click_bar_item("(role) => role === 'pearup-logo'", "pear button")
    menu = open_menu_rect()
    if not menu:
        print("  !! the pear menu did not open")
    region = None
    if menu:
        x, y, w, h = menu
        region = [0, 0, max(x + w, 400) + 16, y + h + 16]
    capture("03-pear-menu", {"menu": region})
    close_menus()


@shot
def file_menu():
    """5b: the app's File menu, opened by a real click."""
    focus_app(FRONT_APP)
    button = click_bar_item("(role, b) => b.label?.text === 'File'", "File menu")
    menu = open_menu_rect()
    if not menu:
        print("  !! the File menu did not open")
    region = None
    if menu and button:
        x, y, w, h = menu
        region = [0, 0, max(x + w, button[0] + button[2]) + 16, y + h + 16]
    capture("04-file-menu", {"menu": region})
    close_menus()


@shot
def notification():
    """6: a notification banner, to show where it lands."""
    focus_app(FRONT_APP)
    call("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
         "org.freedesktop.Notifications", "Notify",
         ("Files", 0, "org.gnome.Nautilus", "Copy finished",
          "3 files were copied to Documents.", [],
          {"desktop-entry": GLib.Variant("s", "org.gnome.Nautilus")}, 8000),
         "(susssasa{sv}i)")
    wait(2.0)
    banner = jsfn("""
        const bin = pv.Main.messageTray._bannerBin;
        return bin && bin.get_n_children() > 0 ? box(bin) : null;""")
    capture("05-notification", {"banner": pad(banner, 16)})
    clear_notifications()


@opt_in_shot
def notification_slide():
    """Opt-in: frames of a banner sliding in from the right and back out, with
    Pear Up's banners-slide-from-right on and the shell slowed down (in the
    container only) so that a picture every second or so catches it moving."""
    slow = 40
    focus_app(FRONT_APP)
    clear_notifications()
    settings = f"pv.Main.extensionManager.lookup('{PEAR_UP}').stateObj.getSettings()"
    jsfn(f"{settings}.set_boolean('banners-slide-from-right', true); return true;")
    jsfn(f"pv.St.Settings.get().slow_down_factor = {slow}; return true;")
    wait(0.5)
    state = """
        const tray = pv.Main.messageTray, bin = tray._bannerBin;
        const monitor = pv.Main.layoutManager.primaryMonitor;
        return {shown: bin.get_n_children() > 0 && tray.visible, tx: bin.translation_x,
                y: bin.y, width: bin.width, height: bin.height,
                animations: pv.St.Settings.get().enable_animations,
                monitor: [monitor.x, monitor.y, monitor.width, monitor.height],
                panel: box(pv.Main.layoutManager.panelBox)};"""
    try:
        call("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
             "org.freedesktop.Notifications", "Notify",
             ("Files", 0, "org.gnome.Nautilus", "Copy finished",
              "3 files were copied to Documents.", [],
              {"desktop-entry": GLib.Variant("s", "org.gnome.Nautilus")}, 0),
             "(susssasa{sv}i)")

        def frames(prefix, done, limit=14):
            region = None
            for i in range(limit):
                st = jsfn(state)
                if region is None and st["width"] > 0:
                    mx, my, mw, mh = st["monitor"]
                    w = st["width"] + 120
                    region = [mx + mw - w, my, w, st["panel"][3] + st["height"] + 40]
                print(f"  {prefix} {i:02d}: shown={st['shown']} x={st['tx']:.0f} y={st['y']:.0f}"
                      f" animations={st['animations']}")
                capture(f"07-{prefix}-{i:02d}-x{round(st['tx'])}", {"corner": region}, keep_full=False)
                if done(st):
                    return

        frames("slide-in", lambda st: st["shown"] and st["tx"] == 0)
        jsfn("""
            const tray = pv.Main.messageTray;
            tray._notificationExpired = true;
            tray._updateState();
            return true;""")
        frames("slide-out", lambda st: not st["shown"], limit=24)
    finally:
        jsfn("pv.St.Settings.get().slow_down_factor = 1; return true;")
        jsfn(f"{settings}.reset('banners-slide-from-right'); return true;")
        clear_notifications()


@shot
def app_name_menu():
    """Extra: the bold app-name menu (Files), opened by a real click."""
    focus_app(FRONT_APP)
    button = click_bar_item("(role, b) => b.has_style_class_name?.('pearup-app-menu')",
                            "app-name menu")
    menu = open_menu_rect()
    region = None
    if menu and button:
        x, y, w, h = menu
        region = [0, 0, max(x + w, button[0] + button[2]) + 16, y + h + 16]
    capture("05b-app-name-menu", {"menu": region})
    close_menus()


@shot
def dock_hover():
    """Extra: the pointer resting on the dock (Pear Up's magnification)."""
    focus_app(FRONT_APP)
    dock = dock_rect()
    if not dock:
        print("  !! no dock")
        return
    x, y, w, h = dock
    pointer().move(x + w / 2, y + h / 2, settle=1.2)
    capture("06-dock-hover", {"dock": pad(dock_rect(), 60)})
    pointer().park()


def _bounce_frames(prefix, app_index, hover):
    """Click a dock favourite (it launches nothing, so it is starting only
    briefly, and its icon lands after the hop in the air) and photograph the
    dock while it bounces. Animations run slowed down twelve times, inside this
    container only, so several captures land in one hop; each frame's lift is
    read back from the overlay just before it is taken."""
    app = jsfn(f"""
        const dock = pv.Main.layoutManager.uiGroup.get_children()
            .find(a => a.name === 'dashtodockContainer' && a.visible);
        const items = dock?.dash?._box.get_children().filter(i => i.child?.app) ?? [];
        const item = items[Math.min({app_index}, items.length - 1)];
        if (!item) return null;
        return {{id: item.child.app.get_id(), slot: box(item), icon: box(item.child.icon.icon)}};""")
    if not app:
        print("  !! no dock favourite to bounce")
        return
    x, y, w, h = app["slot"]
    if hover:
        pointer().move(x + w / 2, y + h / 2, settle=1.2)
    jsfn(f"""
        const dock = pv.Main.layoutManager.uiGroup.get_children()
            .find(a => a.name === 'dashtodockContainer' && a.visible);
        const item = dock.dash._box.get_children().find(i => i.child?.app?.get_id() === '{app["id"]}');
        item.child.activate(1);
        return true;""")
    started = time.monotonic()
    region = pad(dock_rect(), 80)
    for frame in range(18):
        lift = jsfn("""
            const overlay = pv.Main.layoutManager.uiGroup.get_children()
                .find(a => a.name === 'pearup-dock-bounce');
            const clone = overlay?.get_children().find(c => c.opacity > 0);
            const copies = pv.Main.layoutManager.uiGroup.get_children()
                .find(a => a.name === 'pearup-dock-magnifier');
            return {clone: clone ? box(clone) : null, magnified: !!copies};""")
        name = f"{prefix}-{frame:02d}"
        capture(name, {"dock": region}, keep_full=False)
        print(f"    t={time.monotonic() - started:.2f}s clone={lift['clone']} "
              f"icon={app['icon']} magnified={lift['magnified']}")
    if hover:
        pointer().park()


@shot
def dock_bounce():
    """Extra: a dock icon bouncing as its app starts (Pear Up's dock bounce),
    plain and under magnification, as a frame sequence."""
    focus_app(FRONT_APP)
    if not dock_rect():
        print("  !! no dock")
        return
    jsfn(f"""
        const settings = pv.Main.extensionManager.lookup('{PEAR_UP}')?.stateObj?.getSettings();
        if (!settings) return false;
        settings.set_boolean('dock-bounce-on-launch', true);
        pv.St.Settings.get().slow_down_factor = 12;
        return true;""")
    wait(0.5)
    try:
        _bounce_frames("07-dock-bounce", 1, hover=False)
        wait(1.0)
        _bounce_frames("07b-dock-bounce-magnified", 2, hover=True)
    finally:
        jsfn(f"""
            pv.St.Settings.get().slow_down_factor = 1;
            pv.Main.extensionManager.lookup('{PEAR_UP}')?.stateObj?.getSettings()
                ?.reset('dock-bounce-on-launch');
            return true;""")


# ---------------------------------------------------------------- desktop switching
# Spaces Spring: a branch that has it gets frames of its animations, each taken
# from the animation paused and set to a chosen moment, so a slow software-
# rendered capture cannot blur or skip them, plus the numbers behind them in
# spaces-trace.json. The keyboard switch and the bump go through real key
# presses (the RemoteDesktop keyboard); the pull past the end is the swipe
# tracker fed touchpad updates, the way the touchpad feeds it.
SPACES_KEY = "spaces-spring"
EXT = f"pv.Main.extensionManager.lookup('{PEAR_UP}')?.stateObj"
SPACES_JS = """
const ext = %s;
const anim = pv.Main.wm._workspaceAnimation;
const groups = () => anim._switchData?.monitors ?? [];
const seek = (t, ms) => { t.advance(ms); t.emit('new-frame', ms); };
const ws = () => global.workspace_manager.get_active_workspace_index();
const shift = () => { const g = groups()[0]; return g ? {progress: +g.progress.toFixed(4),
    tx: +g._container.translation_x.toFixed(1)} : null; };
""" % EXT


def spaces(body):
    return jsfn(SPACES_JS + body)


def press(*keysyms):
    p = pointer()
    for sym in keysyms:
        call(p.RD, p.rd, f"{p.RD}.Session", "NotifyKeyboardKeysym", (sym, True), "(ub)")
    for sym in reversed(keysyms):
        call(p.RD, p.rd, f"{p.RD}.Session", "NotifyKeyboardKeysym", (sym, False), "(ub)")


CTRL, ALT, LEFT, RIGHT = 0xffe3, 0xffe9, 0xff51, 0xff53


@shot
def desktop_switch():
    """07: switching desktops on Spaces Spring's spring: a keyboard switch part
    way, the desktops pulled past the last one and springing back, the bump."""
    if not spaces(f"return !!ext?._settings?.settings_schema?.has_key('{SPACES_KEY}');"):
        print("  (this branch has no Spaces Spring)")
        return
    was_on = spaces(f"const on = ext._settings.get_boolean('{SPACES_KEY}'); "
                    f"ext._settings.set_boolean('{SPACES_KEY}', true); return on;")
    focus_app(FRONT_APP)
    spaces("global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); return 1;")
    wait(1.0)
    trace = {"state": spaces("return ext._spacesSpring.state;")}
    WINDOWS_JS = ("return global.get_window_actors().map(a => [a.meta_window.get_title(), "
                  "a.meta_window.get_workspace()?.index(), a.visible, a.meta_window.minimized]);")
    trace["windowsAtStart"] = spaces(WINDOWS_JS)
    W = jsfn("return pv.Main.layoutManager.primaryMonitor.width;")
    H = jsfn("return pv.Main.layoutManager.primaryMonitor.height;")
    edge = {"edge": [W - 360, 0, 360, H]}

    # The keyboard switch, Ctrl+Alt+Right, paused the moment it starts.
    press(CTRL, ALT, RIGHT)
    info = spaces("""
        const t = groups()[0]?.get_transition('progress');
        if (!t) return null;
        t.pause();
        const T = t.get_duration();
        const samples = [];
        for (let ms = 0; ms <= T; ms += 20) { seek(t, ms); samples.push([ms, shift().progress]); }
        seek(t, 60);
        return {duration: T, samples, to: ws()};""")
    trace["keyboard"] = info
    if info:
        for ms in (60, 140):
            spaces(f"const t = groups()[0].get_transition('progress'); seek(t, {ms}); return 1;")
            capture(f"07-spaces-switch-{ms}ms", keep_full=True)
        spaces("groups().forEach(g => g.get_transition('progress')?.start()); return 1;")
    else:
        print("  !! the keyboard switch did not animate")
    wait(1.2)

    # On the last desktop: a swipe pulled past it, step by step.
    pull = spaces("""
        const tr = anim._swipeTracker;
        let time = global.get_current_time();
        const last = global.workspace_manager.n_workspaces - 1;
        global.workspace_manager.get_workspace_by_index(last).activate(time);
        return last;""")
    wait(1.0)
    trace["pull"] = spaces("""
        const tr = anim._swipeTracker;
        let time = global.get_current_time();
        tr._touchpadGesture.emit('begin', time, 700, 500);
        const steps = [];
        for (let i = 1; i <= 16; i++) {
            tr._touchpadGesture.emit('update', time += 16, 16, 400);
            steps.push([i * 16, shift()?.tx, +ext._spacesSpring.state.stretch.toFixed(3)]);
        }
        return {last: ws(), steps};""")
    capture("07-spaces-pull", edge)
    trace["springBack"] = spaces("""
        const tr = anim._swipeTracker;
        tr._touchpadGesture.emit('end', global.get_current_time() + 16, 400);
        const sb = ext._spacesSpring._springBack;
        groups().forEach(g => g.get_transition('progress')?.pause());
        if (!sb) return null;
        sb.timeline.pause();
        const T = sb.timeline.get_duration();
        const samples = [];
        for (let ms = 0; ms <= T; ms += 20) { seek(sb.timeline, ms); samples.push([ms, shift().tx]); }
        seek(sb.timeline, 80);
        return {duration: T, samples};""")
    if trace["springBack"]:
        capture("07-spaces-spring-back-80ms", edge, keep_full=False)
        spaces("""
            ext._spacesSpring._springBack?.timeline.start();
            groups().forEach(g => g.get_transition('progress')?.start()); return 1;""")
    else:
        print("  !! no spring back")
    wait(1.2)

    # A swipe back towards the first desktop let go half way: the release.
    trace["release"] = spaces("""
        const tr = anim._swipeTracker;
        let time = global.get_current_time();
        tr._touchpadGesture.emit('begin', time, 700, 500);
        for (let i = 0; i < 10; i++) tr._touchpadGesture.emit('update', time += 16, -24, 400);
        tr._touchpadGesture.emit('end', time + 16, 400);
        const t = groups()[0]?.get_transition('progress');
        if (!t) return null;
        t.pause();
        const T = t.get_duration();
        const samples = [];
        for (let ms = 0; ms <= T; ms += 20) { seek(t, ms); samples.push([ms, shift().progress]); }
        seek(t, T); t.start();
        return {duration: T, samples};""")
    wait(1.2)

    # The bump: Ctrl+Alt+Left on the first desktop.
    spaces("global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); return 1;")
    wait(1.0)
    focus_app(FRONT_APP)
    trace["windowsAtBump"] = spaces(WINDOWS_JS)
    press(CTRL, ALT, LEFT)
    trace["bump"] = spaces("""
        const b = ext._spacesSpring._bump;
        if (!b) return null;
        b.timeline.pause();
        const T = b.timeline.get_duration();
        const tx = () => +b.groups[0]._container.translation_x.toFixed(1);
        const samples = [];
        for (let ms = 0; ms <= T; ms += 20) { seek(b.timeline, ms); samples.push([ms, tx()]); }
        seek(b.timeline, 50);
        return {duration: T, samples, ws: ws()};""")
    if trace["bump"]:
        capture("07-spaces-bump-50ms", {"edge": [0, 0, 360, H]}, keep_full=False)
        spaces("ext._spacesSpring._bump?.timeline.start(); return 1;")
    else:
        print("  !! no bump")
    wait(1.0)

    # The same keyboard switch with the switch off, for comparison: GNOME's own.
    spaces(f"ext._settings.set_boolean('{SPACES_KEY}', false); return 1;")
    spaces("global.workspace_manager.get_workspace_by_index(0).activate(global.get_current_time()); return 1;")
    wait(1.0)
    press(CTRL, ALT, RIGHT)
    trace["keyboardOff"] = spaces("""
        const t = groups()[0]?.get_transition('progress');
        if (!t) return null;
        t.pause();
        const T = t.get_duration();
        const samples = [];
        for (let ms = 0; ms <= T; ms += 20) { seek(t, ms); samples.push([ms, shift().progress]); }
        seek(t, T); t.start();
        return {duration: T, samples};""")
    wait(1.0)

    with open(os.path.join(OUT, "spaces-trace.json"), "w") as handle:
        json.dump(trace, handle, indent=1)
    print("  spaces-trace.json")
    if was_on:
        spaces(f"ext._settings.set_boolean('{SPACES_KEY}', true); return 1;")


# ---------------------------------------------------------------- preferences
# Pear Up's preferences window, page by page. It is a separate GTK4 process, so
# it is driven through the accessibility bus (AT-SPI): each page's tab in the
# view switcher has a "click" action, and each page's scroll bar takes a value,
# which scrolls without needing the pointer. Pages are found, not listed, so a
# branch with an Appearance or Windows page gets pictures of it too.
PREFS_APP = "org.gnome.Shell.Extensions"


def _atspi():
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    Atspi.init()
    return Atspi


def _find(node, role, out, depth=0):
    if depth > 40:
        return out
    try:
        if node.get_role_name() == role:
            out.append(node)
        for index in range(node.get_child_count()):
            child = node.get_child_at_index(index)
            if child is not None:
                _find(child, role, out, depth + 1)
    except GLib.Error:
        pass
    return out


def _prefs_frame(Atspi, timeout=30):
    for _ in range(timeout * 2):
        desktop = Atspi.get_desktop(0)
        for index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(index)
            if app is None or app.get_name() != PREFS_APP:
                continue
            frames = [f for f in _find(app, "frame", []) if "Pear Up" in (f.get_name() or "")]
            if frames and _find(frames[0], "page tab", []):
                return frames[0]
        time.sleep(0.5)
    return None


def _prefs_window_rect():
    return jsfn(f"""
        const w = global.display.list_all_windows()
            .find(w => w.get_wm_class() === '{PREFS_APP}' && w.get_title() === 'Pear Up');
        if (!w) return null;
        w.activate(global.get_current_time());
        const r = w.get_frame_rect();
        return [r.x, r.y, r.width, r.height];""")


def _showing(Atspi, node):
    return node.get_state_set().contains(Atspi.StateType.SHOWING)


@shot
def prefs():
    """10: the preferences window, every page, scrolled through."""
    Atspi = _atspi()
    close_menus()
    try:
        call(PREFS_APP, "/org/gnome/Shell/Extensions", PREFS_APP, "OpenExtensionPrefs",
             (PEAR_UP, "", {}), "(ssa{sv})")
    except GLib.Error as exc:
        # "Already showing a prefs dialog" is fine: that window is used.
        if "Already showing" not in exc.message:
            raise
    frame = _prefs_frame(Atspi)
    if frame is None:
        print("  !! the preferences window did not come up")
        return
    wait(1.5)
    rect = _prefs_window_rect()
    window = pad(rect, 10)
    tabs = sorted(_find(frame, "page tab", []),
                  key=lambda tab: tab.get_extents(Atspi.CoordType.WINDOW).x)
    print(f"  pages: {', '.join(tab.get_name() for tab in tabs)}")
    for tab in tabs:
        title = tab.get_name() or "page"
        slug = "-".join(title.lower().split())
        tab.get_action_iface().do_action(0)
        wait(1.2)
        capture(f"10-prefs-{slug}", {"window": window})

        # The rest of a long page, a viewport at a time with some overlap.
        bars = [bar for bar in _find(frame, "scroll bar", [])
                if _showing(Atspi, bar) and bar.get_value_iface()]
        if not bars:
            continue
        bar = bars[0]
        value = bar.get_value_iface()
        step = max(200, bar.get_extents(Atspi.CoordType.WINDOW).height - 120)
        position, part = value.get_current_value(), 2
        while part <= 12:
            target = min(position + step, value.get_maximum_value())
            if target <= position + 1:
                break
            value.set_current_value(target)
            wait(0.8)
            now = value.get_current_value()
            if now <= position + 1:
                break
            capture(f"10-prefs-{slug}-{part}", {"window": window}, keep_full=False)
            position, part = now, part + 1
        value.set_current_value(value.get_minimum_value())
    jsfn(f"""
        global.display.list_all_windows()
            .filter(w => w.get_wm_class() === '{PREFS_APP}')
            .forEach(w => w.delete(global.get_current_time()));
        return true;""")
    wait(1.0)


# ---------------------------------------------------------------- facts
def facts():
    info = jsfn("""
        const m = pv.Main.layoutManager.primaryMonitor;
        const settings = new pv.Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const exts = pv.Main.extensionManager;
        const ext = uuid => { const e = exts.lookup(uuid); return e ? {state: e.state, error: e.error || null, version: e.metadata?.version ?? null, path: e.path} : null; };
        const ctx = pv.St.ThemeContext.get_for_stage(global.stage);
        return {
            stage: [global.stage.width, global.stage.height],
            primaryMonitor: [m.x, m.y, m.width, m.height],
            monitorScale: m.geometry_scale,
            themeScaleFactor: ctx.scale_factor,
            font: settings.get_string('font-name'),
            iconTheme: settings.get_string('icon-theme'),
            colorScheme: settings.get_string('color-scheme'),
            extensions: Object.fromEntries(exts.getUuids().map(u => [u, ext(u)])),
        };""")
    state = call("org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                 "org.gnome.Mutter.DisplayConfig", "GetCurrentState").unpack()
    info["logicalMonitors"] = [
        {"x": lm[0], "y": lm[1], "scale": lm[2], "monitors": [m[0] for m in lm[5]]}
        for lm in state[2]]
    info["modes"] = [[mode[0] for mode in mon[1] if mode[6].get("is-current")]
                     for mon in state[1]]
    info["layoutMode"] = {1: "logical", 2: "physical"}.get(
        state[3].get("layout-mode"), state[3].get("layout-mode"))
    with open(os.path.join(OUT, "display.json"), "w") as handle:
        json.dump(info, handle, indent=2)
    print(f"  display: mode {info['modes']}, scale {info['monitorScale']}, "
          f"logical {info['primaryMonitor'][2]}x{info['primaryMonitor'][3]}, "
          f"stage {info['stage'][0]}x{info['stage'][1]}, layout {info['layoutMode']}")
    print(f"  font {info['font']}, icons {info['iconTheme']}, scheme {info['colorScheme']}")
    for uuid, e in sorted(info["extensions"].items()):
        state_name = {1: "ACTIVE", 2: "INACTIVE", 3: "ERROR", 4: "OUT_OF_DATE",
                      6: "INITIALIZED"}.get(e and e["state"], e and e["state"])
        print(f"  ext {uuid}: {state_name}"
              + (f" v{e['version']}" if e and e["version"] is not None else "")
              + (f"  ERROR {e['error']}" if e and e["error"] else ""))


def wait_for_accounts(timeout=20):
    """GNOME decides whether Log Out is offered once AccountsService has loaded
    the users; wait for that, so the shell's own answer is settled before any
    picture. (Pear Up may still show what it read when it built its menu.)"""
    for _ in range(timeout * 4):
        if jsfn("return pv.AccountsService.UserManager.get_default().is_loaded;"):
            return True
        time.sleep(0.25)
    print("  note: AccountsService never loaded; Log Out may differ between runs")
    return False


def main():
    os.makedirs(OUT, exist_ok=True)
    wait_for_accounts()
    clear_notifications()
    facts()
    pointer()  # parked over the wallpaper before the first picture
    for fn in SHOTS:
        if (ONLY or getattr(fn, "opt_in", False)) and fn.__name__ not in ONLY:
            continue
        print(f"== {fn.__name__}")
        try:
            fn()
        except Exception as exc:  # one broken shot should not lose the rest
            print(f"  !! {fn.__name__} failed: {exc}")
            try:
                close_menus()
            except Exception:
                pass
    if _pointer is not None:
        _pointer.stop()
    with open(os.path.join(OUT, "shots.txt"), "w") as handle:
        handle.write("\n".join(os.path.basename(p) for p in written) + "\n")
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())

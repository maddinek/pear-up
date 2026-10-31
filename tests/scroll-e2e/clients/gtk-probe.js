#!/usr/bin/env -S gjs -m
// GTK 4 scroll probe for the end-to-end test: a maximized window with a tall
// scrolled page. Logs, as JSON lines to $PROBE_LOG, every scroll event GTK's
// controller sees (deltas, event time), the velocity GTK starts its own glide
// with on a stop ("decelerate"), and on every frame the frame clock's time and
// where the page is: what is drawn, glide included.
// Same events as ~/.cache/scroll-probe/scroll-probe.js on framy, plus frames.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

const out = [];
const path = GLib.getenv('PROBE_LOG') ?? '/tmp/gtk-probe.jsonl';
const w = obj => out.push(JSON.stringify(obj));
const flush = () => {
    GLib.file_set_contents(path, `${out.join('\n')}\n`);
    return GLib.SOURCE_CONTINUE;
};
GLib.timeout_add(GLib.PRIORITY_LOW, 250, flush);

const app = new Gtk.Application({application_id: 'dev.devopsed.ScrollProbeE2E'});
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({application: app, title: 'scroll-probe', default_width: 900, default_height: 700});
    // One tall child: cheap to build, room to scroll both ways.
    const box = new Gtk.Label({label: 'scroll probe', valign: Gtk.Align.START});
    box.set_size_request(800, 400000);
    const sw = new Gtk.ScrolledWindow({child: box, kinetic_scrolling: true});
    win.set_child(sw);
    const adj = sw.get_vadjustment();
    const c = new Gtk.EventControllerScroll({flags: Gtk.EventControllerScrollFlags.BOTH_AXES});
    c.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    c.connect('scroll', (ctl, dx, dy) => {
        const e = ctl.get_current_event();
        w({k: 'scroll', dy, t: e?.get_time(), stop: e?.is_stop?.() ?? false, mono: GLib.get_monotonic_time()});
        return false;
    });
    c.connect('scroll-end', () => w({k: 'end', mono: GLib.get_monotonic_time()}));
    win.add_controller(c);
    const motion = new Gtk.EventControllerMotion();
    let moves = 0;
    motion.connect('enter', (_m, x, y) => w({k: 'enter', x, y, mono: GLib.get_monotonic_time()}));
    motion.connect('motion', (_m, x, y) => {
        if (moves++ < 5)
            w({k: 'motion', x, y});
    });
    win.add_controller(motion);
    // The scrolled window's own controller is the one that glides.
    const controllers = sw.observe_controllers();
    for (let i = 0; i < controllers.get_n_items(); i++) {
        const ctl = controllers.get_item(i);
        if (ctl instanceof Gtk.EventControllerScroll)
            ctl.connect('decelerate', (_c, vx, vy) => w({k: 'decelerate', vy, mono: GLib.get_monotonic_time()}));
    }
    let ready = false;
    sw.add_tick_callback((_w, clock) => {
        if (!ready && adj.get_upper() > 100000) {
            ready = true;
            adj.set_value(adj.get_upper() / 2);
            w({k: 'ready'});
            flush();
        }
        w({k: 'frame', frame: clock.get_frame_time(), y: adj.get_value()});
        return GLib.SOURCE_CONTINUE;
    });
    win.maximize();
    win.present();
});
app.run([]);

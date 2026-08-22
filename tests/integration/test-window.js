// Opens a plain window so the menu bar has an application to describe.
//
// Written against GTK directly rather than installing an application: the image
// stays small, and adding real apps changed what the compositor had to encode
// and broke screen recording.
//
// It runs as a Gtk.Application with its own id on purpose. A bare Gtk.Window
// from gjs reports a window class of "gjs", which Pear Up deliberately ignores
// along with the shell's own surfaces — so it would never get a menu bar.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

const application = new Gtk.Application({
    application_id: 'io.github.maddinek.PearUpTestWindow',
});

application.connect('activate', app => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Pear Up Test Window',
        default_width: 600,
        default_height: 400,
    });
    window.set_child(new Gtk.Label({ label: 'Pear Up test window' }));
    window.present();

    // Long enough for the assertions to run against it, then gone.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 90, () => {
        window.close();
        return GLib.SOURCE_REMOVE;
    });
});

application.run([]);

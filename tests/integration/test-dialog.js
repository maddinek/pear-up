// Opens a modal window, which the shell treats as a dialog of its application.
//
// It is what GNOME's Extensions app does with an extension's preferences: a
// window of its own process that the shell classes as a modal dialog rather than
// a normal window, and in front of which the menu bar used to stand empty.
//
// Like test-window.js it runs as a Gtk.Application with an id of its own, since
// a bare window from gjs reports the class "gjs", which Pear Up ignores.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

const application = new Gtk.Application({
    application_id: 'io.github.maddinek.PearUpTestDialog',
});

application.connect('activate', app => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Pear Up Test Dialog',
        modal: true,
        default_width: 400,
        default_height: 240,
    });
    window.set_child(new Gtk.Label({ label: 'Pear Up test dialog' }));
    window.present();

    // The suite closes it as soon as it has looked; this is only for a run that
    // dies first.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
        window.close();
        return GLib.SOURCE_REMOVE;
    });
});

application.run([]);

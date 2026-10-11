// Pear Up's test window (tests/integration/test-window.js), minus its 90 s
// self-destruct: the preview needs it for the whole run. Same application id,
// so Pear Up treats it exactly as it does in the test suite.
import Gtk from 'gi://Gtk?version=4.0';

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
});

application.run([]);

// Only ever installed inside the preview container, never on a real desktop.
//
// Two things the driver cannot do from outside a headless shell:
//  - look inside it: Eval refuses to run without unsafe mode, which normally
//    only Looking Glass switches on, so this switches it on;
//  - take a picture: the D-Bus screenshot waits for a frame a headless shell may
//    never present, so this paints the stage straight into a texture instead
//    (the same route as Pear Up's own test hook, SaveStage).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import AccountsService from 'gi://AccountsService';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="io.github.maddinek.PearUpPreview">
    <method name="SaveStage">
      <arg type="s" direction="in" name="path"/>
      <arg type="d" direction="out" name="scale"/>
    </method>
  </interface>
</node>`;

const PATH = '/io/github/maddinek/PearUpPreview';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

export default class PreviewHook extends Extension {
    enable() {
        global.context.unsafe_mode = true;
        // Eval runs inside shellDBus.js, which imports little; the driver
        // reaches everything else through this.
        globalThis.pv = {
            Main, MessageTray, Shell, St, Clutter, Meta, Gio, GLib, AccountsService,
        };
        // Two icons this harness causes and a real desktop never shows: unsafe mode's
        // red crossed-out padlock, and the screen-sharing icon the driver's
        // RemoteDesktop session (its pointer) brings up. Kept hidden; Quick
        // Settings may still be building its indicators when this runs, so
        // look for them until they are there.
        this._hideIndicators = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            const qs = Main.panel.statusArea.quickSettings;
            const indicators = [qs?._unsafeMode, qs?._remoteAccess];
            if (!indicators.every(Boolean))
                return GLib.SOURCE_CONTINUE;
            for (const indicator of indicators) {
                indicator.hide();
                indicator.connectObject('notify::visible',
                    () => indicator.visible && indicator.hide(), this);
            }
            this._hideIndicators = 0;
            return GLib.SOURCE_REMOVE;
        });
        this._export = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._export.export(Gio.DBus.session, PATH);
    }

    disable() {
        if (this._hideIndicators)
            GLib.source_remove(this._hideIndicators);
        const qs = Main.panel.statusArea.quickSettings;
        qs?._unsafeMode?.disconnectObject(this);
        qs?._remoteAccess?.disconnectObject(this);
        this._export?.unexport();
        this._export = null;
        delete globalThis.pv;
    }

    // Answers with the stage's scale once the file is written; 0 on failure.
    SaveStageAsync([path], invocation) {
        this._saveStage(path).then(
            scale => invocation.return_value(new GLib.Variant('(d)', [scale])),
            e => {
                console.warn('[pear-up-preview-hook] stage capture failed:', e);
                invocation.return_value(new GLib.Variant('(d)', [0]));
            });
    }

    async _saveStage(path) {
        const shooter = new Shell.Screenshot();
        const [content, scale] = await shooter.screenshot_stage_to_content();
        const stream = Gio.File.new_for_path(path)
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        // Full resolution: the texture is in device pixels, so at scale 2 this
        // is the 2880x1920 picture a 1440x960 stage at scale 2 shows.
        await Shell.Screenshot.composite_to_stream(content.get_texture(),
            0, 0, -1, -1, scale, null, 0, 0, 1, stream);
        stream.close(null);
        return scale;
    }
}

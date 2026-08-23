// Stands in for the shell's ExtensionPreferences while the preferences code is
// built outside a session.
//
// The real base class cannot be used here: it lives in the Extensions app's
// resource bundle and pulls in that app's D-Bus service and the Shew typelib,
// none of which exist in a bare container. What preferences code actually uses
// of it is this small — metadata, a path, and a Gio.Settings — so the stub is
// honest about the surface rather than pretending to be the class.
import Gio from 'gi://Gio';

export class ExtensionPreferences {
    constructor(metadata) {
        this.metadata = metadata;
    }

    get uuid() {
        return this.metadata['uuid'];
    }

    get path() {
        return this.metadata['path'];
    }

    get dir() {
        return this.metadata['dir'];
    }

    getSettings(schema) {
        schema ||= this.metadata['settings-schema'];

        const source = Gio.SettingsSchemaSource.new_from_directory(
            `${this.path}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
        const found = source.lookup(schema, true);
        if (!found)
            throw new Error(`schema ${schema} is not in ${this.path}/schemas`);

        return new Gio.Settings({ settings_schema: found });
    }
}

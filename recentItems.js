// macOS keeps a "Recent Items" submenu in the Apple menu, split into
// Applications, Documents and Servers, with a "Clear Menu" at the end. GNOME
// has all three, in three different places: applications come from the shell's
// own usage statistics, and files and remote locations both come from the
// freedesktop recent list every GTK application writes to.
//
// The submenu is filled when it opens rather than when the menu is built. The
// list changes constantly, and reading a file on every panel rebuild to
// populate a menu nobody opened would be work for nothing.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Schemes that mean "a place you connected to", as opposed to a file on this
// machine. Anything else recent — http, mostly, which is browser history
// leaking into the recent list — is not a document and not a server, so it is
// left out rather than filed under the nearest heading.
const SERVER_SCHEMES = [
    'smb', 'sftp', 'ssh', 'ftp', 'ftps', 'dav', 'davs', 'nfs', 'afp',
    'google-drive', 'onedrive', 'nextcloud', 'mtp', 'gphoto2', 'network',
];

const EMPTY_XBEL = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
</xbel>
`;

function recentFile() {
    return Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']));
}

function unescapeXml(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// The recent list is XBEL, and the shell has no XML parser it is allowed to
// use — GMarkup is not introspectable and GTK cannot be loaded in this process.
// Reading the attributes off each <bookmark> element is enough for a menu, and
// stays read-only: nothing here writes the file except Clear Menu, which
// replaces it wholesale.
function readRecent() {
    let text;
    try {
        const [ok, bytes] = recentFile().load_contents(null);
        if (!ok)
            return [];
        text = new TextDecoder().decode(bytes);
    } catch {
        // No recent list yet, or unreadable. Either way there is nothing to show.
        return [];
    }

    const entries = [];
    // Requiring whitespace after the element name keeps this off the
    // <bookmark:application> children, which carry hrefs of their own.
    const bookmarks = /<bookmark\s+([^>]*)>/g;
    let match;
    while ((match = bookmarks.exec(text)) !== null) {
        const attrs = match[1];
        const href = /\bhref="([^"]*)"/.exec(attrs)?.[1];
        if (!href)
            continue;

        // ISO-8601 stamps in a fixed format, so the newest sorts last as text.
        const stamps = ['added', 'modified', 'visited']
            .map(name => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? '');

        entries.push({
            uri: unescapeXml(href),
            stamp: stamps.reduce((a, b) => (a > b ? a : b), ''),
        });
    }

    entries.sort((a, b) => b.stamp.localeCompare(a.stamp));
    return entries;
}

function schemeOf(uri) {
    return (/^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri)?.[1] ?? '').toLowerCase();
}

function documents(entries, limit) {
    const found = [];
    for (const { uri } of entries) {
        if (found.length >= limit)
            break;
        if (schemeOf(uri) !== 'file')
            continue;

        // A recent list keeps entries long after the file is gone, and an item
        // that reports "file not found" on click is worse than no item.
        const file = Gio.File.new_for_uri(uri);
        if (!file.query_exists(null))
            continue;

        found.push({ uri, label: file.get_basename() ?? uri });
    }
    return found;
}

function servers(entries, limit) {
    const found = [];
    const seen = new Set();
    for (const { uri } of entries) {
        if (found.length >= limit)
            break;
        if (!SERVER_SCHEMES.includes(schemeOf(uri)))
            continue;

        // Collapse every remembered file on a share down to the location it
        // lives on, which is what "Servers" means here: one entry per place
        // connected to, not one per file opened there.
        let root = Gio.File.new_for_uri(uri);
        for (let parent = root.get_parent(); parent; parent = root.get_parent())
            root = parent;

        const label = root.get_parse_name?.() ?? root.get_uri();
        if (seen.has(label))
            continue;

        seen.add(label);
        found.push({ uri: root.get_uri(), label });
    }
    return found;
}

function applications(limit) {
    try {
        const usage = Shell.AppUsage.get_default();
        return (usage?.get_most_used?.() ?? [])
            .filter(app => app?.get_name?.())
            .slice(0, limit);
    } catch {
        // Usage statistics are disabled, or the shell keeps them elsewhere now.
        return [];
    }
}

export function openRecentUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (e) {
        Main.notify('Pear Up', `Could not open ${uri}.`);
        console.warn(`[pear-up] launch_default_for_uri failed for ${uri}: ${e}`);
    }
}

// Empties the freedesktop recent list, which is what every GTK application and
// GNOME's own Privacy settings mean by clearing recent files. Application usage
// is counted by the shell separately and has no public way to reset it, so the
// Applications section survives this — noted in the README rather than hidden.
export function clearRecent() {
    // This rewrites recently-used.xbel wholesale, so it races with any live
    // GTK application holding or rewriting its own cached copy of the list.
    // Clearing is therefore best-effort: a running app flushing later can put
    // the old entries back.
    try {
        recentFile().replace_contents(
            new TextEncoder().encode(EMPTY_XBEL),
            null, false, Gio.FileCreateFlags.NONE, null);
    } catch (e) {
        Main.notify('Pear Up', 'Could not clear the recent items.');
        console.warn(`[pear-up] clearing the recent list failed: ${e}`);
    }
}

// Returns the sections to render, so the caller owns how a menu item is built.
// Each entry is either an application (with its own icon) or a URI.
export function recentSections(limit) {
    const entries = readRecent();

    return [
        {
            heading: 'Applications',
            items: applications(limit).map(app => ({
                label: app.get_name(),
                gicon: app.get_app_info()?.get_icon() ?? null,
                activate: () => app.activate(),
            })),
        },
        {
            heading: 'Documents',
            items: documents(entries, limit).map(({ uri, label }) => ({
                label,
                iconName: 'text-x-generic-symbolic',
                activate: () => openRecentUri(uri),
            })),
        },
        {
            heading: 'Servers',
            items: servers(entries, limit).map(({ uri, label }) => ({
                label,
                iconName: 'folder-remote-symbolic',
                activate: () => openRecentUri(uri),
            })),
        },
    ].filter(section => section.items.length > 0);
}

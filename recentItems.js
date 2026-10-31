// macOS keeps a "Recent Items" submenu in the Apple menu, split into
// Applications, Documents and Servers, with a "Clear Menu" at the end. GNOME
// has all three, in three different places: applications come from the shell's
// own usage statistics, and files and remote locations both come from the
// freedesktop recent list every GTK application writes to.
//
// The submenu opens from a cache while the list refreshes asynchronously.
// A document can live on an unresponsive mount, so even checking whether it
// still exists must never hold up the shell's menu animation.
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

const QUERY_LIMIT = 8;
const QUERY_SLACK = 4;
const QUERY_TIMEOUT_MS = 1500;

// Cancellation can return control before the underlying I/O has stopped.
// Keep these across batches and even button replacements, releasing a slot
// only when its callback returns. A hung mount must not grow a worker queue.
const outstandingQueries = new Set();
const queryWaiters = new Set();

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
function parse(text) {
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

function documents(entries, present, limit) {
    const found = [];
    for (const { uri } of entries) {
        if (found.length >= limit)
            break;
        if (schemeOf(uri) !== 'file' || !present.has(uri))
            continue;

        // A recent list keeps entries long after the file is gone, and an item
        // that reports "file not found" on click is worse than no item.
        const file = Gio.File.new_for_uri(uri);
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
    const failed = e => {
        Main.notify('Pear Up', 'Could not clear the recent items.');
        console.warn(`[pear-up] clearing the recent list failed: ${e}`);
    };
    try {
        recentFile().replace_contents_async(
            new TextEncoder().encode(EMPTY_XBEL),
            null, false, Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    failed(e);
                }
            });
    } catch (e) {
        failed(e);
    }
}

// Returns the sections to render, so the caller owns how a menu item is built.
// Each entry is either an application (with its own icon) or a URI.
function sections(entries, present, limit) {
    return [
        {
            heading: 'Applications',
            items: applications(limit).map(app => ({
                identity: app.get_id(),
                label: app.get_name(),
                gicon: app.get_app_info()?.get_icon() ?? null,
                activate: () => app.activate(),
            })),
        },
        {
            heading: 'Documents',
            items: documents(entries, present, limit).map(({ uri, label }) => ({
                identity: uri,
                label,
                iconName: 'text-x-generic-symbolic',
                activate: () => openRecentUri(uri),
            })),
        },
        {
            heading: 'Servers',
            items: servers(entries, limit).map(({ uri, label }) => ({
                identity: uri,
                label,
                iconName: 'folder-remote-symbolic',
                activate: () => openRecentUri(uri),
            })),
        },
    ].filter(section => section.items.length > 0);
}

// The recent list as the System Menu shows it, kept in memory. sections() reads
// only this cache, so opening the menu does no I/O; refresh() brings the cache
// up to date in the background — the file is read again only after the file
// monitor has seen it change, and the documents in it are checked for still
// existing every time — and calls back once that has settled or timed out.
export class RecentList {
    constructor(limit = 5) {
        this._limit = limit;
        this._file = recentFile();
        this._entries = [];
        this._present = new Set();
        this._generation = 0;
        this._loadedGeneration = -1;
        this._readCancellable = null;
        this._batch = null;
        // A Set: a refresh that never settles — a read stuck on a hung mount —
        // must not collect one callback per opening of the menu.
        this._callbacks = new Set();
        this._refreshing = false;
        this._destroyed = false;
        this._monitor = null;

        try {
            // A file monitor also watches creation when the file is absent,
            // and follows the atomic replacement used by GTK's recent list.
            this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => {
                if (this._destroyed)
                    return;
                this._generation++;
                this._advance();
            });
        } catch (e) {
            // Without a monitor, reread on refresh instead of caching forever.
            console.warn(`[pear-up] monitoring the recent list failed: ${e}`);
        }
    }

    sections(limit = this._limit) {
        this._limit = Math.max(0, limit);
        return sections(this._entries, this._present, this._limit);
    }

    refresh(callback = null) {
        if (this._destroyed)
            return;
        if (callback)
            this._callbacks.add(callback);
        if (this._refreshing)
            return;

        this._refreshing = true;
        if (!this._monitor)
            this._generation++;
        this._advance();
    }

    _advance() {
        if (this._destroyed || !this._refreshing || this._readCancellable)
            return;

        if (this._loadedGeneration !== this._generation) {
            this._cancelBatch();
            this._read();
        } else if (!this._batch) {
            this._startBatch();
        }
    }

    _read() {
        const generation = this._generation;
        this._readCancellable = new Gio.Cancellable();
        const complete = entries => {
            if (this._destroyed)
                return;
            this._readCancellable = null;
            this._entries = entries;
            this._loadedGeneration = generation;
            // An event during the read belongs to the next generation. Do not
            // mark it clean with the contents of an older in-flight read.
            this._advance();
        };

        try {
            this._file.load_contents_async(this._readCancellable, (file, result) => {
                let entries = [];
                try {
                    const [ok, bytes] = file.load_contents_finish(result);
                    if (ok && !this._destroyed)
                        entries = parse(new TextDecoder().decode(bytes));
                } catch {
                    // No recent list yet, or unreadable. There is nothing to show.
                }
                complete(entries);
            });
        } catch {
            complete([]);
        }
    }

    _startBatch() {
        // Deleting a document need not touch XBEL. Every refresh revalidates
        // existence, keeping the previous snapshot visible until this settles.
        const batch = {
            cancellable: new Gio.Cancellable(),
            candidates: new Set(this._entries
                .filter(entry => schemeOf(entry.uri) === 'file')
                .map(entry => entry.uri)),
            pending: new Set(),
            present: new Set(),
            target: this._limit > 0 ? this._limit + QUERY_SLACK : 0,
            timeout: 0,
            pumping: false,
        };
        this._batch = batch;
        queryWaiters.add(this);
        batch.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUERY_TIMEOUT_MS, () => {
            batch.timeout = 0;
            if (!this._destroyed && this._batch === batch)
                this._finishBatch(batch);
            return GLib.SOURCE_REMOVE;
        });
        this._pumpBatch();
    }

    _pumpBatch() {
        const batch = this._batch;
        if (this._destroyed || !batch || batch.pumping)
            return;
        batch.pumping = true;

        // Candidates retain XBEL's recency order. Stop after enough confirmed
        // files plus a small reserve; a huge history is not a reason to stat it
        // all. Queries from older timed-out batches still occupy their slots.
        for (const uri of batch.candidates) {
            if (outstandingQueries.size >= QUERY_LIMIT ||
                batch.present.size + batch.pending.size >= batch.target)
                break;
            if (outstandingQueries.has(uri))
                continue;

            batch.candidates.delete(uri);
            batch.pending.add(uri);
            outstandingQueries.add(uri);
            const complete = exists => {
                outstandingQueries.delete(uri);
                if (!this._destroyed && this._batch === batch) {
                    batch.pending.delete(uri);
                    if (exists)
                        batch.present.add(uri);
                }
                // A retired batch may free the last slot another owner needs.
                for (const waiter of [...queryWaiters])
                    waiter._pumpBatch();
            };

            try {
                Gio.File.new_for_uri(uri).query_info_async(
                    'standard::type', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, batch.cancellable, (file, result) => {
                        let exists = false;
                        try {
                            exists = !!file.query_info_finish(result);
                        } catch {
                            // Missing, inaccessible and cancelled files stay out.
                        }
                        complete(exists);
                    });
            } catch {
                complete(false);
            }
        }
        batch.pumping = false;

        if (this._batch === batch && batch.pending.size === 0 &&
            (batch.present.size >= batch.target || batch.candidates.size === 0))
            this._finishBatch(batch);
    }

    _cancelBatch() {
        const batch = this._batch;
        if (!batch)
            return;
        this._batch = null;
        queryWaiters.delete(this);
        if (batch.timeout)
            GLib.source_remove(batch.timeout);
        batch.timeout = 0;
        batch.cancellable.cancel();
    }

    _finishBatch(batch) {
        this._present = batch.present;
        this._cancelBatch();
        this._refreshing = false;
        const callbacks = [...this._callbacks];
        this._callbacks.clear();
        for (const callback of callbacks) {
            if (this._destroyed)
                break;
            try {
                callback();
            } catch (e) {
                console.warn(`[pear-up] recent items refresh callback failed: ${e}`);
            }
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._monitor?.cancel();
        this._monitor = null;
        this._readCancellable?.cancel();
        this._readCancellable = null;
        this._cancelBatch();
        this._callbacks.clear();
        this._entries = [];
        this._present.clear();
    }
}

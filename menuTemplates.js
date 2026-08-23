// Builtin File / Edit / View / Go / Window / Help trees. Dispatch lives in
// menuManager; this file only describes what to show.
//
// Desktop ids and wm classes are compared as whole tokens. Matching a
// substring of the window title would treat any app with "Files" in the
// name as Nautilus, which is how those actions used to leak onto everything.

const FILE_MANAGERS = new Set([
    'caja',
    'dolphin',
    'io.elementary.files',
    'nautilus',
    'nemo',
    'org.gnome.files',
    'org.gnome.nautilus',
    'org.kde.dolphin',
    'pcmanfm',
    'pcmanfm-qt',
    'thunar',
]);

function normalizeAppId(id) {
    return (id || '').replace(/\.desktop$/i, '').toLowerCase();
}

export function isFileManager(desktopId, wmClass) {
    return FILE_MANAGERS.has(normalizeAppId(desktopId)) ||
        FILE_MANAGERS.has(normalizeAppId(wmClass));
}

// Drop unimplemented stubs and the extra separators they leave behind.
export function compactMenuItems(items) {
    const kept = [];
    for (const item of items) {
        if (item.enabled === false && !item.placeholder)
            continue;
        if (item.children)
            kept.push({ ...item, children: compactMenuItems(item.children) });
        else
            // Spread leaves too: these are shared template constants, and a
            // caller mutating what a built menu hands back must not reach them.
            kept.push({ ...item });
    }

    const squeezed = [];
    for (const item of kept) {
        if (item.type === 'separator' &&
            (squeezed.length === 0 || squeezed[squeezed.length - 1].type === 'separator'))
            continue;
        squeezed.push(item);
    }
    while (squeezed.length && squeezed[squeezed.length - 1].type === 'separator')
        squeezed.pop();
    return squeezed;
}

export function fileMenu(isFiles, fileManagerName) {
    if (isFiles) {
        return {
            type: 'submenu',
            label: 'File',
            children: [
                { label: `New ${fileManagerName} Window`, action: 'new-file-manager-win' },
                { label: 'New Folder', action: 'new-folder' },
                { label: 'New Tab', action: 'new-tab' },
                { label: 'Open', action: 'virtual-open' },
                { label: 'Open With', action: 'native-open-with' },
                { label: 'Print', action: 'print' },
                { type: 'separator' },
                { label: 'Get Info', action: 'properties' },
                { type: 'separator' },
                { label: 'Move to Trash', action: 'delete-item' },
                { type: 'separator' },
                { label: 'Close Window', action: 'close' },
            ],
        };
    }

    return {
        type: 'submenu',
        label: 'File',
        children: [
            { label: 'New Window', action: 'new-app-window' },
            { label: 'New Tab', action: 'new-tab' },
            { label: 'Open', action: 'virtual-open' },
            { label: 'Print', action: 'print' },
            { type: 'separator' },
            { label: 'Close Window', action: 'close' },
        ],
    };
}

export function editMenu() {
    return {
        type: 'submenu',
        label: 'Edit',
        children: [
            { label: 'Undo', action: 'undo' },
            { label: 'Redo', action: 'redo' },
            { type: 'separator' },
            { label: 'Cut', action: 'cut' },
            { label: 'Copy', action: 'copy' },
            { label: 'Paste', action: 'paste' },
            { label: 'Delete', action: 'delete-item' },
            { type: 'separator' },
            { label: 'Select All', action: 'select-all' },
            { type: 'separator' },
            { label: 'Emoji & Symbols', action: 'emoji-picker' },
        ],
    };
}

export function viewMenu() {
    return {
        type: 'submenu',
        label: 'View',
        children: [
            { label: 'Enter Full Screen', action: 'toggle-fullscreen' },
        ],
    };
}

export function goMenu(isFiles) {
    const navigation = [
        { label: 'Back', action: 'go-back' },
        { label: 'Forward', action: 'go-forward' },
    ];
    if (!isFiles)
        return { type: 'submenu', label: 'Go', children: navigation };

    return {
        type: 'submenu',
        label: 'Go',
        children: [
            ...navigation,
            { type: 'separator' },
            { label: 'Recents', action: 'go-recents' },
            { label: 'Documents', action: 'go-documents' },
            { label: 'Desktop', action: 'go-desktop' },
            { label: 'Downloads', action: 'go-downloads' },
            { label: 'Home', action: 'go-home' },
        ],
    };
}

export function windowMenu() {
    return {
        type: 'submenu',
        label: 'Window',
        children: [
            { label: 'Minimize', action: 'minimize' },
            { label: 'Maximize', action: 'maximize' },
            { type: 'separator' },
            { label: 'Close', action: 'close' },
        ],
    };
}

export function helpMenu() {
    return {
        type: 'submenu',
        label: 'Help',
        children: [
            { label: 'GNOME Help', action: 'open-system-help' },
        ],
    };
}

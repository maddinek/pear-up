#!/usr/bin/gjs -m
// Resolve every introspectable API in the manifest against the GNOME installed
// here, and report anything missing. Runs headless: it only loads typelibs, so
// it needs no display, no session and no compositor.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';

const manifestPath = system.programArgs[0] ?? 'tests/api-manifest.json';
const [, bytes] = GLib.file_get_contents(manifestPath);
const manifest = JSON.parse(new TextDecoder().decode(bytes));

const failures = [];
const notes = [];

const namespaces = new Map();
const load = async name => {
    if (namespaces.has(name))
        return namespaces.get(name);
    let namespace = null;
    try {
        namespace = await import(`gi://${name}`);
        namespace = namespace.default;
    } catch (e) {
        namespace = null;
    }
    namespaces.set(name, namespace);
    return namespace;
};

// Plain symbols: constants, classes, enums, functions.
for (const [name, symbols] of Object.entries(manifest.introspected ?? {})) {
    const namespace = await load(name);
    if (!namespace) {
        failures.push(`namespace ${name} could not be loaded at all`);
        continue;
    }
    for (const symbol of symbols) {
        if (namespace[symbol] === undefined)
            failures.push(`${name}.${symbol} is missing`);
    }
}

// Instance methods, checked on the prototype. Resolving a class can throw for
// types GJS cannot represent, which must not end the whole run.
const prototypeOf = target => {
    const [name, className] = target.split('.');
    try {
        const namespace = namespaces.get(name);
        return namespace?.[className]?.prototype ?? null;
    } catch (e) {
        notes.push(`${target} could not be introspected here: ${e.message}`);
        return null;
    }
};

for (const [target, methods] of Object.entries(manifest.methods ?? {})) {
    if (target === 'comment')
        continue;
    await load(target.split('.')[0]);
    const proto = prototypeOf(target);
    if (!proto) {
        failures.push(`${target} could not be resolved`);
        continue;
    }
    for (const method of methods) {
        if (typeof proto[method] !== 'function')
            failures.push(`${target}.${method}() is missing`);
    }
}

// One of several spellings is enough.
for (const [label, alternatives] of Object.entries(manifest.eitherOf ?? {})) {
    if (label === 'comment')
        continue;
    const target = label.split(' ')[0];
    await load(target.split('.')[0]);
    const proto = prototypeOf(target);
    const found = alternatives.filter(
        method => typeof proto?.[method] === 'function');
    if (found.length === 0)
        failures.push(`${label}: none of ${alternatives.join(', ')} exist`);
    else
        notes.push(`${label}: using ${found.join(' or ')}`);
}

// Absent by expectation — a regression here means someone called something that
// only looks real.
for (const [name, symbols] of Object.entries(manifest.absent ?? {})) {
    if (name === 'comment')
        continue;
    const namespace = await load(name);
    for (const symbol of symbols) {
        if (namespace && namespace[symbol] !== undefined)
            notes.push(`${name}.${symbol} exists here, unlike on other versions`);
    }
}

for (const note of notes)
    print(`  note: ${note}`);

if (failures.length === 0) {
    print('introspected APIs: all present');
} else {
    for (const failure of failures)
        print(`  MISSING: ${failure}`);
    print(`introspected APIs: ${failures.length} missing`);
}

system.exit(failures.length === 0 ? 0 : 1);

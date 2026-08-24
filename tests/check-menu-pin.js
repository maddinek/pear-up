// Clutter aborts (or logs until the shell is unusable) if translation-x is
// NaN. The File click crash was that value, from a pin that subtracted a
// stage x that had not been allocated yet. This file is the gate: an offset
// that is not a finite number must not leave pinTranslationX, and
// menuManager must not write translation-x any other way.
//
// Runs under gjs -m (API matrix) and node --experimental-default-type=module
// (script-unit CI), so a NaN return cannot pass only one of those.
import { pinTranslationX } from '../menuPin.js';

let failed = 0;

function check(label, condition) {
    if (condition)
        console.log(`  ok   ${label}`);
    else {
        console.error(`  FAIL ${label}`);
        failed++;
    }
}

function writable(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

const centred = pinTranslationX({
    buttonX: 100,
    menuX: 20,
    menuWidth: 200,
    translationX: 0,
});
check('a centred wide menu is shifted onto the title', centred === 80);

const alreadyPinned = pinTranslationX({
    buttonX: 100,
    menuX: 100,
    menuWidth: 200,
    translationX: 80,
});
check('an already-pinned menu is left where it is', alreadyPinned === 80);

const clamped = pinTranslationX({
    buttonX: 120,
    menuX: 0,
    menuWidth: 240,
    translationX: 0,
});
check('a menu GNOME already clamped to the left edge still moves under the title',
    clamped === 120);

const nanStage = pinTranslationX({ buttonX: 100, menuX: NaN, menuWidth: 200 });
const nanButton = pinTranslationX({ buttonX: NaN, menuX: 0, menuWidth: 200 });
const infIn = pinTranslationX({
    buttonX: Infinity,
    menuX: 0,
    menuWidth: 10,
});
const zeroWidth = pinTranslationX({ buttonX: 100, menuX: 0, menuWidth: 0 });
const missing = pinTranslationX({ buttonX: undefined, menuX: 0, menuWidth: 10 });

check('NaN stage x is not written to translation-x', nanStage === null);
check('NaN button x is not written to translation-x', nanButton === null);
check('Infinity is not written to translation-x', infIn === null);
check('a zero-width menu is not written to translation-x', zeroWidth === null);
check('undefined inputs are not written to translation-x', missing === null);

for (const [label, value] of [
    ['centred', centred],
    ['already pinned', alreadyPinned],
    ['clamped', clamped],
    ['NaN stage', nanStage],
    ['NaN button', nanButton],
    ['Infinity', infIn],
    ['zero width', zeroWidth],
    ['undefined', missing],
])
    check(`${label} is a finite number or null, never NaN`, writable(value));

// The formula that took the desktop down: subtracting an unallocated x.
const oldCrash = Math.round(100 - NaN);
check('the old pin formula produces NaN (this is the crash)', Number.isNaN(oldCrash));
check('pinTranslationX refuses the inputs that produced that NaN',
    nanStage === null && !Number.isNaN(nanStage));

async function readRepoFile(relative) {
    if (globalThis.process?.versions?.node) {
        const { readFileSync } = await import('node:fs');
        const { dirname, join } = await import('node:path');
        const { fileURLToPath } = await import('node:url');
        return readFileSync(
            join(dirname(fileURLToPath(import.meta.url)), '..', relative),
            'utf8');
    }
    const Gio = (await import('gi://Gio')).default;
    const file = Gio.File.new_for_uri(import.meta.url)
        .get_parent()
        .get_parent()
        .resolve_relative_path(relative);
    const [, bytes] = file.load_contents(null);
    return new TextDecoder().decode(bytes);
}

const manager = await readRepoFile('menuManager.js');
const pack = await readRepoFile('scripts/pack.sh');

check('menuManager pins through pinTranslationX',
    manager.includes("import { pinTranslationX } from './menuPin.js'"));
check('menuManager does not pin from notify::translation-x',
    !manager.includes('notify::translation-x'));
check('menuManager queues the pin on idle, not during allocate',
    manager.includes('_queuePin') && manager.includes('GLib.idle_add'));
check('menuManager refuses a null offset',
    /if \(offset === null\)/.test(manager));
check('menuManager only writes the computed offset',
    /actor\.translation_x = offset/.test(manager) &&
    !/actor\.translation_x = desiredLeft/.test(manager));
check('menuManager does not zero translation-x to measure',
    !/translation_x\s*=\s*0/.test(manager));
check('the packed zip ships menuPin.js',
    /^ {4}menuPin\.js$/m.test(pack));

if (failed === 0)
    console.log('menu pin: ok');
else
    console.error(`menu pin: ${failed} failed`);

if (globalThis.process?.exit)
    globalThis.process.exit(failed === 0 ? 0 : 1);
else {
    const system = await import('system');
    system.exit(failed === 0 ? 0 : 1);
}

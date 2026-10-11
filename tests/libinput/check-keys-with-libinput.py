#!/usr/bin/env python3
"""Run the macOS keys plugin inside real libinput, against a keyboard that only
exists in a umockdev testbed, and compare the keys libinput reports with the
keys pressed.

    python3 tests/libinput/check-keys-with-libinput.py <plugin.lua>

Only for a container (tests/lib/check-libinput-here.sh sets one up), and it
refuses to run anywhere else: it installs the plugin into /etc/libinput/plugins,
which on a desktop is a directory the compositor loads plugins from at login.
For why umockdev rather than `libinput replay` or uinput, see
check-with-libinput.py: a uinput keyboard would type into the desktop the test
is run from.

The keyboard is framy's, the laptop's own "AT Translated Set 2 keyboard". The
plugin is installed twice, as Pear Up's preferences would write it with the
Alt/Cmd swap on and with it off, and once not at all, which has to give back
exactly the keys pressed. Kernel key repeats are sent where a key is held;
libinput drops those itself, and so does what it reports.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

PLUGIN = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'libinput', '10-pear-up-macos-keys.lua')

DEV = '/dev/input/event3'
NAME = 'AT Translated Set 2 keyboard'
PLUGIN_DIR = '/etc/libinput/plugins'
STEP = 0.02      # s between keys
REPEAT = 0.033   # s between kernel repeats

EV_SYN, EV_KEY, EV_MSC = 0, 1, 4
MSC_SCAN = 4

CODES = {
    'ESC': 1, '1': 2, 'BACKSPACE': 14, 'TAB': 15, 'Q': 16, 'W': 17, 'T': 20, 'A': 30, 'S': 31, 'F': 33,
    'L': 38, 'Z': 44, 'X': 45, 'C': 46, 'V': 47, 'B': 48, 'N': 49, 'LEFTCTRL': 29, 'LEFTSHIFT': 42,
    'RIGHTSHIFT': 54, 'LEFTALT': 56, 'SPACE': 57, 'RIGHTCTRL': 97, 'RIGHTALT': 100, 'UP': 103,
    'LEFT': 105, 'RIGHT': 106, 'DOWN': 108, 'LEFTMETA': 125, 'F24': 194,
}
# A laptop keyboard has the whole main block; the rest of the codes up to the
# arrows are set too, so the device looks like one to libinput.
KEYS = sorted(set(range(1, 128)) | set(CODES.values()))


def hexs(data):
    return data.hex().upper()


def bits(size, *numbers):
    mask = bytearray(size)
    for number in numbers:
        mask[number // 8] |= 1 << (number % 8)
    return bytes(mask)


def write_device(directory):
    """The udev entry and the ioctl answers of the keyboard, in umockdev's
    formats, as check-with-libinput.py writes the touchpad's."""
    key_words = []
    mask = int.from_bytes(bits(96, *KEYS), 'little')
    while mask:
        key_words.append(mask & 0xffffffffffffffff)
        mask >>= 64
    key_attr = ' '.join(f'{w:x}' for w in reversed(key_words))
    with open(os.path.join(directory, 'keyboard.umockdev'), 'w') as out:
        out.write(f'''P: /devices/platform/i8042/serio0/input/input3/event3
N: input/event3
E: DEVNAME={DEV}
E: ID_INPUT=1
E: ID_INPUT_KEY=1
E: ID_INPUT_KEYBOARD=1
E: MAJOR=13
E: MINOR=67
E: SUBSYSTEM=input
A: dev=13:67

P: /devices/platform/i8042/serio0/input/input3
E: NAME="{NAME}"
E: PRODUCT=11/1/1/ab83
E: PROP=0
E: EV=13
E: KEY={key_attr}
E: MSC=10
E: SUBSYSTEM=input
A: name={NAME}
A: properties=0

P: /devices/platform/i8042/serio0
E: SUBSYSTEM=serio

P: /devices/platform/i8042
E: SUBSYSTEM=platform
''')

    name = NAME.encode() + b'\0'
    phys = b'isa0060/serio0/input0\0'
    lines = [
        f'@DEV {DEV}',
        f'EVIOCGBIT(0) 8 {hexs(bits(8, EV_SYN, EV_KEY, EV_MSC))}',
        f'EVIOCGNAME(0) {len(name)} {hexs(name.ljust(255, bytes(1)))}',
        f'EVIOCGPHYS(0) {len(phys)} {hexs(phys.ljust(255, bytes(1)))}',
        f'EVIOCGUNIQ(0) 1 {hexs(bytes(255))}',
        f'EVIOCGID 0 {hexs(struct.pack("<4H", 0x11, 0x0001, 0x0001, 0xab83))}',
        'EVIOCGVERSION 0 01000100',
        f'EVIOCGPROP(0) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(1) 96 {hexs(bits(96, *KEYS))}',
        f'EVIOCGBIT(2) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(3) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(4) 8 {hexs(bits(8, MSC_SCAN))}',
        f'EVIOCGBIT(5) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(17) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(18) 8 {hexs(bytes(8))}',
        f'EVIOCGBIT(21) 16 {hexs(bytes(16))}',
        f'EVIOCGKEY(0) 96 {hexs(bytes(96))}',
        f'EVIOCGLED(0) 8 {hexs(bytes(8))}',
        f'EVIOCGSW(0) 8 {hexs(bytes(8))}',
    ]
    with open(os.path.join(directory, 'keyboard.ioctl'), 'w') as out:
        out.write('\n'.join(lines) + '\n')


class Kernel:
    """What the kernel sends for keys: the scan code, the key, the end of the
    frame, in CLOCK_MONOTONIC as libinput expects."""

    def __init__(self):
        self.t = time.monotonic() + 1.0
        self.lines = []
        # libinput drains what is pending when it opens the device.
        self.event(EV_MSC, MSC_SCAN, 0)
        self.event(EV_SYN, 0, 0)
        self.t += 0.5

    def event(self, type_, code, value):
        sec = int(self.t)
        usec = int(round((self.t - sec) * 1e6))
        if usec == 1000000:
            sec, usec = sec + 1, 0
        self.lines.append(f'E: {sec}.{usec:06d} {type_:04x} {code:04x} {value}')

    def key(self, name, value):
        code = CODES[name]
        self.event(EV_MSC, MSC_SCAN, 0x70000 + code)
        self.event(EV_KEY, code, value)
        self.event(EV_SYN, 0, 0)
        self.t += REPEAT if value == 2 else STEP

    def play(self, keys):
        """keys as the Lua check writes them: a minus for a release, a plus for
        a repeat."""
        for word in keys.split():
            sign, name = (word[0], word[1:]) if word[0] in '+-' else ('', word)
            self.key(name, {'': 1, '-': 0, '+': 2}[sign])


def replay(workdir, scenarios, plugin_text):
    """The keys libinput reports for each scenario, and its log."""
    kernel = Kernel()
    for _, keys, _ in scenarios:
        kernel.play(keys)
        kernel.play('F24 -F24')   # between scenarios, to tell them apart
    end = kernel.t
    events = os.path.join(workdir, 'keys.events')
    with open(events, 'w') as out:
        out.write('\n'.join(kernel.lines) + '\n')

    installed = os.path.join(PLUGIN_DIR, os.path.basename(PLUGIN))
    if plugin_text is not None:
        with open(installed, 'w') as out:
            out.write(plugin_text)
    elif os.path.exists(installed):
        os.remove(installed)
    seconds = max(3.0, end - time.monotonic() + 1.5)
    args = ['libinput', 'debug-events', '--verbose', '--show-keycodes', '--device', DEV]
    if plugin_text is not None:
        args += ['--enable-plugins']
    inner = (
        'mkdir -p "$UMOCKDEV_DIR/run/udev/data" && '
        'printf "I:1\\nE:ID_INPUT=1\\nE:ID_INPUT_KEY=1\\nE:ID_INPUT_KEYBOARD=1\\n" > "$UMOCKDEV_DIR/run/udev/data/c13:67" && '
        f'exec timeout -s INT {seconds:.1f} ' + ' '.join(args)
    )
    result = subprocess.run(
        ['umockdev-run', '-d', os.path.join(workdir, 'keyboard.umockdev'),
         '-i', f'{DEV}={os.path.join(workdir, "keyboard.ioctl")}',
         '-e', f'{DEV}={events}', '--', 'sh', '-c', inner],
        cwd=workdir, capture_output=True, text=True, timeout=seconds + 30)
    keys = []
    for line in result.stdout.splitlines():
        match = re.search(r'KEYBOARD_KEY\s.*?\bKEY_(\w+) \(\d+\) (pressed|released)', line)
        if match:
            keys.append(f'{match.group(1)}-{"down" if match.group(2) == "pressed" else "up"}')
    # Split at the separators.
    split, current = [], []
    for key in keys:
        if key == 'F24-down':
            continue
        if key == 'F24-up':
            split.append(' '.join(current))
            current = []
        else:
            current.append(key)
    return split, result.stdout + result.stderr


def as_reported(keys):
    """What libinput reports for keys pressed as they are: everything but the
    repeats."""
    out = []
    for word in keys.split():
        if word[0] == '+':
            continue
        out.append(f'{word[1:]}-up' if word[0] == '-' else f'{word}-down')
    return ' '.join(out)


def balanced(reported):
    held = set()
    for word in reported.split():
        key, state = word.rsplit('-', 1)
        if state == 'down':
            if key in held:
                return False
            held.add(key)
        else:
            if key not in held:
                return False
            held.discard(key)
    return not held


def scenarios(option, cmd):
    """(label, keys pressed, keys libinput is to report; None for as pressed)"""
    o, c = option, cmd

    def k(text):
        return text.replace('OPTION', o).replace('CMD', c)
    return [
        ('Option tapped alone', k('OPTION -OPTION'), None),
        ('Option+B', k('OPTION B -B -OPTION'), None),
        ('Option+←: Ctrl down, Option up, then the arrow', k('OPTION LEFT -LEFT -OPTION'),
         k('OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up')),
        ('Option+Shift+→ held and repeating: select by word', k('OPTION LEFTSHIFT RIGHT +RIGHT +RIGHT +RIGHT -RIGHT -LEFTSHIFT -OPTION'),
         k('OPTION-down LEFTSHIFT-down LEFTCTRL-down OPTION-up RIGHT-down RIGHT-up LEFTCTRL-up LEFTSHIFT-up')),
        ('Option let go before the arrow', k('OPTION LEFT -OPTION +LEFT -LEFT'),
         k('OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFTCTRL-up LEFT-up')),
        ('Option+← and then Option+B', k('OPTION LEFT -LEFT B -B -OPTION'),
         k('OPTION-down LEFTCTRL-down OPTION-up LEFT-down LEFT-up LEFTCTRL-up OPTION-down B-down B-up OPTION-up')),
        ('Ctrl+←: Ctrl+Option+←', k('LEFTCTRL LEFT +LEFT -LEFT -LEFTCTRL'),
         k('LEFTCTRL-down OPTION-down LEFT-down LEFT-up OPTION-up LEFTCTRL-up')),
        ('Ctrl let go before the arrow', k('LEFTCTRL RIGHT -LEFTCTRL -RIGHT'),
         k('LEFTCTRL-down OPTION-down RIGHT-down OPTION-up LEFTCTRL-up RIGHT-up')),
        ('Ctrl+Shift+←', k('LEFTCTRL LEFTSHIFT LEFT -LEFT -LEFTSHIFT -LEFTCTRL'), None),
        ('Cmd tapped alone', k('CMD -CMD'), None),
        ('Cmd+Space, Cmd+Q, Cmd+1', k('CMD SPACE -SPACE Q -Q 1 -1 -CMD'), None),
        ('Cmd+C: Ctrl down, Cmd up, then the C', k('CMD C -C -CMD'),
         k('CMD-down LEFTCTRL-down CMD-up C-down C-up LEFTCTRL-up')),
        ('Cmd+Shift+Z held and repeating', k('CMD LEFTSHIFT Z +Z +Z -Z -LEFTSHIFT -CMD'),
         k('CMD-down LEFTSHIFT-down LEFTCTRL-down CMD-up Z-down Z-up LEFTCTRL-up LEFTSHIFT-up')),
        ('Cmd+C and then Cmd+Tab', k('CMD C -C TAB -TAB -CMD'),
         k('CMD-down LEFTCTRL-down CMD-up C-down C-up LEFTCTRL-up CMD-down TAB-down TAB-up CMD-up')),
        ('Cmd+C held and then Ctrl, let go in any order', k('CMD C LEFTCTRL -CMD -C -LEFTCTRL'),
         k('CMD-down LEFTCTRL-down CMD-up C-down CMD-down LEFTCTRL-up LEFTCTRL-down CMD-up C-up LEFTCTRL-up')),
    ]


def meaning(swapped, option, cmd):
    """What xkb makes of the keys the plugin sends, with the layout framy has
    and Pear Up's swap on or off, and whether GNOME 50 binds what Ctrl+← is
    turned into by default. The codes in the plugin are only right if these
    are."""
    names = {'LEFTALT': '<LALT>', 'LEFTMETA': '<LWIN>', 'LEFTCTRL': '<LCTL>'}
    keymap = subprocess.run(
        ['/usr/libexec/xkbcommon/xkbcli-compile-keymap', '--layout', 'us',
         '--options', 'altwin:swap_alt_win' if swapped else ''],
        capture_output=True, text=True).stdout
    mods = {name: set(re.findall(r'<\w+>', keys))
            for name, keys in re.findall(r'modifier_map (\w+) \{([^}]*)\}', keymap)}
    check(f'xkb takes {option} as Alt (Mod1), so Option, and {cmd} as Super (Mod4), so Cmd',
          names[option] in mods.get('Mod1', set()) and names[cmd] in mods.get('Mod4', set())
          and names['LEFTCTRL'] in mods.get('Control', set()),
          f'modifier maps: {mods}')


def gnome_binds_ctrl_option_arrows():
    """GNOME's own switch-to-workspace bindings, as gsettings-desktop-schemas
    ships them: Ctrl+← becomes Ctrl+Option+←, which is only of use if that is
    one."""
    env = dict(os.environ, GSETTINGS_BACKEND='memory')
    for direction in ('left', 'right'):
        value = subprocess.run(['gsettings', 'get', 'org.gnome.desktop.wm.keybindings',
                                f'switch-to-workspace-{direction}'], capture_output=True, text=True, env=env)
        check(f'GNOME binds <Control><Alt>{direction.title()} to the desktop {direction} by default: {value.stdout.strip()}',
              f"'<Control><Alt>{direction.title()}'" in value.stdout, value.stderr.strip())


TRIES = 6
TRANSPORT_TROUBLE = ('missing SYN_REPORT', 'libevdev:')

failures = []
passes = []
retries = [0]


def check(label, ok, detail=''):
    if ok:
        passes.append(label)
        print(f'  ok   {label}')
    else:
        failures.append(label)
        print(f'  FAIL {label}' + (f'\n       {detail}' if detail else ''))


def templated(source, swapped):
    text, count = re.subn(r'^local SWAPPED = (true|false)$', f'local SWAPPED = {"true" if swapped else "false"}',
                          source, flags=re.M)
    if count != 1:
        sys.exit('The plugin has no SWAPPED line to write')
    return text


def main():
    if not (os.path.exists('/run/.containerenv') or os.path.exists('/.dockerenv')):
        sys.exit('This installs the plugin into /etc/libinput/plugins and only runs in a container; '
                 'use tests/run-libinput-tests.sh.')
    workdir = tempfile.mkdtemp(prefix='pear-up-keys-')
    os.makedirs(PLUGIN_DIR, exist_ok=True)
    write_device(workdir)
    with open(PLUGIN) as f:
        source = f.read()

    version = subprocess.run(['libinput', '--version'], capture_output=True, text=True).stdout.strip()
    print(f'  libinput {version}, plugin {os.path.basename(PLUGIN)}, keyboard "{NAME}"')

    def clean(cases, text):
        """A replay that arrived whole; see check-with-libinput.py for why a
        broken one is run again."""
        for _ in range(TRIES):
            got, log = replay(workdir, cases, text)
            if not any(sign in log for sign in TRANSPORT_TROUBLE) and len(got) == len(cases):
                return got, log
            retries[0] += 1
        check('the keys reach libinput intact', False, log[-1500:])
        return got, log

    for swapped, option, cmd, label in ((True, 'LEFTMETA', 'LEFTALT', 'Alt and Cmd swapped'),
                                        (False, 'LEFTALT', 'LEFTMETA', 'not swapped')):
        cases = scenarios(option, cmd)
        print(f'  {label}: Option is {option}, Cmd is {cmd}')
        meaning(swapped, option, cmd)

        plain, log = clean(cases, None)
        check('without the plugin, libinput reports the keys as pressed',
              plain == [as_reported(keys) for _, keys, _ in cases],
              '\n       '.join(f'{p}  /  {as_reported(k)}' for p, (_, k, _) in zip(plain, cases)
                                if p != as_reported(k))[:1500])
        check('libinput saw the keyboard', 'DEVICE_ADDED' in log and NAME in log, log[-1500:])

        got, log = clean(cases, templated(source, swapped))
        check('the plugin was loaded and took the keyboard', f'Pear Up macOS keys: {NAME}' in log, log[-1500:])
        check('and ran without an error', 'unloading after error' not in log and 'Failed to load' not in log,
              log[-1500:])
        for (title, keys, wanted), reported in zip(cases, got):
            wanted = wanted if wanted is not None else as_reported(keys)
            check(f'{title}: {reported}', reported == wanted and balanced(reported),
                  f'pressed: {keys}\n       wanted:  {wanted}')

    print('  GNOME 50')
    gnome_binds_ctrl_option_arrows()

    installed = os.path.join(PLUGIN_DIR, os.path.basename(PLUGIN))
    if os.path.exists(installed):
        os.remove(installed)
    shutil.rmtree(workdir, ignore_errors=True)
    if retries[0]:
        print(f'  ({retries[0]} replays came through the pty broken and were run again)')
    print()
    if failures:
        print(f'{len(failures)} of {len(failures) + len(passes)} checks failed')
        sys.exit(1)
    print(f'All {len(passes)} checks passed')


if __name__ == '__main__':
    main()

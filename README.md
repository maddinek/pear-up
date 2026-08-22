# Pear Up

**Pear up your GNOME.** A macOS-like desktop in a single GNOME Shell extension: a global menu bar for
the focused app, a system menu behind a bitten pear, the clock in the corner, window buttons on the
left, and one settings window that also drives your dock.

> Not affiliated with Apple. The pear is the joke.

![The focused app's menus in the top bar](assets/screenshots/global-menu.png)

## What it does

**A global menu bar.** The focused application's name and its File, Edit, View, Go, Window and Help
menus live in the top bar instead of inside each window. Every menu can be switched off individually.
When no window is in front, the bar clears itself.

**A system menu.** The bitten pear on the far left opens About This System, System Settings,
Activities, the App Grid, your software centre, system monitor, terminal and extensions manager,
Force Quit, and the power actions — each one optional. The icon can be any bundled distro logo, an
Apple-style glyph, or your own image.

![The pear system menu open](assets/screenshots/system-menu.png)

**A macOS-shaped top bar.** The clock moves to the far right with the status icons to its left, the
power glyph is hidden, GNOME's usually-inactive indicators stop reserving space, and a
[Search Light](https://extensions.gnome.org/extension/5489/search-light/) icon can be grouped with
Quick Settings as a Spotlight stand-in.

**Window buttons on the left.** Close, minimize and maximize in macOS order.

**Dock control.** [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/) is
configured from the same window: which screen edge it sits on, icon size, how much of the edge it may
use, whether it is always visible, hides when a window is in the way, or only appears when you point
at the edge — and which display it belongs to.

| Right edge, always visible | Bottom edge, larger icons |
| --- | --- |
| ![Dock on the right edge](assets/screenshots/dock-right.jpg) | ![Dock along the bottom](assets/screenshots/dock-bottom.jpg) |

**macOS keyboard shortcuts.** Optional sets you can switch on or off. On an Apple keyboard Command
already acts as Super, so these are the real chords rather than an approximation; on a PC keyboard
read Cmd as the Super or Windows key.

| Shortcut | Does |
| --- | --- |
| `Cmd+Shift+3` | Whole screen straight to a file |
| `Cmd+Shift+4` | Pick a region, window or screen |
| `Cmd+Shift+5` | Screen recording |
| `Cmd+Q` / `Cmd+W` | Close the window |
| `Cmd+M` | Minimize |
| `Ctrl+Cmd+F` | Full screen |
| `Ctrl+Cmd+Q` | Lock the screen |
| `Ctrl+↑` | Overview, like Mission Control |

Screenshots land in `~/Pictures/Screenshots`, and `Print` keeps working alongside. Each accelerator is
added next to GNOME's own rather than replacing it, so switching a set off leaves your own bindings
untouched. Where Dash to Dock already grabs a chord — it takes `Cmd+number` and `Cmd+Q` — the switch
stands that down and offers to move the dock shortcuts to `Cmd+F1…F9` instead.

Shortcuts *inside* an application, like `Cmd+C`, are sent by the app rather than the desktop and
cannot be rebound from here; matching those needs a key remapper such as `keyd`.

**Your own menus.** Add any number of extra top-level menus whose items run shell commands or send
keyboard shortcuts.

## Settings

Everything lives in one window — the panel layout, which menus appear, the dock, and your custom
menus. Open it by pressing <kbd>Super</kbd> and typing "pear", from the app grid, or through the
Extensions app.

These settings cannot appear in GNOME Settings beside Appearance, which is where they arguably
belong: `gnome-control-center` compiles every panel into its binary and has no plugin interface, so
no extension can add one. Installing puts a **Pear Up Settings** application entry in its place.

| General | Menus |
| --- | --- |
| ![General settings](assets/screenshots/settings-general.png) | ![Menu settings](assets/screenshots/settings-menus.png) |

| Dock | Keyboard |
| --- | --- |
| ![Dock settings](assets/screenshots/settings-dock.png) | ![Keyboard settings](assets/screenshots/settings-keyboard.png) |

## Requirements

- GNOME Shell 45 – 50, under Wayland. Every release in that range is checked by the
  [test suite](#testing) rather than assumed; 50 is also what it is used on daily.
- Optional: [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/) for the Dock page
- Optional: [Search Light](https://extensions.gnome.org/extension/5489/search-light/) for Spotlight-style search

Applications are opened through their desktop files where possible, with fallbacks, so the menu
entries work across distributions rather than assuming GNOME's defaults.

## Install

```bash
git clone https://github.com/maddinek/pear-up.git
cd pear-up
bash install.sh
```

Then log out and back in — GNOME does not load new extension code into a running Wayland session —
and enable **Pear Up** in the Extensions app or Extension Manager.

To remove it:

```bash
bash uninstall.sh
```

## Testing

Both suites run in containers, so no other system has to be installed and nothing touches the
desktop you are using.

**Does it still behave?** Boots a real GNOME Shell headless against a virtual monitor, loads the
extension the way a login would, and checks what it actually did to the panel — the clock moved, the
System Menu appeared, the power icon is hidden, and disabling it leaves nothing behind.

```bash
tests/integration/run.sh        # GNOME 50
tests/integration/run.sh 48     # GNOME 48
```

This is the suite worth trusting, because the interesting failures are about timing rather than
missing functions. The power icon survived two fixes precisely because every API involved existed —
it was being hidden before the thing that draws it had been built.

All six releases pass it, which is why `shell-version` claims them:

| GNOME | 45 | 46 | 47 | 48 | 49 | 50 |
| --- | --- | --- | --- | --- | --- | --- |
| Behaviour | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screenshot artifact | — | ✅ | ✅ | ✅ | ✅ | ✅ |

The screenshot is a convenience, not evidence: whether a recording can be made depends on the
release and the container's media stack, and 45 manages none. The assertions are what matter.

**Do the APIs still exist?** Resolves every GNOME API the extension touches against a given version:
introspected symbols, and the private shell internals that no typelib describes, which are the ones
that vanish quietly between releases.

```bash
tests/run-api-matrix.sh             # every version in the table
tests/run-api-matrix.sh 48 50       # just these
```

`tests/api-manifest.json` is the list of what is depended upon, kept by hand so each entry is a
deliberate statement rather than a grep result.

Neither suite replaces reading GNOME's porting notes when a new release lands, and a passing API
matrix is not grounds on its own for widening `shell-version` — behaviour has to be checked too.

## Credits

Originally written by [ShiroOSL](https://github.com/ShiroOSL) as
[global-menu-for-gnome](https://github.com/ShiroOSL/global-menu-for-gnome), published on
[extensions.gnome.org](https://extensions.gnome.org/extension/10288/global-menu-for-gnome/).

Pear Up is a fork with its own extension UUID, maintained separately and considerably rearranged.
Anything broken here is this project's doing, not the original author's — please report it on this
repository's issue tracker. Use the upstream project if you want the published, supported extension.

Bundled distro logos are trademarks of their respective owners, included only so each distribution
can be represented in the icon picker.

## License

GPL-3.0, inherited from the original project.

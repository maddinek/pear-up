# Pear Up

**Pear up your GNOME.** A macOS-like desktop in a single GNOME Shell extension: a global menu bar for
the focused app, a system menu behind a bitten pear, the clock in the corner, window buttons on the
left, and one settings window that also drives your dock.

> Not affiliated with Apple. The pear is the joke.

## What it does

**A global menu bar.** The focused application's name and its File, Edit, View, Go, Window and Help
menus live in the top bar instead of inside each window. Every menu can be switched off individually.
When no window is in front, the bar clears itself.

**A system menu.** The bitten pear on the far left opens About This System, System Settings,
Activities, the App Grid, your software centre, system monitor, terminal and extensions manager,
Force Quit, and the power actions — each one optional. The icon can be any bundled distro logo, an
Apple-style glyph, or your own image.

**A macOS-shaped top bar.** The clock moves to the far right with the status icons to its left, the
power glyph is hidden, GNOME's usually-inactive indicators stop reserving space, and a
[Search Light](https://extensions.gnome.org/extension/5489/search-light/) icon can be grouped with
Quick Settings as a Spotlight stand-in.

**Window buttons on the left.** Close, minimize and maximize in macOS order.

**Dock control.** [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/) is
configured from the same window: which screen edge it sits on, icon size, how much of the edge it may
use, whether it is always visible, hides when a window is in the way, or only appears when you point
at the edge — and which display it belongs to.

**Your own menus.** Add any number of extra top-level menus whose items run shell commands or send
keyboard shortcuts.

## Requirements

- GNOME Shell 45 – 50
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

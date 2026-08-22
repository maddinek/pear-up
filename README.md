# Global Menu for GNOME

Global Menu for GNOME brings a clean, streamlined desktop layout to your system by adding a dedicated application menu directly into the GNOME top panel. Inspired by the sleek aesthetic of macOS, this extension places essential window actions, navigation controls, a System Menu, and quick-access options into a single unified top-bar component.

This is a fork. It is not published on extensions.gnome.org and is not supported by the
original author — see [Credits](#credits).

## 🚀 Installation

```bash
git clone https://github.com/maddinek/global-menu-for-gnome.git
cd global-menu-for-gnome
bash install.sh
```

🔄 **Apply changes:**
- On Wayland: log out of your desktop session and log back in.
- On X11: press `Alt + F2`, type `r`, and hit Enter to reload GNOME Shell.

Then enable **Global Menu for GNOME** using the Extensions app or Extension Manager.

## ❌ Uninstallation

If you installed from GNOME Extensions, just remove it from the Extensions app.

If you installed from source:

```bash
cd global-menu-for-gnome
bash uninstall.sh
```

## Features

- Global top-bar menu (App, File, Edit, View, Go, Window, Help) with per-menu toggles
- System Menu (Apple-menu-style button) with configurable icon, App Grid, Software Center, System Monitor, Terminal, Extensions, Force Quit, power options, and custom shell-command items
- Multiple independent custom top-level menus, each with shell-command or keyboard-shortcut items
- Bundled distro/Apple icon picker for the System Menu button
- Optional hiding of the Activities button
- Dock page for driving [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/) from the same
  window: screen edge, icon size, length, whether it hides behind windows, and which display it appears on
- macOS-style window buttons on the left of the title bar

## Credits

Originally written by [ShiroOSL](https://github.com/ShiroOSL) as
[global-menu-for-gnome](https://github.com/ShiroOSL/global-menu-for-gnome), available on
[extensions.gnome.org](https://extensions.gnome.org/extension/10288/global-menu-for-gnome/).

This fork carries its own extension UUID and is maintained separately. Bugs here are not the
upstream author's — please report them on this repository's issue tracker, and use the upstream
project if you want the published, supported extension.

Bundled distro logos are trademarks of their respective owners, included only to represent each
distribution in the icon picker.

## License

GPL-3.0

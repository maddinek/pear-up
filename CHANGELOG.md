# Changelog

Notable changes, newest first. Versions are the pair described in
[the README](README.md#releases): the integer GNOME compares, and the name a
human reads.

## Unreleased

### Changed

- **Force Quit picks a window**, instead of killing whatever happens to have
  focus. Click the window after choosing the item, the way xkill does; Esc or
  right-click cancels. Killing the focused app was the wrong default: the window
  you want to abandon is usually the one that is not responding, and therefore
  not the one that has focus.
- **The System Menu now follows the Apple menu it imitates**, group for group:
  About, then settings, then Recent Items, then Force Quit, then the power
  actions, then Lock Screen and Log Out — the last two naming the shortcut this
  system has bound, read from GNOME's own settings rather than assumed. Every
  entry carries an icon, and the account name appears in Log Out.
- **Activities, App Grid, System Monitor and Terminal are off by default.** The
  Apple menu has none of them and the dock reaches them; the settings remain for
  anyone who disagrees.

### Added

- **System Menu text size**, 10–16px, default 13 (GNOME's own). The pear menu
  only; File, Edit and the rest of the bar stay at the shell size.
- **Recent Items**, as Applications, Documents and Servers, with Clear Menu.
  Applications comes from the shell's usage statistics because GNOME keeps no
  recently-used-application list, and Clear Menu empties the recent files list —
  the one GNOME Settings clears — which those statistics do not live in.

## 0.2.0 — `version: 2` — 2026-08-23

The first release after the project became Pear Up, and mostly the result of
running it somewhere other than the machine it was written on.

### Added

- **A search button of its own**, off by default, where macOS keeps Spotlight.
  What it opens is a setting: GNOME's own search, Search Light, or any command.
  Anything unavailable falls back to GNOME's search rather than doing nothing.
- **Status area spacing and padding**, so the right-hand cluster can be spread
  out or packed tighter than GNOME allows. At zero padding the icons touch.
- **A dock page that explains itself** when Dash to Dock is not installed,
  including the install command for the running distribution.
- **A preferences smoke test** that builds every page headlessly on GNOME 45–50,
  and **eslint**, and **CI** that runs both along with the API matrix.

### Fixed

- **The System Menu landing behind the menu bar.** Menus were inserted at fixed
  panel indices, on the assumption that slot 0 belonged to this extension. Any
  extension that claims the left edge first takes that slot — Bazzite's distro
  logo menu does — and the System Menu was pushed one place right per menu until
  it sat ninth.
- **The Activities button reappearing at login.** On GNOME 50 it holds the
  workspace indicators and is built *after* extensions are enabled, so hiding it
  during `enable()` found nothing there. It now retries and stays hidden, the
  way the power icon already did.
- **A click path that could abort the shell.** A press handler answering
  `EVENT_STOP` alongside a live `ClickGesture` takes the event out from under it
  mid-recognition, which is fatal on Clutter 18.
- **A search button that did nothing on GNOME 45–49.** Its click was wired to a
  gesture because `Clutter.ClickGesture` resolved, but only GNOME 50 delivers
  panel presses that way. It now asks the base class what the shell does.
- **Panel teardown throwing during logout**, where a session mode change resynced
  the panel while the shell was disposing it.
- **"New <app> Window" not opening a window.** It opened the home folder, which
  the file manager answers by raising whichever window already shows it. It now
  asks the application for a window.
- **Stale window titles in the application menu.** The list of open windows was
  a snapshot from the last time the focused application changed, so a window
  that had since been renamed — every folder you navigate to renames one — was
  listed under its old title. The list is now rebuilt as the menu opens.

### Notes

- Negative status-area gaps are rejected on purpose: measured on GNOME 50, `-1`
  is silently clamped and `-2` collapses the panel's width until the bar stops
  drawing entirely.
- `contrib/search-light-gnome50.patch` carries fixes for Search Light, which
  ends a Wayland session on GNOME 50 when its icon is clicked. Upstream has them
  open but unmerged.

## 0.1.0 — `version: 1` — 2026-08-22

Where this became its own project rather than a set of patches.

- Took over the menu engine from
  [global-menu-for-gnome](https://github.com/ShiroOSL/global-menu-for-gnome),
  renamed everything to Pear Up, and moved to this repository.
- Added the macOS-shaped top bar: clock to the corner, power glyph hidden,
  inactive indicators stopped from reserving space, Activities folded into the
  System Menu, window buttons on the left.
- Added the pear System Menu, Dash to Dock configuration, macOS keybindings and
  custom menus.
- Fixed the GNOME 50 crash that started all of this: the menu code assumed
  `PanelMenu.Button` has a `.label`, and on GNOME 50 it does not.

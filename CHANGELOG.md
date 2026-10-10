# Changelog

Notable changes, newest first. Versions are the pair described in
[the README](README.md#releases): the integer GNOME compares, and the name a
human reads.

## Unreleased

### Fixed

- **A shortcut set gives Dash to Dock's shortcuts back as you had them.**
  Switching a macOS shortcut set on stands Dash to Dock's own grabs down and
  notes what they were, so that switching it off restores them. The note was
  written but never read back: the call that parses it was missing an argument,
  the error was swallowed on purpose, and so once Preferences had been closed
  and opened again the set found nothing to restore and reset the shortcut to
  Dash to Dock's default instead. The smoke test now sets Dash to Dock's
  shortcut to something of its own, switches the window set on and off through
  a second preferences object, and expects it back; without the fix it comes
  back as the default.

- **Indicators that arrive late are spaced like the rest.** The status area
  was spaced once at start-up and again after each panel rebuild, so an
  indicator added in between kept the stylesheet's floor of 3px instead of
  the Padding Around Each Item setting: Vitals, which loads after Pear Up,
  the tray icon of an app started after login, or an indicator its extension
  makes again. Unless the setting happened to be 3, the bar showed uneven
  gaps until the next lock and unlock. They are spaced as they arrive now,
  however many come at once, and let go of again when Pear Up is disabled.
  The integration suite adds indicators after start-up, singly and in a
  burst, and reads the padding each one gets.

- **Cmd+Q quits the app.** It used to sit on GNOME's close binding, so it
  took one window and left the rest of the app running. GNOME has nothing
  that quits a whole app, so Pear Up now binds Cmd+Q itself and asks the app
  to quit the way the dock's Quit does: through the app's own quit action,
  or by closing every window. An earlier Cmd+Q binding moves over by itself
  at the next login. File → Quit goes the same way.

- **The menu bar is set in regular type, with the app name bold.** The shell
  theme makes every panel button bold, and the regular weight Pear Up gave the
  panel never reached them: a weight set on the button itself beats one it
  would inherit. So File, Edit and the rest drew as heavy as the app name, and
  the clock, the battery percentage and other extensions' readouts were bold
  too. All of them are regular now, as on macOS, and the app name is bold —
  the one heavy word in the bar. The integration suite reads the weight the
  theme resolved for the titles, the clock and the status area.

- **A laptop keeps its battery icon.** Hide the Power Icon hid the Quick
  Settings system indicator outright, but GNOME draws the battery in that same
  icon whenever there is one, which left a bare "80%" in the bar. The icon is
  now hidden only while it is the power glyph — on machines without a battery
  — and shown again once it becomes the battery, which on a laptop happens a
  moment after login. The integration suite checks both, whichever the machine
  running it has, by switching the icon the way the shell does and back.

- **Clicking File no longer takes down the desktop.** Pinning the dropdown
  wrote `translation-x: nan` when the actor had no stage position yet, and
  did it from `notify::allocation` — which is while Clutter is walking the
  actor graph. The pin now waits for idle, and a non-finite offset is never
  written.

- **Dropdowns sit under their titles again.** GNOME centres each dropdown on
  its button and offers no alignment knob, so the left edge used to drift
  right on the widest menus. The dropdowns are now pinned to the title's left
  edge on every relayout, and open with a fade — the slide animation fought
  the offset the whole way out.

- **Title Size and Title Padding follow their sliders.** GNOME's own button
  code lays the bar titles out from two hpadding properties and never reads
  CSS padding, so the old style string zeroed what little spacing remained —
  packing File, Edit and the rest into one long word — while the slider
  changed a property nothing read. The sliders now drive the properties that
  actually draw.

- **Close Window closes one window.** Quit had been wired to the same action,
  so File → Close Window and Window → Close took down every window of the
  focused app. Quit still quits; Close does not.

### Changed

- **Title Padding defaults to 6px**, between the old default and the packed
  look, now that the slider moves the spacing it claims to.

- **File and Go follow the focused app.** New Folder, Open With, Get Info,
  Trash and the folder shortcuts belong to a file manager; they no longer
  appear on Firefox, the test window, or anything else. Items that were only
  ever greyed out — Compress, Duplicate, View as Icons / as List — are omitted
  rather than shown disabled.
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

- **An Appearance page, starting with type and the accent.** macOS-Like Type
  sets the interface, document and window-title fonts to Adwaita Sans — GNOME's
  own fork of Inter, shipped from GNOME 48 — at 11, bold for titles, and turns
  font hinting off, which macOS does not use and a high-resolution screen has
  no need of. Without Adwaita Sans it uses Inter; with neither, the row says
  so and stays off. Whether a family is installed is asked of Pango in the
  preferences process, not inferred from the GNOME version, since an older
  release can have either and a newer one can lack it. Blue Accent, Like macOS
  sets GNOME's accent color, which exists from GNOME 47 and is not offered
  before that. These are GNOME's settings, not Pear Up's, so each switch
  remembers what it replaced in a new `displaced-settings` key — the same
  durable JSON note the shortcut sets use for their conflicts — and switching
  off puts the user's own values back, also after Preferences was closed and
  reopened. A key the user never set goes back to its default rather than to a
  copy of it. A switch reads on whenever every value already matches, whoever
  put them there, and follows them when they change elsewhere.
- **The preferences smoke test drives the Appearance switches.** Against the
  container's own in-memory settings it switches type and accent on and off
  through a second preferences object and expects each value back exactly,
  including keys left at their default, a value that already matched, values
  set by hand with nothing noted, and the accent and type switches sharing one
  note. It forces each branch of the font choice, Adwaita Sans, Inter and
  neither, and checks Pango's answer against fontconfig's.
- **Vitals sits closer and a size smaller, like macOS stat apps.** Its
  readouts are spaced 11px apart in the bar's type; with Vitals installed they
  are now 5px apart, set in 12px regular against the bar's 13px. These were
  edits to Vitals' own stylesheet, which any Vitals update overwrites. Pear
  Up's stylesheet carries them now, ahead of Vitals' rules whichever extension
  loaded last, and none of Vitals' settings are changed: its fixed-widths
  option, which gives each readout a set width, stays Vitals' to choose. The
  integration suite loads a stand-in for Vitals' stylesheet, one that sets a
  size and weight of its own too, and reads what the theme resolves for the
  readouts with Pear Up on and off.

- **No backdrop behind the focused app in the dock.** Dash to Dock puts a grey
  backdrop behind the icon of the app in front; the macOS Dock marks it with
  its dot alone. Pear Up removes it with its own stylesheet and changes none of
  Dash to Dock's settings; Highlight the Focused App, under Running Apps on the
  Dock page, brings it back. The integration suite marks a dock icon focused
  and reads the backdrop the theme resolves with the switch off and on.
- **Dock magnification**: point at the dock and the icon under the pointer
  grows while its neighbours grow less and move apart, as on the macOS Dock.
  Off by default. The Dock page gets a Magnification group with a switch and a
  Strength slider from Weak to Strong, 110–300% of normal size, default 175%;
  the slider greys out while the switch is off. Pear Up draws this over Dash to
  Dock and changes none of Dash to Dock's settings, and clicks and
  drag-and-drop still reach Dash to Dock's own icons. It magnifies Dash to
  Dock's icons, so the group appears only when Dash to Dock is installed.
- **The preferences smoke test drives the magnification rows** against the
  packaged Dash to Dock on each GNOME release: the switch and the slider write
  their keys, the slider's bounds match the schema, the slider's greying
  follows the switch, and a change made outside the window moves the controls.
  Without Dash to Dock it checks the rows are absent.
- **Running app indicator on the Dock page**: one dot under each running app
  like macOS, GNOME's default, or none. Dash to Dock has no style that draws
  nothing — hiding running apps only drops the unpinned ones from the dock — so
  None is the single dot drawn transparent. Dash to Dock marks an app only once
  it has a window, so apps living in the tray, like Steam, get no dot. The row
  steps aside when Dash to Dock's built-in theme is on, since that draws its own,
  and is absent on releases older than the single-dot style.
- **The preferences smoke test builds the Dock page with Dash to Dock**, the
  packaged one for each GNOME release, and checks every indicator choice is
  stored and read back.
- **System Menu text size**, 10–16px, default 13 (GNOME's own). The pear menu
  only; File, Edit and the rest of the bar have their own size.
- **Menu bar title size and padding**, so File, Edit and the menus they open
  can be sized without changing the pear menu.
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

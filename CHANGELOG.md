# Changelog

Notable changes, newest first. Versions are the pair described in
[the README](README.md#releases): the integer GNOME compares, and the name a
human reads.

## Unreleased

The macOS look that was being set up by hand — type, accent, icons and cursor, window buttons and
corners, a frosted dock, where notifications and the volume bubble appear, how the screen fades with
the light, how the touchpad scrolls — is now done from Pear Up's own window, and without Just
Perfection. The switches that set GNOME's own settings, or Blur my Shell's, note what they replaced and put
it back when they are switched off.

### Added

- **Notifications Slide In from the Right.** A new switch under Notifications
  at the Top Right, off by default: a banner comes in from beyond the right
  edge of the screen (an ease-out over about a third of a second, with no
  bounce) and, when its time is up or it is closed, slides back out to the
  right, as on macOS, instead of dropping from the top. It wraps the message
  tray's `_updateShowingNotification` and `_hideNotification` only for the
  length of each call, so the shell's own state handling is untouched; it
  follows the animation switch and slow-down factor, does nothing while the
  banners are not in the corner, and leaves GNOME's drop where those methods
  are missing.

- **Springy Desktop Switching** (General ▸ Desktop, off by default). Desktops
  move the way Spaces do on macOS: a keyboard switch, and the slide after a
  three- or four-finger swipe is let go, land on a critically damped spring in
  about 0.4 s instead of GNOME's 250 ms ease, the release starting at the
  fingers' own speed; pulled past the first or last desktop they follow with
  growing resistance and spring back; and the switch shortcut on the last (or
  first) desktop gives a small bump that way. With dynamic workspaces the last
  desktop is the empty one GNOME keeps. Only the desktop switcher's own swipe
  tracker is changed, on that instance, so the overview's swipe is untouched.
  The rubber band needs GNOME 49 or later; 45 to 48 get the spring and the bump.

- **Window Keys on the Keyboard page.** Cmd+M Minimizes adds Super+M to the
  minimize shortcut and takes it from the message tray, which keeps its other
  keys; Cmd+D Shows the Desktop adds Super+D (macOS uses Cmd+F3 or F11, and F3 is
  a media key on a Framework). Restore GNOME Window Keys refills maximize,
  restore and the tile-left and tile-right keys from GNOME's defaults when
  another extension, Tiling Shell for one, has emptied them, and leaves keys
  that hold something alone. A value that is already right reads as on, and
  switching off puts back what was displaced.

- **Windows that open and close like macOS** (Windows page, Animation, *Open and
  Close Like macOS*, key `macos-window-animations`, off by default). A new
  window fades in while growing from nine tenths of its size around its centre
  (230 ms, ease-out cubic), and a closing one fades while shrinking back to nine
  tenths (190 ms), where GNOME pops a window up from a sliver at its bottom edge.
  It restyles the shell's own animation rather than replacing it: the window
  manager's `_shouldAnimateActor` is wrapped on `Main.wm` — on the instance,
  so it sits in one chain with Magic Lamp's wrapper whichever was enabled first —
  and when the shell is about to animate a normal window or a dialog of its own
  opening or closing, that window's next `ease()` gets other values. The shell
  still decides whether to animate, keeps its books and finishes the window
  through its own `onStopped`, so a window closed mid-animation is finished as
  without Pear Up. Attached dialogs keep GNOME's unfold, which is close to a
  macOS sheet; menus and tooltips are never touched; minimizing stays Magic
  Lamp's. The slow-down factor and Reduce Animation apply as to the shell's own.
  Burn My Windows, if it has an effect for a window, takes precedence.
  Integration tests sample the animation at a quarter speed on GNOME 48 and 50
  (GNOME 45 does not animate windows headless), with a stand-in for Magic Lamp,
  and check that nothing is left behind; the preview takes a frame sequence of
  both and of GNOME's own opening.

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

- **Icon and cursor theme pickers on the Appearance page.** Each lists the
  themes installed on the system, macOS-style ones first — MacTahoe and
  WhiteSur, and for cursors the macOS set — and writes `icon-theme` or
  `cursor-theme` when one is picked. They look where GTK does: the user's data
  directory, `~/.icons`, and the `icons` directory of each system data
  directory. A directory counts as an icon theme if its `index.theme` names
  directories, which a cursor-only theme's does not, and as a cursor theme if it
  has a `cursors/` directory; hicolor, locolor and default are never offered,
  and neither are themes that mark themselves Hidden, except Adwaita, which is
  the stock choice, and the theme in use. A theme in use that is not installed
  is listed as such rather than replaced by the first entry. With no
  macOS-style theme installed, a row links to MacTahoe and WhiteSur, or to
  apple_cursor, and says in a line how to install one into `~/.local/share/icons`
  without root. An unreadable directory or index just leaves a theme out.

- **A Windows page, after Appearance.** What macOS does with its windows, in
  four groups: the buttons, how new windows open, rounded corners and the
  minimize effect. Window Buttons on the Left moves here from General, with the
  same switch and the same two layouts. As on Appearance, none of it is Pear
  Up's own setting, so each row reads the state of the thing it drives, whoever
  put it there, and follows it when it changes elsewhere.

- **Small Window Buttons.** Shrinks the close, minimize and maximize buttons to
  about the size macOS draws them, in every app that draws its own title bar.
  The size is CSS, and Pear Up keeps one block of it in each of
  `~/.config/gtk-4.0/gtk.css` and `~/.config/gtk-3.0/gtk.css`, between two
  marker lines, `/* >>> pear-up window buttons >>> */` and
  `/* <<< pear-up window buttons <<< */`. The GTK 4 file reaches libadwaita
  apps; the GTK 3 one reaches GTK 3 apps and the Electron ones that draw GTK 3
  title buttons, such as Claude, ChatGPT and Cursor. Apps pick it up when they
  next start. Switching on creates the files and directories that are missing
  and puts the block after whatever is there; switching off removes the block
  and the one blank line that set it off, and nothing else, so a file comes
  back byte for byte as it was, bar a final newline it lacked. Doing either
  twice changes nothing. A start marker without an end, or an end without a
  start, is the user's text and is left alone. A file that is not UTF-8, or
  that cannot be read back exactly as it is read, is not touched, and neither
  is the other file: every file is read before any is written, and if a write
  fails the ones already written are put back. A symlink, as a dotfile manager
  leaves, is followed to its target and stays a link. Rules of the user's own
  that already size these buttons count as the switch being on, and are never
  removed: with only those in place the row is greyed out and says where they
  are, and with Pear Up's block beside them it says they are left as they
  are. Whatever the file holds, comments do not count as rules.

- **Don't Maximize New Windows.** Sets mutter's `auto-maximize` to false, so a
  window that opens nearly as large as the screen is left the size it asked
  for, as on macOS. It remembers what it replaced in `displaced-settings`, as
  the Appearance switches do, and switching off gives the user's own value back,
  or the default if there was none.

- **Rounded corners and the genie effect, when their extensions are there.**
  [Rounded Window Corners Reborn](https://extensions.gnome.org/extension/7048/rounded-window-corners-reborn/)
  and [Magic Lamp](https://extensions.gnome.org/extension/3740/compiz-alike-magic-lamp-effect/),
  neither of which Pear Up installs. When one is installed, in the user's data
  directory or a system one, the page has a switch for it and, for the corners,
  a Corner Radius slider from 0 to 40px; when it is not, a row says so and links
  to its page on extensions.gnome.org. The switches ask the shell, as the
  Extensions app does, through `EnableExtension` and `DisableExtension` on
  `org.gnome.Shell.Extensions`, rather than writing `enabled-extensions`: the
  shell puts the extension in one list and takes it out of the other, which
  matters because `disabled-extensions` wins over `enabled-extensions`, and it
  says whether it knows the extension at all. An extension installed since the
  session began is unknown to a Wayland shell until the next login, and the
  switch goes back with a note saying so, as it does when the shell cannot be
  reached. Each switch reads the same two lists and `disable-user-extensions`,
  so it is on whenever the extension is, however it was switched; it keeps the
  user's choice while a call is out and once the shell has said yes, because on
  GNOME 45 and 48 the lists in the preferences process are still the old ones
  when the reply arrives and catch up a moment later; and a second flip is a
  second call, in order. The radius is one entry of
  `global-rounded-corner-settings`, a dictionary of mixed types the extension
  keeps everything in: it is rebuilt entry by entry, so every other entry comes
  back with the type and the place it had, and the radius goes back as the
  unsigned integer the extension writes.

- **Running app indicator on the Dock page**: one dot under each running app
  like macOS, GNOME's default, or none. Dash to Dock has no style that draws
  nothing — hiding running apps only drops the unpinned ones from the dock — so
  None is the single dot drawn transparent. Dash to Dock marks an app only once
  it has a window, so apps living in the tray, like Steam, get no dot. The row
  steps aside when Dash to Dock's built-in theme is on, since that draws its own,
  and is absent on releases older than the single-dot style.

- **Dock magnification**: point at the dock and the icon under the pointer
  grows while its neighbours grow less and move apart, as on the macOS Dock.
  Off by default. The Dock page gets a Magnification group with a switch and a
  Strength slider from Weak to Strong, 110–300% of normal size, default 175%;
  the slider greys out while the switch is off. Pear Up draws this over Dash to
  Dock and changes none of Dash to Dock's settings, and clicks and
  drag-and-drop still reach Dash to Dock's own icons. It magnifies Dash to
  Dock's icons, so the group appears only when Dash to Dock is installed.

- **Dock bounce**: an app's dock icon hops away from the screen edge while the
  app starts, until its first window appears (at most ten seconds), and three
  times when a window of an app in the background asks for attention, landing
  early once the app is brought forward — leftwards for a dock on the right,
  upwards for one at the bottom. Each hop takes 0.6 s and rises half the
  icon's size, rising and falling like a thrown ball; it is slowed with the
  shell's own animations and skipped when animations are off. Two switches in
  a new Bounce group on the Dock page, `dock-bounce-on-launch` and
  `dock-bounce-on-attention`, both off by default. Drawn over Dash to Dock like
  magnification, which lifts its magnified copy instead while the pointer is on
  the dock; the running dot stays put, as on macOS.

- **A Glass group on the Dock page, for a frosted-glass dock.** The floating,
  frosted pill macOS has is [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/)
  blurring and tinting what is behind Dash to Dock, and the group sets how. It is
  there when Blur my Shell is installed, in the user's data directory or a system
  one, and is a row linking to its page on extensions.gnome.org when it is not,
  as the Windows page does for Rounded Window Corners Reborn. Frosted Glass, Like
  macOS switches on the blur, Blur my Shell's override of the dock's background,
  which its tint needs, a dark glass tint, a light one when GNOME's colour scheme
  is not dark, and a brightness of 0.9. Below it are a Tint choice, Transparent,
  Light or Dark, which are the three values of `style-dash-to-dock`, and a
  Brightness slider from 50 to 100%. These are keys of the Dash to Dock
  component of Blur my Shell, `blur`, `override-background`,
  `style-dash-to-dock` and `brightness`, and nothing else is written: not its
  panel, overview or popup components, and not whether the dock's blur is static
  or dynamic. As on Appearance and Windows the switch notes what it replaced in
  `displaced-settings` and gives the user's own values back, and reads on whenever
  the look is there, whoever put it there. Any glass tint and any brightness the
  slider reaches count as the look, so moving Tint or Brightness does not switch it
  off; choosing Transparent does, as it takes the glass away. Blur my Shell
  installed but switched off is said in the group's description, since none of it
  shows then, and one with no dock settings is said so, with the link, rather
  than built into rows that would fail. One thing about the slider, found by
  measuring it: `brightness` is the key of Blur my Shell's dynamic blur. Static
  blur, its default, draws with the pipeline the dock names, a dictionary other
  parts of Blur my Shell use too and that nothing here may rewrite, and ignores
  the key: the dock's pixels were identical at 0.6, 0.9 and 1.0. So
  while the dock's blur is static the slider is greyed out and says so, and it
  works once Blur my Shell's own preferences set the dock to dynamic blur. Tint
  is drawn in both. The switch is the existing displacing switch, which
  gained two options for this: a value that is asked for when it is written,
  for the colour scheme, and a test of what counts as already being the look.

- **A Desktop group on the General page, for what is not the bar.** The
  pieces of the shell that macOS puts elsewhere, each a switch of its own and
  on by default like the bar's tweaks. Together they cover what Just
  Perfection was installed for, so it can go; with it still installed at its
  defaults, nothing fights.

- **Notifications at the Top Right.** GNOME shows a banner under the clock,
  which with Clock on the Right is already the top right corner, but it sets
  that again every time it builds the panel, and Just Perfection puts banners
  top centre, at its defaults, whenever it is enabled. Banners now stay on the
  right whatever the clock does, and go back there on the next idle tick
  after anyone else moves them; a fight with something that moves them back
  each time ends after five rounds. Switched off, they go where the last of
  the others asked.

- **Volume and Brightness at the Top Right.** The bubble a volume or
  brightness key brings up moves from the bottom centre of each screen to the
  top right corner, under the bar, as on macOS. Each monitor's bubble window
  is aligned to the corner and held to the work area, which starts below the
  bar whatever its height, rather than its class being patched, which is how
  Just Perfection does it: two extensions wrapping the same method can only be
  undone in the right order. A monitor added later gets the same, and every
  window gets its own alignment back when the switch is turned off.

- **No Popup When Switching Desktops.** GNOME shows the row of desktops for a
  moment whenever a shortcut switches desktop or moves a window to another;
  macOS only slides the desktop across, and the slide, which is the shell's
  own, stays. The popup is destroyed as the shell asks it to show, which is
  what the shell itself does when a window switcher opens over one.

- **Always Show the Desktops in the Overview.** The strip along the top of
  the overview stays, as Mission Control's Spaces do, where GNOME hides it
  until two desktops are in use. The overview's own strip is asked again when
  the switch changes, and those of other monitors are made as the overview
  opens.

  Both patch a method of a class the shell keeps for its whole life, so the
  patch is made once and recognised at the next enable rather than wrapped
  again — the shell disables and enables Pear Up at every lock. Off, the
  wrapper passes every call through, and it is taken out only while it is the
  one installed: Just Perfection wraps the same two methods when its own
  options for them are set, and putting back what Pear Up found would throw
  its wrapper away. At its defaults it touches neither.

- **Start on the Desktop.** A login lands in the overview, which the shell
  opens as its startup animation; macOS shows the desktop. While the shell
  starts, and only then, the overview's startup animation is stood in for by
  one that does nothing, so the shell finishes starting with the overview
  closed, and the stand-in is gone again once it has. If the shell got there
  first — extensions are enabled while it starts, and with a wallpaper quick
  to load the shell can win — the overview is closed straight away, part-way
  through its animation, which the shell allows for; Dash to Dock waits for
  the start to complete, with the overview fully shown. In a framy-like GNOME
  50.5 that is the usual case: the overview was already showing when the last
  extension was enabled; in the integration suite on 45 and 48 the stand-in
  got there first, and on 50 the overview was closed. Otherwise the
  overview's state, which it is made with at the window picker, is set to
  hidden, where closing it leaves it: a swipe up on the touchpad starts from
  there. Just Perfection and Dash to Dock do this by having the
  session mode say there is no overview while the shell starts, each putting
  back what it read first, and the one that comes second reads the other's
  answer and puts that back, which can leave Super+1…9 off until the next
  lock. Nothing here touches it, and with either of them doing its own the
  shell never calls what is stood in for. Takes effect at the next login.

- **Smooth Automatic Brightness.** With Automatic Screen Brightness on, GNOME
  50 moves the screen to each new light level in one step, and often a large
  one. gnome-settings-daemon smooths the light sensor's readings by the time
  since the last change, so the first change after a quiet spell — a lamp
  switched on, a cloud past the window — gets almost none, and the shell
  applies every level it is sent the moment it arrives. The level now fades
  there instead, by a share of the way left on each tick: most of the way in
  about 1.5 seconds when brightening and 3 when darkening, as macOS fades
  slowly into the dark, and by at least a small step, so the end is not drawn
  out. Only the automatic level fades. The brightness slider and keys still
  act at once, on top of wherever the fade has got to, and so does dimming
  when idle; automatic brightness switched off, or the screen blanked, applies
  at once and stops the fade, and switched on again it starts from where the
  screen is. The fade sets the shell's own level, ticking 25 times a second
  while it moves, and stops when it arrives; it changes nothing on screen
  itself.

  With it, a race in GNOME's own reading of the backlight is patched (gnome-
  shell MR !4467, still open). Each level the shell writes reaches the
  backlight a moment later, and while one is on its way mutter can report the
  one before as a change made by the system. The shell took that level, which
  has the automatic level in it, for the slider's, so the automatic level
  counted twice from then on, and it stopped dimming, which a change from
  outside is meant to end. A fade writes many levels in a row, which would make
  that common. A level read back that is one of the last sixteen written, in
  the last two seconds, is now let pass, and a real change from outside has the
  automatic level taken off before it goes to the slider, as that MR does, so
  the screen stays where it was put.

  The shell sets the brightness itself from GNOME 49. Before, gnome-settings-
  daemon does, out of the shell's reach: there the switch is not offered, and
  Pear Up says once in the journal that there is nothing to smooth. Pear Up is
  off on the lock screen, as it has no session modes of its own, so there the
  levels step as GNOME's do until the unlock; a fade under way when the
  screen locks goes straight to where it was heading. On by default, in the
  Desktop group.

- **Floating Thumbnail after a screenshot, on the Keyboard page.** As on
  macOS, the shot shrinks from where it was taken — the whole screen, the
  selection or the window — into a 220px card with rounded corners in the
  bottom right corner, left of a dock on the right edge (or above one along
  the bottom), stays five seconds, longer while the pointer rests on it, and
  slides off to the right. Clicking opens the file in its default app;
  dragging or swiping it right puts it away at once; a new shot replaces it.
  It follows the shell's own "Screenshot captured" notification, so Print,
  Cmd+Shift+3/4 and window shots all show it and screencasts do not. Hide the
  Screenshot Banner (on) keeps GNOME's banner out of sight meanwhile, from
  GNOME 46; the notification stays in the list until the card goes. Off by
  default; the arrival and leaving follow the shell's animation settings.

- **macOS-Like Scroll Acceleration, in a Trackpad group on the Keyboard
  page.** libinput scrolls by the same amount for every millimetre two
  fingers travel, about 10.5 units, however slowly they go, so a page moves
  away under a gentle nudge; macOS starts slowly and speeds up with the
  fingers. Nothing in the shell can change that, since only libinput sees the
  fingers, so this is a libinput plugin (libinput 1.30 brought them), shipped
  in `libinput/`. The switch copies it into `~/.config/libinput/plugins`,
  where GNOME 50 loads plugins from at login, and switching it off removes
  that one file. While exactly two fingers move together, the plugin scales
  the movement they share by a gain that follows their speed: 0.35 up to 20
  mm/s, rising smoothly to libinput's own rate at 80 mm/s and a touch beyond,
  1.15, for a flick from 200 mm/s. A Strength choice sets the slow end —
  Light 0.6, Medium 0.35, Strong 0.2 — by writing it into the copy, since a
  plugin cannot read files. One finger, three, a palm, the bottom 10 mm where
  the click areas are, a pad pressed down, and any movement the fingers do
  not share — a pinch, one resting while the other moves — reach libinput as
  the kernel sent them. A finger keeps the offset it gathered until it lifts,
  so lifting the other does not make the pointer jump. If the plugin ever
  fails, libinput unloads it and scrolling is as before until the next
  login. Before GNOME 50 the switch is greyed out and says why; a file of the
  same name that is not Pear Up's is left alone. install.sh updates an
  installed copy, keeping its strength, and uninstall.sh removes it. Slower
  browser back and forward swipes come with it, as they do on macOS.

  `tests/run-libinput-tests.sh` checks it in a container: its arithmetic, in
  a sandbox like libinput's; then the plugin loaded into libinput 1.31 itself,
  replaying a slow and a quick two-finger scroll, a pinch and pointer motion
  on a touchpad that only umockdev's fake device node makes, rather than a
  uinput device every libinput on the machine would see. A slow scroll comes
  out at 0.35 of libinput's own, a quick one at about the same, and a pinch
  and one finger exactly as without it. The preferences smoke test installs,
  re-strengthens and removes the file in a config directory of its own.

- **macOS keys inside apps, in an Inside Apps group on the Keyboard page.**
  On a Mac, Option+←/→ moves the cursor a word (with Shift, selects by
  word), Ctrl+←/→ goes to the desktop beside, and Cmd+C copies. Linux apps
  know those as Ctrl+←/→ and Ctrl+C, and an app reads its own keys, so no
  GNOME shortcut can change them: they have to be translated before they
  arrive. That is a second libinput plugin, `libinput/10-pear-up-macos-keys.lua`,
  installed like the scroll one into `~/.config/libinput/plugins` and loaded
  by GNOME 50 at login, with three switches: Option+←/→ Moves by Word
  (Ctrl+←/→), Ctrl+←/→ Switches Desktops (Ctrl+Option+←/→, GNOME's own
  default shortcut for it, so nothing has to be bound; the row says so if it
  has been unbound) and macOS Shortcuts in Apps (Cmd+C, V, X, Z, A, S, F, T,
  W and N as Ctrl with the same key, Shift too; not Q, which is Pear Up's
  Quit). Option, Cmd and Ctrl tapped alone or with any other key, and
  combinations such as Ctrl+Shift+← that Linux apps select by word with,
  reach apps as before. A modifier still reaches libinput the moment it is
  pressed; when a key to translate follows, it is lent to the translation,
  with Ctrl pressed before it is let go so that nothing sees a lone tap of
  Alt or Super, and it stays lent while it is held, so word after word needs
  no tap in between. Held keys repeat as their translation, keys let go in
  any order leave nothing held, and any other key gives back what was lent
  first. What libinput holds is worked out afresh after every key from what
  the keyboard holds, and only the difference is sent. The plugin sees raw
  keys, before xkb's Alt/Cmd swap, so which key is Option and which Cmd is
  written into the installed copy from the Swap Alt and Cmd switch and
  written again when the swap changes; the switches and the Cmd key list are
  lines in it too, and a list edited by hand is kept. An error while a key is
  handled puts the modifiers back to what the keyboard holds and leaves the
  keys alone until the next login. In a terminal Cmd+C becomes Ctrl+C, which
  interrupts, and GNOME's own Super+A, S, V and N give way; both are said
  on the row. Option+Backspace is left as it is, since in a terminal
  Alt+Backspace already deletes a word and Ctrl+Backspace would erase one
  character. If an input-remapper preset already maps a modifier with ←/→,
  or Alt or Super with a key on the list, a row says so and that the keys
  would be translated twice; the preset is only read. The group replaces the
  note that said shortcuts inside applications could not be changed from
  here; before GNOME 50 it is greyed and says that a key remapper such as
  keyd does it. install.sh updates an installed copy, keeping its lines, and
  uninstall.sh removes it; neither touches a file of that name that is not
  Pear Up's.

  `tests/run-libinput-tests.sh` checks it as it does the scroll plugin. Its
  logic, in libinput's sandbox, against keys pressed and let go as a keyboard
  sends them, with the swap on and off: modifiers alone and with other keys
  untouched, each translation key by key, repeats, release orders, the
  switches and the key list as written, and an error mid-translation; then
  3000 runs of random presses, repeats and releases, after each of which
  nothing may be held, nothing pressed twice or let go unpressed, no
  untranslated key pressed with other modifiers than are held, and no lone
  Alt, Super or Ctrl tap made up. Then the plugin in libinput 1.31 itself,
  with `libinput debug-events` reporting fifteen sequences typed on a
  umockdev copy of framy's keyboard, with the swap on, off, and with no
  plugin, where every key has to come out as pressed; xkb's compiled keymap
  confirms which raw key the swap makes Alt and which Super, and GNOME 50's
  schema that Ctrl+Alt+←/→ is bound to the desktops beside. The preferences
  smoke test switches each row on and off in a config directory of its own
  and compares the file byte for byte, follows the swap from the row and from
  outside, keeps a hand-edited key list, leaves other plugins, an older copy,
  someone else's file and an unwritable directory as the scroll plugin's test
  does, and reads a copy of framy's input-remapper preset, a 1.x one and a
  harmless one, warning for the first two only.

- **System Menu text size**, 10–16px, default 13 (GNOME's own). The pear menu
  only; File, Edit and the rest of the bar have their own size.

- **Menu bar title size and padding**, so File, Edit and the menus they open
  can be sized without changing the pear menu.

- **Recent Items**, as Applications, Documents and Servers, with Clear Menu.
  Applications comes from the shell's usage statistics because GNOME keeps no
  recently-used-application list, and Clear Menu empties the recent files list —
  the one GNOME Settings clears — which those statistics do not live in.

- **The test suites cover each of these.** The preferences smoke test and the integration suite
  gained checks for what is added above:

  - **The preferences smoke test drives the Appearance switches.** Against the
    container's own in-memory settings it switches type and accent on and off
    through a second preferences object and expects each value back exactly,
    including keys left at their default, a value that already matched, values
    set by hand with nothing noted, and the accent and type switches sharing one
    note. It forces each branch of the font choice, Adwaita Sans, Inter and
    neither, and checks Pango's answer against fontconfig's.

  - **The preferences smoke test drops themes into the container's XDG
    directories.** A third run installs fixture icon and cursor themes into the
    user data directory, `~/.icons` and a system data directory — one that is
    both, one that hides itself, the three names never offered, a name found in
    two places and one reached through a symlink — and checks what each picker
    lists and in what order. The same page is also built over empty directories,
    where the links to where to get a theme must show, and over the container's
    own themes. Picking an entry writes the key; the key changing elsewhere moves
    the row.

  - **The preferences smoke test drives the Windows page.** Against the
    container's own in-memory settings, and a config directory the runner makes
    and names so the test can tell it from anyone's real one: it does not write
    files anywhere else. The gtk.css switch goes in and out of files that are
    missing, empty, with Windows line endings, without a final newline, with a
    byte order mark, with text that is not ASCII, with a stray marker, with the
    user's own rules in one file or both, and through a symlink, and compares
    every byte outside the block, the modification times of what should not have
    been rewritten, and the files beside them. A file that is not UTF-8, a
    directory where a file should be, a decoder that changes what it reads and a
    write that fails half way each leave the files as they were, which taking out
    the read-everything-first order, the rollback or the re-encoding check each
    makes fail. The extension switches run against a stand-in for the shell that
    does what its `enableExtension` and `disableExtension` do to the two lists,
    with the extensions' metadata, and for Rounded Window Corners Reborn the
    schema of its one key, put where GNOME looks: one in the user's data
    directory and one in a system one, and once with neither. It covers the
    uuid in both lists, extensions switched off as a whole, a shell that does not
    know the extension, one that cannot be reached, a second flip while a call is
    out, and the radius against a dictionary with odd types, with no radius and
    with a radius stored as a double. Auto-maximize is switched on and off
    through a second preferences object, as after the window was closed and
    opened again, and gives back the user's value, or none. The window is also
    opened at the width it asks for, on a screen wide enough to hold it, and every
    page label in the switcher has to be whole.

  - **The preferences smoke test drives the Glass group.** In three runs: with
    Blur my Shell absent, where the group is the link and nothing else; installed
    as Bazzite ships it, in a system directory, with the schemas of the dock, panel
    and popup components as version 74 has them; and installed with no schemas, in
    the user's data directory. With it installed the switch is flipped on and off
    against the defaults, against light and dark colour schemes, one that changes
    while the page is open, and values of the user's own, through a second
    preferences object as after a reopen, and against a look made by hand, which
    has to read on. Tint and brightness are driven, including a style of Blur my
    Shell's own that the list lacks, a brightness outside the slider, a switch that
    has to stay on while they move and a slider that follows the key. At the end
    every key of the panel and popup components, and every key of the dock's but the
    four, has to have no value of the user's.

  - **The preferences smoke test builds the Dock page with Dash to Dock**, the
    packaged one for each GNOME release, and checks every indicator choice is
    stored and read back.

  - **The preferences smoke test drives the magnification rows** against the
    packaged Dash to Dock on each GNOME release: the switch and the slider write
    their keys, the slider's bounds match the schema, the slider's greying
    follows the switch, and a change made outside the window moves the controls.
    Without Dash to Dock it checks the rows are absent.

  - **The integration suite checks each of the Desktop group's switches, and that they are given
    back.** It expects the session to have started on the desktop, the
    overview never to have begun to show once Pear Up was in place, its state
    hidden and nothing left standing in for its animation. It shows a
    notification and expects its banner against the right edge under the bar,
    centres banners the way Just Perfection does and expects them back on the
    right, and brings up the volume bubble and expects it in the top right
    corner of the work area. It switches desktop with Cmd+PageDown and
    back, the way GNOME's own bindings do, and expects the switch with no popup,
    and the overview's strip of desktops shown with only two. After disabling:
    banners centred under the clock, the bubble at the bottom centre with GNOME's
    own alignment, the popup on the next switch, the strip's own rule, and both
    methods the shell's own again, read from their source. Then it enables Pear
    Up once more, as an unlock does, and disables it, and expects the same:
    patched twice over, one disable would have left a wrapper behind.

  - **And the brightness fading, on the shell's own brightness code.** The
    container has no backlight, so on GNOME 49 and later the suite has the
    shell's brightness manager build a monitor scale, of the shell's own class,
    for a stand-in screen whose backlight behaves as mutter's does and records
    every level written to it, and sends levels through the shell's own D-Bus
    interface, as gnome-settings-daemon does. It expects automatic brightness,
    switched on, to fade in from where the screen was; a step from 80% to 30%
    to fade down with no step over 5% and to be half-way after one to three
    seconds; the slider to apply at once with nothing fading after it; idle
    dimming to cap the screen at once, and a level of the shell's own read back
    while dimmed to leave the dimming and the slider alone; a change from
    outside to stay where it was put; and switching off part-way through a
    fade to apply at once and stop it. Disabled part-way through a fade, where
    it was heading applies at once, the shell's own accessor and methods are
    back, and a level sent then applies once with no timer left writing; enabled
    again, it fades again, and disabled again, it leaves nothing behind. On 45
    and 48 it expects Pear Up to have said once that there is nothing to smooth.
    The preferences smoke test expects the switch from GNOME 49 and not before,
    and the API check looks for the brightness manager's internals where the
    shell has one.

- **A preview harness: pictures of a checkout on the desktop you are using.**
  `tests/run-preview.sh` (or `tests/preview/run.sh [checkout] [out-dir]`) boots
  a headless GNOME Shell in a throwaway podman container, installs the checkout
  into it, and saves PNGs at the real monitor's device resolution: the desktop
  with an app in front, the bar, the dock, the overview, the pear menu, the File
  and app-name menus, a notification, the dock under the pointer, and every page
  of the preferences, found rather than listed so a new page needs no change.
  The container is set up like the machine it runs on, read-only: the primary
  monitor's size and scale (or `--size` and `--scale`), the enabled extensions
  that are installed, dconf and the distribution's schema overrides, the icon and
  cursor themes with what they inherit, the wallpaper, `gtk.css`, the dock
  favourites and the battery. The live session is never touched and nothing is
  installed in it. Clicks go through mutter's RemoteDesktop, as `tests/vm/rd-click.py`
  does, and `tests/preview/compare.py` lays two runs side by side. It runs in
  about a minute and a half once its image is built, and stays out of CI like
  the integration suite, since it needs a privileged container and a desktop to
  copy from. It is not part of the extension zip. See `tests/preview/README.md`.

### Changed

- **Window Buttons on the Left is on the Windows page**, not General.

- **The preferences window opens at 820px wide, up from 680.** With eight pages
  the switcher along the bottom gives each an eighth of the width, and 680 cut
  "Custom Menus" to "Custom Me…" in Adwaita Sans 11. 780 is where that font
  fits; 820 leaves room for a size up. The content is clamped, so the extra
  width is margin.

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

- **No backdrop behind the focused app in the dock.** Dash to Dock puts a grey
  backdrop behind the icon of the app in front; the macOS Dock marks it with
  its dot alone. Pear Up removes it with its own stylesheet and changes none of
  Dash to Dock's settings; Highlight the Focused App, under Running Apps on the
  Dock page, brings it back. The integration suite marks a dock icon focused
  and reads the backdrop the theme resolves with the switch off and on.

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

### Fixed

- **Log Out is always there to click, and the power items stay current.** The
  pear menu greyed Log Out out on a machine with one account, and only in some
  sessions. It followed the shell's `canLogout`, which is not "may this user log
  out" but "does the shell offer an entry of its own", and the shell offers none
  there; `activateLogout()` throws when it is false. It was also read once, when
  the menu was built, so it depended on whether AccountsService had answered by
  then. macOS always offers Log Out, and so does the menu now: it asks
  gnome-session for the ordinary logout itself, with the shell's confirmation
  dialog, says so in a notification when there is nothing to ask, and greys the
  item only where an administrator has set the `disable-log-out` lockdown key.
  Sleep, Restart, Shut Down and Lock Screen are still greyed when the system
  says they cannot run, but are asked again each time the menu opens and follow
  the shell as its answers arrive: they come from gnome-session, polkit and
  logind after the menu is built, and polkit's change without notice, so a menu
  built too early stayed greyed for the whole session. The integration suite
  forces the shell's answer to no and rebuilds the menu, then expects Log Out
  active and, with a stand-in for gnome-session, to ask it for the ordinary
  logout; it expects a notification when nothing answers, and Sleep to follow
  the shell's answer when the menu opens and when it changes.

- **The menu bar stays while a dialog is in front.** With Pear Up's own
  preferences open the bar showed the pear and nothing else, no app name and no
  menus. Not an app the shell could not place: the Extensions app opens an
  extension's preferences as a modal dialog, and the bar was built only for
  windows of the normal type, so a dialog of any app emptied it. A dialog and a
  modal dialog are their app's window like any other, and the bar now speaks for
  them, with the app's name — Extensions, for these preferences — and the usual
  menus. The integration suite opens a modal window of its own and expects the
  menus; on GNOME 45 and 50 the shell classes it as a modal dialog, and the bar
  was empty without the change.

- **File → New … Window uses the app's own name.** With Files in front the
  item said "New Nautilus Window" while the bar said Files: it took its name from
  the File Manager / Desktop Name setting, whose default was Nautilus, the name
  of the app's code and not of the app. The setting is empty by default now,
  which means the name the system gives the application, so the item reads "New
  Files Window" and, for another file manager, what that one is called. A name
  typed into the row still wins, as typed; one saved before, even Nautilus, is
  kept. The row, now File Manager Name, says what empty does.

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

- **Cmd+Q quits the app.** It used to sit on GNOME's close binding, so it
  took one window and left the rest of the app running. GNOME has nothing
  that quits a whole app, so Pear Up now binds Cmd+Q itself and asks the app
  to quit the way the dock's Quit does: through the app's own quit action,
  or by closing every window. An earlier Cmd+Q binding moves over by itself
  at the next login. File → Quit goes the same way.

- **Close Window closes one window.** Quit had been wired to the same action,
  so File → Close Window and Window → Close took down every window of the
  focused app. Quit still quits; Close does not.

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

- **The clock stays in the corner when another extension moves it.** Just
  Perfection, at its defaults, moves the clock back to the centre of the bar
  whenever it is enabled: at login, at every unlock, and when it is installed
  in the middle of a session, which is where this was seen. Pear Up placed the
  clock once, and the shell's layout still said right, so nothing put it back
  until the next logout. The clock is watched now, and taken back to the end of
  the right-hand side, on the next idle tick, whenever something moves it to
  the centre or the left; a clock moved within the right-hand side, or into
  a panel of someone else's, is left where it was put, and so is the lock
  screen's, which has it in the centre. An extension that holds the clock
  where it wants it, moving it back each time it is moved, gets it after five
  returns in ten seconds, with a line in the journal, rather than the two of
  them taking turns for the rest of the session. The integration suite moves
  the clock to the centre and to the left the way Just Perfection does and
  expects it back on the right, then holds it in the centre and expects Pear
  Up to give up after a few rounds and stay active.

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

- **The preferences read cleanly at the default width.** Four things that
  showed in the 820px window at scale 2. The Dock page's Indicator dropdown was
  squeezed to "One Dot, Like m…" by its own 81-character subtitle, which shares
  the row with the value; the subtitle is shorter now, what it said about
  tray-only apps such as Steam is the group's description, and the two long
  subtitles of When to Show the Dock are shortened for the same reason. The
  Strong end of the Magnification slider ran to the edge of its row, because
  the labels of a slider's marks are centred on them and overhang its end; every
  slider has a small margin there now. "Before the Control Center Icons" left
  "left" alone on a second line, which a shorter subtitle fixes. And About said
  "Version 2", the integer GNOME compares; it shows the version-name, 0.2.0, and
  the integer only where there is none.

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

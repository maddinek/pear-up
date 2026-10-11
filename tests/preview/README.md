# Pear Up preview

Pictures of what a Pear Up checkout looks like on the desktop you are sitting at, taken without
going near the live session. A throwaway podman container boots systemd and starts its own
headless GNOME Shell on a virtual monitor the size of yours, copies the extensions, settings,
wallpaper, icons and GTK CSS of the machine it is run from into it, installs Pear Up from the
checkout, opens a few real apps and photographs the result at full device resolution.

It is not a test. Nothing is asserted; the point is to see the bar, the menus, the dock and the
preferences the way you would, without installing the branch into the session you are working in.
For what Pear Up does, see the suites in [the main README](../../README.md#testing).

```bash
tests/run-preview.sh                          # this checkout
tests/preview/run.sh [checkout] [out-dir]     # the same, or another checkout / a chosen output directory
tests/preview/run.sh --size 1920x1080 --scale 1
tests/preview/compare.py <out-dir-a> <out-dir-b>   # side-by-side sheets of two runs
```

Output goes to `~/.cache/pear-up-preview/out/<branch>-<timestamp>/` unless an out-dir is given, and
the script prints every PNG path at the end. `display.json` records the display facts (mode, scale,
logical size, layout mode), the font, the icon theme and the state of every extension; `logs/` has
the shell log, the driver output and the effective dconf.

## Prerequisites

- podman (rootless is fine; the container runs `--privileged` because logind needs it, exactly like
  [`tests/integration/run.sh`](../integration/run.sh))
- network for the first image build (Fedora 44 packages)
- on the machine you run it on: `dconf`, `gsettings`, `rsync`, `python3` with PyGObject (for the
  monitor and for `compare.py`; GNOME has it anyway), and `upower` if the machine has a battery

It must be run from a GNOME session on the desktop you want pictured: that is where the settings
come from. Over ssh, with no session to ask, the settings are still read but the monitor falls back
to 2880x1920 at scale 2 (give `--size` and `--scale` to say otherwise).

## How long

- first run: builds `localhost/pear-up-preview:gnome50`, a few minutes and about 1.5 GB. Its first
  layer is shared with Pear Up's own `pear-up-test:gnome50` image when that exists on the machine.
- every run after that: about 90 s (about 55 s without the preferences pages, with
  `PREVIEW_SHOTS="desktop overview pear_menu file_menu notification app_name_menu dock_hover"`)

## What it reads from this machine

Everything is read, nothing is written; see [Safety](#safety).

| what | how |
|---|---|
| monitor | the primary monitor's current mode, scale and layout mode, from mutter's `DisplayConfig.GetCurrentState` on your session bus (a read). `--size WxH` and `--scale N` override it; 2880x1920 at scale 2 is the fallback |
| settings | `dconf dump` of `/org/gnome/desktop/interface/`, `…/wm/preferences/`, `…/wm/keybindings/`, `…/input-sources/`, `/org/gnome/mutter/`, `/org/gnome/shell/` (which includes every extension's settings), `…/background/` and the media keys, with GSConnect, weather, world clocks, command histories and anything account-shaped dropped; plus your distribution's gschema overrides (they set the dark scheme, panel blur and so on, which your own dconf alone does not show) |
| extensions | the extensions in `org.gnome.shell enabled-extensions` that are installed here, from `~/.local/share/gnome-shell/extensions` or the system data directories, in your order, minus a short list that does not change the picture (caffeine, gsconnect, hotedge, restartto, bazaar-integration, user-theme). `PREVIEW_EXTENSIONS="uuid uuid"` loads exactly those instead. Pear Up itself is always the checkout's, whether or not it is installed or enabled here |
| icon and cursor themes | the current `icon-theme` and `cursor-theme`, what they inherit, and every theme in `~/.local/share/icons` and `~/.icons` (themes link into each other, and the preferences list what is installed), mounted read-only. System themes the image does not have are linked in from a read-only mount; `hicolor` is the image's own, plus yours from `~/.local/share/icons` |
| wallpaper | the files `picture-uri` and `picture-uri-dark` point at (a dynamic `.xml` wallpaper is not followed) |
| GTK CSS | `~/.config/gtk-3.0/gtk.css` and `gtk-4.0/gtk.css` (the small window buttons, say) |
| dock | the favourites' names and icons, as launchers that start nothing |
| battery | the current charge from UPower, shown through a mock UPower. A machine with no battery gets none |
| blur | gnome-rounded-blur's typelib and library, mounted read-only where the machine has them; Blur my Shell uses them to round its blur |

## What it does, step by step

1. Copies the checkout to `~/.cache/pear-up-preview/work/…` (rsync, without `.git`, `node_modules`
   and `dist`), so nothing another agent is editing is touched or locked. Only `git rev-parse` is
   run against the checkout.
2. Reads the machine, as above, into that work directory.
3. Boots the container. Nothing is relabelled (`label=disable` instead of `:Z`).
4. Inside: compiles the overrides, installs the extensions, runs the checkout's own `install.sh`
   (which compiles its schemas), adds a small preview hook extension, loads the dconf dumps, and
   starts `gnome-shell --headless --no-x11 --virtual-monitor <size>` as a normal user named like
   yours (Nautilus refuses root), with a `monitors.xml` that gives that monitor the scale and layout
   mode it has on the real machine.
5. Opens Files (in front), Text Editor, Calculator and Pear Up's test window, plus a
   StatusNotifierItem tray icon, laid out on the stage in proportion, then runs
   `container/driver.py`.

## The shots

| file | what |
|---|---|
| `01-desktop.png` (+ `-topbar`, `-topbar-left`, `-topbar-right`, `-dock`, `-window-titlebar`) | Files in front: its menus in the bar, window buttons, the dock |
| `02-overview.png` (+ `-desktops-strip`, `-topbar`) | the overview, via `OverviewActive` on the container's bus |
| `03-pear-menu.png` (+ `-menu`) | the pear menu, opened by a real click |
| `04-file-menu.png` (+ `-menu`) | Files' File menu, opened by a real click |
| `05-notification.png` (+ `-banner`) | a notification banner where the notification settings put it |
| `05b-app-name-menu.png` (+ `-menu`) | the bold app-name menu |
| `06-dock-hover.png` (+ `-dock`) | the pointer resting on the dock (magnification) |
| `10-prefs-<page>.png` (+ `-window`), `10-prefs-<page>-2-window.png`, `-3-window`, … | Pear Up's preferences window at its own default size, one page after another (General, Menus, Custom Menus, Dock, Appearance and Windows where the branch has them, Keyboard, About); a long page is scrolled a screenful at a time and each further screenful is saved as a window crop |

Clicks go through mutter's RemoteDesktop API inside the container's session, as Pear Up's
[`tests/vm/rd-click.py`](../vm/rd-click.py) does: GNOME 50's panel buttons answer through
`Clutter.ClickGesture`, which ignores synthetic Clutter events. Pictures are painted straight from
the stage (`Shell.Screenshot.screenshot_stage_to_content`) by the hook, because a headless shell may
never present the frame the D-Bus screenshot waits for.

The preferences window is a separate GTK process, opened through
`org.gnome.Shell.Extensions.OpenExtensionPrefs` in the container's session (what `gnome-extensions
prefs` does) and driven over the accessibility bus (AT-SPI): each page tab in the view switcher has
a "click" action and each page's scroll bar takes a value, so no coordinates are guessed. Pages are
found, not listed, so a branch with a new page gets pictures of it without a change here.

To add a shot, add a function with `@shot` to `container/driver.py`; `js()` / `jsfn()` run
JavaScript in the shell (the hook switches on unsafe mode and puts `Main`, `St`, `Shell`, … on
`globalThis.pv`), `pointer().click(x, y)` clicks at logical coordinates, `capture(name, {crop: [x,
y, w, h]})` saves the picture and crops (logical coordinates, saved at the monitor's scale).

## Options

| | |
|---|---|
| `--size WxH`, `--scale N` | the virtual monitor, instead of this machine's primary one |
| `PREVIEW_SHOTS="desktop file_menu"` | only these shots, by their function names in `driver.py` |
| `PREVIEW_FRONT_APP=org.gnome.TextEditor.desktop` | the app in front |
| `PREVIEW_TRAY_ICON=<icon name>` | the fake tray item; by default `steam` if the icon theme has art for it, else `applications-system` |
| `PREVIEW_EXTENSIONS="uuid uuid"` | the extensions to load, instead of this machine's enabled ones |
| `PREVIEW_KEEP=1` | keep the stopped container |
| `PREVIEW_HOLD=1` | leave the session running after the shots and print how to get into it |
| `PEAR_UP_PREVIEW_CACHE=<dir>` | where the work files, the build log and the default outputs go |

## What is like the real desktop

- The shell: the same layout, settings and enabled extensions, with the same versions of the
  extensions it copies (including hand edits to their files), at the same size and scale, so
  pictures come out at the monitor's device resolution.
- The look: your dconf, your distribution's defaults, your icon and cursor themes, wallpaper and
  `gtk.css`, your timezone, Adwaita Sans.
- The dock: your favourites, by name and icon.
- The battery: its charge at the time of the run.

## What is not

- **The GNOME version.** The container is Fedora 44's GNOME Shell 50 whatever the host runs. The
  script prints both. Pear Up targets 45 to 50, and this shows none of the others; the integration
  suite's one screenshot (`tests/integration/run.sh 48`) is the nearest there is.
- **Apps.** No Brave, Steam, Cursor etc.: the dock favourites are stand-ins with the right name and
  icon that launch nothing. The running apps are Files, Text Editor, Calculator and Pear Up's test
  window (plain GTK4, so light, not libadwaita-dark).
- **Tray.** One fake StatusNotifierItem, not yours.
- **Sensors.** Vitals reads what the container sees: the sensors of the machine pass through, but
  the values are of that moment.
- **Extensions.** Those left out above, and any that is not installed here. A custom shell theme
  (User Themes) is not shown.
- **Fonts.** The image has Adwaita Sans and Mono; any other font the desktop uses falls back to
  whatever fontconfig picks. Fonts in `~/.local/share/fonts` are not copied.
- **Display.** A virtual monitor (`Meta-0`, 60 Hz) instead of the real one, with its refresh rate
  and variable refresh; software rendering (llvmpipe). Stills only: no animations, no cursor in
  the pictures. A fractional scale needs mutter's `scale-monitor-framebuffer` experimental feature,
  which comes with the dconf if it is set.
- **Session.** No GDM and no real logind seat, so the pear menu's Sleep, Restart and Shut Down are
  greyed out. Log Out comes out active in some runs and greyed in others: GNOME says no to it for a
  single local user with `always-show-log-out` off, and Pear Up reads that once when it builds the
  menu, so it depends on whether AccountsService had answered by then. That is Pear Up's behaviour,
  not the harness's. The shell's "Screen Lock disabled" notification is cleared before the shots.
- **Harness artefacts, hidden on purpose**: unsafe mode's crossed-out padlock and the screen-sharing
  icon the RemoteDesktop pointer causes.
- Container locale is `C.UTF-8`; the bar looks the same.
- Preferences: the icon and cursor theme lists offer the themes in the container's
  `/usr/share/icons` plus this machine's own; the selected ones are this machine's.

## Safety

Nothing runs against the live session: no `gnome-extensions`, no `org.gnome.Shell` calls on the host
bus, no gsettings or dconf writes on the host, nothing written to `~/.local/share/gnome-shell` or
`~/.local/share/icons`. What is called on the host is `dconf dump`, `gsettings get`, `upower -i`,
`gnome-shell --version` and one read of mutter's display configuration. Host files are copied or
mounted read-only, and the checkout is copied first. The copy of your settings lives under
`~/.cache/pear-up-preview/work` for the length of a run and is deleted when it ends.

The container is privileged, which is what logind needs, so it is built from Fedora packages here
and used once, as in the integration suite. It is given no display, session or bus of the host, but
being privileged it can see the host's devices.

## Not in CI

Like the integration suite, it needs a privileged container, and in addition a desktop to copy from;
a runner has neither the desktop nor a reason to want pictures of it. Its JavaScript is linted with
the rest (`tests/run-lint.sh`, and CI's eslint job); its shell scripts are kept shellcheck-clean by
hand.

## Clean up

    podman image rm localhost/pear-up-preview:gnome50
    rm -rf ~/.cache/pear-up-preview

(a container left by `PREVIEW_KEEP`/`PREVIEW_HOLD`: `podman rm -f pear-up-preview-<pid>`)

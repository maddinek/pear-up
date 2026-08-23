# contrib

Fixes for other people's code that Pear Up sits next to. Nothing here is part of
the extension, and nothing here is needed to run it.

## search-light-gnome50.patch

[Search Light](https://github.com/icedman/search-light) crashes GNOME Shell 50
hard enough to end the session. On Wayland the shell *is* the session, so an
abort drops you at the login screen, and two in quick succession trip GNOME's
crash protection, which switches off every extension you have until you turn
them back on by hand.

The cause is one mistake made in several places: Clutter 18 refuses to let the
actor tree change while an input, gesture or signal is still being dispatched,
and Search Light reparents its search entry and moves key focus directly from
its click gesture, its keyboard accelerators, and its focus, Escape and
fullscreen handlers. Deferring that work by a single idle tick — after the
dispatch unwinds — fixes all of it.

Upstream knows: [#166](https://github.com/icedman/search-light/issues/166) has
the full account, with [#164](https://github.com/icedman/search-light/pull/164)
and [#165](https://github.com/icedman/search-light/pull/165) covering the click
and teardown paths. Both were still unmerged when this patch was written, on a
tree whose last commit was months earlier — hence keeping it here.

The patch carries those two PRs plus the sites they leave behind: both
accelerators, the focus-loss and Escape hides, `_hidePopups`, and
`_onFullScreen`.

### Applying it

Patch a copy in your home directory rather than the system one. GNOME loads
per-user extensions in preference to `/usr/share`, so this shadows the
installed version without touching a read-only OS image, and an OS update cannot
quietly revert it:

```bash
UUID=search-light@icedman.github.com
cp -r "/usr/share/gnome-shell/extensions/$UUID" ~/.local/share/gnome-shell/extensions/
cd ~/.local/share/gnome-shell/extensions/$UUID
git apply -p1 /path/to/contrib/search-light-gnome50.patch
```

`git apply` rather than `patch`, because image-based systems like Bluefin ship
git but not patch. Add `--check` to try it without writing anything.

Log out and back in — extension JavaScript is cached for the life of the
session, so nothing changes until the shell restarts. Then confirm the patched
copy is the one in use:

```bash
gnome-extensions info search-light@icedman.github.com | grep Path
```

### Removing it

Delete the per-user copy once upstream ships these fixes, or the shadow will
hold you on the old version for good:

```bash
rm -rf ~/.local/share/gnome-shell/extensions/search-light@icedman.github.com
```

### Not needed if

Pear Up's own search button covers the same ground without any of this. Point it
at GNOME's search and no third-party code runs on the path at all.

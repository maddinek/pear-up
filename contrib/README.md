# contrib

Fixes for other people's code that Pear Up sits next to. Nothing here is part of
the extension, and nothing here is needed to run it.

Neither patch is a dependency. Nothing in Pear Up needs Search Light: its search
button defaults to GNOME's own search, which no third party can break. These
exist so that *if* you run Search Light, it does not end your session.

## Two patches, for two different trees

| File | Applies to | For |
|---|---|---|
| `search-light-gnome50.patch` | the released **v101**, as distributions ship it | fixing the copy on your machine |
| `search-light-gnome50-upstream.patch` | upstream **main** | sending the fix upstream |

The first is the practical one. The second is the same idea rebased onto
upstream's tree and shaped as a commit, so it can go to the project without
anyone having to reconstruct it — deliberately a file here rather than a fork
kept alive somewhere, because a patch costs nothing to carry and a fork has to
be maintained.

Apply it with `git am` in a checkout of upstream, which keeps the commit message
and its reasoning:

```bash
git clone https://github.com/icedman/search-light.git
cd search-light
git am /path/to/contrib/search-light-gnome50-upstream.patch
```

It covers every site listed in
[#166](https://github.com/icedman/search-light/issues/166) and supersedes
[#164](https://github.com/icedman/search-light/pull/164) and
[#165](https://github.com/icedman/search-light/pull/165). Tested on GNOME Shell
50.3 (Wayland, Fedora 44): the panel icon, Super+Space, Escape, focus loss and a
fullscreen window all leave the shell running, where each of them ended the
session before.

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

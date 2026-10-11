"""Dock magnification, checked against a real Dash to Dock in a live shell.

The magnifier draws over someone else's actors, so the failures worth catching
are visual and stateful: an icon left transparent after the pointer has gone, an
overlay that survives Pear Up being switched off, a swell that grows towards the
screen edge or squeezes its neighbours together. Each is checked here from
outside, through the test hook, by comparing what the overlay draws against
where Dash to Dock's own icons are.

The pointer is a virtual one created inside the shell, so hover reaches the dock
through the same input path a mouse takes.
"""
import json
import os
import subprocess

from gi.repository import GLib

DOCK_UUID = "dash-to-dock@micxgx.gmail.com"
DOCK_SCHEMA = "org.gnome.shell.extensions.dash-to-dock"
OVERLAY = "pearup-dock-magnifier"

# St.Side, as Dash to Dock stores its position.
TOP, RIGHT, BOTTOM, LEFT = range(4)
SIDE_NAMES = {TOP: "top", RIGHT: "right", BOTTOM: "bottom", LEFT: "left"}

# Long enough for the 150 ms ease-in, the deferred start and a texture load.
SETTLE = 700 * 1000


def _box_center(box):
    x, y, width, height = box
    return x + width / 2, y + height / 2


class DockChecks:
    def __init__(self, call, check, uuid, artifacts):
        self._call = call
        self._check = check
        self._uuid = uuid
        self._artifacts = artifacts
        self.ready = False
        self._baseline = {}
        self._last_seen = "nothing read"

    # ---------------------------------------------------------------- plumbing
    def _hook(self, method, args=None, signature="()"):
        return self._call("org.gnome.Shell", "/io/github/maddinek/PearUpTestHook",
                          "io.github.maddinek.PearUpTestHook", method,
                          args, signature).unpack()[0]

    def state(self):
        return json.loads(self._hook("GetDockState"))

    def move(self, x, y):
        self._hook("MovePointer", (float(x), float(y)), "(dd)")

    def _extension_info(self, uuid):
        return self._call("org.gnome.Shell", "/org/gnome/Shell",
                          "org.gnome.Shell.Extensions", "GetExtensionInfo",
                          (uuid,), "(s)").unpack()[0]

    @staticmethod
    def _gsettings(schema, key, value, env=None):
        result = subprocess.run(["gsettings", "set", schema, key, value],
                                env=env, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            print(f"  note: could not set {key}={value}: {result.stderr.strip()}")
        return result.returncode == 0

    def _pear_up_setting(self, key, value):
        schemas = (f"{os.environ.get('HOME', '/root')}/.local/share/gnome-shell"
                   f"/extensions/{self._uuid}/schemas")
        return self._gsettings("org.gnome.shell.extensions.pear-up", key, value,
                               {**os.environ, "GSETTINGS_SCHEMA_DIR": schemas})

    def _dock_setting(self, key, value):
        return self._gsettings(DOCK_SCHEMA, key, value)

    def _capture(self, name):
        if os.environ.get("PEAR_UP_SCREENSHOT", "1") == "0":
            return
        path = f"{self._artifacts}/{name}"
        try:
            saved = self._hook("SaveStage", (path,), "(s)")
        except GLib.Error as exc:
            print(f"  note: no {name}: {exc.message.splitlines()[0]}")
            return
        size = os.path.getsize(path) if saved and os.path.exists(path) else 0
        print(f"  note: {name} {size // 1024} KiB" if size else f"  note: no {name}")

    def _dock(self, state):
        return state["docks"][0] if state["docks"] else None

    def _wait_for_dock(self, side, timeout=20):
        self._last_seen = "nothing read"
        for _ in range(timeout * 4):
            GLib.usleep(250 * 1000)
            try:
                state = self.state()
            except GLib.Error as exc:
                self._last_seen = exc.message.splitlines()[0]
                continue
            dock = self._dock(state)
            self._last_seen = (
                f"docks={[(d['position'], [i['id'] or i['kind'] for i in d['items']]) for d in state['docks']]}"
                f" uiGroup={state.get('uiGroup')}")
            if (dock and dock["position"] == side and
                    len([i for i in dock["items"] if i["kind"] == "icon"]) >= 4):
                # One more beat for the icons to finish sliding into place.
                GLib.usleep(800 * 1000)
                return self._dock(self.state())
        return None

    def _away(self):
        # The middle of the screen, nowhere near any edge.
        self.move(640, 360)
        GLib.usleep(SETTLE)

    def _hover_target(self, dock):
        """The icon in the middle of the dock, and where to put the pointer.

        The pointer goes on the centre of its slot, so the icon under it should
        reach exactly the configured size."""
        apps = [item for item in dock["items"]
                if item["kind"] == "icon" and item["id"] != "show-apps"]
        vertical = dock["position"] in (LEFT, RIGHT)
        apps.sort(key=lambda item: _box_center(item["slot"])[1 if vertical else 0])
        target = apps[len(apps) // 2]
        return target, _box_center(target["slot"])

    def _hover(self):
        dock = self._dock(self.state())
        target, (x, y) = self._hover_target(dock)
        self.move(x, y)
        GLib.usleep(SETTLE)
        return target, (x, y)

    def _record_baseline(self, dock):
        self._baseline = {self._key(item): (item["opacity"], item["siblingOpacities"])
                          for item in dock["items"]}
        self._baseline["background"] = dock["backgroundOpacity"]

    @staticmethod
    def _key(item):
        return item["id"] or f"{item['kind']}@{round(item['slot'][0])},{round(item['slot'][1])}"

    # ------------------------------------------------------------------ checks
    def _check_magnified(self, state, pointer, max_scale, where):
        check = self._check
        dock = self._dock(state)
        if not check(f"[{where}] the dock is still there", dock):
            return

        overlays = state["overlays"]
        if not check(f"[{where}] one magnifier overlay is drawn while hovered",
                     len(overlays) == 1, f"found {len(overlays)}"):
            return
        check(f"[{where}] the overlay sits directly above the dock",
              dock["nextSibling"] == OVERLAY, f"next sibling {dock['nextSibling']}")
        # The overlay takes no input: the pointer is still on Dash to Dock's own
        # actors, which is what keeps clicks, drags and menus working.
        check(f"[{where}] the dock itself still has the pointer under the overlay",
              dock["hover"] is True, f"hover={dock['hover']}")

        vertical = dock["position"] in (LEFT, RIGHT)
        axis = 1 if vertical else 0
        icons = sorted((item for item in dock["items"] if item["kind"] == "icon"),
                       key=lambda item: _box_center(item["icon"])[axis])
        copies = sorted((child for child in overlays[0]["children"]
                         if child["type"] == "icon" and child["visible"] and child["opacity"] > 0),
                        key=lambda child: _box_center(child["box"])[axis])
        clones = [child for child in overlays[0]["children"] if child["type"] == "clone"]

        if not check(f"[{where}] every dock icon has a magnified copy",
                     len(copies) == len(icons) and icons,
                     f"{len(copies)} copies for {len(icons)} icons"):
            return
        check(f"[{where}] indicators beside the icons are cloned along with them",
              len(clones) >= len(icons) - 1, f"{len(clones)} clones")

        hidden = [self._key(item) for item in icons if item["opacity"] != 0]
        check(f"[{where}] the real icons are transparent under the overlay",
              not hidden, f"still drawn: {hidden}")

        # Every stand-in is drawn at the opacity of what it replaces — none is
        # left invisible because its source had already been made transparent.
        unseen = [child for child in overlays[0]["children"]
                  if child["visible"] and child["opacity"] == 0 and child["type"] == "clone"
                  and child["clip"]]
        check(f"[{where}] the stretched background is drawn, not left transparent",
              not unseen, f"{len(unseen)} pieces at opacity 0")

        p = pointer[axis]
        rows = []
        for item, copy in zip(icons, copies):
            ix, iy, iw, ih = item["icon"]
            cx, cy, cw, ch = copy["box"]
            rows.append({
                "id": self._key(item),
                "slot": item["slot"][3 if vertical else 2],
                "distance": abs(_box_center(item["icon"])[axis] - p),
                "side": _box_center(item["icon"])[axis] - p,
                "scale": (cw / iw + ch / ih) / 2,
                "shift": _box_center(copy["box"])[axis] - _box_center(item["icon"])[axis],
                "icon": item["icon"],
                "copy": copy["box"],
                "label": item["label"],
            })
        with open(f"{self._artifacts}/dock-magnified-{where}.json", "w") as handle:
            json.dump({"pointer": pointer, "maxScale": max_scale, "rows": rows,
                       "overlay": overlays[0]["children"]}, handle, indent=2)

        nearest = min(rows, key=lambda row: row["distance"])
        scales = {row["id"]: round(row["scale"], 3) for row in rows}
        check(f"[{where}] the icon under the pointer reaches the set size",
              abs(nearest["scale"] - max_scale) <= 0.03,
              f"{nearest['id']} at {nearest['scale']:.3f}, set {max_scale}")
        check(f"[{where}] no icon is larger than the one under the pointer",
              all(row["scale"] <= nearest["scale"] + 0.001 for row in rows), f"{scales}")

        by_distance = sorted(rows, key=lambda row: row["distance"])
        check(f"[{where}] icons shrink with distance from the pointer",
              all(a["scale"] >= b["scale"] - 0.01 for a, b in zip(by_distance, by_distance[1:])),
              f"{scales}")
        check(f"[{where}] neighbours grow less than the icon under the pointer",
              any(1.01 < row["scale"] < nearest["scale"] - 0.01 for row in rows),
              f"{scales}")
        # The swell reaches three slots either side; beyond that, normal size.
        far = [row for row in rows if row["distance"] > 3.05 * nearest["slot"]]
        check(f"[{where}] icons beyond the swell keep their size",
              all(abs(row["scale"] - 1) <= 0.01 for row in far),
              f"{ {row['id']: round(row['scale'], 3) for row in far} }")

        # Pushed apart: everything moves away from the pointer, nothing towards
        # it, and the icon under the pointer stays where it is.
        shifts = {row["id"]: round(row["shift"], 1) for row in rows}
        others = [row for row in rows if row is not nearest]
        check(f"[{where}] the icon under the pointer stays put",
              abs(nearest["shift"]) <= 2, f"moved {nearest['shift']:.1f}px")
        check(f"[{where}] neighbours are pushed outward, never inward",
              all(row["shift"] * row["side"] >= -0.5 for row in others) and
              all(abs(row["shift"]) >= 1 for row in others),
              f"shifts {shifts}")

        # Across the dock the side facing the screen edge stays where it was.
        def edge_gap(row):
            ix, iy, iw, ih = row["icon"]
            cx, cy, cw, ch = row["copy"]
            return {
                RIGHT: (ix + iw) - (cx + cw), LEFT: ix - cx,
                BOTTOM: (iy + ih) - (cy + ch), TOP: iy - cy,
            }[dock["position"]]

        gaps = {row["id"]: round(edge_gap(row), 2) for row in rows}
        check(f"[{where}] icons grow away from the {SIDE_NAMES[dock['position']]} edge",
              all(abs(gap) <= 1.0 for gap in gaps.values()), f"edge gaps {gaps}")

        # The shelf: Dash to Dock's background, drawn in clipped pieces that
        # stretch with the swell. Each piece's clip reaches this far past the
        # background on purpose, to keep a shadow (see dockMagnifier.js).
        margin = 64
        pieces = [child for child in overlays[0]["children"]
                  if child["type"] == "clone" and child["clip"]]
        if dock["background"] and pieces:
            spans = []
            for piece in pieces:
                start = piece["box"][axis]
                scale = piece["scale"][axis]
                clip_from, clip_length = piece["clip"][axis], piece["clip"][axis + 2]
                spans.append((start + clip_from * scale, start + (clip_from + clip_length) * scale))
            shelf = (min(a for a, _ in spans) + margin, max(b for _, b in spans) - margin)
            rest = (dock["background"][axis], dock["background"][axis] + dock["background"][axis + 2])
            first_copy = min(copy["box"][axis] for copy in copies)
            last_copy = max(copy["box"][axis] + copy["box"][axis + 2] for copy in copies)
            check(f"[{where}] the dock's background stretches to take in the magnified icons",
                  len(pieces) == 3 and shelf[0] <= first_copy + 1 and shelf[1] >= last_copy - 1
                  and shelf[1] - shelf[0] > rest[1] - rest[0],
                  f"shelf {[round(v) for v in shelf]} (was {[round(v) for v in rest]}), "
                  f"icons span {round(first_copy)}..{round(last_copy)}, {len(pieces)} pieces")
        else:
            check(f"[{where}] the dock's background stretches to take in the magnified icons",
                  False, f"background={dock['background']} pieces={len(pieces)}")

        label = nearest["label"]
        if label and label["visible"]:
            across = 0 if vertical else 1
            expected = (nearest["icon"][2 if vertical else 3]) * (nearest["scale"] - 1)
            moved = abs(label["translation"][across])
            check(f"[{where}] the hover label is moved out past the magnified icon",
                  abs(moved - expected) <= 2, f"moved {moved:.1f}px, icon grew {expected:.1f}px")
        else:
            print(f"  note: [{where}] no hover label showing to check")

    def check_left_nothing(self, what):
        """No overlay, and every icon and indicator at its old opacity."""
        check = self._check
        try:
            state = self.state()
        except GLib.Error as exc:
            check(f"dock readable after {what}", False, exc.message.splitlines()[0])
            return
        check(f"no magnifier overlay left after {what}", not state["overlays"],
              f"{len(state['overlays'])} left")

        dock = self._dock(state)
        if not dock:
            check(f"the dock survived {what}", False)
            return

        changed = []
        for item in dock["items"]:
            before = self._baseline.get(self._key(item))
            now = (item["opacity"], item["siblingOpacities"])
            if before is not None and tuple(before) != now:
                changed.append(f"{self._key(item)}: {before} -> {now}")
        check(f"every dock icon has its opacity back after {what}", not changed,
              "; ".join(changed))
        check(f"the dock's background has its opacity back after {what}",
              dock["backgroundOpacity"] == self._baseline.get("background"),
              f"{self._baseline.get('background')} -> {dock['backgroundOpacity']}")

        moved = [self._key(item) for item in dock["items"]
                 if item["label"] and item["label"]["translation"] != [0, 0]]
        check(f"no hover label left pushed aside after {what}", not moved, f"{moved}")

    def _check_focus_highlight(self):
        """Dash to Dock's grey backdrop behind the focused app: gone by default,
        as on macOS, and back when the setting asks for it.

        The container's applications launch nothing, so no dock icon is ever
        the focused app's; the hook marks one through Dash to Dock's own
        `focused` property, which is what adds the style class its backdrop
        hangs off. What is read back is the backdrop the theme resolved."""
        check = self._check
        dock = self._dock(self.state())
        apps = [item["id"] for item in dock["items"]
                if item["kind"] == "icon" and item["id"] not in (None, "show-apps")]
        if not apps or not self._hook("SetDockIconFocused", (apps[0], True), "(sb)"):
            check("a dock icon could be marked as the focused app's", False, f"apps={apps}")
            return
        app_id = apps[0]

        def backdrop():
            item = next((item for item in self._dock(self.state())["items"]
                         if item["id"] == app_id), None)
            return (item["focused"], item["backdropAlpha"]) if item else (None, None)

        try:
            focused, plain = backdrop()
            self._pear_up_setting("dock-focus-highlight", "true")
            GLib.usleep(SETTLE)
            _, highlighted = backdrop()
            self._pear_up_setting("dock-focus-highlight", "false")
            GLib.usleep(SETTLE)
            _, plain_again = backdrop()
        finally:
            self._hook("SetDockIconFocused", (app_id, False), "(sb)")

        check("the focused app's dock icon has no backdrop, as on macOS",
              focused is True and plain == 0, f"focused={focused} alpha={plain}")
        check("Dash to Dock's backdrop comes back when the setting asks for it",
              (highlighted or 0) > 0, f"alpha={highlighted}")
        check("and goes again when it is switched back off", plain_again == 0,
              f"alpha={plain_again}")

    # -------------------------------------------------------------- the run
    def run(self):
        check = self._check

        # Martin's own dock: the right edge, always shown, one dot per app.
        for key, value in [("dock-position", "'RIGHT'"), ("dock-fixed", "true"),
                           ("dash-max-icon-size", "32"), ("show-trash", "false"),
                           ("show-mounts", "false"), ("apply-custom-theme", "false"),
                           ("show-show-apps-button", "true")]:
            self._dock_setting(key, value)
        if not self._dock_setting("running-indicator-style", "'DOT'"):
            print("  note: this Dash to Dock has no DOT indicator; using its default")

        try:
            self._call("org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions",
                       "EnableExtension", (DOCK_UUID,), "(s)")
        except GLib.Error as exc:
            check("Dash to Dock could be enabled", False, exc.message.splitlines()[0])
            return

        dock = self._wait_for_dock(RIGHT)
        info = self._extension_info(DOCK_UUID)
        if not check("Dash to Dock is running with its dock on the right",
                     dock is not None,
                     f"version {info.get('version')}" if dock else
                     f"state={info.get('state')} error={info.get('error')} saw {self._last_seen}"):
            return

        self._away()
        state = self.state()
        check("nothing is magnified while the pointer is elsewhere", not state["overlays"])
        self._record_baseline(self._dock(state))
        self.ready = True

        # ---- the backdrop behind the focused app, with the pointer elsewhere
        self._check_focus_highlight()

        # ---- hovered, right edge
        target, pointer = self._hover()
        state = self.state()
        self._check_magnified(state, pointer, 1.75, "right")

        self._capture("dock-magnified-right.png")

        # ---- the size setting applies while hovered
        self._pear_up_setting("dock-magnification-size", "250")
        GLib.usleep(SETTLE)
        self._check_magnified(self.state(), pointer, 2.5, "right-250")
        self._pear_up_setting("dock-magnification-size", "175")
        GLib.usleep(SETTLE)

        # ---- a menu opens on the dock: the swell steps aside, and comes back
        menu_app = target["id"]
        if self._hook("OpenDockMenu", (menu_app,), "(s)"):
            GLib.usleep(SETTLE)
            self.check_left_nothing("a dock icon's menu opens")
            self._hook("CloseDockMenu", (menu_app,), "(s)")
            self.move(*pointer)
            GLib.usleep(SETTLE)
            state = self.state()
            check("the swell returns once the menu closes", len(state["overlays"]) == 1,
                  f"{len(state['overlays'])} overlays, hover={self._dock(state)['hover']}")
        else:
            check("a dock icon's menu could be opened", False, menu_app)

        # ---- a drag starts: no swell moving under the drop target
        self._hook("SignalItemDrag", (True,), "(b)")
        GLib.usleep(SETTLE)
        self.check_left_nothing("an icon drag starts")
        self._hook("SignalItemDrag", (False,), "(b)")
        GLib.usleep(SETTLE)
        state = self.state()
        check("the swell returns once the drag ends", len(state["overlays"]) == 1,
              f"{len(state['overlays'])} overlays")

        # ---- leaving
        self._away()
        self.check_left_nothing("the pointer leaves the dock")

        # ---- switched off while hovered
        self._hover()
        self._pear_up_setting("dock-magnification", "false")
        GLib.usleep(SETTLE)
        self.check_left_nothing("magnification is switched off mid-hover")
        self._pear_up_setting("dock-magnification", "true")
        GLib.usleep(SETTLE)
        state = self.state()
        check("switching magnification back on magnifies the hovered dock",
              len(state["overlays"]) == 1, f"{len(state['overlays'])} overlays")

        # ---- bottom edge: Dash to Dock rebuilds its dock, which must be found
        self._away()
        self._dock_setting("dock-position", "'BOTTOM'")
        dock = self._wait_for_dock(BOTTOM)
        if not check("Dash to Dock rebuilt its dock at the bottom", dock is not None,
                     "" if dock else f"saw {self._last_seen}"):
            return
        self._away()
        self._record_baseline(self._dock(self.state()))

        target, pointer = self._hover()
        self._check_magnified(self.state(), pointer, 1.75, "bottom")
        self._capture("dock-magnified-bottom.png")
        self._away()
        self.check_left_nothing("the pointer leaves the bottom dock")

    def hover_before_disable(self):
        """Leave the dock magnified, so disabling Pear Up has something to undo."""
        if not self.ready:
            return False
        self._hover()
        state = self.state()
        return self._check("the dock is magnified as Pear Up is disabled",
                           len(state["overlays"]) == 1, f"{len(state['overlays'])} overlays")

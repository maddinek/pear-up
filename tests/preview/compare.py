#!/usr/bin/env python3
"""Put two preview runs next to each other, picture by picture.

    ./compare.py <out-dir-a> <out-dir-b> [result-dir]

For every PNG the two runs share, writes one image with A on top and B below
(crops) or A left and B right (full screens), separated by a white gap. Runs on
the host; needs only PyGObject with GdkPixbuf, which GNOME has anyway.
"""
import os
import sys

import gi

gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf

GAP = 24


def side_by_side(a, b, vertical, right=False):
    if vertical:
        width = max(a.get_width(), b.get_width())
        height = a.get_height() + GAP + b.get_height()
    else:
        width = a.get_width() + GAP + b.get_width()
        height = max(a.get_height(), b.get_height())
    sheet = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, width, height)
    sheet.fill(0xFFFFFFFF)
    # Crops of the bar's right end are lined up on their right edges, so a
    # change in width shows as a shift on the left.
    ax = width - a.get_width() if vertical and right else 0
    bx = width - b.get_width() if vertical and right else 0
    a.copy_area(0, 0, a.get_width(), a.get_height(), sheet, ax, 0)
    if vertical:
        b.copy_area(0, 0, b.get_width(), b.get_height(), sheet, bx, a.get_height() + GAP)
    else:
        b.copy_area(0, 0, b.get_width(), b.get_height(), sheet, a.get_width() + GAP, 0)
    return sheet


def main():
    if len(sys.argv) < 3:
        print(__doc__.strip())
        return 2
    a_dir, b_dir = (os.path.abspath(p) for p in sys.argv[1:3])
    out = sys.argv[3] if len(sys.argv) > 3 else (
        f"{a_dir}--vs--{os.path.basename(b_dir)}")
    os.makedirs(out, exist_ok=True)
    shared = sorted(set(n for n in os.listdir(a_dir) if n.endswith(".png"))
                    & set(n for n in os.listdir(b_dir) if n.endswith(".png")))
    for name in shared:
        a = GdkPixbuf.Pixbuf.new_from_file(os.path.join(a_dir, name)).add_alpha(False, 0, 0, 0)
        b = GdkPixbuf.Pixbuf.new_from_file(os.path.join(b_dir, name)).add_alpha(False, 0, 0, 0)
        # Wide crops (the bar) stack; everything else goes side by side.
        vertical = a.get_width() > 2 * a.get_height()
        side_by_side(a, b, vertical, "right" in name).savev(os.path.join(out, name), "png", [], [])
        print(os.path.join(out, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())

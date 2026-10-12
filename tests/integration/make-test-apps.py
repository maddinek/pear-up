#!/usr/bin/env python3
"""Give the test session a few applications for Dash to Dock to show.

The container deliberately has no real applications (see the Containerfile), so
a dock would hold nothing but Show Apps — too little to see icons fall off with
distance from the pointer. These are desktop entries that launch nothing, each
with a plain coloured icon so the screenshot shows which is which.

The icons are PNGs written by hand rather than SVGs: PNG decoding is built into
gdk-pixbuf on every release here, where newer Fedoras hand other formats to
sandboxed loaders that a container may not be able to start.

Prints the desktop file ids as a GVariant list, ready for favorite-apps.
"""
import math
import os
import struct
import sys
import zlib

COLOURS = [
    (0xE6, 0x4A, 0x3C),
    (0xF3, 0x9C, 0x12),
    (0x2E, 0xCC, 0x71),
    (0x1A, 0xBC, 0x9C),
    (0x34, 0x98, 0xDB),
    (0x9B, 0x59, 0xB6),
]
SIZE = 128


def png(width, height, pixel):
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def rounded_square(colour):
    radius = SIZE * 0.22
    inset = SIZE * 0.06

    def pixel(x, y):
        # Distance outside a rounded rectangle, antialiased over one pixel.
        cx = min(max(x + 0.5, inset + radius), SIZE - inset - radius)
        cy = min(max(y + 0.5, inset + radius), SIZE - inset - radius)
        outside = math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius
        alpha = max(0.0, min(1.0, 0.5 - outside))
        # A lighter disc in the middle, so a magnified icon visibly has detail.
        disc = math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2) < SIZE * 0.2
        r, g, b = (min(255, c + 90) for c in colour) if disc else colour
        return (r, g, b, int(alpha * 255))

    return pixel


def main():
    home = os.environ.get("HOME", "/root")
    icons = os.path.join(home, ".local/share/pear-up-test-icons")
    apps = os.path.join(home, ".local/share/applications")
    os.makedirs(icons, exist_ok=True)
    os.makedirs(apps, exist_ok=True)

    ids = []
    for index, colour in enumerate(COLOURS, start=1):
        icon = os.path.join(icons, f"app{index}.png")
        with open(icon, "wb") as handle:
            handle.write(png(SIZE, SIZE, rounded_square(colour)))

        desktop_id = f"pear-up-test-app{index}.desktop"
        with open(os.path.join(apps, desktop_id), "w") as handle:
            handle.write("[Desktop Entry]\n"
                         "Type=Application\n"
                         f"Name=Test App {index}\n"
                         # Still nothing to see, but alive for a while and
                         # launched with startup notification, so a launch
                         # leaves the app starting: what the dock bounce
                         # checks bounce on.
                         "Exec=sleep 30\n"
                         "StartupNotify=true\n"
                         f"Icon={icon}\n")
        ids.append(desktop_id)

    # An app that does start, its window appearing after a delay; not a
    # favourite, so it only shows in the dock while it runs. Its id is the
    # application id test-window.js is given, which is how the shell matches
    # its window to this entry.
    launch_id = "io.github.maddinek.PearUpTestLaunch"
    with open(os.path.join(apps, f"{launch_id}.desktop"), "w") as handle:
        handle.write("[Desktop Entry]\n"
                     "Type=Application\n"
                     "Name=Test Launch\n"
                     f"Exec=gjs -m /src/tests/integration/test-window.js {launch_id} 2500\n"
                     "StartupNotify=true\n"
                     f"Icon={os.path.join(icons, 'app1.png')}\n")

    print("[" + ", ".join(f"'{desktop_id}'" for desktop_id in ids) + "]")
    return 0


if __name__ == "__main__":
    sys.exit(main())

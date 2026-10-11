#!/usr/bin/env python3
"""Filter a `dconf dump` for the preview: stdin to stdout.

Drops what is personal and does not change the look (GSConnect's device name,
weather and world-clock locations, command histories, anything account-shaped),
and writes paths the way the container sees them: on an image-based system the
home directory is /var/home/<user> in dconf and /home/<user> everywhere else.
"""
import re
import sys

DROP_SECTION = re.compile(r"gsconnect|weather|world-clocks|account|goa|online", re.I)
DROP_KEY = re.compile(r"^(command-history|looking-glass-history|last-selected-power-profile)=")

keep = True
for line in sys.stdin:
    if line.startswith("["):
        keep = not DROP_SECTION.search(line)
    if keep and not DROP_KEY.match(line):
        sys.stdout.write(line.replace("file:///var/home/", "file:///home/"))

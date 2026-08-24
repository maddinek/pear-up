#!/usr/bin/env python3
"""The integration suite used to drop null offsets, so File could return
NaN (serialized as null) and the other titles would still carry the check.
This is that hole, without booting a shell.
"""
import math
import sys

failed = 0


def check(label, condition):
    global failed
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}", file=sys.stderr)
        failed += 1


def finite_number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


# What the hook reports when File's stage x is still NaN and the other
# menus have already been allocated.
crash = {"File": None, "Edit": 0, "View": 1, "Go": 0}

old_placed = {k: v for k, v in crash.items() if isinstance(v, (int, float))}
check("dropping only non-numbers lets File's null through",
      "File" not in old_placed and len(old_placed) >= 3)

nonfinite = [label for label, value in crash.items() if not finite_number(value)]
check("the new filter fails the File crash", nonfinite == ["File"])
check("NaN is not a finite offset", not finite_number(float("nan")))
check("null is not a finite offset", not finite_number(None))
check("a real pin is a finite offset", finite_number(0) and finite_number(-2))

if failed:
    print(f"menu pin assert: {failed} failed", file=sys.stderr)
    sys.exit(1)
print("menu pin assert: ok")

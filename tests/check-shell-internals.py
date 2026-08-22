#!/usr/bin/env python3
"""Check the private gnome-shell JavaScript this extension reaches into.

No typelib describes these — they are JavaScript inside gnome-shell — so they
cannot be resolved like an introspected symbol. They are, however, compiled into
the shell's library as a GResource, so the sources can be searched directly.

These are the dependencies that break quietly: a renamed private member throws
at runtime, on someone else's machine, with no warning at build time.
"""
import json
import pathlib
import sys

SEARCH_ROOTS = [
    pathlib.Path("/usr/lib64/gnome-shell"),
    pathlib.Path("/usr/lib/gnome-shell"),
    pathlib.Path("/usr/lib64"),
    pathlib.Path("/usr/lib"),
]


def shell_libraries():
    """The gnome-shell libraries that carry the bundled JavaScript."""
    for root in SEARCH_ROOTS:
        if not root.is_dir():
            continue
        for path in sorted(root.glob("libshell*.so*")):
            if path.is_file():
                yield path


def main():
    manifest_path = sys.argv[1] if len(sys.argv) > 1 else "tests/api-manifest.json"
    manifest = json.loads(pathlib.Path(manifest_path).read_text())
    wanted = manifest.get("shellInternals", [])

    libraries = list(shell_libraries())
    if not libraries:
        print("  could not find a gnome-shell library to inspect", file=sys.stderr)
        return 2

    blob = b"".join(path.read_bytes() for path in libraries)
    print(f"  searched: {', '.join(p.name for p in libraries)}")

    missing = [name for name in wanted if name.encode() not in blob]

    for name in missing:
        print(f"  MISSING: {name} not found in the shell's sources")

    if missing:
        print(f"shell internals: {len(missing)} of {len(wanted)} missing")
        return 1

    print(f"shell internals: all {len(wanted)} present")
    return 0


if __name__ == "__main__":
    sys.exit(main())

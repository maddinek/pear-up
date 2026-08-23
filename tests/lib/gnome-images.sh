#!/usr/bin/env bash
# Which container image carries which GNOME release. Shared by the test runners
# so a new release is added in one place.
#
# GNOME ships with a known Fedora release, which is the cheapest way to get a
# specific version's libraries without installing any of them.
declare -A IMAGE_FOR=(
    [45]=fedora:39
    [46]=fedora:40
    [47]=fedora:41
    [48]=fedora:42
    [49]=fedora:43
    [50]=fedora:44
)

ALL_VERSIONS=(45 46 47 48 49 50)

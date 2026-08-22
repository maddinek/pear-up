#!/bin/bash
# Follow this extension's messages in the shell's log.
#
# Turn on "Verbose Error Logging" on the General preferences page first: the
# handled-error messages are gated behind it so the journal is not spammed in
# normal use.
set -euo pipefail

LOG_FILE="${1:-testing.log}"

echo "--------------------------------------------------"
echo "📋 Following Pear Up messages, also writing to: $LOG_FILE"
echo "--------------------------------------------------"

# Messages are tagged "[pear-up]" or with the full UUID, so match the stem that
# appears in both rather than one exact string.
journalctl /usr/bin/gnome-shell -f -o cat \
    | grep --line-buffered -E "pear-up" \
    | tee -a "$LOG_FILE"

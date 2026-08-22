#!/bin/bash

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_UUID="$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_DIR/metadata.json")"
LOG_FILE="testing.log"

echo "--------------------------------------------------"
echo "📋 Starting live logging for Global manu for gnome"
echo "📝 Logs will be piped to: $LOG_FILE"
echo "--------------------------------------------------"

journalctl /usr/bin/gnome-shell -f | grep "$EXTENSION_UUID" --line-buffered | tee -a "$LOG_FILE"

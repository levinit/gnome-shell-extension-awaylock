#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXTENSION_DIR="$ROOT_DIR/extension"
UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXTENSION_DIR/metadata.json" | head -n 1)
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Disable first, then remove files
gnome-extensions disable "$UUID" 2>/dev/null || true
gsettings set org.gnome.shell disabled-extensions \
	"$(gsettings get org.gnome.shell disabled-extensions |
		sed "s/]$/, '$UUID']/")" 2>/dev/null || true

rm -rf "$TARGET_DIR"
printf 'Removed extension %s\n' "$UUID"

#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXTENSION_DIR="$ROOT_DIR/extension"
UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXTENSION_DIR/metadata.json" | head -n 1)
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

# Install to user extensions directory
mkdir -p "$TARGET_DIR/schemas"
cp "$EXTENSION_DIR"/*.js "$EXTENSION_DIR"/metadata.json "$TARGET_DIR/" 2>/dev/null || true
cp "$EXTENSION_DIR"/schemas/*.xml "$TARGET_DIR/schemas/"
glib-compile-schemas --strict "$TARGET_DIR/schemas"

# Install locale data if compiled
if [ -d "$ROOT_DIR/po/locale" ]; then
	cp -r "$ROOT_DIR/po/locale" "$TARGET_DIR/"
fi

# Remove from disabled list (Shell auto-disables broken extensions)
gsettings set org.gnome.shell disabled-extensions \
	"$(gsettings get org.gnome.shell disabled-extensions |
		sed "s/'$UUID',\\?\\s*//g" |
		sed 's/, \]/]/g')" 2>/dev/null || true

# Enable via GSettings
CURRENT=$(gsettings get org.gnome.shell enabled-extensions)
case "$CURRENT" in
*"$UUID"*) ;; # already enabled
*)
	NEW=$(echo "$CURRENT" | sed "s/]$/, '$UUID']/")
	gsettings set org.gnome.shell enabled-extensions "$NEW" 2>/dev/null || true
	;;
esac

printf 'Extension %s installed and enabled.\n' "$UUID"
printf '\nOn Wayland, log out and back in once for Shell to discover your\n'
printf 'extension. After that, use this command to hot-reload after changes:\n'
printf '  make install && gnome-extensions reset %s && gnome-extensions enable %s\n' "$UUID" "$UUID"

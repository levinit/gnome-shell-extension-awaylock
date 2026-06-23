#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXTENSION_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$ROOT_DIR/build"
UUID=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$EXTENSION_DIR/metadata.json" | head -n 1)
STAGING_DIR="$BUILD_DIR/$UUID"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR" "$DIST_DIR"

cp "$EXTENSION_DIR"/*.js "$EXTENSION_DIR"/metadata.json "$STAGING_DIR/" 2>/dev/null || true
mkdir -p "$STAGING_DIR/schemas"
cp "$EXTENSION_DIR"/schemas/*.xml "$STAGING_DIR/schemas/"

glib-compile-schemas --strict "$STAGING_DIR/schemas"

# Include compiled locale data
if [ -d "$ROOT_DIR/po/locale" ]; then
	cp -r "$ROOT_DIR/po/locale" "$STAGING_DIR/"
fi

ARCHIVE_PATH="$DIST_DIR/$UUID.zip"
rm -f "$ARCHIVE_PATH"

cd "$STAGING_DIR"

if command -v zip >/dev/null 2>&1; then
	zip -qr "$ARCHIVE_PATH" .
elif command -v bsdtar >/dev/null 2>&1; then
	bsdtar -a -cf "$ARCHIVE_PATH" .
else
	printf 'zip or bsdtar is required to package the extension\n' >&2
	exit 1
fi

printf 'Created %s\n' "$ARCHIVE_PATH"

EXTENSION_UUID := awaylock@levinit.github.io
EXTENSION_DIR := extension
BUILD_DIR := build
DIST_DIR := dist

.PHONY: all package install uninstall enable-extension disable-extension locale clean

all: locale package

locale:
	cd po && for f in *.po; do lang="$${f%.po}"; mkdir -p "locale/$$lang/LC_MESSAGES" && msgfmt "$$f" -o "locale/$$lang/LC_MESSAGES/$(EXTENSION_UUID).mo" 2>/dev/null; done

package: locale
	./scripts/package-extension.sh

install: locale
	./scripts/install-extension.sh

enable-extension:
	gnome-extensions enable $(EXTENSION_UUID)

disable-extension:
	gnome-extensions disable $(EXTENSION_UUID)

uninstall:
	./scripts/uninstall-extension.sh

clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR) po/locale
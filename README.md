# AwayLock

A GNOME Shell extension that automatically locks your session when you step away with your Bluetooth device.

## Quick Start

```bash
make install
make enable-extension
```

Then open **Extensions** → **AwayLock** to configure a trusted Bluetooth device.

## Usage

1. Pick your phone or any Bluetooth device from the dropdown.
2. Set how long the desktop can be idle before it checks if you're away.
3. Walk away — the session locks automatically when signal drops below threshold.

Configuration is in **Settings → AwayLock** or through the Extensions app.

## Build from Source

```bash
make package         # create a distributable .zip
make install         # install to local GNOME Shell
make uninstall       # remove
```

Requires: `zip` or `bsdtar`.

## Packages

| Distro | Directory |
|--------|-----------|
| Arch Linux | [packages/arch/](packages/arch/) |
| Debian / Ubuntu | [packages/debian/](packages/debian/) |
| Fedora / RHEL | [packages/fedora/](packages/fedora/) |

## Website

Project home page on GitHub Pages:

[https://levinit.github.io/gnome-shell-extension-awaylock/](https://levinit.github.io/gnome-shell-extension-awaylock/)

Source in [docs/](docs/).

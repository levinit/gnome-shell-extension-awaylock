%global uuid awaylock@levinit.github.io
%global extsdir %{_datadir}/gnome-shell/extensions/%{uuid}

Name:           gnome-shell-extension-awaylock
Version:        1.0.0
Release:        1%{?dist}
Summary:        GNOME Shell extension for Bluetooth-based session locking

License:        MIT
URL:            https://github.com/levinit/gnome-shell-extension-awaylock
Source0:        https://github.com/levinit/gnome-shell-extension-awaylock/archive/refs/tags/v%{version}.tar.gz

BuildArch:      noarch

Requires:       gnome-shell >= 48
Requires:       bluez

%description
AwayLock locks the current GNOME session when the desktop is idle
and a trusted Bluetooth device is no longer nearby.

Supports multiple Bluetooth devices, dual RSSI thresholds with
hysteresis, signal smoothing, and a configurable disconnect grace
period.

%prep
%autosetup -n gnome-shell-extension-awaylock-%{version}

%install
install -d %{buildroot}%{extsdir}/schemas
install -pm 0644 extension/*.js extension/metadata.json %{buildroot}%{extsdir}/
install -pm 0644 extension/schemas/*.xml %{buildroot}%{extsdir}/schemas/
glib-compile-schemas %{buildroot}%{extsdir}/schemas

# Compile and install locale data
for f in po/*.po; do
    lang=$(basename "$f" .po)
    install -d %{buildroot}%{extsdir}/locale/$lang/LC_MESSAGES
    msgfmt "$f" -o %{buildroot}%{extsdir}/locale/$lang/LC_MESSAGES/%{uuid}.mo
done

%post
glib-compile-schemas %{extsdir}/schemas &>/dev/null || :

%postun
glib-compile-schemas %{extsdir}/schemas &>/dev/null || :

%files
%license LICENSE
%doc README.md CHANGELOG.md
%{extsdir}/extension.js
%{extsdir}/prefs.js
%{extsdir}/bluez.js
%{extsdir}/status.js
%{extsdir}/metadata.json
%{extsdir}/schemas/

%changelog
* Sun Jun 22 2026 levinit <levinit@github.com> - 1.0.0-1
- Initial package
- GNOME Shell extension with Bluetooth proximity gating

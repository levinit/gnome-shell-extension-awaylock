
# Changelog

## Unreleased
- Disabled by default; never lock when no device is configured
- Filter BlueZ signals to presence-relevant properties only (RSSI/Connected/Trusted, Device1 interfaces)
- Lock via `org.gnome.ScreenSaver` D-Bus with `loginctl` fallback
- Refresh Quick Settings subtitle immediately on re-enable
- Index-independent device row sync in preferences (was order-coupled)
- Complete translations for all 16 non-Chinese languages (50/50 entries each)
- Drop stray `po/zh_CN.po~` backup file

## v1
- Initial release candidate
- Idle detection logic
- Basic state machine locking
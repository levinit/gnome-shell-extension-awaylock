import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { evaluatePresenceSample, findBluetoothDevice, subscribeToBluetoothSignals } from './bluez.js';
import { writeStatusSnapshot } from './status.js';

const AwayLockToggle = GObject.registerClass(
    class AwayLockToggle extends QuickSettings.QuickToggle {
        _init(extension) {
            super._init({
                title: 'AwayLock',
                iconName: 'system-lock-screen-symbolic',
                toggleMode: true,
            });

            this._extension = extension;
            this._settings = extension.getSettings();

            this._settings.bind(
                'enabled',
                this,
                'checked',
                Gio.SettingsBindFlags.DEFAULT
            );

            this._updateSubtitle();
            this._settingsChangedId = this._settings.connect('changed::bluetooth-device-address', () => {
                this._updateSubtitle();
            });
        }

        _updateSubtitle() {
            const address = this._settings.get_string('bluetooth-device-address');
            const count = address.split(',').map(a => a.trim()).filter(Boolean).length;
            if (count === 0) {
                this.subtitle = 'No device configured';
            } else if (count === 1) {
                this.subtitle = '1 device monitored';
            } else {
                this.subtitle = `${count} devices monitored`;
            }
        }

        destroy() {
            if (this._settingsChangedId) {
                this._settings.disconnect(this._settingsChangedId);
                this._settingsChangedId = 0;
            }
            super.destroy();
        }
    });

const AwayLockIndicator = GObject.registerClass(
    class AwayLockIndicator extends QuickSettings.SystemIndicator {
        _init(extension) {
            super._init();

            this._indicator = this._addIndicator();
            this._indicator.icon_name = 'system-lock-screen-symbolic';

            this._settings = extension.getSettings();

            this._toggle = new AwayLockToggle(extension);
            this.quickSettingsItems.push(this._toggle);

            this._syncVisibility();
            this._settingsChangedIds = [
                this._settings.connect('changed::enabled', () => this._syncVisibility()),
            ];
        }

        _syncVisibility() {
            this._indicator.visible = this._settings.get_boolean('enabled');
        }

        destroy() {
            for (const id of this._settingsChangedIds) {
                this._settings.disconnect(id);
            }
            this._toggle.destroy();
            super.destroy();
        }
    });


export default class AwayLockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._indicator = new AwayLockIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._idleWatch = null;
        this._userActiveWatch = null;
        this._lockTimeout = null;
        this._idleTriggered = false;
        this._deviceNear = false;
        this._lastDevice = null;
        this._presenceState = null;
        this._presencePoll = 0;

        this._bluezUnsubscribe = subscribeToBluetoothSignals(() => this._onBluetoothStateChanged());

        this._settingsChangedIds = [
            this._settings.connect('changed::enabled', () => this._syncEnabledState()),
            this._settings.connect('changed::idle-seconds', () => this._syncIdleState()),
            this._settings.connect('changed::lock-delay-seconds', () => this._syncIdleState()),
            this._settings.connect('changed::bluetooth-device-address', () => this._resetPresenceModel()),
            this._settings.connect('changed::arrive-rssi-threshold', () => this._syncPresenceAndLockState()),
            this._settings.connect('changed::leave-rssi-threshold', () => this._syncPresenceAndLockState()),
            this._settings.connect('changed::sample-window', () => this._resetPresenceModel()),
            this._settings.connect('changed::away-grace-seconds', () => this._syncPresenceAndLockState()),
            this._settings.connect('changed::sample-interval-seconds', () => this._restartPresencePoll()),
        ];

        this._syncEnabledState();
    }

    disable() {
        this._clearIdleWatch();
        this._clearUserActiveWatch();

        this._clearLockTimeout();

        if (this._bluezUnsubscribe) {
            this._bluezUnsubscribe();
            this._bluezUnsubscribe = null;
        }

        if (this._presencePoll) {
            GLib.source_remove(this._presencePoll);
            this._presencePoll = 0;
        }

        if (this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);

            this._settingsChangedIds = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._publishStatus('extension-disabled', false);

        this._settings = null;
        this._idleMonitor = null;
    }

    _syncIdleState() {
        if (!this._settings.get_boolean('enabled'))
            return;

        if (this._isIdleThresholdReached()) {
            this._enterIdleState();
            return;
        }

        this._exitIdleState();
    }

    _syncEnabledState() {
        const enabled = this._settings.get_boolean('enabled');
        if (enabled) {
            this._syncIdleState();
            this._restartPresencePoll();
        } else {
            this._clearIdleWatch();
            this._clearUserActiveWatch();
            this._clearLockTimeout();
            if (this._presencePoll) {
                GLib.source_remove(this._presencePoll);
                this._presencePoll = 0;
            }
            this._publishStatus('disabled', false);
        }
    }

    _syncPresenceAndLockState() {
        this._refreshBluetoothState();

        if (this._idleTriggered)
            this._maybeScheduleLock();
    }

    _enterIdleState() {
        this._idleTriggered = true;
        this._clearIdleWatch();
        this._ensureUserActiveWatch();
        this._maybeScheduleLock();
    }

    _exitIdleState() {
        this._idleTriggered = false;
        this._clearLockTimeout();
        this._clearUserActiveWatch();
        this._armIdleWatch();
    }

    _armIdleWatch() {
        if (!this._settings.get_boolean('enabled'))
            return;
        if (this._idleWatch || this._idleTriggered)
            return;

        this._idleWatch = this._idleMonitor.add_idle_watch(
            this._getIdleSeconds() * 1000,
            () => this._onIdle()
        );
    }

    _ensureUserActiveWatch() {
        if (!this._settings.get_boolean('enabled'))
            return;
        if (this._userActiveWatch)
            return;

        this._userActiveWatch = this._idleMonitor.add_user_active_watch(
            () => this._onUserActive()
        );
    }

    _onIdle() {
        this._idleWatch = null;
        this._enterIdleState();
    }

    _onUserActive() {
        this._userActiveWatch = null;
        this._exitIdleState();
    }

    _onBluetoothStateChanged() {
        this._syncPresenceAndLockState();
    }

    _maybeScheduleLock() {
        if (!this._idleTriggered)
            return;

        if (this._deviceNear) {
            this._clearLockTimeout();
            return;
        }

        if (this._lockTimeout)
            return;

        const remainingDelayMs = this._getRemainingDelayMs();

        if (remainingDelayMs === 0) {
            this._verifyAndMaybeLock();
            return;
        }

        this._lockTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            Math.ceil(remainingDelayMs / 1000),
            () => this._verifyAndMaybeLock()
        );
    }

    _verifyAndMaybeLock() {
        this._lockTimeout = null;

        if (!this._isIdleThresholdReached()) {
            this._syncIdleState();
            return GLib.SOURCE_REMOVE;
        }

        this._refreshBluetoothState();

        if (!this._deviceNear) {
            this._lock();
            this._publishStatus('lock-requested');
            return GLib.SOURCE_REMOVE;
        }

        this._publishStatus('lock-skipped-presence');

        return GLib.SOURCE_REMOVE;
    }

    _refreshBluetoothState() {
        this._deviceNear = this._isTrustedDeviceNear();
        this._publishStatus(this._deviceNear ? 'presence-present' : 'presence-away');
    }

    _isTrustedDeviceNear() {
        const configuredAddress = this._getConfiguredAddress();

        if (!configuredAddress) {
            this._lastDevice = null;
            return false;
        }

        const addresses = configuredAddress.split(',')
            .map(addr => addr.trim().toUpperCase())
            .filter(Boolean);

        if (addresses.length === 0) {
            this._lastDevice = null;
            return false;
        }

        this._presenceStates = this._presenceStates || {};

        let anyPresent = false;
        let activeDevice = null;

        for (const address of addresses) {
            const device = findBluetoothDevice(address);
            const previousState = this._presenceStates[address];

            const state = evaluatePresenceSample(device, previousState, {
                arriveThreshold: this._getArriveRssiThreshold(),
                leaveThreshold: this._getLeaveRssiThreshold(),
                sampleWindow: this._getSampleWindow(),
                awayGraceSeconds: this._getAwayGraceSeconds(),
            });

            this._presenceStates[address] = state;

            if (state.present) {
                anyPresent = true;
                if (device)
                    activeDevice = device;
            }
        }

        if (anyPresent) {
            this._lastDevice = activeDevice || findBluetoothDevice(addresses[0]);
        } else {
            this._lastDevice = findBluetoothDevice(addresses[0]);
        }

        const activeAddress = activeDevice ? activeDevice.address : addresses[0];
        this._presenceState = this._presenceStates[activeAddress];

        return anyPresent;
    }

    _getConfiguredAddress() {
        return this._settings.get_string('bluetooth-device-address').trim().toUpperCase();
    }

    _getIdleSeconds() {
        return Math.max(30, this._settings.get_uint('idle-seconds'));
    }

    _getLockDelaySeconds() {
        return this._settings.get_uint('lock-delay-seconds');
    }

    _getArriveRssiThreshold() {
        return this._settings.get_int('arrive-rssi-threshold');
    }

    _getLeaveRssiThreshold() {
        return this._settings.get_int('leave-rssi-threshold');
    }

    _getSampleWindow() {
        return Math.max(1, this._settings.get_uint('sample-window'));
    }

    _getAwayGraceSeconds() {
        return this._settings.get_uint('away-grace-seconds');
    }

    _getSampleIntervalSeconds() {
        return Math.max(1, this._settings.get_uint('sample-interval-seconds'));
    }

    _getRemainingDelayMs() {
        const idleExceededMs = this._idleMonitor.get_idletime() - this._getIdleSeconds() * 1000;
        return Math.max(0, this._getLockDelaySeconds() * 1000 - idleExceededMs);
    }

    _isIdleThresholdReached() {
        return this._idleMonitor.get_idletime() >= this._getIdleSeconds() * 1000;
    }

    _clearIdleWatch() {
        if (!this._idleWatch)
            return;

        this._idleMonitor.remove_watch(this._idleWatch);
        this._idleWatch = null;
    }

    _clearUserActiveWatch() {
        if (!this._userActiveWatch)
            return;

        this._idleMonitor.remove_watch(this._userActiveWatch);
        this._userActiveWatch = null;
    }

    _clearLockTimeout() {
        if (!this._lockTimeout)
            return;

        GLib.source_remove(this._lockTimeout);
        this._lockTimeout = null;
    }

    _restartPresencePoll() {
        if (this._presencePoll) {
            GLib.source_remove(this._presencePoll);
            this._presencePoll = 0;
        }

        if (!this._settings.get_boolean('enabled'))
            return;

        this._scheduleNextPresencePoll();
    }

    _scheduleNextPresencePoll() {
        if (this._presencePoll) {
            GLib.source_remove(this._presencePoll);
            this._presencePoll = 0;
        }

        if (!this._settings.get_boolean('enabled'))
            return;

        const interval = this._getNextPollIntervalSeconds();
        this._presencePoll = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._presencePoll = 0;
                this._onPresencePoll();
                this._scheduleNextPresencePoll();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _getNextPollIntervalSeconds() {
        const idleTimeMs = this._idleMonitor.get_idletime();
        const idleThresholdMs = this._getIdleSeconds() * 1000;

        if (idleTimeMs < idleThresholdMs - 15000)
            return 15;

        return this._getSampleIntervalSeconds();
    }

    _onPresencePoll() {
        this._syncPresenceAndLockState();
    }

    _resetPresenceModel() {
        this._presenceState = null;
        this._presenceStates = {};
        this._syncPresenceAndLockState();
    }

    _publishStatus(lastAction, enabled = true) {
        if (!this._settings)
            return;

        if (this._indicator && this._indicator._toggle) {
            const extEnabled = this._settings.get_boolean('enabled');
            if (!extEnabled) {
                this._indicator._toggle.subtitle = 'Disabled';
            } else {
                const device = this._lastDevice;
                if (device) {
                    this._indicator._toggle.subtitle = `${device.alias}${this._deviceNear ? '  •  near' : '  •  away'}`;
                } else {
                    this._indicator._toggle._updateSubtitle();
                }
            }
        }

        const idleMilliseconds = this._idleMonitor.get_idletime();
        const device = this._lastDevice;

        writeStatusSnapshot({
            runtime: 'shell-extension',
            enabled,
            present: this._deviceNear,
            idleMilliseconds,
            idleThresholdMilliseconds: this._getIdleSeconds() * 1000,
            lockDelaySeconds: this._getLockDelaySeconds(),
            lockPending: Boolean(this._lockTimeout),
            idleTriggered: this._idleTriggered,
            deviceAddress: this._getConfiguredAddress(),
            deviceAlias: device?.alias ?? null,
            deviceConnected: device?.connected ?? false,
            rawRssi: typeof device?.rssi === 'number' ? device.rssi : null,
            smoothedRssi: Number.isFinite(this._presenceState?.smoothedRssi) ? this._presenceState.smoothedRssi : null,
            sampleCount: Array.isArray(this._presenceState?.samples) ? this._presenceState.samples.length : 0,
            arriveRssiThreshold: this._getArriveRssiThreshold(),
            leaveRssiThreshold: this._getLeaveRssiThreshold(),
            sampleWindow: this._getSampleWindow(),
            sampleIntervalSeconds: this._getSampleIntervalSeconds(),
            awayGraceSeconds: this._getAwayGraceSeconds(),
            lastAction,
            updatedAtUnixMs: Date.now(),
        });
    }

    _lock() {
        GLib.spawn_command_line_async('loginctl lock-session');
    }
}
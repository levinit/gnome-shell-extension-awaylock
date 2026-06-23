
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { formatBluetoothDeviceLabel, listBluetoothDevices, setDeviceTrusted } from './bluez.js';
import { readStatusSnapshot } from './status.js';

export default class AwayLockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();
        const devices = [];
        const currentDeviceRows = [];

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Detection'),
            description: _('Configure the idle timeout and choose the Bluetooth device that represents your presence.'),
        });
        const statusGroup = new Adw.PreferencesGroup({
            title: _('Status'),
            description: _('Live status from the extension runtime.'),
        });

        const enabledRow = new Adw.SwitchRow({
            title: _('Enable proximity gating'),
            subtitle: _('Toggle whether session locks automatically.'),
        });
        settings.bind('enabled', enabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const devicesExpander = new Adw.ExpanderRow({
            title: _('Bluetooth Devices'),
            subtitle: _('Select one or more trusted devices to monitor.'),
        });
        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reload Bluetooth devices'),
        });
        devicesExpander.add_suffix(refreshButton);

        const addressRow = new Adw.ActionRow({
            title: _('Trusted Bluetooth Devices'),
            subtitle: _('None configured'),
        });
        // Force smaller subtitle via markup
        addressRow.use_markup = true;
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const setSubtitle = (text) => {
            addressRow.set_subtitle(`<span alpha="95%">${esc(text)}</span>`);
        };

        const addManualRow = new Adw.EntryRow({
            title: _('Add address (e.g. 00:11:22:33:44:55)'),
        });
        const addManualButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Add MAC address'),
        });
        addManualRow.add_suffix(addManualButton);
        addManualRow.activatable_widget = addManualButton;

        devicesExpander.add_row(addManualRow);

        const addCustomAddress = (text) => {
            const newAddr = text.trim().toUpperCase();
            const macRegex = /^([0-9A-FA-F]{2}[:-]){5}([0-9A-FA-F]{2})$/;
            if (!macRegex.test(newAddr))
                return;

            let addresses = settings.get_string('bluetooth-device-address')
                .split(',')
                .map(a => a.trim().toUpperCase())
                .filter(Boolean);

            if (!addresses.includes(newAddr)) {
                addresses.push(newAddr);
                settings.set_string('bluetooth-device-address', addresses.join(', '));
                repopulateDevices();
            }
            addManualRow.text = '';
        };

        addManualButton.connect('clicked', () => {
            addCustomAddress(addManualRow.text);
        });

        const idleRow = new Adw.SpinRow({
            title: _('Idle timeout (seconds)'),
            subtitle: _('Default: 300s'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 60,
                value: settings.get_uint('idle-seconds'),
            }),
        });
        idleRow.connect('notify::value', row => {
            settings.set_uint('idle-seconds', Math.round(row.get_value()));
        });

        const delayRow = new Adw.SpinRow({
            title: _('Lock delay after idle (seconds)'),
            subtitle: _('Default: 10s'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 120,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_uint('lock-delay-seconds'),
            }),
        });
        delayRow.connect('notify::value', row => {
            settings.set_uint('lock-delay-seconds', Math.round(row.get_value()));
        });

        const rssiRow = new Adw.SpinRow({
            title: _('Arrival RSSI threshold (dBm)'),
            subtitle: _('Default: -70 dBm'),
            adjustment: new Gtk.Adjustment({
                lower: -100,
                upper: -30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('arrive-rssi-threshold'),
            }),
        });
        rssiRow.connect('notify::value', row => {
            settings.set_int('arrive-rssi-threshold', Math.round(row.get_value()));
        });

        const leaveRssiRow = new Adw.SpinRow({
            title: _('Leave RSSI threshold (dBm)'),
            subtitle: _('Default: -78 dBm'),
            adjustment: new Gtk.Adjustment({
                lower: -100,
                upper: -30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('leave-rssi-threshold'),
            }),
        });
        leaveRssiRow.connect('notify::value', row => {
            settings.set_int('leave-rssi-threshold', Math.round(row.get_value()));
        });

        const windowRow = new Adw.SpinRow({
            title: _('RSSI smoothing window'),
            subtitle: _('Default: 5'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 15,
                step_increment: 1,
                page_increment: 1,
                value: settings.get_uint('sample-window'),
            }),
        });
        windowRow.connect('notify::value', row => {
            settings.set_uint('sample-window', Math.round(row.get_value()));
        });

        const graceRow = new Adw.SpinRow({
            title: _('Disconnect grace period (seconds)'),
            subtitle: _('Default: 12s'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 120,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_uint('away-grace-seconds'),
            }),
        });
        graceRow.connect('notify::value', row => {
            settings.set_uint('away-grace-seconds', Math.round(row.get_value()));
        });

        const sampleIntervalRow = new Adw.SpinRow({
            title: _('Sample interval (seconds)'),
            subtitle: _('Default: 3s'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_uint('sample-interval-seconds'),
            }),
        });
        sampleIntervalRow.connect('notify::value', row => {
            settings.set_uint('sample-interval-seconds', Math.round(row.get_value()));
        });

        const resetRow = new Adw.ActionRow({
            title: _('Reset settings'),
            subtitle: _('Restore all options to default values.'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset to Defaults'),
            valign: Gtk.Align.CENTER,
        });
        resetButton.connect('clicked', () => {
            settings.reset('enabled');
            settings.reset('bluetooth-device-address');
            settings.reset('idle-seconds');
            settings.reset('lock-delay-seconds');
            settings.reset('arrive-rssi-threshold');
            settings.reset('leave-rssi-threshold');
            settings.reset('sample-window');
            settings.reset('away-grace-seconds');
            settings.reset('sample-interval-seconds');

            setSubtitle(_('None configured'));
            addManualRow.text = '';
            idleRow.value = settings.get_uint('idle-seconds');
            delayRow.value = settings.get_uint('lock-delay-seconds');
            rssiRow.value = settings.get_int('arrive-rssi-threshold');
            leaveRssiRow.value = settings.get_int('leave-rssi-threshold');
            windowRow.value = settings.get_uint('sample-window');
            graceRow.value = settings.get_uint('away-grace-seconds');
            sampleIntervalRow.value = settings.get_uint('sample-interval-seconds');

            repopulateDevices();
        });
        resetRow.add_suffix(resetButton);
        resetRow.activatable_widget = resetButton;

        group.add(enabledRow);
        group.add(addressRow);
        group.add(devicesExpander);
        group.add(idleRow);
        group.add(delayRow);
        group.add(rssiRow);
        group.add(leaveRssiRow);
        group.add(windowRow);
        group.add(graceRow);
        group.add(sampleIntervalRow);
        group.add(resetRow);

        const presenceRow = new Adw.ActionRow({ title: _('Presence'), subtitle: '-' });
        const deviceRow = new Adw.ActionRow({ title: _('Device'), subtitle: '-' });
        const rssiStatusRow = new Adw.ActionRow({ title: _('RSSI'), subtitle: '-' });
        const idleStatusRow = new Adw.ActionRow({ title: _('Idle'), subtitle: '-' });
        const actionRow = new Adw.ActionRow({ title: _('Last action'), subtitle: '-' });
        const updatedRow = new Adw.ActionRow({ title: _('Updated'), subtitle: '-' });

        statusGroup.add(presenceRow);
        statusGroup.add(deviceRow);
        statusGroup.add(rssiStatusRow);
        statusGroup.add(idleStatusRow);
        statusGroup.add(actionRow);
        statusGroup.add(updatedRow);

        page.add(group);
        page.add(statusGroup);
        window.add(page);

        const repopulateDevices = () => {
            devices.splice(0, devices.length, ...listBluetoothDevices());

            for (const row of currentDeviceRows)
                devicesExpander.remove(row);
            currentDeviceRows.length = 0;

            const configuredAddresses = settings.get_string('bluetooth-device-address')
                .split(',')
                .map(a => a.trim().toUpperCase())
                .filter(Boolean);

            const allDevicesToShow = [...devices];
            for (const addr of configuredAddresses) {
                if (!allDevicesToShow.some(d => d.address === addr)) {
                    allDevicesToShow.push({
                        address: addr,
                        alias: _('Custom Device'),
                        connected: false,
                        paired: false,
                        trusted: false,
                        rssi: null,
                        isCustom: true
                    });
                }
            }

            if (allDevicesToShow.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No Bluetooth devices found'),
                    subtitle: _('Make sure BlueZ is running and devices are paired/visible.'),
                });
                devicesExpander.add_row(emptyRow);
                currentDeviceRows.push(emptyRow);
            } else {
                for (const device of allDevicesToShow) {
                    const row = new Adw.ActionRow({
                        title: `${device.connected ? '✅' : '❌'}  ${device.alias}`,
                        subtitle: formatBluetoothDeviceLabel(device),
                    });
                    const checkButton = new Gtk.CheckButton({
                        valign: Gtk.Align.CENTER,
                    });

                    checkButton.active = configuredAddresses.includes(device.address);

                    checkButton.connect('toggled', () => {
                        let addresses = settings.get_string('bluetooth-device-address')
                            .split(',')
                            .map(a => a.trim().toUpperCase())
                            .filter(Boolean);

                        if (checkButton.active) {
                            if (!addresses.includes(device.address))
                                addresses.push(device.address);

                            // Auto-trust real BlueZ devices when selected
                            if (!device.isCustom)
                                setDeviceTrusted(device.path);
                        } else {
                            addresses = addresses.filter(a => a !== device.address);
                        }

                        const newStr = addresses.join(', ');
                        settings.set_string('bluetooth-device-address', newStr);
                        syncSelectionFromAddress();
                    });

                    row.add_suffix(checkButton);
                    row.activatable_widget = checkButton;
                    devicesExpander.add_row(row);
                    currentDeviceRows.push(row);
                }
            }

            devicesExpander.subtitle = allDevicesToShow.length > 0
                ? _('Select one or more trusted devices to monitor.')
                : _('No Bluetooth devices were returned by BlueZ.');

            syncSelectionFromAddress();
        };

        const syncSelectionFromAddress = () => {
            const configuredAddresses = settings.get_string('bluetooth-device-address')
                .split(',')
                .map(a => a.trim().toUpperCase())
                .filter(Boolean);

            if (configuredAddresses.length === 0) {
                setSubtitle(_('None configured'));
            } else {
                const formatted = configuredAddresses.map(addr => {
                    const found = devices.find(d => d.address === addr);
                    const connected = found?.connected ?? false;
                    if (found) {
                        return `${connected ? '✅' : '❌'}  ${found.alias} · ${addr}`;
                    }
                    return `❌  ${_('Custom')} · ${addr}`;
                }).join('    ');
                setSubtitle(formatted);
            }

            const allDevicesToShow = [...devices];
            for (const addr of configuredAddresses) {
                if (!allDevicesToShow.some(d => d.address === addr)) {
                    allDevicesToShow.push({
                        address: addr,
                        alias: _('Custom Device'),
                        connected: false,
                        paired: false,
                        trusted: false,
                        rssi: null,
                        isCustom: true
                    });
                }
            }

            for (let i = 0; i < currentDeviceRows.length; i++) {
                const row = currentDeviceRows[i];
                const check = row.activatable_widget;
                if (check && check.set_active) {
                    const device = allDevicesToShow[i];
                    if (device) {
                        const isSelected = configuredAddresses.includes(device.address);
                        if (check.active !== isSelected)
                            check.active = isSelected;
                    }
                }
            }
        };

        refreshButton.connect('clicked', () => repopulateDevices());

        const refreshRuntimeStatus = () => {
            const snapshot = readStatusSnapshot();

            if (!snapshot) {
                presenceRow.subtitle = '-';
                deviceRow.subtitle = '-';
                rssiStatusRow.subtitle = '-';
                idleStatusRow.subtitle = '-';
                actionRow.subtitle = '-';
                updatedRow.subtitle = '-';
                return GLib.SOURCE_CONTINUE;
            }

            presenceRow.subtitle = snapshot.present ? _('present') : _('away');

            const deviceBits = [snapshot.deviceAlias, snapshot.deviceAddress].filter(Boolean);
            deviceRow.subtitle = deviceBits.length > 0 ? deviceBits.join('  •  ') : '-';

            const rssiBits = [];
            if (typeof snapshot.rawRssi === 'number')
                rssiBits.push(`${_('raw')} ${snapshot.rawRssi} ${_('dBm')}`);
            if (typeof snapshot.smoothedRssi === 'number')
                rssiBits.push(`${_('smoothed')} ${snapshot.smoothedRssi.toFixed(1)} ${_('dBm')}`);
            if (typeof snapshot.sampleCount === 'number' && snapshot.sampleCount > 0)
                rssiBits.push(`${_('samples')} ${snapshot.sampleCount}`);
            rssiStatusRow.subtitle = rssiBits.length > 0 ? rssiBits.join('  •  ') : (_('RSSI not available'));

            const idleSeconds = typeof snapshot.idleMilliseconds === 'number'
                ? (snapshot.idleMilliseconds / 1000).toFixed(1)
                : null;
            const thresholdSeconds = typeof snapshot.idleThresholdMilliseconds === 'number'
                ? (snapshot.idleThresholdMilliseconds / 1000).toFixed(0)
                : null;
            idleStatusRow.subtitle = idleSeconds !== null
                ? `${idleSeconds}${_('s')} / ${thresholdSeconds ?? '?'}${_('s')}${snapshot.lockPending ? `  •  ${_('lock pending')}` : ''}`
                : '-';

            actionRow.subtitle = snapshot.lastAction ?? '-';

            if (typeof snapshot.updatedAtUnixMs === 'number') {
                const date = GLib.DateTime.new_from_unix_local(Math.floor(snapshot.updatedAtUnixMs / 1000));
                updatedRow.subtitle = date ? date.format('%F %T') : '-';
            } else {
                updatedRow.subtitle = '-';
            }

            return GLib.SOURCE_CONTINUE;
        };

        const statusRefreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            2,
            () => refreshRuntimeStatus()
        );

        window.connect('close-request', () => {
            if (statusRefreshSource)
                GLib.source_remove(statusRefreshSource);

            return false;
        });

        repopulateDevices();
        refreshRuntimeStatus();
    }
}

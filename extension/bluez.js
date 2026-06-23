import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ_SERVICE = 'org.bluez';
const BLUEZ_OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const BLUEZ_PROPERTIES = 'org.freedesktop.DBus.Properties';
const DEVICE_INTERFACE = 'org.bluez.Device1';

function unpack(value) {
  return value?.deepUnpack ? value.deepUnpack() : value;
}

function getManagedObjects() {
  const reply = Gio.DBus.system.call_sync(
    BLUEZ_SERVICE,
    '/',
    BLUEZ_OBJECT_MANAGER,
    'GetManagedObjects',
    null,
    new GLib.VariantType('(a{oa{sa{sv}}})'),
    Gio.DBusCallFlags.NONE,
    -1,
    null
  );

  const [objects] = reply.deepUnpack();
  return objects;
}

function mapDevice(device, objectPath) {
  const properties = {};

  for (const [key, value] of Object.entries(device))
    properties[key] = unpack(value);

  return {
    path: objectPath,
    address: String(properties.Address ?? '').toUpperCase(),
    alias: String(properties.Alias ?? properties.Name ?? properties.Address ?? ''),
    name: String(properties.Name ?? properties.Alias ?? properties.Address ?? ''),
    connected: Boolean(properties.Connected),
    paired: Boolean(properties.Paired),
    trusted: Boolean(properties.Trusted),
    rssi: typeof properties.RSSI === 'number' ? properties.RSSI : null,
  };
}

export function listBluetoothDevices() {
  try {
    const objects = getManagedObjects();
    const devices = [];

    for (const [objectPath, interfaces] of Object.entries(objects)) {
      const device = interfaces[DEVICE_INTERFACE];

      if (device)
        devices.push(mapDevice(device, objectPath));
    }

    devices.sort((left, right) => {
      if (left.connected !== right.connected)
        return left.connected ? -1 : 1;

      if (left.paired !== right.paired)
        return left.paired ? -1 : 1;

      return left.alias.localeCompare(right.alias);
    });

    return devices;
  } catch (error) {
    logError(error, 'awaylock: failed to list Bluetooth devices');
    return [];
  }
}

export function findBluetoothDevice(address) {
  const normalizedAddress = address.trim().toUpperCase();

  if (!normalizedAddress)
    return null;

  return listBluetoothDevices().find(device => device.address === normalizedAddress) ?? null;
}

export function subscribeToBluetoothSignals(callback) {
  const signalIds = [
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_PROPERTIES,
      'PropertiesChanged',
      null,
      DEVICE_INTERFACE,
      Gio.DBusSignalFlags.NONE,
      callback
    ),
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_OBJECT_MANAGER,
      'InterfacesAdded',
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      callback
    ),
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_OBJECT_MANAGER,
      'InterfacesRemoved',
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      callback
    ),
  ];

  return () => {
    for (const signalId of signalIds)
      Gio.DBus.system.signal_unsubscribe(signalId);
  };
}

export function formatBluetoothDeviceLabel(device) {
  return device.address;
}

/**
 * Set a Bluetooth device as trusted via D-Bus Properties.Set.
 * Returns true if the trust was set or was already set.
 * Returns false on D-Bus error (e.g., device not paired, permission denied).
 */
export function setDeviceTrusted(devicePath) {
  try {
    // Check cached Trusted state first
    const proxy = new Gio.DBusProxy.sync(
      Gio.BusType.SYSTEM,
      Gio.DBusProxyFlags.NONE,
      null,
      BLUEZ_SERVICE,
      devicePath,
      DEVICE_INTERFACE,
      null
    );

    const cached = proxy.get_cached_property('Trusted');
    if (cached && cached.get_boolean()) {
      log('awaylock: device already trusted — skipping');
      return true;
    }

    // Call Properties.Set to mark the device as trusted
    Gio.DBus.system.call_sync(
      BLUEZ_SERVICE,
      devicePath,
      BLUEZ_PROPERTIES,
      'Set',
      new GLib.Variant('(ssv)', [
        DEVICE_INTERFACE,
        'Trusted',
        new GLib.Variant('b', true),
      ]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null
    );

    log(`awaylock: successfully trusted ${devicePath}`);
    return true;
  } catch (error) {
    logError(error, `awaylock: failed to set trusted for ${devicePath}`);
    return false;
  }
}

export function evaluatePresenceSample(device, state, settings) {
  const nextState = {
    samples: Array.isArray(state?.samples) ? state.samples.slice(-15) : [],
    present: Boolean(state?.present),
    lastSeenMonotonicUs: Number.isFinite(state?.lastSeenMonotonicUs) ? state.lastSeenMonotonicUs : 0,
    smoothedRssi: Number.isFinite(state?.smoothedRssi) ? state.smoothedRssi : null,
  };

  if (!device || !device.connected) {
    const nowUs = GLib.get_monotonic_time();
    const graceUs = settings.awayGraceSeconds * 1000000;

    if (nextState.lastSeenMonotonicUs === 0)
      nextState.lastSeenMonotonicUs = nowUs;

    if (nowUs - nextState.lastSeenMonotonicUs >= graceUs)
      nextState.present = false;

    return nextState;
  }

  nextState.lastSeenMonotonicUs = GLib.get_monotonic_time();

  if (typeof device.rssi !== 'number') {
    nextState.present = true;
    return nextState;
  }

  nextState.samples.push(device.rssi);
  if (nextState.samples.length > settings.sampleWindow)
    nextState.samples.splice(0, nextState.samples.length - settings.sampleWindow);

  const smoothedRssi = nextState.samples.reduce((sum, value) => sum + value, 0) / nextState.samples.length;
  nextState.smoothedRssi = smoothedRssi;

  if (nextState.present) {
    nextState.present = smoothedRssi >= settings.leaveThreshold;
  } else {
    nextState.present = smoothedRssi >= settings.arriveThreshold;
  }

  return nextState;
}
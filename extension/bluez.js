import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ_SERVICE = 'org.bluez';
const BLUEZ_OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const BLUEZ_PROPERTIES = 'org.freedesktop.DBus.Properties';
const DEVICE_INTERFACE = 'org.bluez.Device1';

function unpack(value) {
  return value?.deepUnpack ? value.deepUnpack() : value;
}

// Canonical Bluetooth address form: upper-case, colon-separated.
// BlueZ reports colon-separated addresses, but users may type hyphens;
// normalising here (and in the callers) keeps a hyphen-typed address
// from silently never matching a BlueZ device.
export function normalizeBluetoothAddress(address) {
  return String(address ?? '').trim().toUpperCase().replace(/-/g, ':');
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
    address: normalizeBluetoothAddress(properties.Address ?? ''),
    alias: String(properties.Alias ?? properties.Name ?? properties.Address ?? ''),
    connected: Boolean(properties.Connected),
    paired: Boolean(properties.Paired),
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

// When a caller already holds a device list (e.g. the extension evaluating
// several configured addresses in one refresh), pass it in so this does not
// trigger one synchronous BlueZ scan per address. Without it, one scan is
// still performed, preserving the original single-device behaviour.
export function findBluetoothDevice(address, devices = null) {
  const normalizedAddress = normalizeBluetoothAddress(address);

  if (!normalizedAddress)
    return null;

  const list = devices ?? listBluetoothDevices();
  return list.find(device => device.address === normalizedAddress) ?? null;
}

export function subscribeToBluetoothSignals(callback) {
  // Only forward signals that can affect presence evaluation.
  // PropertiesChanged arrives already filtered to Device1 by arg0; keep
  // only presence-relevant properties. InterfacesAdded/Removed are not
  // arg0-filterable, so check the interface map explicitly.
  const onSignal = (connection, senderName, objectPath, interfaceName, signalName, parameters) => {
    if (signalName === 'PropertiesChanged') {
      const [changedInterface, changedProperties, invalidatedProperties] = parameters.deepUnpack();
      if (changedInterface !== DEVICE_INTERFACE)
        return;
      // Invalidated properties carry no value, but losing RSSI/Connected
      // is itself presence-relevant and must trigger a refresh.
      const invalidated = Array.isArray(invalidatedProperties) ? invalidatedProperties : [];
      const changed = changedProperties ?? {};
      const relevant = ['RSSI', 'Connected', 'Trusted'];
      if (!relevant.some(prop => prop in changed) &&
          !relevant.some(prop => invalidated.includes(prop)))
        return;
    } else {
      const [objectPath_, interfaces] = parameters.deepUnpack();
      // InterfacesAdded carries a dict (interface -> properties), but
      // InterfacesRemoved carries an array of interface names. Using
      // `in` on the array never matched Device1, so removals were
      // silently ignored until the next poll.
      const hasDeviceInterface = Array.isArray(interfaces)
        ? interfaces.includes(DEVICE_INTERFACE)
        : DEVICE_INTERFACE in interfaces;
      if (!hasDeviceInterface)
        return;
    }
    callback();
  };

  const signalIds = [
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_PROPERTIES,
      'PropertiesChanged',
      null,
      DEVICE_INTERFACE,
      Gio.DBusSignalFlags.NONE,
      onSignal
    ),
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_OBJECT_MANAGER,
      'InterfacesAdded',
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      onSignal
    ),
    Gio.DBus.system.signal_subscribe(
      BLUEZ_SERVICE,
      BLUEZ_OBJECT_MANAGER,
      'InterfacesRemoved',
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      onSignal
    ),
  ];

  return () => {
    for (const signalId of signalIds)
      Gio.DBus.system.signal_unsubscribe(signalId);
  };
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
    rssiUnknown: Boolean(state?.rssiUnknown),
    rssiUnknownSinceUs: Number.isFinite(state?.rssiUnknownSinceUs) ? state.rssiUnknownSinceUs : 0,
  };

  // Defensive hysteresis: arrive must stay above leave, otherwise the
  // present/away flip-flops. If settings were changed outside the
  // preferences UI (e.g. via gsettings) to an inverted pair, derive a
  // 5 dB gap here instead of trusting the inverted values.
  const arriveThreshold = settings.arriveThreshold;
  const leaveThreshold = Math.min(settings.leaveThreshold, arriveThreshold - 5);

  if (!device || !device.connected) {
    const nowUs = GLib.get_monotonic_time();
    const graceUs = settings.awayGraceSeconds * 1000000;

    if (nextState.lastSeenMonotonicUs === 0)
      nextState.lastSeenMonotonicUs = nowUs;

    if (nowUs - nextState.lastSeenMonotonicUs >= graceUs) {
      nextState.present = false;
      // Stale samples must not influence the next arrival: a device that
      // was away and comes back has to re-earn presence from fresh RSSI.
      nextState.samples = [];
      nextState.smoothedRssi = null;
    }
    nextState.rssiUnknown = false;
    nextState.rssiUnknownSinceUs = 0;

    return nextState;
  }

  nextState.lastSeenMonotonicUs = GLib.get_monotonic_time();

  if (typeof device.rssi !== 'number') {
    // No RSSI is not, by itself, absence. Some connected devices
    // (notably classic Bluetooth) legitimately never report RSSI, and
    // for those the connection itself is the presence signal, so the
    // original present=true behaviour is preserved when no RSSI has
    // ever been seen. But a device that previously reported RSSI and
    // then stops while staying connected is different: after the same
    // away-grace period it is treated as away, instead of staying
    // present forever on a stale connection.
    nextState.rssiUnknown = true;
    if (nextState.smoothedRssi === null) {
      nextState.present = true;
      return nextState;
    }

    const nowUs = GLib.get_monotonic_time();
    const graceUs = settings.awayGraceSeconds * 1000000;

    if (nextState.rssiUnknownSinceUs === 0)
      nextState.rssiUnknownSinceUs = nowUs;

    if (nowUs - nextState.rssiUnknownSinceUs >= graceUs)
      nextState.present = false;

    return nextState;
  }

  nextState.rssiUnknown = false;
  nextState.rssiUnknownSinceUs = 0;

  nextState.samples.push(device.rssi);
  if (nextState.samples.length > settings.sampleWindow)
    nextState.samples.splice(0, nextState.samples.length - settings.sampleWindow);

  const smoothedRssi = nextState.samples.reduce((sum, value) => sum + value, 0) / nextState.samples.length;
  nextState.smoothedRssi = smoothedRssi;

  if (nextState.present) {
    nextState.present = smoothedRssi >= leaveThreshold;
  } else {
    nextState.present = smoothedRssi >= arriveThreshold;
  }

  return nextState;
}
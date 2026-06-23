import GLib from 'gi://GLib';

function getStateDir() {
  return GLib.get_user_state_dir();
}

function getStatusFilePath() {
  return GLib.build_filenamev([getStateDir(), 'awaylock', 'status.json']);
}

let lastWrittenHash = null;

export function writeStatusSnapshot(snapshot) {
  // Compare semantic fields only — skip always-changing fields
  const { updatedAtUnixMs: _, idleMilliseconds: _i, idleThresholdMilliseconds: _it, ...compare } = snapshot;
  const currentHash = JSON.stringify(compare);

  if (currentHash === lastWrittenHash)
    return;

  lastWrittenHash = currentHash;

  const path = getStatusFilePath();
  const dir = GLib.path_get_dirname(path);

  GLib.mkdir_with_parents(dir, 0o755);
  GLib.file_set_contents(path, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function readStatusSnapshot() {
  try {
    const [ok, contents] = GLib.file_get_contents(getStatusFilePath());

    if (!ok)
      return null;

    const json = new TextDecoder().decode(contents);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
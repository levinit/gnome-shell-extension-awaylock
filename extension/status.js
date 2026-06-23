import GLib from 'gi://GLib';

function getStateDir() {
  return GLib.get_user_state_dir();
}

export function getStatusFilePath() {
  return GLib.build_filenamev([getStateDir(), 'awaylock', 'status.json']);
}

export function writeStatusSnapshot(snapshot) {
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
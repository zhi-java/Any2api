import { dirname, resolve } from 'path';

function packagedEntrypoint() {
  return process.pkg?.entrypoint || process.pkg?.defaultEntrypoint || null;
}

export function srcPath(...segments) {
  const entrypoint = packagedEntrypoint();
  if (entrypoint) {
    return resolve(dirname(entrypoint), ...segments);
  }

  return resolve(process.cwd(), 'src', ...segments);
}

export function appRootPath(...segments) {
  if (process.pkg) {
    return resolve(dirname(process.execPath), ...segments);
  }

  return resolve(process.cwd(), ...segments);
}

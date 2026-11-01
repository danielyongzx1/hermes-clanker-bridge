import * as fs from 'node:fs/promises';

/** Windows readers and scanners can briefly refuse atomic replacement. Keep the
 * previous complete state and retry the replacement, never delete it first. */
export async function writeState(file, body, io = fs, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.writeFile(file + '.tmp', body, { mode: 0o600 });
      await io.rename(file + '.tmp', file);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      await pause(Math.min(25 * 2 ** attempt, 800));
    }
  }
}

import { constants, existsSync, fstatSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const held = new WeakMap();
export function canonicalEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0'))
    throw new Error('An absolute evidence directory is required');
  let ancestor = resolve(directory); const tail = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor); tail.unshift(relative(parent, ancestor)); ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}

/** One existing kernel lock, shared by provider startup and owned initialization. */
export async function ownEvidenceDirectory(directory) {
  if (process.platform === 'win32') throw new Error('The metered provider currently requires a POSIX host');
  directory = canonicalEvidenceDirectory(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
  const path = join(directory, 'owner.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      await tryLockExclusive(handle.fd);
      const current = await stat(path, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      const info = await handle.stat({ bigint: true });
      if (current && info.ino === current.ino && info.dev === current.dev) {
        const record = { handle, path, directory, closed: false };
        const owner = Object.freeze({ directory, async close() {
          if (record.closed) return; record.closed = true; await handle.close();
        } });
        held.set(owner, record); return owner;
      }
    } catch (error) { await handle.close(); throw error; }
    await handle.close();
  }
  throw new Error('The transport evidence directory changed while acquiring ownership');
}

export function assertEvidenceOwnership(owner, directory) {
  const record = held.get(owner);
  if (!record || record.closed || record.directory !== canonicalEvidenceDirectory(directory))
    throw new Error('A live evidence-directory lease is required');
  const info = fstatSync(record.handle.fd, { bigint: true }), current = statSync(record.path, { bigint: true });
  if (info.ino !== current.ino || info.dev !== current.dev)
    throw new Error('The held evidence-directory lease was replaced');
}

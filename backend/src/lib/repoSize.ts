import { lstat, readdir } from 'fs/promises';
import path from 'path';

// Total size of a directory tree. Symlinks are counted as links, never followed.
// Stops early once `stopAfter` bytes are exceeded so a huge repo is rejected quickly.
export async function dirSizeBytes(dir: string, stopAfter = Infinity): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (total > stopAfter) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await lstat(p)).size;
    }
  };
  await walk(dir);
  return total;
}

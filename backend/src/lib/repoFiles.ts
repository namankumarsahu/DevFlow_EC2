import { lstat, readFile } from 'fs/promises';
import path from 'path';
import type { RepoFiles } from './detect';

const MAX_BYTES = 1024 * 1024;

// Reads files from a freshly cloned (untrusted) repo. Symlinks are treated as missing, so a repo cannot make
// the worker read its own files (e.g. a package.json -> /proc/self/environ), and big files are skipped.
export function fsRepoFiles(root: string): RepoFiles {
  const resolve = (rel: string) => path.join(root, rel);
  const regularFile = async (rel: string) => {
    try {
      const st = await lstat(resolve(rel));
      return st.isFile() && st.size <= MAX_BYTES;
    } catch {
      return false;
    }
  };
  return {
    exists: async (rel) => {
      try {
        const st = await lstat(resolve(rel));
        return !st.isSymbolicLink();
      } catch {
        return false;
      }
    },
    read: async (rel) => ((await regularFile(rel)) ? readFile(resolve(rel), 'utf8').catch(() => null) : null),
  };
}

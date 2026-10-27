import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

/** Bundles are directories directly under the configured root, named by one path segment. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type BundleLookup =
  { ok: true; dir: string } | { ok: false; reason: 'invalid_bundle_id' | 'bundle_not_found' };

/** Resolves an id to a real directory inside `root`; never follows a link out of it. */
export async function resolveBundle(root: string, id: string): Promise<BundleLookup> {
  if (!BUNDLE_ID.test(id) || id === '..') return { ok: false, reason: 'invalid_bundle_id' };
  const dir = join(root, id);
  try {
    if (!(await lstat(dir)).isDirectory()) return { ok: false, reason: 'bundle_not_found' };
    const [real, realRoot] = await Promise.all([realpath(dir), realpath(root)]);
    if (!real.startsWith(realRoot + sep)) return { ok: false, reason: 'bundle_not_found' };
  } catch {
    return { ok: false, reason: 'bundle_not_found' };
  }
  return { ok: true, dir };
}

/** Ids of the real directories under `root`, sorted; an absent root lists nothing. */
export async function listBundleIds(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && BUNDLE_ID.test(e.name))
    .map((e) => e.name)
    .sort();
}

import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDataDefaults } from '../src/app/data-dirs.ts';
import { writeSyntheticBundles } from '../src/evaluation/synthetic.ts';

/**
 * `pnpm demo:seed`: copies the synthetic evaluation bundles into the application's bundles
 * directory, so the console has something to list and validate. It adds only bundles that are
 * not already there, never overwrites or deletes, and touches nothing else. The bundles are
 * synthetic (src/evaluation/synthetic.ts); one of them is deliberately tampered, to show a
 * validation failure. No AI provider is involved.
 */
const target = withDataDefaults(process.env, homedir())['EOAI_BUNDLES_DIR'];
if (!target || !target.startsWith('/'))
  throw new Error('EOAI_BUNDLES_DIR must be an absolute path');
await mkdir(target, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(join(tmpdir(), 'eoai-seed-'));
try {
  const made = await writeSyntheticBundles(scratch);
  const existing = new Set(await readdir(target));
  for (const dir of [made.excerpt, made.fabricated, made.tampered]) {
    const name = dir.slice(scratch.length + 1);
    if (existing.has(name)) {
      console.log(`skipped (exists): ${name}`);
    } else {
      await cp(dir, join(target, name), { recursive: true, errorOnExist: true, force: false });
      console.log(`added: ${name}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

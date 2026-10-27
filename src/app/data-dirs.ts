import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppEnv } from './provider-gate.ts';

/**
 * Where the application keeps its data (ADR 0012). Nothing persistent lives in the repository:
 * by default bundles and runs sit under the user's home, in `~/.engineering-operations-ai/`.
 * `EOAI_DATA_DIR` moves that root, and `EOAI_BUNDLES_DIR` and `EOAI_RUNS_DIR` override each
 * directory; explicit values always win. This function only fills in what is missing.
 */
export const DEFAULT_DATA_DIRNAME = '.engineering-operations-ai';

export function withDataDefaults(env: AppEnv, home: string): AppEnv {
  const configured = env['EOAI_DATA_DIR']?.trim();
  // A relative or empty root is left for configuration validation to reject, not guessed at.
  const root =
    configured === undefined || configured === ''
      ? join(home, DEFAULT_DATA_DIRNAME)
      : isAbsolute(configured)
        ? resolve(configured)
        : configured;
  return {
    ...env,
    EOAI_BUNDLES_DIR: env['EOAI_BUNDLES_DIR'] || join(root, 'bundles'),
    EOAI_RUNS_DIR: env['EOAI_RUNS_DIR'] || join(root, 'runs'),
    // Beside an explicit runs directory the settings file follows it (see loadConfig), so a
    // test or an operator who sets the directories never reads the user's own settings.
    ...(env['EOAI_SETTINGS_FILE'] || env['EOAI_RUNS_DIR']
      ? {}
      : { EOAI_SETTINGS_FILE: join(root, 'settings.json') }),
  };
}

/**
 * Creates the bundles and runs directories when missing, private to the user (0700). It never
 * replaces, empties or deletes anything: an existing directory is left as it is, and a path
 * that exists but is not a directory is an error.
 */
export async function ensureDataDirs(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await stat(dir)).isDirectory()) throw new Error('a data path is not a directory');
  }
}

import { isAbsolute, resolve } from 'node:path';
import { gateProvider, type AppEnv, type GatedProvider } from './provider-gate.ts';
import type { FakeStep } from '../investigation/fake-provider.ts';

export class AppConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    // Problems name variables, never values.
    super(`invalid application configuration: ${problems.join('; ')}`);
    this.name = 'AppConfigError';
    this.problems = problems;
  }
}

export interface AppConfig {
  provider: GatedProvider;
  bundlesDir: string;
  runsDir: string;
}

function directory(env: AppEnv, name: string, problems: string[]): string {
  const value = env[name]?.trim() ?? '';
  if (value === '' || !isAbsolute(value)) {
    problems.push(`${name} must be set to an absolute path`);
    return '';
  }
  return resolve(value);
}

/**
 * Validates the whole configuration without touching the filesystem or any provider. The
 * provider policy is checked first, so a refused provider is reported before anything else.
 */
export function loadConfig(env: AppEnv, options: { fakeSteps?: FakeStep[] } = {}): AppConfig {
  const provider = gateProvider(env, options);
  const problems: string[] = [];
  const bundlesDir = directory(env, 'EOAI_BUNDLES_DIR', problems);
  const runsDir = directory(env, 'EOAI_RUNS_DIR', problems);
  if (problems.length > 0) throw new AppConfigError(problems);
  return { provider, bundlesDir, runsDir };
}

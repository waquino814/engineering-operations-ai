import { dirname, isAbsolute, join, resolve } from 'node:path';
import { OllamaEndpointError, resolveOllamaEndpoint } from '../providers/ollama/client.ts';
import { pinnedProvider, type AppEnv, type ProviderName } from './provider-gate.ts';

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
  bundlesDir: string;
  runsDir: string;
  settingsFile: string;
  /** Set by EOAI_MODEL_PROVIDER; the Settings page cannot change it. */
  pinned: ProviderName | null;
  /** A validated loopback endpoint; Ollama is not contacted until a status check or a run. */
  ollamaUrl: URL;
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
export function loadConfig(env: AppEnv): AppConfig {
  const pinned = pinnedProvider(env);
  const problems: string[] = [];
  const bundlesDir = directory(env, 'EOAI_BUNDLES_DIR', problems);
  const runsDir = directory(env, 'EOAI_RUNS_DIR', problems);
  const explicit = env['EOAI_SETTINGS_FILE']?.trim();
  const settingsFile =
    explicit === undefined || explicit === ''
      ? runsDir === ''
        ? ''
        : join(dirname(runsDir), 'settings.json')
      : directory(env, 'EOAI_SETTINGS_FILE', problems);
  let ollamaUrl = new URL('http://127.0.0.1:11434/');
  try {
    ollamaUrl = resolveOllamaEndpoint(env['EOAI_OLLAMA_URL']);
  } catch (e) {
    if (!(e instanceof OllamaEndpointError)) throw e;
    problems.push('EOAI_OLLAMA_URL must be http on a loopback address');
  }
  if (problems.length > 0) throw new AppConfigError(problems);
  return { bundlesDir, runsDir, settingsFile, pinned, ollamaUrl };
}

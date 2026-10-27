import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MODEL_NAME } from '../providers/ollama/verify.ts';
import { isProviderName, type ProviderName } from './provider-gate.ts';

/**
 * The persisted provider choice (ADR 0013, section 4): one small JSON file in the data
 * directory, validated against a closed shape on every read and write. It holds a provider name
 * and an installed model's name, and nothing else: no secret, no URL, no path, no command. An
 * invalid file is an error, never a guess. Writes are atomic and private to the user.
 */
export interface Settings {
  provider: ProviderName;
  ollamaModel: string | null;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  provider: 'fake',
  ollamaModel: null,
});

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sameKeys = (o: Json, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);

/** A request body: exactly `provider`, and optionally `ollamaModel`. */
export function parseSettingsInput(value: unknown): Settings | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.includes('provider') || keys.some((k) => k !== 'provider' && k !== 'ollamaModel'))
    return null;
  const model = value['ollamaModel'] ?? null;
  if (!isProviderName(value['provider'])) return null;
  if (
    model !== null &&
    (typeof model !== 'string' || !MODEL_NAME.test(model) || /cloud/i.test(model))
  )
    return null;
  return { provider: value['provider'], ollamaModel: model };
}

export async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw new SettingsError('the settings file could not be read');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new SettingsError('the settings file is not valid JSON');
  }
  if (
    !isObject(doc) ||
    !sameKeys(doc, ['version', 'provider', 'ollamaModel']) ||
    doc['version'] !== 1
  )
    throw new SettingsError('the settings file has an unexpected shape');
  const parsed = parseSettingsInput({ provider: doc['provider'], ollamaModel: doc['ollamaModel'] });
  if (!parsed) throw new SettingsError('the settings file holds an invalid value');
  return parsed;
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`, {
    mode: 0o600,
    flag: 'w',
  });
  await rename(tmp, file);
}

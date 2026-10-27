import type { OllamaHttp } from './client.ts';

/**
 * Local-only verification of an Ollama model (ADR 0013, section 2). It runs before any prompt is
 * sent, using only read-only metadata calls (`/api/tags`, `/api/show`), and fails closed: a model
 * is accepted only if it is installed, carries real weights, has no remote marker, and every
 * field of both metadata documents is one this code knows. An unknown field (a future remote or
 * cloud marker, say) blocks the model rather than being guessed at.
 *
 * What this establishes: the model named is a locally installed model whose weights are on this
 * machine, served by a runtime on a loopback address that reports its cloud features as
 * **disabled** (`GET /api/status`, `{"cloud":{"disabled":true,...}}`). Loopback and local
 * weights alone do not show that a runtime cannot reach a hosted service, so a runtime whose
 * cloud features are enabled, or that does not report them, is blocked before any prompt. This
 * is the runtime's own report of its own setting: it is not proof about its code or network, and
 * it is read once per investigation, not monitored. The application never changes Ollama's
 * settings; the operator does, and the message says how.
 */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** Real weights are far larger; a stub that merely points elsewhere would not be. */
const MIN_WEIGHTS_BYTES = 10_000_000;

/** Exactly what `GET /api/status` reports about cloud features (Ollama 0.40, checked 2026-10-27). */
export const CLOUD_DISABLE_HELP =
  'To use a local model, disable Ollama\'s cloud features yourself (set OLLAMA_NO_CLOUD=1, or "disable_ollama_cloud": true in ~/.ollama/server.json) and restart Ollama. This application never changes Ollama\'s settings.';

const TAGS_KEYS = new Set([
  'name',
  'model',
  'modified_at',
  'size',
  'digest',
  'details',
  'capabilities',
]);
const SHOW_KEYS = new Set([
  'license',
  'modelfile',
  'parameters',
  'template',
  'system',
  'renderer',
  'parser',
  'template_source',
  'details',
  'model_info',
  'capabilities',
  'modified_at',
  'requires',
  'thinking',
  'messages',
  'projector_info',
]);

declare const verified: unique symbol;
/** A model that passed verification; the only thing the chat adapter accepts. */
export interface VerifiedLocalModel {
  readonly [verified]: true;
  readonly name: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export type LocalModelCode =
  | 'ollama_unreachable'
  | 'bad_response'
  | 'cloud_not_disabled'
  | 'cloud_status_unknown'
  | 'no_models'
  | 'model_not_selected'
  | 'model_not_installed'
  | 'not_verifiably_local';

export type LocalModelCheck =
  | { ok: true; model: VerifiedLocalModel; installed: string[] }
  | { ok: false; code: LocalModelCode; message: string; installed: string[] };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const unknownKeys = (o: Json, allowed: Set<string>) =>
  Object.keys(o).filter((k) => !allowed.has(k));

export function installedModels(body: unknown): string[] | null {
  if (!isObject(body) || !Array.isArray(body['models'])) return null;
  const names: string[] = [];
  for (const m of body['models'] as unknown[]) {
    if (!isObject(m) || typeof m['name'] !== 'string') return null;
    names.push(m['name']);
  }
  return names;
}

export async function verifyLocalModel(
  http: OllamaHttp,
  wanted: string | null,
  signal?: AbortSignal,
): Promise<LocalModelCheck> {
  const fail = (
    code: LocalModelCode,
    message: string,
    installed: string[] = [],
  ): LocalModelCheck => ({
    ok: false,
    code,
    message,
    installed,
  });
  let tags;
  try {
    tags = await http.get('/api/tags', signal);
  } catch {
    return fail(
      'ollama_unreachable',
      `Ollama is not reachable at ${http.endpoint}. Start Ollama, then retry. Nothing was run.`,
    );
  }
  const installed = tags.status === 200 ? installedModels(tags.body) : null;
  if (installed === null)
    return fail(
      'bad_response',
      'Ollama answered, but not with a model list this application understands. Nothing was run.',
    );
  if (installed.length === 0)
    return fail(
      'no_models',
      'Ollama has no installed model. Install one yourself; this application never downloads models.',
      installed,
    );

  // The runtime's own report of its cloud setting, before any model is considered.
  let status;
  try {
    status = await http.get('/api/status', signal);
  } catch {
    return fail(
      'ollama_unreachable',
      `Ollama stopped answering at ${http.endpoint}. Nothing was run.`,
      installed,
    );
  }
  const cloud =
    isObject(status.body) && Object.keys(status.body).length === 1
      ? status.body['cloud']
      : undefined;
  if (
    status.status !== 200 ||
    !isObject(cloud) ||
    typeof cloud['disabled'] !== 'boolean' ||
    typeof cloud['source'] !== 'string' ||
    Object.keys(cloud).length !== 2
  )
    return fail(
      'cloud_status_unknown',
      `This Ollama does not report whether its cloud features are disabled in a form this application understands, so it cannot be shown to be local-only. Nothing was sent. ${CLOUD_DISABLE_HELP}`,
      installed,
    );
  if (!cloud['disabled'])
    return fail(
      'cloud_not_disabled',
      `Ollama's cloud features are enabled on this machine (source: ${cloud['source'] === 'none' ? 'not set' : cloud['source'].slice(0, 40)}), so a prompt could be routed to a hosted service; local-only operation cannot be shown. Nothing was sent. ${CLOUD_DISABLE_HELP}`,
      installed,
    );

  const name = wanted ?? (installed.length === 1 ? (installed[0] ?? null) : null);
  if (name === null)
    return fail(
      'model_not_selected',
      'Several models are installed: choose one in Settings.',
      installed,
    );
  if (!MODEL_NAME.test(name) || /cloud/i.test(name))
    return fail(
      'not_verifiably_local',
      'That model name is not accepted as a local model.',
      installed,
    );
  if (!installed.includes(name))
    return fail(
      'model_not_installed',
      `Model "${name}" is not installed in Ollama. Nothing was run.`,
      installed,
    );

  const entry = ((tags.body as Json)['models'] as Json[]).find((m) => m['name'] === name) ?? {};
  const blocked = (why: string) =>
    fail(
      'not_verifiably_local',
      `Model "${name}" could not be verified as local-only (${why}). It stays blocked; nothing was sent to it.`,
      installed,
    );
  if (unknownKeys(entry, TAGS_KEYS).length > 0)
    return blocked('its model entry has fields this application does not recognise');
  const size = entry['size'];
  const digest = entry['digest'];
  if (
    typeof size !== 'number' ||
    size < MIN_WEIGHTS_BYTES ||
    typeof digest !== 'string' ||
    digest === ''
  )
    return blocked('its weights are not present on this machine');

  let show;
  try {
    show = await http.post('/api/show', { model: name }, signal);
  } catch {
    return fail(
      'ollama_unreachable',
      `Ollama stopped answering at ${http.endpoint}. Nothing was run.`,
      installed,
    );
  }
  if (show.status !== 200 || !isObject(show.body) || !isObject(show.body['model_info']))
    return blocked('its metadata could not be read');
  if (unknownKeys(show.body, SHOW_KEYS).length > 0)
    return blocked('its metadata has fields this application does not recognise');
  const details = show.body['details'];
  if (isObject(details) && Object.keys(details).some((k) => /remote|cloud/i.test(k)))
    return blocked('its details carry a remote marker');

  return { ok: true, model: { name, digest, sizeBytes: size } as VerifiedLocalModel, installed };
}

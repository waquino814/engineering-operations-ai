import { readInvestigationResult } from '../../investigation/result.ts';
import type {
  BundleIssue,
  CitationCheck,
  BundleOption,
  BundleValidation,
  InvestigationDataSource,
  InvestigationRecord,
  ProviderSettings,
  StartOutcome,
  Unavailable,
} from './types.ts';

/**
 * The console's data source over the local application's HTTP API (ADR 0012). Every result is
 * checked with the contract reader before the console sees it, and every failure (network, status,
 * malformed body) becomes an error the views show as one; a failed request is never turned into
 * data. It only calls same-origin `/api/` paths and carries no credential.
 */
export class ApiError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

function parseSettings(b: Json): ProviderSettings {
  if (
    (b['provider'] !== 'fake' && b['provider'] !== 'ollama') ||
    (b['ollamaModel'] !== null && typeof b['ollamaModel'] !== 'string') ||
    typeof b['pinned'] !== 'boolean'
  )
    throw new ApiError('The settings response is malformed.');
  return { provider: b['provider'], ollamaModel: b['ollamaModel'], pinned: b['pinned'] };
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function createHttpSource(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  base = '',
): InvestigationDataSource {
  async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch {
      throw new ApiError('The local application could not be reached. Is it running?');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A proxy in front of an absent application (Vite's dev proxy, for one) answers with an
      // empty text/plain 502, 503 or 504. Say what that means; it is still an error.
      if (GATEWAY_STATUSES.has(response.status))
        throw new ApiError(
          `The local application is not reachable (HTTP ${String(response.status)}). Start it with "pnpm serve", then retry.`,
          'application_unreachable',
        );
      throw new ApiError(
        `The local application sent an unreadable response (HTTP ${String(response.status)}).`,
      );
    }
    if (!isObject(body)) throw new ApiError('The local application sent an unexpected response.');
    return { status: response.status, body };
  }
  const errorOf = (body: Json): { code: string | null; message: string } => {
    const e = body['error'];
    return isObject(e) && typeof e['message'] === 'string'
      ? { code: typeof e['code'] === 'string' ? e['code'] : null, message: e['message'] }
      : { code: null, message: 'The local application reported an error.' };
  };
  const ok = async (path: string): Promise<Json> => {
    const { status, body } = await call(path);
    if (status !== 200) {
      const e = errorOf(body);
      throw new ApiError(e.message, e.code);
    }
    return body;
  };

  async function fetchRun(id: string): Promise<InvestigationRecord | null> {
    const { status, body } = await call(`/api/runs/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) {
      const e = errorOf(body);
      throw new ApiError(e.message, e.code);
    }
    const read = readInvestigationResult(body['result']);
    if (!read.ok) throw new ApiError(`Run ${id} is not a valid investigation result.`);
    return {
      id,
      label: `Run ${id}`,
      bundleId: read.result.caseId ?? '',
      origin: 'local',
      result: read.result,
    };
  }

  return {
    description: {
      mode: 'local',
      notice:
        'Connected to the local application on this machine. It never calls a hosted model: runs are simulated (fake) or use a verified local Ollama model.',
    },
    async getProviderStatus() {
      const b = await ok('/api/status');
      if (
        (b['selected'] !== 'fake' && b['selected'] !== 'ollama') ||
        typeof b['pinned'] !== 'boolean' ||
        typeof b['runnable'] !== 'boolean' ||
        typeof b['simulated'] !== 'boolean' ||
        (b['model'] !== null && typeof b['model'] !== 'string') ||
        !Array.isArray(b['models']) ||
        !b['models'].every((m) => typeof m === 'string') ||
        (b['reason'] !== null && typeof b['reason'] !== 'string')
      )
        throw new ApiError('The status response is malformed.');
      return {
        selected: b['selected'],
        pinned: b['pinned'],
        runnable: b['runnable'],
        simulated: b['simulated'],
        model: b['model'],
        models: b['models'],
        reason: b['reason'],
      };
    },
    async getEvidence(id) {
      const b = await ok(`/api/runs/${encodeURIComponent(id)}/evidence`);
      if (b['status'] === 'unavailable') {
        const reason = b['reason'];
        if (
          reason !== 'not_admitted' &&
          reason !== 'no_bundle_recorded' &&
          reason !== 'bundle_not_found'
        )
          throw new ApiError('The evidence response is malformed.');
        return { status: 'unavailable', reason };
      }
      const list = b['citations'];
      if (b['status'] !== 'checked' || !Array.isArray(list))
        throw new ApiError('The evidence response is malformed.');
      const statuses = [
        'verified',
        'file_changed',
        'line_missing',
        'identity_mismatch',
        'unreadable',
      ];
      const citations: CitationCheck[] = list.map((c: unknown) => {
        if (
          !isObject(c) ||
          typeof c['findingId'] !== 'string' ||
          typeof c['file'] !== 'string' ||
          typeof c['line'] !== 'number' ||
          typeof c['status'] !== 'string' ||
          !statuses.includes(c['status']) ||
          (c['excerpt'] !== null && typeof c['excerpt'] !== 'string') ||
          typeof c['truncated'] !== 'boolean' ||
          !Array.isArray(c['issues']) ||
          !c['issues'].every((i) => typeof i === 'string')
        )
          throw new ApiError('The evidence response is malformed.');
        return c as unknown as CitationCheck;
      });
      return { status: 'checked', citations };
    },
    async getSettings() {
      return parseSettings(await ok('/api/settings'));
    },
    async saveSettings(input) {
      const { status, body } = await call('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (status !== 200) {
        const e = errorOf(body);
        throw new ApiError(e.message, e.code);
      }
      return parseSettings(body);
    },
    async listInvestigations() {
      const body = await ok('/api/runs');
      if (!Array.isArray(body['runs'])) throw new ApiError('The run list is malformed.');
      const ids = (body['runs'] as unknown[]).flatMap((r) =>
        isObject(r) && r['ok'] === true && typeof r['id'] === 'string' ? [r['id']] : [],
      );
      const records = await Promise.all(ids.map(fetchRun));
      return records
        .filter((r): r is InvestigationRecord => r !== null)
        .sort((a, b) => b.result.run.startedAt.localeCompare(a.result.run.startedAt));
    },
    getInvestigation: fetchRun,
    async listBundles(): Promise<BundleOption[]> {
      const body = await ok('/api/bundles');
      if (!Array.isArray(body['bundles'])) throw new ApiError('The bundle list is malformed.');
      return (body['bundles'] as unknown[]).flatMap((b) =>
        isObject(b) && typeof b['id'] === 'string'
          ? [
              {
                id: b['id'],
                label: b['id'],
                description: 'A bundle in the configured bundles directory.',
                origin: 'local' as const,
              },
            ]
          : [],
      );
    },
    async validateBundle(bundleId): Promise<BundleValidation> {
      const body = await ok(`/api/bundles/${encodeURIComponent(bundleId)}/validation`);
      if (
        typeof body['valid'] !== 'boolean' ||
        !Array.isArray(body['issues']) ||
        (body['schemaVersion'] !== null && typeof body['schemaVersion'] !== 'string')
      )
        throw new ApiError('The validation response is malformed.');
      const metadata = body['metadata'];
      if (metadata !== null && !isObject(metadata))
        throw new ApiError('The validation response is malformed.');
      return {
        bundleId,
        valid: body['valid'],
        schemaVersion: body['schemaVersion'],
        issues: body['issues'] as BundleIssue[],
        metadata: metadata as BundleValidation['metadata'],
      };
    },
    uploadBundle: (): Promise<Unavailable> =>
      Promise.resolve({
        status: 'unavailable',
        reason:
          'Uploading a bundle is not supported. Bundles are read from the local bundles directory.',
      }),
    async startInvestigation(bundleId): Promise<StartOutcome> {
      let result: { status: number; body: Json };
      try {
        result = await call('/api/investigations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bundleId }),
        });
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : 'The request failed.' };
      }
      const { status, body } = result;
      if (status === 201 && typeof body['runId'] === 'string')
        return { status: 'started', investigationId: body['runId'] };
      const e = errorOf(body);
      // A policy refusal is an expected, stable answer: nothing ran, and nothing is shown as a result.
      if (e.code === 'no_runnable_provider')
        return { status: 'unavailable', reason: e.message, fixtureInvestigationIds: [] };
      return { status: 'error', message: e.message };
    },
  };
}

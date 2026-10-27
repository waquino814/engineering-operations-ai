import {
  ProviderError,
  type ModelProvider,
  type ModelReply,
  type ModelRequest,
} from './provider.ts';
import { MODEL_OUTPUT_VERSION } from './schemas.ts';

/**
 * The deterministic simulated provider: the `fake` option of the application. It exercises the
 * whole workflow (selection, request, verification, persistence, history) on any bundle, and it
 * is not an investigator. It reads no telemetry for meaning: it cites the first record of each
 * telemetry file that the request carried, quoting identifiers exactly, and says in every field
 * it writes that the output is simulated. It reports `symptom` findings with `low` confidence
 * only, never a root cause. No network, no clock, no randomness: the same request gives the same
 * reply.
 */
export const SIMULATED_MODEL = 'simulated-deterministic-v1';
const NOTICE =
  'SIMULATED by the deterministic fake provider (simulated-deterministic-v1): no analysis was performed and this is not AI-generated.';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const COMPONENT = /^[a-z][a-z0-9-]*$/;

interface Carried {
  file: string;
  line: number;
  record: unknown;
}

function reference(c: Carried): Json | null {
  const r = isObject(c.record) ? c.record : {};
  if (c.file === 'logs.jsonl')
    return typeof r['time'] === 'string' && typeof r['service'] === 'string'
      ? { file: c.file, line: c.line, time: r['time'], service: r['service'] }
      : null;
  if (c.file === 'metrics.jsonl')
    return typeof r['name'] === 'string' && isObject(r['labels'])
      ? { file: c.file, line: c.line, series: { name: r['name'], labels: r['labels'] } }
      : null;
  if (c.file === 'traces.jsonl') {
    const spans = (r['resourceSpans'] as unknown[] | undefined)
      ?.flatMap((rs) => (isObject(rs) ? (rs['scopeSpans'] ?? []) : []))
      .flatMap((ss) => (isObject(ss) ? (ss['spans'] ?? []) : []));
    const first = spans?.[0];
    return isObject(first) && typeof first['traceId'] === 'string'
      ? { file: c.file, line: c.line, traceId: first['traceId'] }
      : null;
  }
  return null;
}

export class SimulatedProvider implements ModelProvider {
  readonly provider = 'fake';
  readonly model = SIMULATED_MODEL;

  complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply> {
    if (options.signal.aborted)
      return Promise.reject(new ProviderError('timeout', 'request aborted'));
    let input: unknown;
    try {
      input = JSON.parse(request.input);
    } catch {
      return Promise.reject(new ProviderError('rejected_request', 'the request input is not JSON'));
    }
    const carried: Carried[] =
      isObject(input) && Array.isArray(input['evidence'])
        ? (input['evidence'] as unknown[]).flatMap((e) =>
            isObject(e) && typeof e['file'] === 'string' && typeof e['line'] === 'number'
              ? [{ file: e['file'], line: e['line'], record: e['record'] }]
              : [],
          )
        : [];
    const firsts = ['logs.jsonl', 'metrics.jsonl', 'traces.jsonl']
      .map((f) => carried.find((c) => c.file === f))
      .flatMap((c) => (c ? [c] : []));
    const refs: Json[] = firsts.flatMap((c) => {
      const r = reference(c);
      return r ? [r] : [];
    });
    const counts = ['logs.jsonl', 'metrics.jsonl', 'traces.jsonl']
      .map((f) => `${String(carried.filter((c) => c.file === f).length)} from ${f}`)
      .join(', ');

    const schemaVersion = MODEL_OUTPUT_VERSION;
    const output =
      refs.length === 0
        ? {
            schemaVersion,
            outcome: 'inconclusive',
            findings: [],
            remediation: [],
            limitations: [NOTICE, 'The request carried no telemetry record that could be cited.'],
          }
        : {
            schemaVersion,
            outcome: 'completed',
            findings: [
              {
                id: 'SIM1',
                kind: 'symptom',
                statement: `SIMULATED: the request carried ${counts}. The records cited are the first of each file, chosen mechanically.`,
                components: [
                  ...new Set(
                    refs.flatMap((r) =>
                      typeof r['service'] === 'string' && COMPONENT.test(r['service'])
                        ? [r['service']]
                        : [],
                    ),
                  ),
                ],
                confidence: 'low',
                rationale: 'Simulated: chosen by position, not by meaning. It is not a diagnosis.',
                evidence: refs,
              },
            ],
            remediation: [
              {
                step: 'SIMULATED: this run only exercises the workflow. Choose the Ollama provider for a real investigation, or read the cited records yourself.',
                addresses: ['SIM1'],
              },
            ],
            limitations: [NOTICE],
          };
    return Promise.resolve({ text: JSON.stringify(output) });
  }
}

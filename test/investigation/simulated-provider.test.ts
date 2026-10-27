import { describe, expect, it } from 'vitest';
import { createInvestigator } from '../../src/index.ts';
import { ProviderError } from '../../src/investigation/provider.ts';
import { readInvestigationResult } from '../../src/investigation/result.ts';
import { SIMULATED_MODEL, SimulatedProvider } from '../../src/investigation/simulated-provider.ts';
import { excerptView, fabricatedView } from './support.ts';

const req = (input: unknown) => ({
  instructions: 'x',
  input: typeof input === 'string' ? input : JSON.stringify(input),
  outputSchema: {},
  maxOutputTokens: 1,
});
const signal = () => new AbortController().signal;
interface Out {
  outcome: string;
  findings: { kind: string; confidence: string; components: string[]; evidence: unknown[] }[];
  limitations: string[];
}
const reply = async (input: unknown) =>
  JSON.parse(
    (await new SimulatedProvider().complete(req(input), { signal: signal() })).text,
  ) as Out;

describe('the simulated provider', () => {
  it('identifies itself as fake and simulated', () => {
    const p = new SimulatedProvider();
    expect([p.provider, p.model]).toEqual(['fake', SIMULATED_MODEL]);
  });

  it('cites only records the request carried, quotes their identifiers, and claims no root cause', async () => {
    const out = await reply({
      evidence: [
        { file: 'logs.jsonl', line: 3, record: { time: 't1', service: 'api' } },
        { file: 'logs.jsonl', line: 4, record: { time: 't2', service: 'worker' } },
        { file: 'metrics.jsonl', line: 2, record: { name: 'm', labels: { a: 'b' } } },
        {
          file: 'traces.jsonl',
          line: 5,
          record: { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'abc' }] }] }] },
        },
        { file: 'other.jsonl', line: 1, record: {} },
      ],
    });
    expect(out.outcome).toBe('completed');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      kind: 'symptom',
      confidence: 'low',
      components: ['api'],
    });
    expect(out.findings[0]?.evidence).toEqual([
      { file: 'logs.jsonl', line: 3, time: 't1', service: 'api' },
      { file: 'metrics.jsonl', line: 2, series: { name: 'm', labels: { a: 'b' } } },
      { file: 'traces.jsonl', line: 5, traceId: 'abc' },
    ]);
    expect(JSON.stringify(out)).toContain('SIMULATED');
  });

  it('is deterministic: the same request gives the same reply', async () => {
    const input = {
      evidence: [{ file: 'logs.jsonl', line: 1, record: { time: 't', service: 's' } }],
    };
    expect(await reply(input)).toEqual(await reply(input));
  });

  it('is inconclusive when nothing can be cited, ignoring records it cannot quote', async () => {
    for (const input of [
      { evidence: [] },
      {},
      {
        evidence: [
          { file: 'logs.jsonl', line: 1, record: {} },
          { file: 'metrics.jsonl', line: 1, record: 4 },
          { file: 'traces.jsonl', line: 1, record: { resourceSpans: [] } },
          'x',
          { line: 2 },
        ],
      },
    ]) {
      const out = await reply(input);
      expect(out.outcome).toBe('inconclusive');
      expect(out.findings).toEqual([]);
      expect(out.limitations[0]).toContain('SIMULATED');
    }
  });

  it('rejects input that is not JSON and an already aborted call', async () => {
    const p = new SimulatedProvider();
    await expect(p.complete(req('{oops'), { signal: signal() })).rejects.toMatchObject({
      kind: 'rejected_request',
    });
    const c = new AbortController();
    c.abort();
    const e = await p.complete(req({}), { signal: c.signal }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
  });

  it('passes the real investigator on the synthetic bundles, so its output is verified like any other', async () => {
    for (const view of [await excerptView(), await fabricatedView()]) {
      const result = await createInvestigator({
        provider: new SimulatedProvider(),
        now: () => 0,
      }).investigate(view);
      expect(result.outcome).toBe('completed');
      expect(readInvestigationResult(result).ok).toBe(true);
      expect(result.findings[0]?.verification).toMatchObject({
        referenceExists: 'verified',
        semanticSupport: 'not_assessed',
      });
      expect(result.run).toMatchObject({ provider: 'fake', model: SIMULATED_MODEL });
    }
  });
});

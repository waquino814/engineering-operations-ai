import { describe, expect, it } from 'vitest';
import { parseModelOutput } from '../../src/index.ts';
import { MAX_REPLY_BYTES } from '../../src/investigation/result.ts';
import { excerptView, goodOutput } from './support.ts';

/** ADR 0007: model output is untrusted; nothing is defaulted, repaired or invented. */
describe('model output parsing', () => {
  it('accepts a valid output unchanged', async () => {
    const output = goodOutput(await excerptView());
    expect(parseModelOutput(JSON.stringify(output))).toEqual({ ok: true, output });
  });

  it('rejects malformed JSON, non-objects and oversized replies', () => {
    expect(parseModelOutput('{"schemaVersion": "0.1.0",')).toMatchObject({
      ok: false,
      problems: [{ code: 'malformed_json' }],
    });
    expect(parseModelOutput('Here is my analysis: {}')).toMatchObject({
      ok: false,
      problems: [{ code: 'malformed_json' }],
    });
    for (const text of ['[]', '"text"', 'null', '42']) {
      expect(parseModelOutput(text), text).toMatchObject({
        ok: false,
        problems: [{ code: 'not_an_object' }],
      });
    }
    expect(parseModelOutput(`"${'x'.repeat(MAX_REPLY_BYTES)}"`)).toMatchObject({
      ok: false,
      problems: [{ code: 'reply_too_large' }],
    });
  });

  it('rejects missing and unsupported result versions before anything else', async () => {
    const view = await excerptView();
    for (const version of [undefined, '1.0.0', '0.2.0', 0.1]) {
      const output = { ...goodOutput(view), schemaVersion: version };
      expect(parseModelOutput(JSON.stringify(output)), String(version)).toMatchObject({
        ok: false,
        problems: [{ code: 'unsupported_result_version', field: 'schemaVersion' }],
      });
    }
  });

  it('rejects unknown fields at any level', async () => {
    const view = await excerptView();
    const out = goodOutput(view) as unknown as {
      findings: Record<string, unknown>[];
      verified?: boolean;
    };
    out.verified = true;
    (out.findings[0] as Record<string, unknown>).support = 'confirmed';
    const parsed = parseModelOutput(JSON.stringify(out));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((p) => [p.code, p.field])).toEqual([
      ['schema_violation', 'verified'],
      ['schema_violation', 'findings.0.support'],
    ]);
  });

  it('rejects invalid confidence, findings without evidence and unknown kinds', async () => {
    const view = await excerptView();
    const base = goodOutput(view);
    const cases: [object, string][] = [
      [
        { ...base, findings: [{ ...base.findings[0], confidence: 'certain' }] },
        'findings.0.confidence',
      ],
      [{ ...base, findings: [{ ...base.findings[0], confidence: 0.9 }] }, 'findings.0.confidence'],
      [{ ...base, findings: [{ ...base.findings[0], evidence: [] }] }, 'findings.0.evidence'],
      [{ ...base, findings: [{ ...base.findings[0], kind: 'hunch' }] }, 'findings.0.kind'],
      [{ ...base, outcome: 'done' }, 'outcome'],
      [
        { ...base, findings: [{ ...base.findings[0], components: ['Not A Component'] }] },
        'findings.0.components.0',
      ],
    ];
    for (const [output, field] of cases) {
      const parsed = parseModelOutput(JSON.stringify(output));
      expect(!parsed.ok && parsed.problems.map((p) => p.field), field).toContain(field);
    }
  });
});

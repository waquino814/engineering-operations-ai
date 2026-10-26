import { describe, expect, it } from 'vitest';
import type { InvestigationResult } from '../../src/investigation/result.ts';
import type { UiFixtures } from '../../src/ui/data/types.ts';
import committed from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };
import {
  affectedComponents,
  evidenceTimeline,
  formatNumber,
  formatTime,
  issueLocation,
  KIND_LABELS,
  limitRows,
  outcomeView,
  plural,
  referenceIdentity,
  rootCauseSummary,
  RULE_HINTS,
  shortHash,
  tokenView,
  VERIFICATION_LABELS,
  verificationText,
} from '../../src/ui/model.ts';

/** What the console derives from results: nothing more than the result says. */
const result = (id: string): InvestigationResult => {
  const r = (committed as UiFixtures).investigations.find((i) => i.id === id)?.result;
  if (!r) throw new Error(`no fixture ${id}`);
  return r;
};

describe('outcome', () => {
  it('distinguishes all five states, with what each means', () => {
    expect(
      ['fx-001', 'fx-003', 'fx-006', 'fx-007', 'fx-008'].map((id) => outcomeView(result(id)).key),
    ).toEqual(['completed', 'inconclusive', 'failed', 'budget_exceeded', 'not_admitted']);
    expect(outcomeView(result('fx-001'))).toEqual({
      key: 'completed',
      label: 'Completed',
      meaning: 'The investigation concluded with 2 findings.',
    });
    expect(outcomeView(result('fx-005')).meaning).toBe(
      'The investigation concluded with 2 findings.',
    );
    expect(outcomeView(result('fx-003')).meaning).toMatch(/ran correctly/);
    expect(outcomeView(result('fx-007')).label).toBe('Budget exceeded');
    expect(outcomeView(result('fx-006')).label).toBe('Failed');
    expect(outcomeView(result('fx-008')).label).toBe('Not admitted');
  });

  it('pluralizes', () => {
    expect(plural(1, 'finding')).toBe('1 finding');
    expect(plural(0, 'finding')).toBe('0 findings');
    expect(plural(2, 'retry', 'retries')).toBe('2 retries');
  });
});

describe('findings', () => {
  it('takes the root cause from the first root-cause finding, or none', () => {
    expect(rootCauseSummary(result('fx-001'))).toBe(
      'Payment provider lookups fail, so payments cannot be confirmed.',
    );
    expect(rootCauseSummary(result('fx-003'))).toBeNull();
  });

  it('lists components, root causes first, with the kinds that name them', () => {
    expect(affectedComponents(result('fx-005'))).toEqual([
      { name: 'cache-node', kinds: ['root_cause'] },
      { name: 'orders-api', kinds: ['affected_component'] },
    ]);
    expect(affectedComponents(result('fx-006'))).toEqual([]);
    expect(KIND_LABELS.root_cause).toBe('Root cause');
  });

  it('shows every identifier a reference quotes', () => {
    expect(
      referenceIdentity({
        file: 'metrics.jsonl',
        line: 1,
        series: { name: 'm', labels: { a: '1', b: '2' } },
        samples: [[10, '0.5']],
        sha256: 'f'.repeat(64),
      }),
    ).toEqual([
      ['Series', 'm{a="1", b="2"}'],
      ['Samples', '10: 0.5'],
      ['File SHA-256', 'ffffffffffff…'],
    ]);
    expect(referenceIdentity({ file: 'logs.jsonl', line: 2, time: 't', service: 's' })).toEqual([
      ['Time', 't'],
      ['Service', 's'],
    ]);
    expect(
      referenceIdentity({
        file: 'traces.jsonl',
        line: 3,
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
      }),
    ).toEqual([
      ['Trace', 'a'.repeat(32)],
      ['Span', 'b'.repeat(16)],
    ]);
    expect(shortHash('0123456789abcdef')).toBe('0123456789ab…');
  });

  it('never words semantic support as verified', () => {
    expect(verificationText('verified')).toBe('Verified');
    expect(verificationText('not_assessed')).toBe('Not assessed');
    expect(verificationText('something_else')).toBe('something_else');
    expect(Object.keys(VERIFICATION_LABELS)).toEqual([
      'referenceExists',
      'identityMatches',
      'integrity',
      'includedInRequest',
      'semanticSupport',
    ]);
    expect(VERIFICATION_LABELS.semanticSupport.detail).toMatch(/not checked/);
  });
});

describe('the evidence timeline', () => {
  it('orders cited log times and quoted metric samples; traces quote no time', () => {
    const base = result('fx-001');
    const finding = base.findings[0];
    if (!finding) throw new Error('no finding');
    const r: InvestigationResult = {
      ...base,
      findings: [
        {
          ...finding,
          id: 'F9',
          evidence: [
            { file: 'logs.jsonl', line: 1, time: '2026-01-01T00:00:05.000Z', service: 'api' },
            { file: 'logs.jsonl', line: 2, time: '2026-01-01T00:00:01.000Z' },
            {
              file: 'metrics.jsonl',
              line: 3,
              series: { name: 'errors', labels: {} },
              samples: [[1767225603, '4']],
            },
            { file: 'metrics.jsonl', line: 4, samples: [[1767225602, '1']] },
            { file: 'traces.jsonl', line: 5, traceId: 'a'.repeat(32) },
          ],
        },
      ],
    };
    expect(evidenceTimeline(r).map((e) => [e.time, e.what])).toEqual([
      ['2026-01-01T00:00:01.000Z', 'log record from an unnamed service'],
      ['2026-01-01T00:00:02.000Z', 'metric = 1'],
      ['2026-01-01T00:00:03.000Z', 'errors = 4'],
      ['2026-01-01T00:00:05.000Z', 'log record from api'],
    ]);
    expect(evidenceTimeline(result('fx-003'))).toEqual([]);
  });
});

describe('tokens and limits', () => {
  it('reports reported and charged tokens against the budget', () => {
    expect(tokenView(result('fx-001'))).toEqual({
      reportedInput: 6_200,
      reportedOutput: 410,
      charged: 6_610,
      budget: 816_000,
      share: 6_610 / 816_000,
      accounting: 'reported',
      unreportedCalls: 0,
      inconsistentReports: 0,
    });
    expect(tokenView(result('fx-007'))).toMatchObject({
      budget: 204_000,
      share: 1,
      accounting: 'estimated',
      unreportedCalls: 1,
    });
  });

  it('has no budget or limit rows when the configuration was invalid', () => {
    const invalid = { ...result('fx-008'), run: { ...result('fx-008').run, limits: {} } };
    expect(tokenView(invalid)).toMatchObject({ budget: null, share: null });
    expect(limitRows(invalid)).toBeNull();
    expect(limitRows(result('fx-001'))).toContainEqual(['maxTotalTokens', 816_000]);
  });

  it('formats numbers and UTC times independently of locale', () => {
    expect(formatNumber(816000)).toBe('816,000');
    expect(formatTime('2026-10-26T09:00:00.250Z')).toBe('2026-10-26 09:00:00 UTC');
  });
});

describe('validation issues', () => {
  it('locate each issue and say what to do about every rule', () => {
    expect(
      issueLocation({
        rule: 4,
        ruleId: 'jsonl-records',
        file: 'logs.jsonl',
        line: 1,
        message: 'm',
      }),
    ).toBe('logs.jsonl · line 1');
    expect(
      issueLocation({
        rule: 9,
        ruleId: 'file-integrity',
        file: 'logs.jsonl',
        field: 'files.logs.jsonl.sha256',
        message: 'm',
      }),
    ).toBe('logs.jsonl · files.logs.jsonl.sha256');
    expect(
      issueLocation({ rule: 1, ruleId: 'files-present', file: null, field: '', message: 'm' }),
    ).toBe('bundle directory');
    expect(Object.keys(RULE_HINTS)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});

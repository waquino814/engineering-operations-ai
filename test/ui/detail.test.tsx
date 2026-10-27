// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { readInvestigationResult } from '../../src/investigation/result.ts';
import type { InvestigationRecord } from '../../src/ui/data/types.ts';
import { deferred, investigation, renderAt, sourceWith } from './support.tsx';

/** Screen C: one investigation, in each of its states. */
const open = async (id: string, source = sourceWith({})) => {
  renderAt(`#/investigations/${id}`, source);
  return screen.findByRole('region', { name: 'Outcome' });
};
const region = (name: string) => screen.getByRole('region', { name });

describe('a completed investigation', () => {
  it('shows the outcome, root cause and affected components', async () => {
    const banner = await open('fx-001');
    expect(banner.textContent).toContain('Completed');
    expect(banner.textContent).toContain('concluded with 2 findings');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^Case [0-9a-f]{16}$/);
    const summary = region('Summary');
    expect(summary.textContent).toContain(
      'Payment provider lookups fail, so payments cannot be confirmed.',
    );
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['payment-provider root cause', 'worker']);
    const subtitle = document.querySelector('.page__subtitle');
    expect(subtitle?.textContent).toBe('Scripted reply · Fixture · Simulated · scripted');
  });

  it('shows each finding with its evidence and every verification statement', async () => {
    await open('fx-001');
    const findings = region('Findings');
    const items = within(findings)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('finding'));
    expect(items).toHaveLength(2);
    const first = items[0] as HTMLElement;
    expect(first.textContent).toContain('Root cause');
    expect(first.textContent).toContain('Confidence: medium');
    expect(first.textContent).toContain('Rationale:');
    const evidence = within(first).getByRole('table', { name: 'Evidence for F1' });
    const rows = within(evidence).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toMatch(/^metrics\.jsonl1Series:/);
    expect(rows[1]?.textContent).toMatch(/^logs\.jsonl3Time:.*Service:/);
    const checks = within(first)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('check'))
      .map((li) => [
        li.querySelector('.check__label')?.textContent,
        li.querySelector('.check__value')?.textContent,
      ]);
    expect(checks).toEqual([
      ['Reference exists', 'Verified'],
      ['Identity matches', 'Verified'],
      ['Integrity', 'Verified'],
      ['Included in request', 'Verified'],
      ['Semantic support', 'Not assessed'],
    ]);
    // No numeric confidence or probability anywhere in the findings.
    expect(findings.textContent).not.toMatch(/\d+(\.\d+)?\s*%|probability:/i);
    expect(findings.textContent).not.toMatch(/Semantic support\s*Verified/);
  });

  it('shows remediation as advice, the evidence timeline, run usage and diagnostics', async () => {
    await open('fx-001');
    expect(region('Recommended remediation').textContent).toContain('Advice only');
    expect(region('Recommended remediation').textContent).toContain('(addresses F1, F2)');
    expect(within(region('Evidence timeline')).getAllByRole('listitem')[0]?.textContent).toContain(
      'log record from worker',
    );
    const run = region('Run');
    expect(run.textContent).toContain('Simulated · scripted');
    expect(run.textContent).toContain('1 (0 retries, 0 repairs)');
    expect(run.textContent).toContain('6,200 in · 410 out');
    expect(run.textContent).toContain('6,610 of 816,000 budget');
    expect(run.textContent).toContain('Accounting: reported.');
    expect(within(run).getByRole('meter', { name: 'Token budget used' })).toBeDefined();
    const diagnostics = region('Diagnostics');
    expect(
      within(diagnostics).getByRole('table', { name: 'Evidence selection by file' }).textContent,
    ).toContain('logs.jsonl');
    expect(diagnostics.textContent).toContain('maxTotalTokens816,000');
    expect(diagnostics.textContent).not.toContain('Failure class');
    expect(region('Limitations').textContent).toContain('None stated.');
  });

  it('notes omitted records and selection notes when the capture was cut', async () => {
    const base = investigation('fx-005');
    const selection = base.result.selection;
    if (!selection) throw new Error('no selection');
    const record: InvestigationRecord = {
      ...base,
      origin: 'fixture',
      result: {
        ...base.result,
        selection: {
          ...selection,
          files: {
            ...selection.files,
            'logs.jsonl': {
              ...selection.files['logs.jsonl'],
              omitted: { record_limit: 2, context_limit: 0, record_too_large: 1, repeated: 0 },
            },
          },
          notes: ['Trace capture for orders-api was truncated (service_cap).'],
        },
      },
    };
    await open('fx-005', sourceWith({ getInvestigation: () => Promise.resolve(record) }));
    const diagnostics = region('Diagnostics');
    expect(diagnostics.textContent).toContain('2 record limit, 1 record too large');
    expect(diagnostics.textContent).toContain('Trace capture for orders-api was truncated');
  });
});

describe('the other outcomes', () => {
  it('shows an inconclusive investigation as valid, with its limitations and no findings', async () => {
    const banner = await open('fx-003');
    expect(banner.textContent).toContain('Inconclusive');
    expect(banner.textContent).toContain('ran correctly');
    expect(banner.textContent).not.toContain(':'); // no failure line
    expect(region('Findings').textContent).toContain('the evidence did not support a conclusion');
    expect(region('Limitations').textContent).toContain('shows no failing component');
    expect(region('Summary').textContent).toContain('No root cause stated');
    expect(region('Evidence timeline').textContent).toContain('No cited evidence quotes a time.');
    expect(screen.queryByRole('region', { name: 'Recommended remediation' })).toBeNull();
  });

  it('shows a failed run with its failure class and message, and nothing found', async () => {
    const banner = await open('fx-006');
    expect(banner.textContent).toContain('Failed');
    expect(banner.textContent).toContain('provider_unavailable: unavailable after 2 retries');
    expect(region('Findings').textContent).toContain('the run did not complete');
    expect(region('Run').textContent).toContain('3 (2 retries, 0 repairs)');
    expect(region('Run').textContent).toContain(
      'Accounting: estimated. 3 calls without a valid usage report were charged',
    );
    expect(region('Diagnostics').textContent).toContain('Failure classprovider_unavailable');
    expect(region('Summary').textContent).toContain('None named');
  });

  it('shows a run stopped by its token budget distinctly', async () => {
    const banner = await open('fx-007');
    expect(banner.textContent).toContain('Budget exceeded');
    expect(banner.textContent).toContain('A limit stopped the run');
    expect(banner.textContent).toContain('resource_limit_exceeded');
    expect(banner.className).toContain('banner--budget_exceeded');
    expect(region('Run').textContent).toContain('204,000 of 204,000 budget');
    expect(region('Run').textContent).toContain('1 call without a valid usage report was charged');
  });

  it('shows a refused bundle as not admitted, with no case or selection', async () => {
    const banner = await open('fx-008');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Investigation not admitted',
    );
    expect(banner.textContent).toContain('Not admitted');
    expect(banner.textContent).toContain('invalid_bundle');
    expect(region('Diagnostics').textContent).toContain('the run stopped before selection');
  });

  it('shows a repaired run with its repair count', async () => {
    await open('fx-002');
    expect(region('Run').textContent).toContain('2 (0 retries, 1 repair)');
  });

  it('says when an invalid configuration left no limits or budget', async () => {
    // The pipeline's invalid-configuration result has the not-admitted fixture's shape, with
    // its own class and no limits; it must still be a valid result.
    const base = investigation('fx-008');
    const result = {
      ...base.result,
      failure: { class: 'invalid_configuration' as const, message: 'invalid limits' },
      run: { ...base.result.run, limits: {} },
    };
    expect(readInvestigationResult(result).ok).toBe(true);
    const record: InvestigationRecord = {
      id: 'cfg',
      label: 'Bad limits',
      bundleId: 'bundle-a',
      origin: 'fixture',
      result,
    };
    await open('cfg', sourceWith({ getInvestigation: () => Promise.resolve(record) }));
    expect(region('Diagnostics').textContent).toContain(
      'Not recorded: the configuration was invalid.',
    );
    expect(region('Run').textContent).toContain('Tokens charged0');
    expect(within(region('Run')).queryByRole('meter')).toBeNull();
  });

  it('reports inconsistent usage reports in the accounting note', async () => {
    const base = investigation('fx-001');
    const record: InvestigationRecord = {
      ...base,
      origin: 'fixture',
      result: {
        ...base.result,
        run: {
          ...base.result.run,
          usage: { ...base.result.run.usage, inconsistentReports: 1, tokenAccounting: 'estimated' },
        },
      },
    };
    await open('fx-001', sourceWith({ getInvestigation: () => Promise.resolve(record) }));
    expect(region('Run').textContent).toContain(
      '0 calls without a valid usage report were charged at the call ceiling; 1 report exceeded a ceiling.',
    );
  });
});

describe('loading, errors and missing investigations', () => {
  it('shows loading, then the investigation', async () => {
    const pending = deferred<InvestigationRecord | null>();
    renderAt('#/investigations/fx-001', sourceWith({ getInvestigation: () => pending.promise }));
    expect(screen.getByRole('status').textContent).toContain('Loading the investigation');
    await act(async () => {
      pending.resolve(null);
      await pending.promise;
    });
    expect(screen.getByText('Investigation not found')).toBeDefined();
  });

  it('says when no investigation has the id, with a way back', async () => {
    renderAt('#/investigations/fx-999');
    expect(await screen.findByText('Investigation not found')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Back to investigations' }).getAttribute('href')).toBe(
      '#/investigations',
    );
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('fx-999'),
    ).toBeDefined();
  });

  it('shows an error with a retry', async () => {
    const get = vi
      .fn<() => Promise<InvestigationRecord | null>>()
      .mockRejectedValueOnce(new Error('not readable'))
      .mockResolvedValueOnce(null);
    renderAt('#/investigations/fx-001', sourceWith({ getInvestigation: get }));
    expect((await screen.findByRole('alert')).textContent).toContain('not readable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Investigation not found')).toBeDefined();
  });
});

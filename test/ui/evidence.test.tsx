// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CitationCheck, EvidenceReport } from '../../src/ui/data/types.ts';
import { deferred, investigation, renderAt, sourceWith } from './support.tsx';

/** The detail page re-checks a saved run's citations against the bundle and shows the text. */
const cite = (over: Partial<CitationCheck>): CitationCheck => ({
  findingId: 'F1',
  file: 'metrics.jsonl',
  line: 1,
  status: 'verified',
  excerpt: '{"name":"commerce_payment_calls_total"}',
  truncated: false,
  issues: [],
  ...over,
});
const open = (report: Promise<EvidenceReport> | (() => Promise<EvidenceReport>), id = 'fx-001') => {
  const getEvidence = vi.fn(typeof report === 'function' ? report : () => report);
  renderAt(`#/investigations/${id}`, sourceWith({ getEvidence }));
  return getEvidence;
};

describe('citation re-check on the detail page', () => {
  it('shows the verification count and the cited record next to each reference', async () => {
    const evidence = investigation('fx-001').result.findings[0]?.evidence ?? [];
    const citations = evidence.map((e) =>
      cite({ file: e.file, line: e.line, excerpt: `{"line":${String(e.line)}}` }),
    );
    const getEvidence = open(
      Promise.resolve({
        status: 'checked',
        citations: [...citations, cite({ findingId: 'F2', file: 'traces.jsonl', line: 1 })],
      }),
    );
    const note = await screen.findByText(/citations verified/);
    expect(note.closest('p')?.textContent).toContain(
      'Re-checked against the original bundle just now, without running a model',
    );
    expect(note.closest('p')?.textContent).toContain('not assessed');
    expect(getEvidence).toHaveBeenCalledWith('fx-001');
    expect(screen.getAllByText('Cited record').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Verified: the record is at this line/).length).toBeGreaterThan(0);
    expect(screen.getByText('{"line":1}')).toBeDefined();
  });

  it('flags citations that no longer hold, with the reason and without text from a changed file', async () => {
    open(
      Promise.resolve({
        status: 'checked',
        citations: [
          cite({
            status: 'file_changed',
            excerpt: null,
            issues: ['metrics.jsonl no longer matches the checksum the run recorded'],
          }),
          cite({
            file: 'logs.jsonl',
            line: 3,
            status: 'identity_mismatch',
            issues: ['line 3 has service "api"'],
            truncated: true,
          }),
          cite({ findingId: 'F2', file: 'traces.jsonl', status: 'line_missing', excerpt: null }),
        ],
      }),
    );
    const note = await screen.findByText(/citations verified/);
    expect(note.textContent).toBe('0 of 3 citations verified');
    expect(note.closest('p')?.className).toContain('notice--error');
    expect(
      screen.getByText(/Not verified: the bundle file has changed since the run/),
    ).toBeDefined();
    expect(screen.getByText(/does not match the identifiers quoted/)).toBeDefined();
    expect(screen.getByText(/no record at this line/)).toBeDefined();
    expect(screen.getByText('line 3 has service "api"')).toBeDefined();
    expect(screen.getByText(/The record is longer; the start is shown/)).toBeDefined();
    // Text is shown only for a record whose file is unchanged.
    expect(screen.getAllByText('Cited record')).toHaveLength(1);
  });

  it.each([
    ['not_admitted', /no citations to re-check/],
    ['no_bundle_recorded', /did not record which bundle/],
    ['bundle_not_found', /no longer in the bundles directory/],
    ['fixture', /Fixture runs have no bundle/],
  ] as const)('says plainly why it cannot re-check (%s)', async (reason, text) => {
    open(Promise.resolve({ status: 'unavailable', reason }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByText(/citations verified/)).toBeNull();
    // The citations themselves are still shown, as quoted by the result.
    expect(screen.getAllByText('metrics.jsonl').length).toBeGreaterThan(0);
  });

  it('shows a failed check as an error with a retry, and checks again on request', async () => {
    const getEvidence = vi.fn<() => Promise<EvidenceReport>>(() =>
      Promise.reject(new Error('down')),
    );
    renderAt('#/investigations/fx-001', sourceWith({ getEvidence }));
    expect((await screen.findByText(/could not be re-checked: down/)).textContent).toContain(
      'down',
    );
    getEvidence.mockImplementation(() =>
      Promise.resolve({ status: 'checked', citations: [cite({})] }),
    );
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 of 1 citations verified')).toBeDefined();
    getEvidence.mockImplementation(() => Promise.resolve({ status: 'checked', citations: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('0 of 0 citations verified')).toBeDefined();
    expect(getEvidence).toHaveBeenCalledTimes(3);
  });

  it('waits visibly, and asks nothing for a run that has no findings', async () => {
    const pending = deferred<EvidenceReport>();
    open(() => pending.promise);
    expect(await screen.findByText(/check against the bundle/)).toBeDefined();
    pending.resolve({ status: 'unavailable', reason: 'fixture' });
    const none = open(
      () => Promise.resolve({ status: 'unavailable', reason: 'fixture' } as const),
      'fx-003',
    );
    await screen.findByText('Inconclusive', { selector: 'span, h1, p' }).catch(() => undefined);
    expect(none).not.toHaveBeenCalled();
  });
});

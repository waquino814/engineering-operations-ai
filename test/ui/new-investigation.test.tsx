// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BundleOption, BundleValidation } from '../../src/ui/data/types.ts';
import { deferred, renderAt, sourceWith } from './support.tsx';

/** Screen B: choose or upload, validate, then start only from a valid bundle. */
const panel = (name: string) => screen.getByRole('region', { name });
const choose = async (label: string) => {
  fireEvent.click(await screen.findByRole('radio', { name: new RegExp(label) }));
};

describe('choosing and validating a bundle', () => {
  it('lists the fixture bundles, marked as fixtures, and asks for a choice first', async () => {
    renderAt('#/new');
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(panel('1. Bundle').textContent).toContain('Fixture bundle A');
    expect(panel('1. Bundle').textContent).toContain('Fixture');
    expect(panel('2. Validation').textContent).toContain('Choose a bundle to validate it');
    expect(
      within(panel('3. Start')).getByRole('button', { name: 'Start investigation' }),
    ).toHaveProperty('disabled', true);
  });

  it("shows a valid bundle's blinded metadata and allows starting", async () => {
    renderAt('#/new');
    await choose('Fixture bundle A');
    const validation = panel('2. Validation');
    expect(
      await within(validation).findByText(/^Valid: the bundle meets all nine contract rules/),
    ).toBeDefined();
    expect(validation.textContent).toContain('Contract version1.0.0');
    expect(validation.textContent).toMatch(/Case ID[0-9a-f]{16}/);
    expect(validation.textContent).toContain('orders-api');
    expect(
      within(validation).getByRole('table', { name: 'Telemetry files' }).textContent,
    ).toContain('logs.jsonl');
    expect(validation.textContent).toContain('Trace capture');
    // No scenario-bearing manifest fields are shown.
    expect(validation.textContent).not.toMatch(/provider-outage|bundleId|seed/);
    const start = within(panel('3. Start')).getByRole('button', { name: 'Start investigation' });
    expect(start).toHaveProperty('disabled', false);
    expect(panel('3. Start').textContent).toContain('The bundle is valid and can be investigated.');
  });

  it('shows actionable errors for an invalid bundle and does not allow starting', async () => {
    renderAt('#/new');
    await choose('Fixture bundle C');
    const validation = panel('2. Validation');
    expect(await within(validation).findByText('Invalid: 4 issues found.')).toBeDefined();
    const issues = within(validation).getByRole('table', { name: 'Validation issues' });
    const rows = within(issues).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('4 jsonl-records');
    expect(rows[0]?.textContent).toContain('logs.jsonl · line 1');
    expect(rows[0]?.textContent).toContain('malformed JSON');
    expect(rows[0]?.textContent).toContain('Regenerate the bundle');
    expect(rows[1]?.textContent).toContain('9 file-integrity');
    expect(rows[1]?.textContent).toContain('restore the original files');
    expect(validation.textContent).toContain('Case ID—');
    expect(
      within(panel('3. Start')).getByRole('button', { name: 'Start investigation' }),
    ).toHaveProperty('disabled', true);
    expect(panel('3. Start').textContent).toContain('only from a valid bundle');
  });

  it('explains an unsupported contract version', async () => {
    renderAt('#/new');
    await choose('Fixture bundle D');
    const validation = panel('2. Validation');
    expect(await within(validation).findByText('Invalid: 1 issue found.')).toBeDefined();
    expect(validation.textContent).toContain('2 supported-major-version');
    expect(validation.textContent).toContain('supported contract major version');
  });

  it('shows loading while validating, and an error if validation fails', async () => {
    const pending = deferred<BundleValidation>();
    renderAt('#/new', sourceWith({ validateBundle: () => pending.promise }));
    await choose('Fixture bundle A');
    expect(within(panel('2. Validation')).getByRole('status').textContent).toContain(
      'Loading validation',
    );
    await act(async () => {
      pending.reject(new Error('validator crashed'));
      await pending.promise.catch(() => undefined);
    });
    expect(within(panel('2. Validation')).getByRole('alert').textContent).toContain(
      'validator crashed',
    );
  });

  it('reports a non-Error validation failure as text', async () => {
    renderAt(
      '#/new',
      // A data source might reject with a plain value; the view must still say something useful.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      sourceWith({ validateBundle: () => Promise.reject('refused') }),
    );
    await choose('Fixture bundle A');
    expect((await within(panel('2. Validation')).findByRole('alert')).textContent).toContain(
      'refused',
    );
  });

  it('shows loading and error states for the bundle list', async () => {
    const pending = deferred<BundleOption[]>();
    const list = vi
      .fn<() => Promise<BundleOption[]>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([]);
    renderAt('#/new', sourceWith({ listBundles: list }));
    expect(within(panel('1. Bundle')).getByRole('status').textContent).toContain('Loading bundles');
    await act(async () => {
      pending.reject(new Error('no bundles'));
      await pending.promise.catch(() => undefined);
    });
    fireEvent.click(within(panel('1. Bundle')).getByRole('button', { name: 'Retry' }));
    expect(await within(panel('1. Bundle')).findByRole('group')).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('starting and uploading', () => {
  it('says starting needs the E6 boundary, and links to the fixture results for the bundle', async () => {
    renderAt('#/new');
    await choose('Fixture bundle A');
    await within(panel('2. Validation')).findByText(/^Valid/);
    fireEvent.click(within(panel('3. Start')).getByRole('button', { name: 'Start investigation' }));
    const notice = await within(panel('3. Start')).findByRole('status');
    expect(notice.textContent).toContain('Starting an investigation');
    expect(notice.textContent).toContain('application/API boundary planned for milestone E6');
    expect(
      within(notice)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '#/investigations/fx-001',
      '#/investigations/fx-002',
      '#/investigations/fx-003',
      '#/investigations/fx-004',
    ]);
  });

  it('shows no fixture links when the bundle has none', async () => {
    renderAt(
      '#/new',
      sourceWith({
        validateBundle: (bundleId) =>
          Promise.resolve({
            bundleId,
            valid: true,
            schemaVersion: '1.0.0',
            issues: [],
            metadata: null,
          }),
      }),
    );
    await choose('Fixture bundle D');
    await within(panel('2. Validation')).findByText(/^Valid/);
    fireEvent.click(within(panel('3. Start')).getByRole('button', { name: 'Start investigation' }));
    const notice = await within(panel('3. Start')).findByRole('status');
    expect(within(notice).queryAllByRole('link')).toEqual([]);
  });

  it('links to the new investigation when a data source can start one', async () => {
    renderAt(
      '#/new',
      sourceWith({
        startInvestigation: () => Promise.resolve({ status: 'started', investigationId: 'run-42' }),
      }),
    );
    await choose('Fixture bundle B');
    await within(panel('2. Validation')).findByText(/^Valid/);
    fireEvent.click(within(panel('3. Start')).getByRole('button', { name: 'Start investigation' }));
    const link = await within(panel('3. Start')).findByRole('link', { name: 'run-42' });
    expect(link.getAttribute('href')).toBe('#/investigations/run-42');
  });

  it('says uploading needs the E6 boundary, and ignores an empty selection', async () => {
    const base = sourceWith({});
    const upload = vi.fn((files: readonly File[]) => base.uploadBundle(files));
    renderAt('#/new', sourceWith({ uploadBundle: upload }));
    await screen.findAllByRole('radio');
    const input = screen.getByLabelText("Or upload a bundle's files");
    fireEvent.change(input, { target: { files: [] } });
    expect(upload).not.toHaveBeenCalled();
    const file = new File(['{}'], 'manifest.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    const notice = await within(panel('1. Bundle')).findByRole('status');
    expect(notice.textContent).toContain('Uploading a bundle');
    expect(notice.textContent).toContain('milestone E6');
    expect(upload).toHaveBeenCalledWith([file]);
  });

  it('confirms an upload when a data source accepts one', async () => {
    renderAt(
      '#/new',
      sourceWith({
        uploadBundle: () => Promise.resolve({ status: 'uploaded', bundleId: 'upload-1' }),
      }),
    );
    await screen.findAllByRole('radio');
    fireEvent.change(screen.getByLabelText("Or upload a bundle's files"), {
      target: { files: [new File(['x'], 'logs.jsonl')] },
    });
    expect((await within(panel('1. Bundle')).findByRole('status')).textContent).toBe(
      'Uploaded as upload-1.',
    );
  });
});

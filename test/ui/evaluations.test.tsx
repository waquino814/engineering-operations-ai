// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  EvaluationComparisonView,
  EvaluationDetailView,
  EvaluationEntryView,
  EvaluationStartOutcome,
  EvaluationSuite,
} from '../../src/ui/data/types.ts';
import { deferred, renderAt, sourceWith } from './support.tsx';

/** The Evaluations pages, over real evaluation documents produced by the real harness. */
type EvaluationRun = EvaluationDetailView;
let scripted: EvaluationRun;
let simulated: EvaluationRun;
beforeAll(async () => {
  const out = await promisify(execFile)(
    process.execPath,
    [join(process.cwd(), 'test/ui/make-evaluations.ts')],
    { maxBuffer: 20_000_000 },
  );
  ({ scripted, simulated } = JSON.parse(out.stdout) as {
    scripted: EvaluationRun;
    simulated: EvaluationRun;
  });
}, 60_000);

const suites: EvaluationSuite[] = [
  {
    id: 'development',
    version: '1',
    split: 'development',
    description: 'The provider-outage excerpt with scripted replies.',
    cases: [{ id: 'excerpt-correct', scenario: 'provider-outage' }],
  },
  {
    id: 'held-out',
    version: '1',
    split: 'held-out',
    description:
      'An invented scenario that no prompt, selection or scoring code was written against.',
    cases: [{ id: 'fabricated-correct', scenario: 'synthetic-cache-saturation' }],
  },
];
const entry = (r: EvaluationRun): EvaluationEntryView => ({
  id: r.id,
  ok: true,
  suite: r.suite,
  provider: r.provider,
  measuresModelQuality: r.measuresModelQuality,
  startedAt: r.startedAt,
  status: r.status,
  headline: { cases: r.report.cases.length, rootCauseCorrect: '3/7', completion: '6/8' },
});
const view = (r: EvaluationRun): EvaluationDetailView => r;
/** What the application answers for two stored runs (the comparison itself is tested with the harness). */
const cmp = (a: EvaluationRun, b: EvaluationRun): EvaluationComparisonView => ({
  suite: { id: a.suite.id, version: a.suite.version },
  a: { id: a.id, provider: a.provider },
  b: { id: b.id, provider: b.provider },
  sameProvider: a.provider.kind === b.provider.kind,
  metrics: [
    { id: 'root_cause_correct', label: 'Root cause correct', a: 0.429, b: 0, delta: -0.429 },
  ],
  cases: [
    {
      id: 'excerpt-correct',
      change: 'regressed',
      a: 'completed; root cause correct',
      b: 'completed; root cause missing',
    },
    {
      id: 'excerpt-wrong-root-cause',
      change: 'improved',
      a: 'completed; root cause incorrect',
      b: 'completed; root cause correct',
    },
    { id: 'excerpt-inconclusive', change: 'unchanged', a: 'x', b: 'x' },
  ],
  regressions: 1,
  improvements: 1,
});

describe('the evaluations list and the start form', () => {
  const open = (over: Parameters<typeof sourceWith>[0] = {}) =>
    renderAt(
      '#/evaluations',
      sourceWith({
        listEvaluationSuites: () => Promise.resolve(suites),
        listEvaluations: () => Promise.resolve([entry(simulated), entry(scripted)]),
        ...over,
      }),
    );

  it('shows stored runs with what produced them, and links to each', async () => {
    open();
    const table = await screen.findByRole('table', { name: 'Stored evaluations, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Simulated · simulated-deterministic-v1');
    expect(rows[1]?.textContent).toContain('Scripted test double');
    expect(rows[1]?.textContent).toContain('development v1');
    expect(rows[1]?.textContent).toContain('3/7');
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`#/evaluations/${scripted.id}`);
    expect(screen.getByRole('main').textContent).toContain('test the pipeline, not a model');
  });

  it('says it is empty, lists unreadable files by name, and retries a failed list', async () => {
    open({ listEvaluations: () => Promise.resolve([]) });
    expect(await screen.findByText('No evaluations yet')).toBeDefined();
    document.body.innerHTML = '';
  });

  it('starts a scripted evaluation and links to the stored result', async () => {
    const start = vi.fn((): Promise<EvaluationStartOutcome> =>
      Promise.resolve({ status: 'started', id: scripted.id }),
    );
    open({ startEvaluation: start });
    fireEvent.click(await screen.findByRole('button', { name: 'Run evaluation' }));
    expect(
      (await screen.findByRole('link', { name: scripted.id, hidden: false })).getAttribute('href'),
    ).toContain(scripted.id);
    expect(start).toHaveBeenCalledWith({ suiteId: 'development', provider: 'scripted' });
  });

  it('offers the three reply sources, the held-out suite, and sends what was chosen', async () => {
    const start = vi.fn((): Promise<EvaluationStartOutcome> =>
      Promise.resolve({ status: 'started', id: simulated.id }),
    );
    open({ startEvaluation: start });
    const suite = await screen.findByLabelText('Suite');
    fireEvent.change(suite, { target: { value: 'held-out' } });
    expect(screen.getByText(/invented scenario/)).toBeDefined();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual([
      'scripted',
      'simulated',
      'ollama',
    ]);
    fireEvent.click(screen.getByRole('radio', { name: /Simulated provider/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    await screen.findByText(/Stored:/);
    expect(start).toHaveBeenCalledWith({ suiteId: 'held-out', provider: 'simulated' });
  });

  it('shows a refused Ollama evaluation as "cannot run", with no fallback and nothing stored', async () => {
    const reason = "Ollama's cloud features are enabled on this machine. Nothing was sent.";
    const start = vi.fn((): Promise<EvaluationStartOutcome> =>
      Promise.resolve({ status: 'refused', message: reason }),
    );
    open({ startEvaluation: start });
    fireEvent.click(await screen.findByRole('radio', { name: /Ollama \(real local model\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    const notice = (await screen.findByText(/This evaluation cannot run/)).closest('div');
    expect(notice?.textContent).toContain(reason);
    expect(notice?.textContent).toContain('no fallback');
    expect(screen.queryByText(/Stored:/)).toBeNull();
  });

  it('shows the running state, and a failed start as an alert', async () => {
    const answer = deferred<EvaluationStartOutcome>();
    const start = vi.fn(() => answer.promise);
    open({ startEvaluation: start });
    fireEvent.click(await screen.findByRole('button', { name: 'Run evaluation' }));
    expect(await screen.findByRole('button', { name: 'Running…' })).toHaveProperty(
      'disabled',
      true,
    );
    answer.resolve({ status: 'error', message: 'an investigation is already running' });
    expect((await screen.findByRole('alert')).textContent).toContain('already running');
    start.mockImplementation(() => Promise.reject(new Error('connection lost')));
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    await vi.waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('connection lost');
    });
  });

  it('shows errors loading suites and the list, and a console without suites', async () => {
    open({
      listEvaluationSuites: () => Promise.reject(new Error('suites down')),
      listEvaluations: () => Promise.reject(new Error('list down')),
    });
    expect(await screen.findByText('suites down')).toBeDefined();
    expect(await screen.findByText('list down')).toBeDefined();
    document.body.innerHTML = '';
    open({ listEvaluationSuites: () => Promise.resolve([]) });
    expect(await screen.findByText(/no evaluation suites to run/)).toBeDefined();
  });

  it('lists an unreadable stored file and does not hide it', async () => {
    open({
      listEvaluations: () =>
        Promise.resolve([
          { id: '20260101T000000Z-development-scripted', ok: false, problems: ['not valid JSON'] },
        ]),
    });
    expect(await screen.findByText(/Unreadable: not valid JSON/)).toBeDefined();
  });
});

describe('an evaluation’s detail page', () => {
  const open = (
    run: EvaluationRun | null,
    others: EvaluationEntryView[] = [],
    over: Parameters<typeof sourceWith>[0] = {},
  ) =>
    renderAt(
      `#/evaluations/${run?.id ?? 'x'}`,
      sourceWith({
        getEvaluation: () => Promise.resolve(run === null ? null : view(run)),
        listEvaluations: () => Promise.resolve(others),
        ...over,
      }),
    );

  it('says a scripted run tests the pipeline, not a model, and shows every metric with its count and definition', async () => {
    open(scripted);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Evaluation: development v1' }),
    ).toBeDefined();
    const banner = screen.getByText('This evaluation tests the pipeline, not a model.');
    expect(banner.closest('div')?.textContent).toContain('no number below is model accuracy');
    expect(screen.getAllByText('Scripted test double').length).toBeGreaterThan(0);
    expect(screen.getByText('Measures model quality').nextSibling?.textContent).toBe('No');
    const metrics = screen.getByRole('table', {
      name: 'Aggregate metrics with numerators and denominators',
    });
    const row = (label: string) => within(metrics).getByText(label).closest('tr') as HTMLElement;
    expect(row('Root cause correct').textContent).toContain('42.9%');
    expect(row('Root cause correct').textContent).toContain('3 / 7');
    expect(row('Root cause correct').textContent).toContain(
      'Admitted cases whose single named root-cause',
    );
    expect(row('Investigations that reached a result').textContent).toContain('6 / 8');
    expect(row('Remediation quality').textContent).toContain('Not scored');
    expect(row('Remediation quality').textContent).toContain('no rubric');
    expect(
      screen.getByText(
        /Development split: prompts, selection and scoring were written looking at this scenario/,
      ),
    ).toBeDefined();
    expect(screen.getAllByText(/Missing for a full held-out evaluation/)).toBeDefined();
  });

  it('shows the scenario breakdown, reliability, and the reasons behind a failed or ambiguous case', async () => {
    open(scripted);
    const scenarios = await screen.findByRole('table', { name: 'Results by scenario' });
    expect(within(scenarios).getByText('provider-outage (seed 42)')).toBeDefined();
    expect(within(scenarios).getByText('Not admitted (no scenario)')).toBeDefined();
    expect(screen.getByText('Provider timeouts').nextSibling?.textContent).toBe('0');
    expect(screen.getByText(/evidence_verification_failed: 1, invalid_bundle: 1/)).toBeDefined();
    const cases = screen.getByRole('table', { name: 'Each case, with the reason for its score' });
    const caseRow = (id: string) => within(cases).getByText(id).closest('tr') as HTMLElement;
    const ambiguous = caseRow('excerpt-conflicting-root-causes');
    expect(ambiguous.textContent).toContain('ambiguous');
    fireEvent.click(within(ambiguous).getByText('Reasons'));
    expect(ambiguous.textContent).toMatch(
      /Root cause ambiguous: 2 components named as the root cause/,
    );
    const failed = caseRow('excerpt-fabricated-evidence');
    expect(failed.textContent).toContain('evidence_verification_failed');
    fireEvent.click(within(failed).getByText('Reasons'));
    expect(failed.textContent).toMatch(/Failure: /);
    const tampered = caseRow('tampered-bundle');
    fireEvent.click(within(tampered).getByText('Reasons'));
    expect(tampered.textContent).toContain('Not scored: the bundle was not admitted');
  });

  it('marks a simulated run as a placeholder, and a real model’s run as describing only those bundles', async () => {
    open(simulated);
    expect(
      await screen.findByText('This evaluation tests the pipeline, not a model.'),
    ).toBeDefined();
    expect(screen.getAllByText(/Simulated · simulated-deterministic-v1/).length).toBeGreaterThan(0);
    document.body.innerHTML = '';
    const real = {
      ...structuredClone(scripted),
      provider: {
        kind: 'real_model' as const,
        provider: 'ollama',
        model: 'gemma4:12b',
        simulated: false,
      },
      measuresModelQuality: true,
      status: 'incomplete' as const,
      harnessErrors: [{ id: 'case-x', error: 'the harness could not evaluate this case' }],
    };
    open(real);
    expect(await screen.findByText('A real local model generated these replies.')).toBeDefined();
    expect(screen.getByText(/not an estimate of accuracy on real incidents/)).toBeDefined();
    expect(screen.getByText(/Incomplete:/)).toBeDefined();
    expect(screen.getByText(/The harness could not evaluate: case-x/)).toBeDefined();
    expect(screen.getAllByText('Real model · gemma4:12b').length).toBeGreaterThan(0);
  });

  it('shows a missing evaluation and a failed load, with a retry', async () => {
    open(null);
    expect(await screen.findByText('Evaluation not found')).toBeDefined();
    document.body.innerHTML = '';
    const getEvaluation = vi.fn(() => Promise.reject(new Error('down')));
    renderAt(
      '#/evaluations/x',
      sourceWith({
        getEvaluation: getEvaluation,
        listEvaluations: () => Promise.resolve([]),
      }),
    );
    expect(await screen.findByText('down')).toBeDefined();
    getEvaluation.mockImplementation(() => Promise.resolve(view(scripted)) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Evaluation: development v1')).toBeDefined();
  });

  it('compares with an earlier run of the same suite and shows regressions, flagging a different provider', async () => {
    const compare = vi.fn(() => Promise.resolve(cmp(simulated, scripted)));
    open(scripted, [entry(simulated), entry(scripted)], { compareEvaluations: compare });
    const select = await screen.findByLabelText('Earlier run (compared to this one)');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a run…', `${simulated.id} (simulated)`]);
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveProperty('disabled', true);
    fireEvent.change(select, { target: { value: simulated.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await screen.findByText(/regressed,/);
    expect(compare).toHaveBeenCalledWith(simulated.id, scripted.id);
    expect(screen.getByText(/used different providers or models/)).toBeDefined();
    expect(screen.getByRole('table', { name: 'Metric differences' })).toBeDefined();
    expect(screen.getAllByText('improved').length).toBeGreaterThan(0);
  });

  it('says there is nothing to compare with, and shows a failed comparison as an error', async () => {
    open(scripted, [entry(scripted)]);
    expect(await screen.findByText(/No other stored run of this suite and version/)).toBeDefined();
    document.body.innerHTML = '';
    open(scripted, [entry(simulated)], {
      compareEvaluations: () => Promise.reject(new Error('different suites')),
    });
    fireEvent.change(await screen.findByLabelText('Earlier run (compared to this one)'), {
      target: { value: simulated.id },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText('different suites')).toBeDefined();
  });
});

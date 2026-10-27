import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEvaluationRun } from '../../src/evaluation/document.ts';
import { runSuite, type EvaluationRun } from '../../src/evaluation/run.ts';
import { SplitViolation } from '../../src/evaluation/suites.ts';
import {
  isEntryPoint,
  main,
  USAGE,
  type SuiteCliDeps,
  type SuiteDocument,
} from '../../src/evaluation/suite-cli.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eoai-suite-cli-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Fixed time and a counting clock, so two invocations are byte for byte alike. */
const steady = (over: SuiteCliDeps = {}): SuiteCliDeps => {
  let tick = 0;
  return {
    now: () => new Date('2026-10-27T12:00:00Z'),
    clock: () => (tick += 5),
    ...over,
  };
};

async function invoke(args: string[], deps: SuiteCliDeps = steady()) {
  let out = '';
  let err = '';
  const code = await main(args, { write: (t) => (out += t) }, { write: (t) => (err += t) }, deps);
  return { code, out, err };
}

const document = (out: string) => JSON.parse(out) as SuiteDocument;

describe('the suite evaluation command', () => {
  it('runs every suite offline, validates each run, and passes its gate', async () => {
    const { code, out, err } = await invoke(['all']);
    expect([code, err]).toEqual([0, '']);
    const doc = document(out);
    expect(doc.gate).toEqual({ passed: true, problems: [] });
    expect(doc.runs.map((r) => [r.suite.id, r.suite.split, r.provider.kind])).toEqual([
      ['development', 'development', 'scripted'],
      ['held-out', 'held-out', 'scripted'],
    ]);
    for (const run of doc.runs) {
      expect(readEvaluationRun(run)).toEqual({ ok: true, run });
      expect(run.measuresModelQuality).toBe(false);
      expect(run.limitations.join(' ')).toContain('say nothing about any model');
      // Per-case and aggregate results are both present, and remediation stays unscored.
      expect(run.report.cases.length).toBeGreaterThan(0);
      expect(run.metrics.find((m) => m.id === 'remediation')).toMatchObject({
        status: 'not_scored',
      });
    }
  });

  it('keeps wrong and fabricated diagnoses out of the gate: they are the suite’s expected outcomes', async () => {
    const doc = document((await invoke(['development'])).out);
    const [run] = doc.runs as [EvaluationRun];
    expect(run.report.totals.rootCauseCorrect).toBeLessThan(run.report.totals.cases);
    expect(run.report.totals.rejectedForEvidence).toBe(1);
    expect(doc.gate.passed).toBe(true);
  });

  it('repeats exactly: the same suite twice gives the same bytes', async () => {
    const a = await invoke(['all']);
    const b = await invoke(['all']);
    expect(a.out).toBe(b.out);
    // The id says what produced the numbers.
    expect(document(a.out).runs[0]?.id).toBe('20261027T120000Z-development-scripted');
  });

  it('runs the simulated provider over the suite bundles, labelled as a placeholder', async () => {
    const { code, out } = await invoke(['held-out', '--provider', 'simulated']);
    expect(code).toBe(0);
    const [run] = document(out).runs as [EvaluationRun];
    expect(run.provider).toMatchObject({ kind: 'simulated', simulated: true });
    expect(run.measuresModelQuality).toBe(false);
    expect(run.limitations.join(' ')).toContain('Simulated provider');
  });

  it.each([
    [[], 'a suite id, or "all", is required'],
    [['--provider', 'scripted'], 'a suite id, or "all", is required'],
    [['nope'], 'unknown suite "nope"'],
    [['dev elopment!?'], 'unknown suite "(value withheld)"'],
    [['all', '--out'], '--out needs a value'],
    [['all', '--provider', '--out'], '--provider needs a value'],
    [['all', '--verbose', 'x'], 'unknown option --verbose'],
  ])('refuses %j as a usage error, running nothing', async (args, message) => {
    let ran = 0;
    const { code, err, out } = await invoke(
      args,
      steady({
        run: (suite, options) => {
          ran++;
          return runSuite(suite, options);
        },
      }),
    );
    expect([code, ran, out]).toEqual([2, 0, '']);
    expect(err).toContain(message);
    expect(err).toContain(USAGE);
  });

  it.each(['ollama', 'anthropic', 'real_model', 'local', 'Scripted'])(
    'will not run provider %s: only scripted and simulated are reachable, so nothing can spend',
    async (provider) => {
      let ran = 0;
      const { code, err } = await invoke(
        ['all', '--provider', provider],
        steady({
          run: (s, o) => {
            ran++;
            return runSuite(s, o);
          },
        }),
      );
      expect([code, ran]).toEqual([2, 0]);
      expect(err).toContain('only the "scripted" and "simulated" providers');
    },
  );

  describe('the gate', () => {
    const tamper =
      (change: (run: EvaluationRun) => void): NonNullable<SuiteCliDeps['run']> =>
      async (suite, options) => {
        const run = await runSuite(suite, options);
        change(run);
        return run;
      };

    it('fails with exit 1 when an answer leaked', async () => {
      const { code, err, out } = await invoke(
        ['held-out'],
        steady({ run: tamper((r) => (r.report.totals.answerLeaks = 2)) }),
      );
      expect(code).toBe(1);
      expect(err).toContain('gate: held-out@1: 2 case(s) leaked answer text');
      expect(document(out).gate.passed).toBe(false);
    });

    it('fails when a result does not satisfy its contract', async () => {
      const { code, err } = await invoke(
        ['held-out'],
        steady({
          run: tamper((r) => {
            const first = r.report.cases[0];
            if (first) first.resultValid = false;
          }),
        }),
      );
      expect(code).toBe(1);
      expect(err).toContain('result fails its contract in fabricated-correct');
    });

    it('fails when the harness could not complete the run', async () => {
      const { code, err } = await invoke(
        ['held-out'],
        steady({
          run: tamper((r) => {
            r.status = 'incomplete';
            r.harnessErrors = [{ id: 'x', error: 'the harness could not evaluate this case' }];
          }),
        }),
      );
      expect(code).toBe(1);
      expect(err).toContain('incomplete (1 case(s) the harness could not evaluate)');
    });

    it('reports every problem of every suite, not only the first', async () => {
      const { code, err } = await invoke(
        ['all'],
        steady({ run: tamper((r) => (r.report.totals.answerLeaks = 1)) }),
      );
      expect(code).toBe(1);
      expect(err).toContain('development@1');
      expect(err).toContain('held-out@1');
    });

    it('exits 3 and reports no result when the development / held-out split is breached', async () => {
      const { code, err, out } = await invoke(
        ['all'],
        steady({
          run: () =>
            Promise.reject(new SplitViolation('case x: scenario "y" has no declared split')),
        }),
      );
      expect([code, out]).toEqual([3, '']);
      expect(err).toContain('split violation: case x');
    });

    it('does not swallow an unexpected error as a gate failure', async () => {
      await expect(
        invoke(['all'], steady({ run: () => Promise.reject(new Error('boom')) })),
      ).rejects.toThrow('boom');
    });
  });

  describe('--out and --baseline', () => {
    it('writes the document to a file, prints nothing, and never overwrites a file', async () => {
      const file = join(dir, 'run.json');
      const first = await invoke(['all', '--out', file]);
      expect([first.code, first.out]).toEqual([0, '']);
      const written = await readFile(file, 'utf8');
      expect(written).toBe((await invoke(['all'])).out);
      const second = await invoke(['all', '--out', file]);
      expect(second.code).toBe(2);
      expect(second.err).toContain('cannot write the output file');
      expect(await readFile(file, 'utf8')).toBe(written);
    });

    it('passes against its own earlier document', async () => {
      const file = join(dir, 'baseline.json');
      await invoke(['all', '--out', file]);
      const { code, err } = await invoke(['all', '--baseline', file]);
      expect([code, err]).toEqual([0, '']);
    });

    it('fails with exit 1 and names the case that got worse than the baseline', async () => {
      const file = join(dir, 'baseline.json');
      const base = document((await invoke(['development'])).out);
      // As if the wrong diagnosis had once been right: now it is a regression.
      const wrong = base.runs[0]?.report.cases.find((c) => c.id === 'excerpt-wrong-root-cause');
      if (!wrong?.score) throw new Error('fixture changed');
      wrong.score.rootCause = 'correct';
      await writeFile(file, JSON.stringify(base));
      const { code, err, out } = await invoke(['development', '--baseline', file]);
      expect(code).toBe(1);
      expect(err).toContain('development@1: case excerpt-wrong-root-cause is regressed');
      expect(document(out).gate.passed).toBe(false);
    });

    it('does not count an improvement over the baseline as a problem', async () => {
      const file = join(dir, 'baseline.json');
      const base = document((await invoke(['development'])).out);
      const right = base.runs[0]?.report.cases.find((c) => c.id === 'excerpt-correct');
      if (!right?.score) throw new Error('fixture changed');
      right.score.rootCause = 'incorrect';
      await writeFile(file, JSON.stringify(base));
      expect((await invoke(['development', '--baseline', file])).code).toBe(0);
    });

    it('fails when the baseline has no run of the same suite and provider kind', async () => {
      const file = join(dir, 'baseline.json');
      await invoke(['held-out', '--out', file]);
      const other = await invoke(['development', '--baseline', file]);
      expect(other.code).toBe(1);
      expect(other.err).toContain('the baseline has no scripted run of this suite');
      const simulated = await invoke(['held-out', '--provider', 'simulated', '--baseline', file]);
      expect(simulated.code).toBe(1);
      expect(simulated.err).toContain('the baseline has no simulated run of this suite');
    });

    it.each([
      ['missing', undefined, 'cannot be read as JSON'],
      ['not JSON', 'not json', 'cannot be read as JSON'],
      ['no runs', '{"gate":{}}', 'holds no "runs" array'],
      ['null', 'null', 'holds no "runs" array'],
      ['a run that fails its schema', '{"runs":[{"id":"x"}]}', 'fails its schema'],
    ])(
      'refuses a baseline that is %s, as an input error, running nothing',
      async (_n, text, msg) => {
        const file = join(dir, 'baseline.json');
        if (text !== undefined) await writeFile(file, text);
        let ran = 0;
        const { code, err } = await invoke(
          ['all', '--baseline', file],
          steady({
            run: (s, o) => {
              ran++;
              return runSuite(s, o);
            },
          }),
        );
        expect([code, ran]).toEqual([2, 0]);
        expect(err).toContain(msg);
      },
    );
  });

  it('runs as a program and exits 0 with a parseable document', async () => {
    const cli = new URL('../../src/evaluation/suite-cli.ts', import.meta.url).pathname;
    const { stdout } = await promisify(execFile)('node', [cli, 'held-out']);
    const doc = JSON.parse(stdout) as SuiteDocument;
    expect(doc.gate.passed).toBe(true);
    expect(doc.runs).toHaveLength(1);
    await expect(promisify(execFile)('node', [cli, 'nope'])).rejects.toMatchObject({ code: 2 });
  });

  it('recognises when it is the program being run', () => {
    const url = new URL('../../src/evaluation/suite-cli.ts', import.meta.url);
    expect(isEntryPoint(url.href, url.pathname)).toBe(true);
    expect(isEntryPoint(url.href, '/somewhere/else.ts')).toBe(false);
    expect(isEntryPoint(url.href, undefined)).toBe(false);
  });
});

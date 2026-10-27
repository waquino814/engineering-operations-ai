import { link, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareRuns, type Comparison } from '../evaluation/compare.ts';
import { readEvaluationRun } from '../evaluation/document.ts';
import { runSuite, type EvaluationRun, type ProviderChoice } from '../evaluation/run.ts';
import { suiteById, SUITES, type SuiteDefinition } from '../evaluation/suites.ts';

/**
 * The application's whole contact with the evaluation package (E7). Evaluation reads the answer
 * key, which no other application code may (ADR 0003, ADR 0009), so every import of
 * `src/evaluation/` from the application layer is in this file, and `test/architecture.test.ts`
 * enforces that. It also keeps stored evaluation runs
 * (E7): one JSON file per run in the evaluations directory, written
 * atomically, never over an existing run, validated on every read. Reading one never reruns an
 * investigation. A file that fails validation is listed as unreadable and never repaired.
 */
const EVALUATION_ID =
  /^[0-9]{8}T[0-9]{6}Z-[a-z0-9-]{1,40}-(scripted|simulated|real_model)(-[0-9]{1,3})?$/;
const MAX_BYTES = 10_000_000;
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/** The id a new run will try first: time, suite and what produced the replies. */
export const evaluationIdBase = (nowMs: number, suiteId: string, kind: string) =>
  `${stamp(nowMs)}-${suiteId}-${kind}`;

export type EvaluationEntry =
  | {
      id: string;
      ok: true;
      suite: EvaluationRun['suite'];
      provider: EvaluationRun['provider'];
      measuresModelQuality: boolean;
      startedAt: string;
      status: EvaluationRun['status'];
      headline: { cases: number; rootCauseCorrect: string; completion: string };
    }
  | { id: string; ok: false; problems: string[] };

export type EvaluationLookup =
  | { ok: true; run: EvaluationRun }
  | { ok: false; reason: 'invalid_id' | 'not_found' | 'unreadable'; problems?: string[] };

/** Free ids are found by trying `-1`, `-2` after the base; the base is time, suite and kind. */
export async function saveEvaluation(
  dir: string,
  make: (id: string) => EvaluationRun,
  base: string,
): Promise<EvaluationRun> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? base : `${base}-${String(n)}`;
    if (!EVALUATION_ID.test(id)) throw new Error('not a valid evaluation id');
    const run = make(id);
    const check = readEvaluationRun(run);
    if (!check.ok)
      throw new Error('refusing to store an evaluation that fails its document schema');
    const tmp = join(dir, `.tmp-${id}-${String(process.pid)}`);
    await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
    try {
      // A hard link fails if the target exists, so an evaluation is never replaced.
      await link(tmp, join(dir, `${id}.json`));
      return run;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      await unlink(tmp);
    }
  }
  throw new Error('could not find a free evaluation id');
}

export async function getEvaluation(dir: string, id: string): Promise<EvaluationLookup> {
  if (!EVALUATION_ID.test(id)) return { ok: false, reason: 'invalid_id' };
  const file = join(dir, `${id}.json`);
  let text: string;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_BYTES)
      return {
        ok: false,
        reason: 'unreadable',
        problems: ['not a regular file of acceptable size'],
      };
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable', problems: ['not valid JSON'] };
  }
  const read = readEvaluationRun(value);
  if (!read.ok) return { ok: false, reason: 'unreadable', problems: read.problems };
  if (read.run.id !== id)
    return {
      ok: false,
      reason: 'unreadable',
      problems: ['the file name and the stored id differ'],
    };
  return { ok: true, run: read.run };
}

const pct = (
  m: { value: number | null; numerator: number | null; denominator: number } | undefined,
) =>
  m === undefined || m.value === null ? 'n/a' : `${String(m.numerator)}/${String(m.denominator)}`;

/** Newest first. */
export async function listEvaluations(dir: string): Promise<EvaluationEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => EVALUATION_ID.test(id))
    .sort()
    .reverse();
  return Promise.all(
    ids.map(async (id): Promise<EvaluationEntry> => {
      const got = await getEvaluation(dir, id);
      if (!got.ok) return { id, ok: false, problems: got.problems ?? [] };
      const { run } = got;
      const metric = (mid: string) => run.metrics.find((m) => m.id === mid);
      return {
        id,
        ok: true,
        suite: run.suite,
        provider: run.provider,
        measuresModelQuality: run.measuresModelQuality,
        startedAt: run.startedAt,
        status: run.status,
        headline: {
          cases: run.report.totals.cases,
          rootCauseCorrect: pct(metric('root_cause_correct')),
          completion: pct(metric('completion')),
        },
      };
    }),
  );
}

export type { Comparison, EvaluationRun, ProviderChoice, SuiteDefinition };

export const listEvaluationSuites = (): SuiteDefinition[] => [...SUITES];

/** Runs a suite and stores the result under a new id; null when the suite does not exist. */
export async function runAndStoreEvaluation(
  dir: string,
  suiteId: string,
  provider: ProviderChoice,
  deps: { nowMs: number; clock: () => number; signal?: AbortSignal },
): Promise<EvaluationRun | null> {
  const suite = suiteById(suiteId);
  if (suite === undefined) return null;
  const finished = await runSuite(suite, {
    provider,
    id: 'pending',
    clock: deps.clock,
    now: () => new Date(deps.nowMs),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  // Only now does the run get its id; the document is validated before it is written.
  return saveEvaluation(
    dir,
    (id) => ({ ...finished, id }),
    evaluationIdBase(deps.nowMs, suite.id, provider.kind),
  );
}

export async function compareStored(dir: string, a: string, b: string) {
  const [ra, rb] = [await getEvaluation(dir, a), await getEvaluation(dir, b)];
  if (!ra.ok) return { status: 'error', reason: ra.reason } as const;
  if (!rb.ok) return { status: 'error', reason: rb.reason } as const;
  const c = compareRuns(ra.run, rb.run);
  return c === 'different_suite'
    ? ({ status: 'error', reason: 'different_suite' } as const)
    : ({ status: 'ok', comparison: c } as const);
}

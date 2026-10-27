import { link, lstat, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readInvestigationResult,
  type InvestigationResult,
  type ResultProblem,
} from '../investigation/result.ts';
import { summarize, type InvestigationSummary } from '../investigation/summary.ts';

/**
 * Run history: one JSON file per run in the runs directory, holding exactly the validated
 * InvestigationResult, which carries no path, validation report or answer value (ADR 0003, 0012).
 * No database. Files are never repaired: an unreadable one is reported as such.
 */
const RUN_ID =
  /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}(-[0-9]{1,3})?$|^[0-9]{8}T[0-9]{6}Z-nocase(-[0-9]{1,3})?$/;

/** A result is far smaller; this only stops an arbitrary large file being read into memory. */
const MAX_RUN_BYTES = 10_000_000;

export type RunEntry =
  | { id: string; ok: true; summary: InvestigationSummary }
  | { id: string; ok: false; problems: ResultProblem[] };

export type RunLookup =
  | { ok: true; result: InvestigationResult }
  | {
      ok: false;
      reason: 'invalid_run_id' | 'run_not_found' | 'unreadable';
      problems?: ResultProblem[];
    };

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/** Writes the result under a new id, atomically, and never over an existing run. */
export async function saveRun(
  dir: string,
  result: InvestigationResult,
  nowMs: number,
): Promise<string> {
  const check = readInvestigationResult(result);
  if (!check.ok) throw new Error('refusing to store a result that fails the contract');
  await mkdir(dir, { recursive: true });
  const base = `${stamp(nowMs)}-${result.caseId ?? 'nocase'}`;
  const tmp = join(dir, `.tmp-${base}-${String(process.pid)}`);
  await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  try {
    for (let n = 0; n < 1000; n++) {
      const id = n === 0 ? base : `${base}-${String(n)}`;
      try {
        // A hard link fails if the target exists, so a run is never replaced.
        await link(tmp, join(dir, `${id}.json`));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error('could not find a free run id');
  } finally {
    await unlink(tmp);
  }
}

export async function getRun(dir: string, id: string): Promise<RunLookup> {
  if (!RUN_ID.test(id)) return { ok: false, reason: 'invalid_run_id' };
  const file = join(dir, `${id}.json`);
  let text: string;
  try {
    // Only a regular file of sensible size is read: a link could point anywhere.
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_RUN_BYTES)
      return {
        ok: false,
        reason: 'unreadable',
        problems: [{ code: 'not_an_object', message: 'not a regular file of acceptable size' }],
      };
    text = await readFile(file, 'utf8');
  } catch {
    return { ok: false, reason: 'run_not_found' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: 'unreadable',
      problems: [{ code: 'not_an_object', message: 'not valid JSON' }],
    };
  }
  const read = readInvestigationResult(value);
  return read.ok
    ? { ok: true, result: read.result }
    : { ok: false, reason: 'unreadable', problems: read.problems };
}

/** Every run file, oldest first; one that fails the contract is listed as unreadable. */
export async function listRuns(dir: string): Promise<RunEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => RUN_ID.test(id))
    .sort();
  return Promise.all(
    ids.map(async (id): Promise<RunEntry> => {
      const run = await getRun(dir, id);
      return run.ok
        ? { id, ok: true, summary: summarize(run.result) }
        : { id, ok: false, problems: run.problems ?? [] };
    }),
  );
}

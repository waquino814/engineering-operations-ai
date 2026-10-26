import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * Small synthetic bundles for tests, written to temporary directories. They start from the
 * genuine example (docs/examples/): its manifest and ground truth, and its excerpt lines as the
 * telemetry. The manifest's `files` entries and `bundleId` are recomputed so the fixture is a
 * complete, valid bundle; its `capture` counts still describe the original, full capture. The
 * example itself is never written to.
 */
export const EXAMPLE_ID = 'provider-outage-42-20261026T122230Z';
export const EXAMPLE_DIR = new URL(`../docs/examples/${EXAMPLE_ID}/`, import.meta.url).pathname;

type Json = Record<string, unknown>;
type Content = string | Uint8Array | null;
export type FileName =
  'manifest.json' | 'ground_truth.json' | 'traces.jsonl' | 'metrics.jsonl' | 'logs.jsonl';

export const example = async (file: string) => readFile(join(EXAMPLE_DIR, file));

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const records = (name: string, b: Uint8Array) => {
  if (name === 'ground_truth.json') return 1;
  if (b.length === 0) return 0;
  const n = b.filter((x) => x === 0x0a).length;
  return b[b.length - 1] === 0x0a ? n : n + 1;
};

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

export interface BundleOptions {
  /** Directory name; the manifest's bundleId follows it unless `manifest` changes it. */
  dirName?: string;
  /** File contents to use before checksums are computed; null leaves the file out. */
  files?: Partial<Record<FileName, Content>>;
  /** Changes to the manifest after its `files` entries are computed. */
  manifest?: (m: Json) => void;
  /** File contents written after the manifest, so the manifest no longer matches them. */
  after?: Partial<Record<FileName, Content>>;
}

export async function makeBundle(options: BundleOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eoai-bundle-'));
  roots.push(root);
  const dirName = options.dirName ?? EXAMPLE_ID;
  const dir = join(root, dirName);
  await mkdir(dir);
  const { 'manifest.json': manifestContent, ...overrides } = options.files ?? {};
  const contents: Record<string, Content> = {
    'ground_truth.json': await example('ground_truth.json'),
    'traces.jsonl': await example('traces.excerpt.jsonl'),
    'metrics.jsonl': await example('metrics.excerpt.jsonl'),
    'logs.jsonl': await example('logs.excerpt.jsonl'),
    ...overrides,
  };
  const manifest = JSON.parse((await example('manifest.json')).toString('utf8')) as Json;
  manifest.bundleId = dirName;
  const files: Json = {};
  for (const [name, content] of Object.entries(contents)) {
    if (content === null) continue;
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    files[name] = { sha256: sha256(bytes), bytes: bytes.length, records: records(name, bytes) };
    await writeFile(join(dir, name), bytes);
  }
  manifest.files = files;
  options.manifest?.(manifest);
  if (manifestContent === undefined) {
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (manifestContent !== null) {
    await writeFile(join(dir, 'manifest.json'), manifestContent);
  }
  for (const [name, content] of Object.entries(options.after ?? {})) {
    if (content === null) await rm(join(dir, name));
    else await writeFile(join(dir, name), content);
  }
  return dir;
}

/** The first line of an excerpt file, parsed. */
export async function firstRecord(file: string): Promise<Json> {
  const text = (await example(file)).toString('utf8');
  return JSON.parse(text.split('\n')[0] ?? '') as Json;
}

/** SHA-256 of every file in a directory, to prove nothing was written. */
export async function snapshot(
  dir: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const n of names)
    out[n] = sha256(await readFile(join(dir, n)).catch(() => Buffer.from('<absent>')));
  return out;
}

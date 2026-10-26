import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAILURE_CLASSES } from '../src/index.ts';

/**
 * Module boundaries (ADR 0006): which layer may touch bundle paths, the filesystem, the answer
 * file, the network and the scoring code. Checked on the source text, so a violation fails CI.
 */
const root = new URL('../src/', import.meta.url).pathname;
async function sources(dir = ''): Promise<{ file: string; text: string }[]> {
  return Promise.all(
    (await readdir(join(root, dir), { recursive: true }))
      .filter((f) => f.endsWith('.ts'))
      .map(async (f) => ({ file: join(dir, f), text: await readFile(join(root, dir, f), 'utf8') })),
  );
}
/** Static imports and re-exports, dynamic imports, and require calls. */
const imports = (text: string) =>
  [
    ...text.matchAll(/from '([^']+)'/g),
    ...text.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]/g),
    ...text.matchAll(/\brequire\(\s*['"`]([^'"`]+)['"`]/g),
  ].map((m) => m[1] ?? '');

describe('module boundaries', () => {
  it('keeps the investigation layer off the filesystem, intake validation, the pipeline and scoring', async () => {
    for (const { file, text } of await sources('investigation')) {
      for (const spec of imports(text)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /^node:(fs|path|child_process|net|http|https)|validate-bundle|\/evaluation\/|\/pipeline\//,
        );
      }
      expect(text, file).not.toMatch(/ground_truth|GROUND_TRUTH_FILE|readAnswerKey/);
      // No way around the static checks: no computed imports, no require, no environment.
      expect(text, file).not.toMatch(
        /\bimport\(|\brequire\(|createRequire|process\.env|process\.binding/,
      );
    }
  });

  it('sees dynamic imports and require calls, not only static imports', () => {
    expect(
      imports('const a = await import(\'node:fs\'); const b = require("../evaluation/score.ts");'),
    ).toEqual(['node:fs', '../evaluation/score.ts']);
  });

  it('keeps intake independent of everything built on it', async () => {
    for (const { file, text } of await sources('intake')) {
      for (const spec of imports(text))
        expect(spec, `${file} imports ${spec}`).not.toMatch(/investigation|pipeline|evaluation/);
    }
  });

  it('lets only intake, the pipeline and evaluation reach bundle paths', async () => {
    const fsUsers = (await sources())
      .filter(({ text }) => imports(text).some((s) => /^node:fs/.test(s)))
      .map(({ file }) => file)
      .sort();
    expect(fsUsers).toEqual([
      'evaluation/cli.ts',
      'evaluation/ground-truth.ts',
      'evaluation/leakage.ts',
      'evaluation/synthetic.ts',
      'intake/checks.ts',
      'intake/contract.ts',
      'intake/validate-bundle.ts',
    ]);
  });

  it('keeps scoring code out of everything but evaluation', async () => {
    for (const { file, text } of await sources()) {
      if (file.startsWith('evaluation/')) continue;
      expect(
        imports(text).filter((s) => s.includes('evaluation')),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/scoreResult|AnswerKey|protectedValues|findLeaks/);
    }
  });

  it('keeps answer-key values and scenario constants out of the investigator and the pipeline', async () => {
    // Values taken from the committed example, so the list follows the data, plus the known
    // scenario names and run-protocol constants (ADR 0003, "Remaining risks").
    const example = new URL(
      '../docs/examples/provider-outage-42-20261026T122230Z/',
      import.meta.url,
    );
    const truth = JSON.parse(await readFile(new URL('ground_truth.json', example), 'utf8')) as {
      scenario: { name: string };
      rootCause: { component: string };
      faultParameters: Record<string, string>;
      primarySymptom: { metric: string; matchers: Record<string, string> };
    };
    // A value equal to one of this project's own failure classes (the example's fault parameter
    // "provider_unavailable" is one) is generic vocabulary, not scenario knowledge.
    const values = [
      truth.scenario.name,
      truth.rootCause.component,
      truth.primarySymptom.metric,
      ...Object.values(truth.faultParameters),
      ...Object.values(truth.primarySymptom.matchers).filter((v) => v.length >= 8),
    ].filter((v) => !(FAILURE_CLASSES as readonly string[]).includes(v));
    const constants = [
      /bad-deploy|payment-timeouts|provider-outage|api-pool-exhaustion|poison-order/,
      /triggerOffset|requestedDurationMs|detectedAt|loadStartedAt|captureFrom|planHash|runPrefix/,
      /\b(30|90|120)_?000\b/,
    ];
    const files = [...(await sources('investigation')), ...(await sources('pipeline'))];
    for (const { file, text } of files) {
      for (const v of values) expect(text, `${file}: ${v}`).not.toContain(v);
      for (const c of constants) expect(text, `${file}: ${String(c)}`).not.toMatch(c);
    }
  });

  it('names the answer file only in the contract, contract validation and the scoring boundary', async () => {
    const mentions = (await sources())
      .filter(({ text }) => /ground_truth|GROUND_TRUTH_FILE/.test(text))
      .map(({ file }) => file)
      .sort();
    expect(mentions).toEqual([
      'evaluation/ground-truth.ts',
      'evaluation/leakage.ts',
      'evaluation/synthetic.ts',
      'intake/contract.ts',
      'intake/validate-bundle.ts',
    ]);
  });

  it('makes no network calls and bundles no AI provider SDK', async () => {
    for (const { file, text } of await sources()) {
      expect(text, file).not.toMatch(
        /\bfetch\(|XMLHttpRequest|WebSocket|from 'node:(http|https|net|tls|dgram)'/,
      );
      expect(text, file).not.toMatch(/@anthropic-ai|openai|@google\/generative|ollama/i);
    }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['ajv', 'ajv-formats']);
  });
});

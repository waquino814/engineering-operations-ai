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
      // .tsx included: the console (ADR 0011) is held to the same rules.
      .filter((f) => /\.tsx?$/.test(f))
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
      'app/bundles.ts',
      'app/data-dirs.ts',
      'app/evaluation-service.ts',
      'app/evidence.ts',
      'app/http-server.ts',
      'app/run-store.ts',
      'app/settings.ts',
      'evaluation/cli.ts',
      'evaluation/ground-truth.ts',
      'evaluation/leakage.ts',
      'evaluation/suites.ts',
      'evaluation/synthetic.ts',
      'evaluation/ui-fixtures.ts',
      'intake/checks.ts',
      'intake/contract.ts',
      'intake/validate-bundle.ts',
    ]);
  });

  it('keeps the hosted adapter, its SDK and provider selection unreachable from the runnable application', async () => {
    const all = new Map((await sources()).map(({ file, text }) => [file, text]));
    // Everything the CLI and the application layer can import, transitively, by relative path.
    const reachable = new Set<string>();
    const visit = (file: string) => {
      if (reachable.has(file)) return;
      reachable.add(file);
      for (const spec of imports(all.get(file) ?? '')) {
        if (spec.startsWith('.')) visit(join(file, '..', spec).replace(/^\.\//, ''));
      }
    };
    visit('cli.ts');
    for (const file of all.keys()) if (file.startsWith('app/')) visit(file);
    expect(reachable.size).toBeGreaterThan(10);
    for (const file of reachable) {
      // The local Ollama adapter and the shared wire schema are runnable; nothing hosted is.
      expect(file, 'reachable from the runnable application').not.toMatch(
        /^providers\/(anthropic\/|select\.ts)/,
      );
      for (const spec of imports(all.get(file) ?? ''))
        expect(spec, `${file} imports ${spec}`).not.toMatch(
          /@anthropic-ai|providers\/(anthropic|select)/,
        );
    }
  });

  it('lets only the loopback server listen, and only on a validated loopback host', async () => {
    const users = (await sources())
      .filter(({ text }) => /from 'node:http'/.test(text))
      .map(({ file }) => file);
    expect(users).toEqual([join('app', 'http-server.ts')]);
    const text =
      (await sources('app')).find((f) => f.file === join('app', 'http-server.ts'))?.text ?? '';
    expect(text).not.toMatch(/0\.0\.0\.0|\.listen\(\d|listen\(\s*port/);
    expect(text).toContain('resolveListenHost(options.host)');
  });

  it('lets only the Ollama client reach the network, through a validated loopback endpoint', async () => {
    const all = await sources();
    const fetchers = all
      .filter(({ text }) => /\bfetch\(/.test(text))
      .map(({ file }) => file)
      .sort();
    expect(fetchers).toEqual([
      join('providers', 'ollama', 'client.ts'),
      join('ui', 'data', 'http-source.ts'),
    ]);
    const client = all.find((f) => f.file === join('providers', 'ollama', 'client.ts'))?.text ?? '';
    expect(client).toContain("redirect: 'error'");
    expect(client).toContain('LOOPBACK_HOSTS');
    expect(client).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|\$\{)/);
  });

  it('limits the console to same-origin /api/ requests', async () => {
    const text =
      (await sources('ui')).find((f) => f.file === join('ui', 'data', 'http-source.ts'))?.text ??
      '';
    const paths = [...text.matchAll(/['"`](\/[A-Za-z][^'"`]*)['"`]/g)].map((m) => m[1] ?? '');
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) expect(p, p).toMatch(/^\/api\//);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('keeps the process environment out of the application layer: only the CLI entry reads it', async () => {
    for (const { file, text } of await sources('app')) {
      expect(text, file).not.toMatch(/process\.(env|argv)|createRequire|\bimport\(/);
      expect(text, file).not.toMatch(/ground_truth|GROUND_TRUTH_FILE|readAnswerKey/);
    }
  });

  it('keeps scoring code out of everything but evaluation', async () => {
    for (const { file, text } of await sources()) {
      if (file.startsWith('evaluation/')) continue;
      // The one place the application layer touches the evaluation package (E7).
      const evaluationImports = imports(text).filter((s) => /(^|\/)evaluation\//.test(s));
      expect(evaluationImports.length > 0, file).toBe(
        file === join('app', 'evaluation-service.ts'),
      );
      expect(text, file).not.toMatch(/scoreResult|AnswerKey|protectedValues|findLeaks/);
    }
  });

  it('keeps the held-out scenario’s identifiers out of every module that builds prompts, selects evidence or runs providers', async () => {
    // Identifiers of the invented held-out scenario (src/evaluation/suites.ts). If any of them
    // appears in the code that shapes what a model sees, the split no longer holds.
    const heldOut = /synthetic-cache-saturation|cache-node|cache_requests_total/;
    for (const { file, text } of await sources()) {
      if (file.startsWith('evaluation/')) continue;
      expect(text, file).not.toMatch(heldOut);
    }
  });

  it('lets the development and held-out suites share no scenario, seed or telemetry file', async () => {
    const { SUITES, SCENARIO_SPLIT, buildSuite } = await import('../src/evaluation/suites.ts');
    const { readAnswerKey } = await import('../src/evaluation/ground-truth.ts');
    const { createHash } = await import('node:crypto');
    const seen = { development: new Set<string>(), 'held-out': new Set<string>() };
    const identity = { development: new Set<string>(), 'held-out': new Set<string>() };
    for (const suite of SUITES) {
      const built = await buildSuite(suite);
      try {
        for (const b of built.bundles) {
          const key = await readAnswerKey(b.dir);
          expect(SCENARIO_SPLIT[key.scenario], key.scenario).toBe(suite.split);
          identity[suite.split].add(`${key.scenario}#${String(key.scenarioSeed)}`);
          for (const f of ['traces.jsonl', 'metrics.jsonl', 'logs.jsonl'])
            seen[suite.split].add(
              createHash('sha256')
                .update(await readFile(join(b.dir, f)))
                .digest('hex'),
            );
        }
      } finally {
        await built.cleanup();
      }
    }
    expect(identity.development.size).toBeGreaterThan(0);
    expect(identity['held-out'].size).toBeGreaterThan(0);
    expect([...identity.development].filter((x) => identity['held-out'].has(x))).toEqual([]);
    expect([...seen.development].filter((x) => seen['held-out'].has(x))).toEqual([]);
    // Scenario names, not only seeds, are disjoint.
    const names = (side: string) =>
      new Set([...identity[side as 'development']].map((x) => x.split('#')[0]));
    expect([...names('development')].filter((n) => names('held-out').has(n))).toEqual([]);
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

  it('makes no outgoing network calls and bundles no AI provider SDK', async () => {
    for (const { file, text } of await sources()) {
      // Narrow exceptions: the loopback server listens (it never calls out), and the console's
      // HTTP source fetches its own origin's /api/ paths. Both are checked by tests below.
      const listens = file === join('app', 'http-server.ts');
      const fetches =
        file === join('ui', 'data', 'http-source.ts') ||
        file === join('providers', 'ollama', 'client.ts');
      expect(text, file).not.toMatch(
        listens
          ? /\bfetch\(|XMLHttpRequest|WebSocket|from 'node:(https|net|tls|dgram)'/
          : fetches
            ? /XMLHttpRequest|WebSocket|from 'node:/
            : /\bfetch\(|XMLHttpRequest|WebSocket|from 'node:(http|https|net|tls|dgram)'/,
      );
      // ADR 0008: the Anthropic SDK is allowed in its adapter directory and nowhere else.
      const adapter = file.startsWith(join('providers', 'anthropic') + '/');
      const mentionsOllama =
        file.startsWith(join('providers', 'ollama') + '/') ||
        file.startsWith('app/') ||
        file.startsWith('ui/') ||
        file === 'cli.ts' ||
        file === join('investigation', 'simulated-provider.ts');
      expect(text, file).not.toMatch(
        adapter
          ? /openai|@google\/generative|ollama/i
          : mentionsOllama
            ? /@anthropic-ai|openai|@google\/generative/i
            : /@anthropic-ai|openai|@google\/generative|ollama/i,
      );
    }
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // ADR 0011 adds React for the console; ADR 0008 adds the Anthropic SDK for its adapter only.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@anthropic-ai/sdk',
      'ajv',
      'ajv-formats',
      'react',
      'react-dom',
    ]);
  });

  it('lets only the Anthropic adapter import the SDK, and keeps it out of the console', async () => {
    const users = (await sources())
      .filter(({ text }) => imports(text).some((s) => s.startsWith('@anthropic-ai/')))
      .map(({ file }) => file)
      .sort();
    expect(users).toEqual([join('providers', 'anthropic', 'provider.ts')]);
  });

  it('keeps the console to the browser, the result contract and its own data interface', async () => {
    // Runtime imports only; `import type` is erased and may name any module's types.
    const runtime = (text: string) =>
      [
        ...text.matchAll(/^import (?!type\b)[^;]*?from '([^']+)'/gm),
        ...text.matchAll(/^import '([^']+)'/gm),
        ...text.matchAll(/^export (?!type\b)[^;]*?from '([^']+)'/gm),
        ...text.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]/g),
      ].map((m) => m[1] ?? '');
    const allowedOutside = /^(\.\.\/)+investigation\/(result|config|schemas)\.ts$/;
    const files = await sources('ui');
    expect(files.length).toBeGreaterThan(10);
    for (const { file, text } of files) {
      for (const spec of runtime(text)) {
        const external = !spec.startsWith('.');
        const inside =
          spec.startsWith('./') ||
          /^\.\.\/(?!\.\.\/)(?!investigation|intake|pipeline|evaluation)/.test(spec);
        expect(
          external ? /^react(-dom\/client)?$/.test(spec) : inside || allowedOutside.test(spec),
          `ui/${file} imports ${spec}`,
        ).toBe(true);
      }
      expect(text, file).not.toMatch(
        file === join('ui', 'data', 'http-source.ts')
          ? /node:|process\.|XMLHttpRequest|ground_truth|GROUND_TRUTH/
          : /node:|process\.|\bfetch\(|XMLHttpRequest|ground_truth|GROUND_TRUTH/,
      );
    }
  });
});

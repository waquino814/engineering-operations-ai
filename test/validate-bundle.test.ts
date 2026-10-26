import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES, validateBundle, validateRecord, type ValidationIssue } from '../src/index.ts';
import { EXAMPLE_DIR, EXAMPLE_ID, example, firstRecord, makeBundle, snapshot } from './support.ts';

type Json = Record<string, unknown>;
const summary = (issues: ValidationIssue[]) =>
  issues.map((i) => [i.rule, i.file, i.line ?? i.field ?? null]);
const rules = (issues: ValidationIssue[]) => [...new Set(issues.map((i) => i.rule))];
const scenario = (m: Json) => m.scenario as Json;
const capture = (m: Json) => (m.capture as Json).traces as Json;

describe('a valid bundle', () => {
  it('passes every rule', async () => {
    const report = await validateBundle(await makeBundle());
    expect(report).toMatchObject({ valid: true, schemaVersion: '1.0.0', issues: [] });
  });

  it('accepts a newer minor version and fields it does not know (ADR 0007)', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        m.schemaVersion = '1.7.2';
        m.addedInSomeLaterMinor = { anything: true };
      },
    });
    expect((await validateBundle(dir)).valid).toBe(true);
  });

  it('accepts a scenario and components it has never seen (open vocabulary)', async () => {
    const truth = JSON.parse((await example('ground_truth.json')).toString('utf8')) as Json;
    scenario(truth).name = 'disk-full';
    (truth.rootCause as Json).component = 'storage-volume';
    truth.affectedComponents = ['storage-volume', 'worker'];
    const dir = await makeBundle({
      dirName: 'disk-full-42-20261026T000000Z',
      files: { 'ground_truth.json': `${JSON.stringify(truth)}\n` },
      manifest: (m) => (scenario(m).name = 'disk-full'),
    });
    expect(await validateBundle(dir)).toMatchObject({ valid: true, issues: [] });
  });

  it('accepts empty telemetry files as zero records', async () => {
    const dir = await makeBundle({ files: { 'logs.jsonl': '' } });
    expect((await validateBundle(dir)).valid).toBe(true);
  });

  it('never writes to the bundle, even when it is invalid', async () => {
    const dir = await makeBundle({ after: { 'logs.jsonl': 'not json\n' } });
    const names = [
      'manifest.json',
      'ground_truth.json',
      'traces.jsonl',
      'metrics.jsonl',
      'logs.jsonl',
    ];
    const before = await snapshot(dir, names);
    await validateBundle(dir);
    expect(await snapshot(dir, names)).toEqual(before);
  });
});

describe('the committed example (an excerpt, not a complete bundle)', () => {
  it('fails only because its full telemetry files are absent', async () => {
    const report = await validateBundle(EXAMPLE_DIR);
    expect(report.valid).toBe(false);
    expect(summary(report.issues)).toEqual([
      [1, 'traces.jsonl', null],
      [1, 'metrics.jsonl', null],
      [1, 'logs.jsonl', null],
    ]);
  });

  it('has a manifest and excerpt lines that each match their vendored schema', async () => {
    const manifest = JSON.parse((await example('manifest.json')).toString('utf8')) as unknown;
    expect(await validateRecord('manifest.json', manifest)).toEqual([]);
    for (const [kind, file] of [
      ['traces.jsonl', 'traces.excerpt.jsonl'],
      ['metrics.jsonl', 'metrics.excerpt.jsonl'],
      ['logs.jsonl', 'logs.excerpt.jsonl'],
    ] as const) {
      const lines = (await example(file)).toString('utf8').split('\n').slice(0, -1);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(await validateRecord(kind, JSON.parse(l))).toEqual([]);
    }
  });
});

describe('rule 1: files present', () => {
  it('reports a path that is not a directory, and stops', async () => {
    const report = await validateBundle(join(EXAMPLE_DIR, 'manifest.json'));
    expect(summary(report.issues)).toEqual([[1, null, null]]);
    expect(report.issues[0]?.message).toMatch(/is not a directory$/);
  });

  it('reports each missing file and still checks the others', async () => {
    const dir = await makeBundle({ after: { 'ground_truth.json': null, 'metrics.jsonl': null } });
    const report = await validateBundle(dir);
    expect(summary(report.issues)).toEqual([
      [1, 'ground_truth.json', null],
      [1, 'metrics.jsonl', null],
    ]);
    expect(report.issues.map((i) => i.message)).toEqual([
      'ground_truth.json is missing',
      'metrics.jsonl is missing',
    ]);
  });

  it('reports a missing manifest without guessing the schema version', async () => {
    const report = await validateBundle(await makeBundle({ files: { 'manifest.json': null } }));
    expect(summary(report.issues)).toEqual([[1, 'manifest.json', null]]);
    expect(report.schemaVersion).toBeNull();
  });

  it('reports a file that exists but cannot be read', async () => {
    const dir = await makeBundle();
    await chmod(join(dir, 'logs.jsonl'), 0o000);
    const report = await validateBundle(dir);
    expect(summary(report.issues)).toEqual([[1, 'logs.jsonl', null]]);
    expect(report.issues[0]?.message).toBe('logs.jsonl could not be read (EACCES)');
  });
});

describe('rule 2: supported major version', () => {
  it('refuses an unsupported major version and validates nothing against a schema', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        m.schemaVersion = '2.0.0';
        delete m.detection;
      },
    });
    const report = await validateBundle(dir);
    expect(summary(report.issues)).toEqual([[2, 'manifest.json', 'schemaVersion']]);
    expect(report.issues[0]?.message).toBe(
      'schemaVersion "2.0.0" has major version 2; supported: 1',
    );
    expect(report.schemaVersion).toBe('2.0.0');
  });

  it('rejects a missing or non-semver schemaVersion', async () => {
    for (const [value, shown] of [
      [undefined, 'nothing'],
      ['v1', '"v1"'],
      [1, '1'],
    ] as const) {
      const dir = await makeBundle({
        manifest: (m) => {
          if (value === undefined) delete m.schemaVersion;
          else m.schemaVersion = value;
        },
      });
      const report = await validateBundle(dir);
      expect(rules(report.issues), String(value)).toEqual([2]);
      expect(report.issues[0]?.message).toBe(
        `schemaVersion must be a semantic version such as "1.0.0"; found ${shown}`,
      );
    }
  });
});

describe('rule 3: documents match their schemas', () => {
  it('names the missing manifest field', async () => {
    const report = await validateBundle(await makeBundle({ manifest: (m) => delete m.detection }));
    expect(summary(report.issues)).toEqual([[3, 'manifest.json', 'detection']]);
    expect(report.issues[0]?.message).toBe(
      "manifest.json: detection must have required property 'detection'",
    );
  });

  it('reports a wrongly typed nested field', async () => {
    const report = await validateBundle(
      await makeBundle({ manifest: (m) => ((m.producer as Json).dirty = 'no') }),
    );
    expect(summary(report.issues)).toEqual([[3, 'manifest.json', 'producer.dirty']]);
  });

  it('reports malformed and non-UTF-8 manifests', async () => {
    for (const [content, message] of [
      ['{"schemaVersion": "1.0.0",', 'manifest.json is not valid JSON'],
      [Buffer.from([0x7b, 0xff, 0x7d]), 'manifest.json is not valid UTF-8'],
      ['[1, 2]', 'manifest.json must be a JSON object'],
    ] as const) {
      const report = await validateBundle(
        await makeBundle({ files: { 'manifest.json': content } }),
      );
      expect(report.issues.filter((i) => i.file === 'manifest.json').map((i) => i.message)).toEqual(
        [message],
      );
      expect(report.schemaVersion).toBeNull();
    }
  });

  it('validates the ground truth, including its own major version', async () => {
    const truth = JSON.parse((await example('ground_truth.json')).toString('utf8')) as Json;
    delete truth.rootCause;
    truth.schemaVersion = '2.0.0';
    const report = await validateBundle(
      await makeBundle({ files: { 'ground_truth.json': `${JSON.stringify(truth)}\n` } }),
    );
    expect(summary(report.issues)).toEqual([
      [3, 'ground_truth.json', 'rootCause'],
      [3, 'ground_truth.json', 'schemaVersion'],
    ]);
  });

  it('reports a malformed ground truth', async () => {
    const report = await validateBundle(
      await makeBundle({ files: { 'ground_truth.json': 'not json' } }),
    );
    expect(report.issues.map((i) => [i.rule, i.message])).toEqual([
      [3, 'ground_truth.json is not valid JSON'],
    ]);
  });
});

describe('rule 4: JSONL records', () => {
  it('reports blank lines, malformed JSON and a missing final newline, by line', async () => {
    const good = (await example('logs.excerpt.jsonl')).toString('utf8').split('\n')[0] ?? '';
    const report = await validateBundle(
      await makeBundle({ files: { 'logs.jsonl': `${good}\n\n{oops\n${good}` } }),
    );
    expect(report.issues.map((i) => [i.rule, i.file, i.line, i.message])).toEqual([
      [4, 'logs.jsonl', 2, 'logs.jsonl line 2: blank line'],
      [4, 'logs.jsonl', 3, 'logs.jsonl line 3: malformed JSON'],
      [4, 'logs.jsonl', 4, 'logs.jsonl line 4: missing final newline'],
    ]);
  });

  it('validates each record against its schema, naming the line and field', async () => {
    const record = await firstRecord('logs.excerpt.jsonl');
    delete record.level;
    const report = await validateBundle(
      await makeBundle({ files: { 'logs.jsonl': `${JSON.stringify(record)}\n` } }),
    );
    expect(report.issues).toEqual([
      {
        rule: 4,
        ruleId: 'jsonl-records',
        file: 'logs.jsonl',
        field: 'level',
        line: 1,
        message: "logs.jsonl record: level must have required property 'level'",
      },
    ]);
  });

  it('rejects a trace line that is not OTLP-shaped, and non-UTF-8 telemetry', async () => {
    const report = await validateBundle(
      await makeBundle({
        files: {
          'traces.jsonl': '{"resourceSpans": []}\n',
          'metrics.jsonl': Buffer.from([0xc3, 0x28, 0x0a]),
        },
      }),
    );
    expect(summary(report.issues)).toEqual([
      [4, 'traces.jsonl', 1],
      [4, 'metrics.jsonl', null],
    ]);
    expect(report.issues[1]?.message).toBe('metrics.jsonl is not valid UTF-8');
  });

  it('lists at most 20 line issues per file and rule, then counts the rest', async () => {
    const report = await validateBundle(
      await makeBundle({ files: { 'metrics.jsonl': 'x\n'.repeat(30) } }),
    );
    expect(report.issues).toHaveLength(21);
    expect(report.issues[19]?.line).toBe(20);
    expect(report.issues[20]).toEqual({
      rule: 4,
      ruleId: 'jsonl-records',
      file: 'metrics.jsonl',
      message: '10 more line issues in metrics.jsonl under rule 4 are not listed',
    });
  });
});

describe('rule 5: one trace per line', () => {
  it('reports a line mixing two trace IDs', async () => {
    const trace = await firstRecord('traces.excerpt.jsonl');
    const spans = ((trace.resourceSpans as Json[])[0]?.scopeSpans as Json[])[0]?.spans as Json[];
    expect(spans.length).toBeGreaterThan(1);
    (spans[1] as Json).traceId = 'f'.repeat(32);
    const report = await validateBundle(
      await makeBundle({ files: { 'traces.jsonl': `${JSON.stringify(trace)}\n` } }),
    );
    expect(report.issues.map((i) => [i.rule, i.file, i.line, i.message])).toEqual([
      [
        5,
        'traces.jsonl',
        1,
        'traces.jsonl line 1 mixes 2 trace IDs; each line must hold one trace',
      ],
    ]);
  });
});

describe('rule 6: bundle ID', () => {
  it('accepts any directory name the bundle ID matches', async () => {
    const dir = await makeBundle({ dirName: 'renamed-42-20261026T000000Z' });
    expect((await validateBundle(dir)).valid).toBe(true);
  });

  it('reports a bundle ID that does not name the directory', async () => {
    const dir = await makeBundle({ manifest: (m) => (m.bundleId = 'other-42-20261026T000000Z') });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.field, i.message])).toEqual([
      [
        6,
        'bundleId',
        `bundleId "other-42-20261026T000000Z" does not match the directory name "${EXAMPLE_ID}"`,
      ],
    ]);
  });

  it('compares with the directory name even for a trailing slash or relative path', async () => {
    const dir = await makeBundle();
    expect((await validateBundle(`${dir}/`)).valid).toBe(true);
    expect((await validateBundle(`${dir}/../${EXAMPLE_ID}`)).valid).toBe(true);
  });
});

describe('rule 7: scenario agreement', () => {
  it('reports each scenario key that differs from the ground truth', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        scenario(m).seed = 7;
        scenario(m).version = 2;
      },
    });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.field, i.message])).toEqual([
      [7, 'scenario.version', 'scenario.version is 2 in manifest.json but 1 in ground_truth.json'],
      [7, 'scenario.seed', 'scenario.seed is 7 in manifest.json but 42 in ground_truth.json'],
    ]);
  });
});

describe('rule 8: truncation flag', () => {
  it('requires truncated exactly when there are truncation reasons', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        const services = capture(m).services as Json[];
        (services[0] as Json).truncated = true;
        (services[1] as Json).truncationReasons = ['service_cap'];
      },
    });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.field])).toEqual([
      [8, 'capture.traces.services.0.truncated'],
      [8, 'capture.traces.services.1.truncated'],
    ]);
    expect(report.issues[0]?.message).toBe(
      'capture.traces.services.0: truncated is true but truncationReasons has 0 entries; truncated must be true exactly when there are reasons',
    );
  });

  it('accepts a truncated capture that states its reasons', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        const s = (capture(m).services as Json[])[0] as Json;
        s.truncated = true;
        s.truncationReasons = ['slice_saturated'];
      },
    });
    expect((await validateBundle(dir)).valid).toBe(true);
  });
});

describe('rule 9: file integrity', () => {
  it('reports a changed file by checksum and byte count', async () => {
    const lines = (await example('metrics.excerpt.jsonl')).toString('utf8');
    const dir = await makeBundle({ after: { 'metrics.jsonl': lines.replace('"job"', '"jbo"') } });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.file, i.field])).toEqual([
      [9, 'metrics.jsonl', 'files.metrics.jsonl.sha256'],
    ]);
    const longer = await makeBundle({ after: { 'metrics.jsonl': `${lines}${lines}` } });
    expect((await validateBundle(longer)).issues.map((i) => i.field)).toEqual([
      'files.metrics.jsonl.sha256',
      'files.metrics.jsonl.bytes',
      'files.metrics.jsonl.records',
    ]);
  });

  it('reports a record-count mismatch and quotes both values', async () => {
    const dir = await makeBundle({
      manifest: (m) => (((m.files as Json)['logs.jsonl'] as Json).records = 5),
    });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.message])).toEqual([
      [9, 'manifest.json files.logs.jsonl.records is 5, but logs.jsonl has 4'],
    ]);
  });

  it('checks the ground truth too', async () => {
    const truth = (await example('ground_truth.json')).toString('utf8');
    const dir = await makeBundle({ after: { 'ground_truth.json': truth.replace('42', '43') } });
    const report = await validateBundle(dir);
    expect(report.issues.map((i) => [i.rule, i.file, i.field])).toEqual([
      [7, 'manifest.json', 'scenario.seed'],
      [9, 'ground_truth.json', 'files.ground_truth.json.sha256'],
    ]);
  });
});

describe('reporting', () => {
  it('is deterministic and ordered by rule, then file', async () => {
    const dir = await makeBundle({
      manifest: (m) => {
        m.bundleId = 'x-1-20261026T000000Z';
        scenario(m).seed = 1;
        delete m.createdAt;
      },
      after: { 'logs.jsonl': 'nope\n', 'ground_truth.json': null },
    });
    const first = await validateBundle(dir);
    const second = await validateBundle(dir);
    expect(second).toEqual(first);
    expect(summary(first.issues)).toEqual([
      [1, 'ground_truth.json', null],
      [3, 'manifest.json', 'createdAt'],
      [4, 'logs.jsonl', 1],
      [6, 'manifest.json', 'bundleId'],
      [9, 'logs.jsonl', 'files.logs.jsonl.sha256'],
      [9, 'logs.jsonl', 'files.logs.jsonl.bytes'],
      [9, 'logs.jsonl', 'files.logs.jsonl.records'],
    ]);
    for (const i of first.issues) expect(i.ruleId).toBe(RULES[i.rule]);
  });

  it('reports a broken bundle written by hand in one pass', async () => {
    const dir = await makeBundle();
    await writeFile(join(dir, 'traces.jsonl'), '\n');
    const report = await validateBundle(dir);
    expect(rules(report.issues)).toEqual([4, 9]);
  });
});

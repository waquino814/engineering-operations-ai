import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app/application.ts';
import {
  DEFAULT_SETTINGS,
  parseSettingsInput,
  readSettings,
  SettingsError,
  writeSettings,
} from '../../src/app/settings.ts';
import { readInvestigationResult } from '../../src/investigation/result.ts';
import { chatReply, ollamaStub, tempDir, workspace } from './support.ts';
import { goodOutput } from '../investigation/support.ts';
import { openEvidence } from '../../src/index.ts';

describe('settings input', () => {
  it('accepts exactly a permitted provider and an optional plain model name', () => {
    expect(parseSettingsInput({ provider: 'fake' })).toEqual({
      provider: 'fake',
      ollamaModel: null,
    });
    expect(parseSettingsInput({ provider: 'ollama', ollamaModel: 'gemma4:12b' })).toEqual({
      provider: 'ollama',
      ollamaModel: 'gemma4:12b',
    });
    for (const bad of [
      null,
      [],
      'fake',
      {},
      { provider: 'anthropic' },
      { provider: 'local' },
      { provider: 'fake', url: 'http://x' },
      { provider: 'ollama', ollamaModel: 'x:cloud' },
      { provider: 'ollama', ollamaModel: '../../x' },
      { provider: 'ollama', ollamaModel: 3 },
      { ollamaModel: 'a' },
    ])
      expect(parseSettingsInput(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('the settings file', () => {
  it('defaults when absent, round-trips, and is private and atomic', async () => {
    const dir = await tempDir();
    const file = join(dir, 'nested', 'settings.json');
    expect(await readSettings(file)).toEqual(DEFAULT_SETTINGS);
    await writeSettings(file, { provider: 'ollama', ollamaModel: 'a:1b' });
    expect(await readSettings(file)).toEqual({ provider: 'ollama', ollamaModel: 'a:1b' });
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect((await readdir(join(dir, 'nested'))).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it.each([
    ['not json', '{oops'],
    ['an array', '[]'],
    ['an unknown key', '{"version":1,"provider":"fake","ollamaModel":null,"url":"http://x"}'],
    ['a missing key', '{"version":1,"provider":"fake"}'],
    ['another version', '{"version":2,"provider":"fake","ollamaModel":null}'],
    ['a hosted provider', '{"version":1,"provider":"anthropic","ollamaModel":null}'],
    ['a cloud model', '{"version":1,"provider":"ollama","ollamaModel":"x-cloud"}'],
  ])('rejects a file with %s, without using any of it', async (_why, text) => {
    const file = join(await tempDir(), 'settings.json');
    await writeFile(file, text);
    await expect(readSettings(file)).rejects.toBeInstanceOf(SettingsError);
  });

  it('reports a path that cannot be read as a settings error', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'settings.json'));
    await expect(readSettings(join(dir, 'settings.json'))).rejects.toThrow('could not be read');
  });
});

describe('the application with Ollama', () => {
  it('runs through the local runtime, validates the reply against the bundle, and stores it', async () => {
    const w = await workspace();
    const view = await openEvidence(w.b.excerpt);
    const stub = ollamaStub({ chat: () => chatReply(JSON.stringify(goodOutput(view))) });
    const app = createApplication(w.env(), { ollamaFetch: stub.fetch });
    expect(await app.updateSettings({ provider: 'ollama' })).toMatchObject({ status: 'saved' });
    const out = await app.startInvestigation(w.excerptId);
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.result.run).toMatchObject({ provider: 'ollama', model: 'tiny:1b' });
    expect(out.result.run.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      tokenAccounting: 'reported',
    });
    expect(out.result.run.limits).toMatchObject({
      maxContextBytes: 48_000,
      maxEvidenceRecords: 40,
    });
    expect(readInvestigationResult(out.result).ok).toBe(true);
    // Verification ran before the prompt: tags and show first, then exactly one chat.
    expect(stub.calls.map((c) => c.path)).toEqual([
      '/api/tags',
      '/api/status',
      '/api/show',
      '/api/chat',
    ]);
  });

  it('rejects a reply that cites a record the bundle does not have, and a malformed or empty reply', async () => {
    const w = await workspace();
    const view = await openEvidence(w.b.excerpt);
    const good = goodOutput(view);
    const first = good.findings[0];
    if (!first) throw new Error('scripted finding');
    const cases: [string, string][] = [
      [
        'an invented line',
        JSON.stringify({
          ...good,
          findings: [
            {
              ...first,
              evidence: [{ file: 'logs.jsonl', line: 999, time: 't', service: 'worker' }],
            },
          ],
        }),
      ],
      [
        'an invented identifier',
        JSON.stringify({
          ...good,
          findings: [
            {
              ...first,
              evidence: [{ file: 'logs.jsonl', line: 1, time: 'invented', service: 'worker' }],
            },
          ],
        }),
      ],
      ['malformed JSON', '{"outcome": "completed", '],
      ['empty text', ''],
      ['the wrong shape', '{"hello":"world"}'],
    ];
    for (const [why, text] of cases) {
      const stub = ollamaStub({ chat: () => chatReply(text) });
      const app = createApplication(w.env({ EOAI_MODEL_PROVIDER: 'ollama' }), {
        ollamaFetch: stub.fetch,
      });
      const out = await app.startInvestigation(w.excerptId);
      expect(out.status, why).toBe('done');
      if (out.status !== 'done') continue;
      // Rejected, with the bounded repair spent; never turned into a successful result.
      expect(out.result.outcome, why).toBe('failed');
      expect(out.result.findings, why).toEqual([]);
      expect(out.result.failure?.class, why).toMatch(/^(invalid_|malformed_|evidence_)/);
      expect(
        stub.calls.filter((c) => c.path === '/api/chat'),
        why,
      ).toHaveLength(2);
    }
  });

  it('records a failing runtime as a failed run, and never falls back to Fake', async () => {
    const w = await workspace();
    const stub = ollamaStub({ chat: () => ({ status: 500, body: { error: 'oom' } }) });
    const app = createApplication(w.env({ EOAI_MODEL_PROVIDER: 'ollama' }), {
      ollamaFetch: stub.fetch,
      sleep: () => Promise.resolve(),
    });
    const out = await app.startInvestigation(w.excerptId);
    expect(out).toMatchObject({
      status: 'done',
      result: { outcome: 'failed', run: { provider: 'ollama' } },
    });
    expect((await app.listRuns()).every((r) => r.ok && r.summary.outcome === 'failed')).toBe(true);
  });

  it('refuses without sending a prompt when the model is missing or cannot be verified', async () => {
    const w = await workspace();
    for (const models of [
      [],
      [{ name: 'x:cloud' }],
      [{ name: 'a:1b', extraTags: { remote_host: 'h' } }],
    ]) {
      const stub = ollamaStub({ models, chat: () => chatReply('{}') });
      const app = createApplication(w.env({ EOAI_MODEL_PROVIDER: 'ollama' }), {
        ollamaFetch: stub.fetch,
      });
      const out = await app.startInvestigation(w.excerptId);
      expect(out).toMatchObject({ status: 'refused', reason: 'provider_blocked' });
      expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
    }
  });

  it('blocks a real run, before any prompt, when Ollama reports its cloud features enabled', async () => {
    const w = await workspace();
    const stub = ollamaStub({
      status: { body: { cloud: { disabled: false, source: 'none' } } },
      chat: () => chatReply('{}'),
    });
    const app = createApplication(w.env({ EOAI_MODEL_PROVIDER: 'ollama' }), {
      ollamaFetch: stub.fetch,
    });
    const status = await app.getProviderStatus();
    expect(status).toMatchObject({
      selected: 'ollama',
      runnable: false,
      simulated: false,
      models: ['tiny:1b'],
    });
    expect(status.reason).toContain('cloud features are enabled');
    expect(status.reason).toContain('OLLAMA_NO_CLOUD=1');
    const out = await app.startInvestigation(w.excerptId);
    expect(out).toMatchObject({ status: 'refused', reason: 'provider_blocked' });
    expect(stub.calls.some((c) => c.path === '/api/chat')).toBe(false);
    // No silent fallback: nothing was stored from any provider.
    expect(await app.listRuns()).toEqual([]);
  });

  it('uses the model chosen in settings, and says when it is not installed', async () => {
    const w = await workspace();
    const stub = ollamaStub({ models: [{ name: 'a:1b' }, { name: 'b:1b' }] });
    const app = createApplication(w.env(), { ollamaFetch: stub.fetch });
    await app.updateSettings({ provider: 'ollama' });
    expect(await app.getProviderStatus()).toMatchObject({
      runnable: false,
      models: ['a:1b', 'b:1b'],
    });
    await app.updateSettings({ provider: 'ollama', ollamaModel: 'b:1b' });
    expect(await app.getProviderStatus()).toMatchObject({ runnable: true, model: 'b:1b' });
    await app.updateSettings({ provider: 'ollama', ollamaModel: 'gone:1b' });
    expect(await app.getProviderStatus()).toMatchObject({ runnable: false, model: 'gone:1b' });
  });

  it('keeps earlier results intact when the provider is changed', async () => {
    const w = await workspace();
    const app = createApplication(w.env(), { ollamaFetch: ollamaStub().fetch });
    const first = await app.startInvestigation(w.excerptId);
    if (first.status !== 'done') throw new Error('expected a run');
    await app.updateSettings({ provider: 'ollama' });
    await app.updateSettings({ provider: 'fake' });
    expect(await app.getRun(first.runId)).toEqual({ ok: true, result: first.result });
  });
});

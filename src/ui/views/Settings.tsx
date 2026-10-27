import { useState } from 'react';
import { DEFAULT_LIMITS } from '../../investigation/config.ts';
import { MODEL_OUTPUT_VERSION, RESULT_SCHEMA_VERSION } from '../../investigation/schemas.ts';
import { ErrorState, KeyValues, Loading, OriginTag, Panel } from '../components.tsx';
import type { InvestigationDataSource, ProviderSettings, ProviderStatus } from '../data/types.ts';
import { formatNumber } from '../model.ts';
import { useAsync } from '../use-async.ts';

/**
 * Settings (ADR 0013): the investigation provider, `Fake` or `Ollama`, saved by the application
 * and kept across restarts. The selection and its readiness are shown apart: Ollama can be
 * selected while unavailable, and then says why a run is blocked. Nothing here can enable a
 * hosted provider or fall back from one provider to another.
 */
type Saving =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'error'; message: string };

const LABEL = { fake: 'Fake (simulated)', ollama: 'Ollama (local model)' } as const;

export function Settings({ source }: { source: InvestigationDataSource }) {
  const [settings, reloadSettings] = useAsync(() => source.getSettings(), [source]);
  const [status, reloadStatus] = useAsync(() => source.getProviderStatus(), [source]);
  const [provider, setProvider] = useState<'fake' | 'ollama' | null>(null);
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState<Saving>({ state: 'idle' });

  const save = (chosen: 'fake' | 'ollama', chosenModel: string | null) => {
    setSaving({ state: 'saving' });
    source.saveSettings({ provider: chosen, ollamaModel: chosenModel }).then(
      () => {
        setSaving({ state: 'saved' });
        setProvider(null);
        setModel(undefined);
        reloadSettings();
        reloadStatus();
      },
      (err: unknown) => {
        setSaving({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">Choose how investigations run.</p>
        </div>
      </div>
      <div className="grid grid--settings">
        <Panel title="Investigation provider">
          {settings.status === 'loading' && <Loading what="settings" />}
          {settings.status === 'error' && (
            <ErrorState message={settings.message} onRetry={reloadSettings} />
          )}
          {settings.status === 'ready' && (
            <ProviderForm
              settings={settings.value}
              status={status.status === 'ready' ? status.value : null}
              provider={provider ?? settings.value.provider}
              model={model === undefined ? settings.value.ollamaModel : model}
              saving={saving}
              onProvider={(p) => {
                setProvider(p);
                setSaving({ state: 'idle' });
              }}
              onModel={(m) => {
                setModel(m);
                setSaving({ state: 'idle' });
              }}
              onSave={(p, m) => {
                save(p, m);
              }}
            />
          )}
        </Panel>
        <Panel title="Readiness">
          {status.status === 'loading' && <Loading what="provider status" />}
          {status.status === 'error' && (
            <ErrorState message={status.message} onRetry={reloadStatus} />
          )}
          {status.status === 'ready' && (
            <Readiness status={status.value} onRecheck={reloadStatus} />
          )}
        </Panel>
        <Panel title="Data source">
          <KeyValues
            rows={[
              ['Mode', <OriginTag origin={source.description.mode} />],
              ['About', source.description.notice],
              ['Hosted models', 'Not available. No setting, request or control can enable one.'],
              ['Result contract', `investigation-result ${RESULT_SCHEMA_VERSION}`],
              ['Model output contract', `model-output ${MODEL_OUTPUT_VERSION}`],
            ]}
          />
        </Panel>
        <Panel title="Default investigation limits">
          <KeyValues rows={Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, formatNumber(v)])} />
        </Panel>
      </div>
    </div>
  );
}

function ProviderForm(props: {
  settings: ProviderSettings;
  status: ProviderStatus | null;
  provider: 'fake' | 'ollama';
  model: string | null;
  saving: Saving;
  onProvider: (p: 'fake' | 'ollama') => void;
  onModel: (m: string | null) => void;
  onSave: (p: 'fake' | 'ollama', m: string | null) => void;
}) {
  const { settings, status, provider, model, saving } = props;
  const changed =
    provider !== settings.provider || (provider === 'ollama' && model !== settings.ollamaModel);
  const models = status?.models ?? [];
  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(provider, provider === 'ollama' ? model : null);
      }}
    >
      <fieldset className="choices" disabled={settings.pinned}>
        <legend className="visually-hidden">Investigation provider</legend>
        {(['fake', 'ollama'] as const).map((p) => (
          <label key={p} className={`choice ${provider === p ? 'choice--on' : ''}`}>
            <input
              type="radio"
              name="provider"
              value={p}
              checked={provider === p}
              disabled={settings.pinned}
              onChange={() => {
                props.onProvider(p);
              }}
            />
            <span>
              <span className="choice__title">{LABEL[p]}</span>
              <span className="choice__detail">
                {p === 'fake'
                  ? 'Deterministic simulated output for demos and tests. It performs no analysis and is labelled as simulated everywhere it appears.'
                  : 'Real inference with a model already installed in your local Ollama. Checked as local-only before any prompt is sent; never downloads a model.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {provider === 'ollama' && (
        <div className="field">
          <label htmlFor="ollama-model">Ollama model</label>
          <select
            id="ollama-model"
            value={model ?? ''}
            disabled={settings.pinned}
            onChange={(event) => {
              props.onModel(event.target.value === '' ? null : event.target.value);
            }}
          >
            <option value="">Automatic (the only installed model)</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {models.length === 0 && (
            <p className="muted">No installed model was found; you can still select Ollama.</p>
          )}
        </div>
      )}
      {settings.pinned && (
        <p className="notice" role="status">
          The provider is fixed outside the console and cannot be changed here.
        </p>
      )}
      <button
        type="submit"
        className="button button--primary"
        disabled={settings.pinned || !changed || saving.state === 'saving'}
      >
        {saving.state === 'saving' ? 'Saving…' : 'Save provider'}
      </button>
      {saving.state === 'saved' && (
        <p className="notice" role="status">
          Saved. This choice is kept when the application restarts.
        </p>
      )}
      {saving.state === 'error' && (
        <p className="notice notice--error" role="alert">
          Not saved: {saving.message}
        </p>
      )}
    </form>
  );
}

function Readiness({ status, onRecheck }: { status: ProviderStatus; onRecheck: () => void }) {
  return (
    <>
      <KeyValues
        rows={[
          [
            'Selected',
            status.selected === 'fixture'
              ? 'Fixtures'
              : LABEL[status.selected] + (status.pinned ? ' (fixed outside the console)' : ''),
          ],
          [
            'Readiness',
            status.runnable ? 'Ready to run' : `Blocked: ${status.reason ?? 'not ready'}`,
          ],
          ['Model', status.model ?? '—'],
        ]}
      />
      {status.simulated && (
        <p className="notice" role="status">
          Runs with this provider are <strong>simulated</strong>: deterministic placeholders, not AI
          findings.
        </p>
      )}
      <button type="button" className="button" onClick={onRecheck}>
        Check again
      </button>
    </>
  );
}

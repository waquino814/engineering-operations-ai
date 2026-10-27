import { useState } from 'react';
import { EmptyState, ErrorState, EvaluationKindBadge, Loading, Panel } from '../components.tsx';
import type {
  EvaluationProviderChoice,
  EvaluationStartOutcome,
  InvestigationDataSource,
} from '../data/types.ts';
import { formatTime } from '../model.ts';
import { href } from '../router.ts';
import { useAsync } from '../use-async.ts';

/**
 * Evaluations (E7): run a versioned suite and open stored results. A scripted or simulated run
 * tests the pipeline and the scoring; only an evaluation of a real local model says anything
 * about a model, and Ollama is available only if it passes the same local-only check as an
 * investigation, which this page cannot bypass.
 */
const PROVIDERS: { value: EvaluationProviderChoice; label: string; detail: string }[] = [
  {
    value: 'scripted',
    label: 'Scripted replies (test double)',
    detail:
      'Each case has a reply written in advance. Tests the pipeline, verification and scoring; no model.',
  },
  {
    value: 'simulated',
    label: 'Simulated provider (placeholder)',
    detail:
      'The deterministic fake provider over each bundle. Tests the pipeline end to end; no model.',
  },
  {
    value: 'ollama',
    label: 'Ollama (real local model)',
    detail:
      'Runs only if Ollama reports its cloud features disabled. Slow: one investigation per bundle.',
  },
];

export function Evaluations({ source }: { source: InvestigationDataSource }) {
  const [suites] = useAsync(() => source.listEvaluationSuites(), [source]);
  const [list, reload] = useAsync(() => source.listEvaluations(), [source]);
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const [provider, setProvider] = useState<EvaluationProviderChoice>('scripted');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<EvaluationStartOutcome | null>(null);

  const chosen = suiteId ?? (suites.status === 'ready' ? suites.value[0]?.id : undefined) ?? null;
  const start = () => {
    if (chosen === null) return;
    setRunning(true);
    setOutcome(null);
    source
      .startEvaluation({ suiteId: chosen, provider })
      .then(setOutcome, (err: unknown) => {
        setOutcome({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        setRunning(false);
        reload();
      });
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Evaluations</h1>
          <p className="page__subtitle">
            Repeatable scores for the investigation pipeline. Scripted and simulated runs test the
            pipeline, not a model.
          </p>
        </div>
      </div>

      <Panel title="Run an evaluation">
        {suites.status === 'loading' && <Loading what="suites" />}
        {suites.status === 'error' && <ErrorState message={suites.message} />}
        {suites.status === 'ready' && suites.value.length === 0 && (
          <p className="muted">This console has no evaluation suites to run.</p>
        )}
        {suites.status === 'ready' && suites.value.length > 0 && (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              start();
            }}
          >
            <div className="field">
              <label htmlFor="eval-suite">Suite</label>
              <select
                id="eval-suite"
                value={chosen ?? ''}
                onChange={(event) => {
                  setSuiteId(event.target.value);
                }}
              >
                {suites.value.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} v{s.version} · {s.split} split
                  </option>
                ))}
              </select>
              <p className="muted small">
                {suites.value.find((s) => s.id === chosen)?.description}
              </p>
            </div>
            <fieldset className="choices">
              <legend className="visually-hidden">Replies from</legend>
              {PROVIDERS.map((p) => (
                <label
                  key={p.value}
                  className={`choice ${provider === p.value ? 'choice--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="eval-provider"
                    value={p.value}
                    checked={provider === p.value}
                    onChange={() => {
                      setProvider(p.value);
                    }}
                  />
                  <span>
                    <span className="choice__title">{p.label}</span>
                    <span className="choice__detail">{p.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="submit" className="button button--primary" disabled={running}>
              {running ? 'Running…' : 'Run evaluation'}
            </button>
            {running && (
              <p className="notice" role="status">
                Running. A real model can take several minutes; keep this page open.
              </p>
            )}
            {outcome?.status === 'started' && (
              <p className="notice" role="status">
                Stored: <a href={href({ name: 'evaluation', id: outcome.id })}>{outcome.id}</a>
              </p>
            )}
            {outcome?.status === 'refused' && (
              <div className="notice" role="status">
                <p>
                  <strong>This evaluation cannot run.</strong> {outcome.message}
                </p>
                <p>
                  Nothing was run and nothing was stored. There is no fallback to another provider.
                </p>
              </div>
            )}
            {outcome?.status === 'error' && (
              <p className="notice notice--error" role="alert">
                The evaluation did not run: {outcome.message}
              </p>
            )}
          </form>
        )}
      </Panel>

      <Panel title="Stored evaluations">
        {list.status === 'loading' && <Loading what="evaluations" />}
        {list.status === 'error' && <ErrorState message={list.message} onRetry={reload} />}
        {list.status === 'ready' && list.value.length === 0 && (
          <EmptyState title="No evaluations yet">
            <p>
              Run a suite above; its result is stored and can be reopened without rerunning
              anything.
            </p>
          </EmptyState>
        )}
        {list.status === 'ready' && list.value.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Stored evaluations, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Evaluation</th>
                  <th scope="col">Suite</th>
                  <th scope="col">Replies from</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Root cause correct
                  </th>
                  <th scope="col" className="num">
                    Reached a result
                  </th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {list.value.map((e) =>
                  e.ok ? (
                    <tr key={e.id}>
                      <th scope="row">
                        <a href={href({ name: 'evaluation', id: e.id })}>
                          <span className="mono">{e.id}</span>
                        </a>
                      </th>
                      <td>
                        {e.suite.id} v{e.suite.version}{' '}
                        <span className="muted">({e.suite.split})</span>
                      </td>
                      <td>
                        <EvaluationKindBadge kind={e.provider.kind} model={e.provider.model} />
                      </td>
                      <td>{e.status === 'complete' ? 'Complete' : 'Incomplete'}</td>
                      <td className="num">{e.headline.rootCauseCorrect}</td>
                      <td className="num">{e.headline.completion}</td>
                      <td className="nowrap">{formatTime(e.startedAt)}</td>
                    </tr>
                  ) : (
                    <tr key={e.id}>
                      <th scope="row">
                        <span className="mono">{e.id}</span>
                      </th>
                      <td colSpan={6} className="muted">
                        Unreadable: {e.problems[0] ?? 'it does not match the evaluation format'}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

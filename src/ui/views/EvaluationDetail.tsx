import { useState } from 'react';
import {
  EmptyState,
  ErrorState,
  EvaluationKindBadge,
  KeyValues,
  Loading,
  Panel,
} from '../components.tsx';
import type {
  EvaluationCaseView,
  EvaluationComparisonView,
  EvaluationDetailView,
  EvaluationMetric,
  InvestigationDataSource,
} from '../data/types.ts';
import { formatNumber, formatTime } from '../model.ts';
import { href } from '../router.ts';
import { useAsync } from '../use-async.ts';

/**
 * One stored evaluation run: what produced the replies, every metric with its numerator and
 * denominator and definition, the per-scenario and per-case results with the reason for each,
 * reliability, and what the run does not show. Nothing here reruns an investigation.
 */
export function EvaluationDetail({ source, id }: { source: InvestigationDataSource; id: string }) {
  const [state, reload] = useAsync(() => source.getEvaluation(id), [source, id]);
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <a href={href({ name: 'evaluations' })}>Evaluations</a> <span aria-hidden="true">/</span>{' '}
        <span>{id}</span>
      </nav>
      {state.status === 'loading' && <Loading what="the evaluation" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={reload} />}
      {state.status === 'ready' && state.value === null && (
        <EmptyState title="Evaluation not found">
          <p>
            There is no stored evaluation <span className="mono">{id}</span>.
          </p>
          <a className="button" href={href({ name: 'evaluations' })}>
            Back to evaluations
          </a>
        </EmptyState>
      )}
      {state.status === 'ready' && state.value !== null && (
        <Run run={state.value} source={source} />
      )}
    </div>
  );
}

const pct = (m: Pick<EvaluationMetric, 'value'>) =>
  m.value === null ? 'n/a' : `${(m.value * 100).toFixed(1)}%`;

function MetricRow({ m }: { m: EvaluationMetric }) {
  return (
    <tr>
      <th scope="row">
        {m.label}
        <span className="cell-sub">
          {m.status === 'not_scored' ? (m.note ?? m.definition) : m.definition}
        </span>
      </th>
      <td className="num">
        {m.status === 'not_scored' ? 'Not scored' : m.status === 'not_applicable' ? 'n/a' : pct(m)}
      </td>
      <td className="num">
        {m.numerator === null
          ? '—'
          : `${formatNumber(m.numerator)} / ${formatNumber(m.denominator)}`}
      </td>
    </tr>
  );
}

function Run({ run, source }: { run: EvaluationDetailView; source: InvestigationDataSource }) {
  const real = run.provider.kind === 'real_model';
  return (
    <>
      <div className="page__header">
        <div>
          <h1>
            Evaluation: {run.suite.id} v{run.suite.version}
          </h1>
          <p className="page__subtitle">
            <EvaluationKindBadge kind={run.provider.kind} model={run.provider.model} />{' '}
            <span className="tag">{run.suite.split} split</span>{' '}
            {run.suite.synthetic && <span className="tag">synthetic bundles</span>}
          </p>
        </div>
      </div>

      <div className={`banner ${real ? '' : 'banner--warn'}`} role="status">
        <p className="banner__title">
          {real
            ? 'A real local model generated these replies.'
            : 'This evaluation tests the pipeline, not a model.'}
        </p>
        <p>
          {real
            ? 'Scores describe this model on these few bundles only; they are not an estimate of accuracy on real incidents.'
            : 'The replies are fixed or placeholder, so no number below is model accuracy.'}
        </p>
        {run.status === 'incomplete' && (
          <p>
            <strong>Incomplete:</strong> the run was cancelled or a case could not be evaluated; the
            numbers cover only the cases that finished.
          </p>
        )}
      </div>

      <div className="grid">
        <Panel title="Run">
          <KeyValues
            rows={[
              ['Suite', `${run.suite.id} v${run.suite.version} (${run.suite.split})`],
              ['About', run.suite.description],
              ['Replies from', `${run.provider.provider} · ${run.provider.model}`],
              ['Measures model quality', run.measuresModelQuality ? 'Yes' : 'No'],
              ['Started', formatTime(run.startedAt)],
              ['Duration', `${formatNumber(Math.round(run.durationMs))} ms`],
              ['Status', run.status === 'complete' ? 'Complete' : 'Incomplete'],
            ]}
          />
        </Panel>
        <Panel title="Reliability">
          <KeyValues
            rows={[
              ['Cases', String(run.reliability.cases)],
              [
                'Outcomes',
                `${String(run.reliability.completed)} completed, ${String(run.reliability.inconclusive)} inconclusive, ${String(run.reliability.failed)} failed, ${String(run.reliability.budgetExceeded)} over budget`,
              ],
              ['Not admitted', String(run.reliability.notAdmitted)],
              ['Provider timeouts', String(run.reliability.timeouts)],
              ['Harness errors', String(run.reliability.harnessErrors)],
              [
                'Failures by class',
                Object.entries(run.reliability.failuresByClass).length === 0
                  ? 'None'
                  : Object.entries(run.reliability.failuresByClass)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(', '),
              ],
            ]}
          />
        </Panel>
      </div>

      <Panel title="Metrics">
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">
              Aggregate metrics with numerators and denominators
            </caption>
            <thead>
              <tr>
                <th scope="col">Metric and definition</th>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col" className="num">
                  Count
                </th>
              </tr>
            </thead>
            <tbody>
              {run.metrics.map((m) => (
                <MetricRow key={m.id} m={m} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="By scenario">
        <div className="table-wrap">
          <table className="table table--compact">
            <caption className="visually-hidden">Results by scenario</caption>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Cases</th>
                <th scope="col">Root cause correct</th>
                <th scope="col">Symptom series cited</th>
                <th scope="col">Citations verified</th>
              </tr>
            </thead>
            <tbody>
              {run.scenarios.map((s) => {
                const get = (mid: string) => s.metrics.find((m) => m.id === mid);
                const cell = (mid: string) => {
                  const m = get(mid);
                  return m === undefined || m.numerator === null
                    ? 'n/a'
                    : `${String(m.numerator)}/${String(m.denominator)}`;
                };
                return (
                  <tr key={s.scenario ?? 'not-admitted'}>
                    <th scope="row">
                      {s.scenario === null
                        ? 'Not admitted (no scenario)'
                        : `${s.scenario} (seed ${String(s.seed)})`}
                    </th>
                    <td>{s.cases.length}</td>
                    <td>{cell('root_cause_correct')}</td>
                    <td>{cell('symptom_evidence')}</td>
                    <td>{cell('citation_grounding')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Cases">
        <div className="table-wrap">
          <table className="table table--compact">
            <caption className="visually-hidden">Each case, with the reason for its score</caption>
            <thead>
              <tr>
                <th scope="col">Case</th>
                <th scope="col">Outcome</th>
                <th scope="col">Root cause</th>
                <th scope="col">Symptom series</th>
                <th scope="col">Citations</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {run.report.cases.map((c) => (
                <CaseRow key={c.id} c={c} />
              ))}
            </tbody>
          </table>
        </div>
        {run.harnessErrors.length > 0 && (
          <p className="notice notice--error" role="alert">
            The harness could not evaluate: {run.harnessErrors.map((h) => h.id).join(', ')}.
          </p>
        )}
      </Panel>

      <Compare run={run} source={source} />

      <Panel title="What this run does not show">
        <ul className="plain">
          {run.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function CaseRow({ c }: { c: EvaluationCaseView }) {
  return (
    <tr>
      <th scope="row">
        <span className="mono">{c.id}</span>
        <span className="cell-sub">
          {c.scenario === null
            ? 'not admitted'
            : `${c.scenario.name}, seed ${String(c.scenario.seed)}`}
        </span>
      </th>
      <td>
        {c.summary.outcome}
        {c.failure && <span className="cell-sub">{c.failure.class}</span>}
      </td>
      <td>{c.score?.rootCause ?? 'n/a'}</td>
      <td>{c.score?.symptomEvidence.replace('_', ' ') ?? 'n/a'}</td>
      <td>
        {c.grounding === null
          ? 'n/a'
          : `${String(c.grounding.verified)}/${String(c.grounding.citations)}`}
      </td>
      <td className="cell-wrap">
        <details>
          <summary>Reasons</summary>
          <ul className="plain">
            {c.rationale.map((r) => (
              <li key={r}>{r}</li>
            ))}
            {c.failure && <li>Failure: {c.failure.message}</li>}
            {c.score === null && <li>Not scored: the bundle was not admitted.</li>}
            {c.answerLeak.leaked && <li>An answer leak was detected for this case.</li>}
            {!c.resultValid && <li>The result did not satisfy the result contract.</li>}
          </ul>
        </details>
      </td>
    </tr>
  );
}

function Compare({ run, source }: { run: EvaluationDetailView; source: InvestigationDataSource }) {
  const [others] = useAsync(() => source.listEvaluations(), [source, run.id]);
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; value: EvaluationComparisonView }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const candidates =
    others.status === 'ready'
      ? others.value.flatMap((e) =>
          e.ok &&
          e.id !== run.id &&
          e.suite.id === run.suite.id &&
          e.suite.version === run.suite.version
            ? [e]
            : [],
        )
      : [];
  return (
    <Panel title="Compare with another run">
      {others.status !== 'ready' || candidates.length === 0 ? (
        <p className="muted">No other stored run of this suite and version to compare with.</p>
      ) : (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (target === '') return;
            setResult({ status: 'loading' });
            source.compareEvaluations(target, run.id).then(
              (value) => {
                setResult({ status: 'ready', value });
              },
              (err: unknown) => {
                setResult({
                  status: 'error',
                  message: err instanceof Error ? err.message : String(err),
                });
              },
            );
          }}
        >
          <div className="field">
            <label htmlFor="compare-target">Earlier run (compared to this one)</label>
            <select
              id="compare-target"
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
            >
              <option value="">Choose a run…</option>
              {candidates.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.id} ({e.provider.kind})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button" disabled={target === ''}>
            Compare
          </button>
        </form>
      )}
      {result.status === 'loading' && <Loading what="the comparison" />}
      {result.status === 'error' && <ErrorState message={result.message} />}
      {result.status === 'ready' && <Comparison value={result.value} />}
    </Panel>
  );
}

function Comparison({ value }: { value: EvaluationComparisonView }) {
  return (
    <div>
      {!value.sameProvider && (
        <p className="notice notice--error" role="status">
          These runs used different providers or models, so a difference may reflect the provider,
          not a change in the pipeline.
        </p>
      )}
      <p role="status">
        <strong>
          {value.regressions} regressed, {value.improvements} improved
        </strong>{' '}
        of {value.cases.length} cases.
      </p>
      <div className="table-wrap">
        <table className="table table--compact">
          <caption className="visually-hidden">Metric differences</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="num">
                Earlier
              </th>
              <th scope="col" className="num">
                This run
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {value.metrics.map((m) => (
              <tr key={m.id}>
                <th scope="row">{m.label}</th>
                <td className="num">{m.a === null ? 'n/a' : m.a}</td>
                <td className="num">{m.b === null ? 'n/a' : m.b}</td>
                <td className="num">{m.delta === null ? 'n/a' : m.delta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="plain">
        {value.cases
          .filter((c) => c.change !== 'unchanged')
          .map((c) => (
            <li key={c.id}>
              <span className="mono">{c.id}</span>: <strong>{c.change.replace(/_/g, ' ')}</strong>
              {c.a !== null && <span className="muted"> — earlier: {c.a}</span>}
              {c.b !== null && <span className="muted"> — this run: {c.b}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}

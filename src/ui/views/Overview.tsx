import { EmptyState, ErrorState, Loading, OriginTag, StatusBadge } from '../components.tsx';
import type { InvestigationDataSource } from '../data/types.ts';
import {
  affectedComponents,
  formatNumber,
  formatTime,
  outcomeView,
  rootCauseSummary,
} from '../model.ts';
import { href } from '../router.ts';
import { useAsync } from '../use-async.ts';

/** Screen A: recent investigations, newest first. */
export function Overview({ source }: { source: InvestigationDataSource }) {
  const [state, reload] = useAsync(() => source.listInvestigations(), [source]);
  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Investigations</h1>
          <p className="page__subtitle">Recent runs and their outcomes.</p>
        </div>
        <a className="button button--primary" href={href({ name: 'new' })}>
          New investigation
        </a>
      </div>
      {state.status === 'loading' && <Loading what="investigations" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={reload} />}
      {state.status === 'ready' && state.value.length === 0 && (
        <EmptyState title="No investigations yet">
          <p>Validate a bundle and start an investigation to see it here.</p>
          <a className="button button--primary" href={href({ name: 'new' })}>
            New investigation
          </a>
        </EmptyState>
      )}
      {state.status === 'ready' && state.value.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Investigations, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Incident</th>
                <th scope="col">Outcome</th>
                <th scope="col">Root cause</th>
                <th scope="col">Components</th>
                <th scope="col" className="num">
                  Findings
                </th>
                <th scope="col" className="num">
                  Model calls
                </th>
                <th scope="col" className="num">
                  Tokens charged
                </th>
                <th scope="col">Started</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {state.value.map((inv) => {
                const outcome = outcomeView(inv.result);
                const root = rootCauseSummary(inv.result);
                return (
                  <tr key={inv.id}>
                    <th scope="row">
                      <a href={href({ name: 'investigation', id: inv.id })}>
                        <span className="mono">{inv.result.caseId ?? inv.id}</span>
                      </a>
                      <span className="cell-sub">{inv.label}</span>
                    </th>
                    <td>
                      <StatusBadge outcome={outcome.key} label={outcome.label} />
                    </td>
                    <td className="cell-wrap">
                      {root ?? (
                        <span className="muted">
                          {inv.result.failure ? inv.result.failure.class : 'No root cause stated'}
                        </span>
                      )}
                    </td>
                    <td>
                      {affectedComponents(inv.result)
                        .map((c) => c.name)
                        .join(', ') || <span className="muted">—</span>}
                    </td>
                    <td className="num">{inv.result.findings.length}</td>
                    <td className="num">{inv.result.run.usage.modelCalls}</td>
                    <td className="num">{formatNumber(inv.result.run.usage.chargedTokens)}</td>
                    <td className="nowrap">{formatTime(inv.result.run.startedAt)}</td>
                    <td>
                      <OriginTag origin={inv.origin} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

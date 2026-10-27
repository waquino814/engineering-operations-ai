import {
  EmptyState,
  ErrorState,
  KeyValues,
  Loading,
  OriginTag,
  ProviderBadge,
  Panel,
  StatusBadge,
} from '../components.tsx';
import type { InvestigationDataSource, InvestigationRecord } from '../data/types.ts';
import type { FindingVerification, VerifiedFinding } from '../../investigation/result.ts';
import {
  affectedComponents,
  evidenceTimeline,
  formatNumber,
  formatTime,
  KIND_LABELS,
  limitRows,
  outcomeView,
  plural,
  referenceIdentity,
  rootCauseSummary,
  tokenView,
  VERIFICATION_LABELS,
  verificationText,
} from '../model.ts';
import { href } from '../router.ts';
import { useAsync } from '../use-async.ts';

/** Screen C: one investigation, everything the result says and nothing it does not. */
export function InvestigationDetail({
  source,
  id,
}: {
  source: InvestigationDataSource;
  id: string;
}) {
  const [state, reload] = useAsync(() => source.getInvestigation(id), [source, id]);
  return (
    <div className="page">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <a href={href({ name: 'investigations' })}>Investigations</a>{' '}
        <span aria-hidden="true">/</span> <span>{id}</span>
      </nav>
      {state.status === 'loading' && <Loading what="the investigation" />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={reload} />}
      {state.status === 'ready' && state.value === null && (
        <EmptyState title="Investigation not found">
          <p>
            There is no investigation with ID <span className="mono">{id}</span>.
          </p>
          <a className="button" href={href({ name: 'investigations' })}>
            Back to investigations
          </a>
        </EmptyState>
      )}
      {state.status === 'ready' && state.value !== null && <Workspace record={state.value} />}
    </div>
  );
}

function Workspace({ record }: { record: InvestigationRecord }) {
  const { result } = record;
  const outcome = outcomeView(result);
  const root = rootCauseSummary(result);
  const components = affectedComponents(result);
  const timeline = evidenceTimeline(result);
  return (
    <>
      <div className="page__header">
        <div>
          <h1>
            {result.caseId ? (
              <>
                Case <span className="mono">{result.caseId}</span>
              </>
            ) : (
              'Investigation not admitted'
            )}
          </h1>
          <p className="page__subtitle">
            {record.label} · <OriginTag origin={record.origin} /> ·{' '}
            <ProviderBadge provider={result.run.provider} model={result.run.model} />
          </p>
        </div>
        <StatusBadge outcome={outcome.key} label={outcome.label} />
      </div>

      <section className={`banner banner--${outcome.key}`} aria-label="Outcome">
        <p className="banner__title">{outcome.label}</p>
        <p>{outcome.meaning}</p>
        {result.failure && (
          <p>
            <span className="mono">{result.failure.class}</span>: {result.failure.message}
          </p>
        )}
      </section>

      <div className="grid grid--detail">
        <div className="col">
          <Panel title="Summary">
            <KeyValues
              rows={[
                ['Root cause', root ?? <span className="muted">No root cause stated</span>],
                [
                  'Affected components',
                  components.length > 0 ? (
                    <ul className="chips">
                      {components.map((c) => (
                        <li
                          key={c.name}
                          className={`chip ${c.kinds.includes('root_cause') ? 'chip--root' : ''}`}
                        >
                          {c.name}
                          {c.kinds.includes('root_cause') && (
                            <span className="chip__note"> root cause</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">None named</span>
                  ),
                ],
                ['Findings', String(result.findings.length)],
              ]}
            />
          </Panel>

          <Panel title="Findings">
            {result.findings.length === 0 ? (
              <p className="muted">
                {result.outcome === 'inconclusive'
                  ? 'No findings: the evidence did not support a conclusion.'
                  : 'No findings: the run did not complete.'}
              </p>
            ) : (
              <ol className="findings">
                {result.findings.map((f) => (
                  <Finding key={f.id} finding={f} />
                ))}
              </ol>
            )}
          </Panel>

          {result.remediation.length > 0 && (
            <Panel title="Recommended remediation">
              <p className="muted small">Advice only; nothing is changed automatically.</p>
              <ol className="plain">
                {result.remediation.map((r, i) => (
                  <li key={i}>
                    {r.step} <span className="muted">(addresses {r.addresses.join(', ')})</span>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          <Panel title="Evidence timeline">
            {timeline.length === 0 ? (
              <p className="muted">No cited evidence quotes a time.</p>
            ) : (
              <ol className="timeline">
                {timeline.map((t, i) => (
                  <li key={i} className="timeline__item">
                    <span className="timeline__time mono">{formatTime(t.time)}</span>
                    <span>
                      {t.what}{' '}
                      <span className="muted">
                        — {t.file}:{t.line}, finding {t.findingId}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>

        <div className="col">
          <Panel title="Limitations">
            {result.limitations.length === 0 ? (
              <p className="muted">None stated.</p>
            ) : (
              <ul className="plain">
                {result.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </Panel>
          <RunDetails record={record} />
          <Diagnostics record={record} />
        </div>
      </div>
    </>
  );
}

function Finding({ finding }: { finding: VerifiedFinding }) {
  return (
    <li className="finding">
      <div className="finding__header">
        <span className="mono muted">{finding.id}</span>
        <span className="tag">{KIND_LABELS[finding.kind] ?? finding.kind}</span>
        <span className="tag" title="Qualitative level stated by the model; not a probability">
          Confidence: {finding.confidence}
        </span>
        {finding.components.length > 0 && (
          <span className="muted">{finding.components.join(', ')}</span>
        )}
      </div>
      <p className="finding__statement">{finding.statement}</p>
      <p className="finding__rationale">
        <span className="muted">Rationale:</span> {finding.rationale}
      </p>
      <h3 className="subhead">Evidence ({plural(finding.evidence.length, 'reference')})</h3>
      <div className="table-wrap">
        <table className="table table--compact">
          <caption className="visually-hidden">Evidence for {finding.id}</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col" className="num">
                Line
              </th>
              <th scope="col">Identifiers quoted</th>
            </tr>
          </thead>
          <tbody>
            {finding.evidence.map((ref) => (
              <tr key={`${ref.file}:${String(ref.line)}`}>
                <td className="mono">{ref.file}</td>
                <td className="num">{ref.line}</td>
                <td>
                  <ul className="identity">
                    {referenceIdentity(ref).map(([k, v]) => (
                      <li key={k}>
                        <span className="muted">{k}:</span> <span className="mono">{v}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="subhead">Verification</h3>
      <ul className="checks">
        {(Object.keys(VERIFICATION_LABELS) as (keyof FindingVerification)[]).map((k) => (
          <li key={k} className={`check check--${finding.verification[k]}`}>
            <span className="check__label">{VERIFICATION_LABELS[k].label}</span>
            <span className="check__value">{verificationText(finding.verification[k])}</span>
            <span className="check__detail muted">{VERIFICATION_LABELS[k].detail}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function RunDetails({ record }: { record: InvestigationRecord }) {
  const { run } = record.result;
  const tokens = tokenView(record.result);
  return (
    <Panel title="Run">
      <KeyValues
        rows={[
          ['Provider', <ProviderBadge provider={run.provider} model={run.model} />],
          ['Started', formatTime(run.startedAt)],
          ['Finished', formatTime(run.finishedAt)],
          ['Duration', `${formatNumber(run.durationMs)} ms`],
          [
            'Model calls',
            `${String(run.usage.modelCalls)} (${plural(run.usage.retries, 'retry', 'retries')}, ${plural(run.usage.repairAttempts, 'repair')})`,
          ],
          [
            'Tokens reported',
            `${formatNumber(tokens.reportedInput)} in · ${formatNumber(tokens.reportedOutput)} out`,
          ],
          [
            'Tokens charged',
            tokens.budget === null
              ? formatNumber(tokens.charged)
              : `${formatNumber(tokens.charged)} of ${formatNumber(tokens.budget)} budget`,
          ],
        ]}
      />
      {tokens.share !== null && (
        <meter
          className="meter"
          min={0}
          max={1}
          value={tokens.share}
          aria-label="Token budget used"
        />
      )}
      <p className="small muted">
        {tokens.accounting === 'reported'
          ? 'Accounting: reported. Every call had a valid usage report.'
          : `Accounting: estimated. ${plural(tokens.unreportedCalls, 'call')} without a valid usage report ${tokens.unreportedCalls === 1 ? 'was' : 'were'} charged at the call ceiling${tokens.inconsistentReports > 0 ? `; ${plural(tokens.inconsistentReports, 'report')} exceeded a ceiling` : ''}.`}
      </p>
    </Panel>
  );
}

function Diagnostics({ record }: { record: InvestigationRecord }) {
  const { result } = record;
  const { selection } = result;
  const limits = limitRows(result);
  return (
    <Panel title="Diagnostics">
      {result.failure && (
        <KeyValues
          rows={[
            ['Failure class', <span className="mono">{result.failure.class}</span>],
            ['Message', result.failure.message],
          ]}
        />
      )}
      <h3 className="subhead">Evidence selection</h3>
      {selection === null ? (
        <p className="muted">No evidence was selected: the run stopped before selection.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table--compact">
              <caption className="visually-hidden">Evidence selection by file</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                  <th scope="col" className="num">
                    Sent
                  </th>
                  <th scope="col" className="num">
                    Omitted
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(selection.files).map(([file, f]) => {
                  const omitted = Object.entries(f.omitted).filter(([, n]) => n > 0);
                  return (
                    <tr key={file}>
                      <td className="mono">{file}</td>
                      <td className="num">{f.records}</td>
                      <td className="num">{f.selected}</td>
                      <td className="num">
                        {omitted.length === 0
                          ? '0'
                          : omitted
                              .map(([why, n]) => `${String(n)} ${why.replace(/_/g, ' ')}`)
                              .join(', ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {selection.notes.length > 0 && (
            <ul className="plain small">
              {selection.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <h3 className="subhead">Limits</h3>
      {limits ? (
        <KeyValues rows={limits.map(([k, v]) => [k, formatNumber(v)])} />
      ) : (
        <p className="muted">Not recorded: the configuration was invalid.</p>
      )}
    </Panel>
  );
}

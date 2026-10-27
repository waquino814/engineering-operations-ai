import { useState, type ChangeEvent } from 'react';
import { ErrorState, KeyValues, Loading, OriginTag, Panel } from '../components.tsx';
import type {
  BundleValidation,
  InvestigationDataSource,
  StartOutcome,
  Unavailable,
} from '../data/types.ts';
import { formatNumber, issueLocation, plural, RULE_HINTS, shortHash } from '../model.ts';
import { href } from '../router.ts';
import { useAsync, type AsyncState } from '../use-async.ts';

/**
 * Screen B: choose or upload a bundle, validate it, and start an investigation only when it is
 * valid. Every step goes through the data source; with fixtures, upload and start answer that
 * they need the E6 application boundary.
 */
export function NewInvestigation({ source }: { source: InvestigationDataSource }) {
  const [bundles, reloadBundles] = useAsync(() => source.listBundles(), [source]);
  const [status] = useAsync(() => source.getProviderStatus(), [source]);
  const [selected, setSelected] = useState<string | null>(null);
  const [validation, setValidation] = useState<AsyncState<BundleValidation> | null>(null);
  const [upload, setUpload] = useState<
    Unavailable | { status: 'uploaded'; bundleId: string } | null
  >(null);
  const [start, setStart] = useState<StartOutcome | null>(null);
  const [running, setRunning] = useState(false);

  const choose = (bundleId: string) => {
    setSelected(bundleId);
    setStart(null);
    setValidation({ status: 'loading' });
    source.validateBundle(bundleId).then(
      (value) => {
        setValidation({ status: 'ready', value });
      },
      (err: unknown) => {
        setValidation({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
  };

  const onUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    if (files.length === 0) return;
    void source.uploadBundle(files).then(setUpload);
  };

  const valid = validation?.status === 'ready' && validation.value.valid;
  // A start is offered only when the application says it can run one; until it answers, it is not.
  const blocked = status.status === 'ready' && !status.value.runnable;
  const simulated = status.status === 'ready' && status.value.simulated;
  const canStart = valid && selected !== null && status.status === 'ready' && status.value.runnable;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>New investigation</h1>
          <p className="page__subtitle">Choose a bundle, check that it is valid, then start.</p>
        </div>
      </div>

      <div className="grid grid--new">
        <Panel title="1. Bundle">
          {bundles.status === 'loading' && <Loading what="bundles" />}
          {bundles.status === 'error' && (
            <ErrorState message={bundles.message} onRetry={reloadBundles} />
          )}
          {bundles.status === 'ready' && (
            <fieldset className="choices">
              <legend className="visually-hidden">Bundle</legend>
              {bundles.value.map((b) => (
                <label key={b.id} className={`choice ${selected === b.id ? 'choice--on' : ''}`}>
                  <input
                    type="radio"
                    name="bundle"
                    value={b.id}
                    checked={selected === b.id}
                    onChange={() => {
                      choose(b.id);
                    }}
                  />
                  <span>
                    <span className="choice__title">
                      {b.label} <OriginTag origin={b.origin} />
                    </span>
                    <span className="choice__detail">{b.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="upload">
            <label htmlFor="bundle-upload" className="upload__label">
              Or upload a bundle's files
            </label>
            <input id="bundle-upload" type="file" multiple onChange={onUpload} />
            {upload?.status === 'unavailable' && (
              <p className="notice" role="status">
                {upload.reason}
              </p>
            )}
            {upload?.status === 'uploaded' && (
              <p className="notice" role="status">
                Uploaded as {upload.bundleId}.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="2. Validation">
          {validation === null && (
            <p className="muted">
              Choose a bundle to validate it against the incident-bundle contract.
            </p>
          )}
          {validation?.status === 'loading' && <Loading what="validation" />}
          {validation?.status === 'error' && <ErrorState message={validation.message} />}
          {validation?.status === 'ready' && <ValidationResult validation={validation.value} />}
        </Panel>

        <Panel title="3. Start">
          <p className="muted">
            {valid
              ? 'The bundle is valid and can be investigated.'
              : 'An investigation can start only from a valid bundle.'}
          </p>
          {blocked && (
            <div className="notice" role="status">
              <p>
                <strong>The selected provider cannot run.</strong>{' '}
                {status.value.reason ?? 'No runnable provider.'}
              </p>
              <p>
                Nothing was run and nothing is stored. The application never falls back to another
                provider or fabricates findings.
              </p>
            </div>
          )}
          {status.status === 'error' && (
            <p className="notice notice--error" role="alert">
              Could not check whether an investigation can run: {status.message}
            </p>
          )}
          <button
            type="button"
            className="button button--primary"
            disabled={!canStart || running}
            onClick={() => {
              if (!selected) return;
              setRunning(true);
              setStart(null);
              void source
                .startInvestigation(selected)
                .then(setStart, (err: unknown) => {
                  setStart({
                    status: 'error',
                    message: err instanceof Error ? err.message : String(err),
                  });
                })
                .finally(() => {
                  setRunning(false);
                });
            }}
          >
            {running ? 'Running…' : 'Start investigation'}
          </button>
          {running && (
            <p className="notice" role="status">
              Running. A local model can take several minutes; keep this page open.
            </p>
          )}
          {simulated && !blocked && (
            <p className="notice" role="status">
              The selected provider is the Fake provider: the result will be a simulated
              placeholder, not an AI investigation. Choose Ollama in Settings for a real one.
            </p>
          )}
          {start?.status === 'unavailable' && (
            <div className="notice" role="status">
              <p>{start.reason}</p>
              {start.fixtureInvestigationIds.length > 0 && (
                <>
                  <p>Fixture investigations precomputed for this bundle:</p>
                  <ul className="links">
                    {start.fixtureInvestigationIds.map((id) => (
                      <li key={id}>
                        <a href={href({ name: 'investigation', id })}>{id}</a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {start?.status === 'error' && (
            <p className="notice notice--error" role="alert">
              The investigation did not start: {start.message}
            </p>
          )}
          {start?.status === 'started' && (
            <p className="notice" role="status">
              Started:{' '}
              <a href={href({ name: 'investigation', id: start.investigationId })}>
                {start.investigationId}
              </a>
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

function ValidationResult({ validation }: { validation: BundleValidation }) {
  const { metadata } = validation;
  return (
    <div className="validation">
      <p className={`validation__status validation__status--${validation.valid ? 'ok' : 'bad'}`}>
        {validation.valid
          ? 'Valid: the bundle meets all nine contract rules.'
          : `Invalid: ${plural(validation.issues.length, 'issue')} found.`}
      </p>
      <KeyValues
        rows={[
          ['Contract version', validation.schemaVersion ?? 'unreadable'],
          ['Case ID', metadata ? <span className="mono">{metadata.caseId}</span> : '—'],
        ]}
      />
      {validation.issues.length > 0 && (
        <div className="table-wrap">
          <table className="table table--compact">
            <caption className="visually-hidden">Validation issues</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Where</th>
                <th scope="col">Problem</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            <tbody>
              {validation.issues.map((issue, i) => (
                <tr key={i}>
                  <td className="nowrap">
                    {issue.rule} <span className="muted">{issue.ruleId}</span>
                  </td>
                  <td className="mono">{issueLocation(issue)}</td>
                  <td className="cell-wrap">{issue.message}</td>
                  <td className="cell-wrap">{RULE_HINTS[issue.rule]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {metadata && (
        <>
          <h3 className="subhead">Services</h3>
          <ul className="chips">
            {metadata.manifest.services.map((s) => (
              <li key={s.name} className="chip">
                {s.name} <span className="muted">{s.version}</span>
              </li>
            ))}
          </ul>
          <h3 className="subhead">Telemetry files</h3>
          <div className="table-wrap">
            <table className="table table--compact">
              <caption className="visually-hidden">Telemetry files</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                  <th scope="col" className="num">
                    Bytes
                  </th>
                  <th scope="col">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metadata.manifest.files).map(([file, f]) => (
                  <tr key={file}>
                    <td className="mono">{file}</td>
                    <td className="num">{formatNumber(f.records)}</td>
                    <td className="num">{formatNumber(f.bytes)}</td>
                    <td className="mono">{shortHash(f.sha256)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="subhead">Trace capture</h3>
          <ul className="plain">
            {metadata.manifest.capture.traces.services.map((s) => (
              <li key={s.name}>
                {s.name}:{' '}
                {s.truncated ? `truncated (${s.truncationReasons.join(', ')})` : 'complete'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

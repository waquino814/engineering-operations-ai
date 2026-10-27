import { DEFAULT_LIMITS } from '../../investigation/config.ts';
import { MODEL_OUTPUT_VERSION, RESULT_SCHEMA_VERSION } from '../../investigation/schemas.ts';
import { KeyValues, OriginTag, Panel } from '../components.tsx';
import type { InvestigationDataSource } from '../data/types.ts';
import { formatNumber } from '../model.ts';
import { useAsync } from '../use-async.ts';

/**
 * Settings, read-only: what the console is connected to and the defaults a run would use.
 * Nothing here can change the provider policy (ADR 0012, ADR 0013).
 */
export function Settings({ source }: { source: InvestigationDataSource }) {
  const [status] = useAsync(() => source.getProviderStatus(), [source]);
  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">Read-only.</p>
        </div>
      </div>
      <div className="grid grid--settings">
        <Panel title="Data source">
          <KeyValues
            rows={[
              ['Mode', <OriginTag origin={source.description.mode} />],
              ['About', source.description.notice],
              [
                'Model provider',
                'No runnable provider. The application permits only a fake provider (deterministic tests, no replies, not a model) and a local one that stays blocked until local-only operation is verified. No hosted model can be enabled here.',
              ],
              [
                'Can start a run',
                status.status === 'loading'
                  ? 'Checking…'
                  : status.status === 'error'
                    ? `Unknown: ${status.message}`
                    : status.value.runnable
                      ? `Yes (${status.value.provider})`
                      : `No: ${status.value.reason ?? 'no runnable provider'}`,
              ],
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

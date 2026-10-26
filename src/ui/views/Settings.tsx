import { DEFAULT_LIMITS } from '../../investigation/config.ts';
import { MODEL_OUTPUT_VERSION, RESULT_SCHEMA_VERSION } from '../../investigation/schemas.ts';
import { KeyValues, OriginTag, Panel } from '../components.tsx';
import type { InvestigationDataSource } from '../data/types.ts';
import { formatNumber } from '../model.ts';

/**
 * Settings, read-only in E4: what the console is connected to and the defaults a run would use.
 * Nothing here can be changed until there is an application boundary to change it in (E6).
 */
export function Settings({ source }: { source: InvestigationDataSource }) {
  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1>Settings</h1>
          <p className="page__subtitle">Read-only until live runs exist.</p>
        </div>
      </div>
      <div className="grid grid--settings">
        <Panel title="Data source">
          <KeyValues
            rows={[
              ['Mode', <OriginTag origin={source.description.mode} />],
              ['About', source.description.notice],
              ['Model provider', 'None configured. Real providers arrive in milestone E5.'],
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

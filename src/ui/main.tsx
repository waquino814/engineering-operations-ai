import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createFixtureSource } from './data/fixture-source.ts';
import { createHttpSource } from './data/http-source.ts';
import type { InvestigationDataSource, UiFixtures } from './data/types.ts';
import fixtures from './fixtures/fixtures.json' with { type: 'json' };
import './styles.css';

/**
 * The console's entry point. By default the data source is the local application over HTTP
 * (ADR 0012); `VITE_EOAI_SOURCE=fixture` at build or dev time selects the committed fixtures.
 */
export function defaultSource(): InvestigationDataSource {
  return import.meta.env.VITE_EOAI_SOURCE === 'fixture'
    ? createFixtureSource(fixtures as UiFixtures)
    : createHttpSource();
}

export function mount(element: HTMLElement, source: InvestigationDataSource = defaultSource()) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App source={source} />
    </StrictMode>,
  );
  return root;
}

const element = document.getElementById('root');
if (element) mount(element);

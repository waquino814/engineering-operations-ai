import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createFixtureSource } from './data/fixture-source.ts';
import type { UiFixtures } from './data/types.ts';
import fixtures from './fixtures/fixtures.json' with { type: 'json' };
import './styles.css';

/**
 * The console's entry point. In E4 the data source is the committed fixtures; E6 replaces this
 * one line with a source for the application boundary.
 */
export function mount(element: HTMLElement) {
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App source={createFixtureSource(fixtures as UiFixtures)} />
    </StrictMode>,
  );
  return root;
}

const element = document.getElementById('root');
if (element) mount(element);

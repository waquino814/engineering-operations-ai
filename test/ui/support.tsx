import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import { createFixtureSource } from '../../src/ui/data/fixture-source.ts';
import type {
  InvestigationDataSource,
  ProviderStatus,
  UiFixtures,
} from '../../src/ui/data/types.ts';
import committed from '../../src/ui/fixtures/fixtures.json' with { type: 'json' };

/** Shared helpers for the console tests (jsdom). */
export const fixtures = committed as UiFixtures;

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

export const fixtureSource = () => createFixtureSource(fixtures);

/** Renders the whole console at a route, as an operator would open it. */
export function renderAt(hash: string, source: InvestigationDataSource = fixtureSource()) {
  window.location.hash = hash;
  return render(<App source={source} />);
}

/** A promise the test settles, to hold a view in its loading state. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The fixture source with some operations replaced. */
export function sourceWith(overrides: Partial<InvestigationDataSource>): InvestigationDataSource {
  return { ...fixtureSource(), ...overrides };
}

export const investigation = (id: string) => {
  const found = fixtures.investigations.find((i) => i.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

/** A provider status with every field, for tests that change only some. */
export const providerStatus = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  selected: 'fake',
  pinned: false,
  runnable: true,
  simulated: true,
  model: 'simulated-deterministic-v1',
  models: [],
  reason: null,
  ...over,
});

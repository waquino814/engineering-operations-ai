import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

/**
 * Loads data through the data source and tracks loading, error and ready states. A load whose
 * component has gone, or that a newer load replaced, is ignored. `reload` retries.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): [AsyncState<T>, () => void] {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: 'loading' });
    load().then(
      (value) => {
        if (current) setState({ status: 'ready', value });
      },
      (err: unknown) => {
        if (current)
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      current = false;
    };
    // `deps` lists what `load` reads, as with useEffect; `attempt` changes on reload.
  }, [...deps, attempt]);
  const reload = useCallback(() => {
    setAttempt((a) => a + 1);
  }, []);
  return [state, reload];
}

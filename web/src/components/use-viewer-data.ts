'use client';

import { useCallback, useEffect, useState } from 'react';

export type DataState<T> =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: T };

/**
 * Loads one viewer API route and reloads when `url` changes. A 401 ends the viewer session
 * through `onSessionExpired`; any other failure becomes an error state with a retry.
 */
export function useViewerData<T>(
  url: string,
  onSessionExpired: () => void,
): { data: DataState<T>; reload: () => void } {
  const [data, setData] = useState<DataState<T>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData({ state: 'loading' });
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) return onSessionExpired();
        const body = (await res.json().catch(() => null)) as
          (T & { message?: string }) | null;
        if (cancelled) return;
        if (!res.ok || body === null)
          return setData({
            state: 'error',
            message: body?.message ?? 'The data could not be loaded.',
          });
        setData({ state: 'ready', data: body });
      })
      .catch(() => {
        if (!cancelled)
          setData({
            state: 'error',
            message: 'The console is not reachable right now.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [url, attempt, onSessionExpired]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, reload };
}

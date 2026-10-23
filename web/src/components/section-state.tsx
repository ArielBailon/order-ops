import type { ReactNode } from 'react';
import type { DataState } from './use-viewer-data';

/** Loading and error states shared by the dashboard sections. */
export function SectionState<T>({
  data,
  onRetry,
  children,
}: {
  data: DataState<T>;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (data.state === 'loading') return <p className="muted">Loading…</p>;
  if (data.state === 'error')
    return (
      <p className="error">
        {data.message}{' '}
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  return <>{children(data.data)}</>;
}

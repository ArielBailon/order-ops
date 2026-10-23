'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface PendingRefund {
  id: string;
  orderId: string;
  customerId: string;
  amount: string;
  /** Untrusted customer text. */
  reason: string;
  createdAt: string;
}

type ListState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; refunds: PendingRefund[] };

type Decision = 'approve' | 'reject';

const time = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function OperatorRefunds({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [deciding, setDeciding] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    setList({ state: 'loading' });
    try {
      const res = await fetch('/api/operator/refunds', { cache: 'no-store' });
      if (res.status === 401) return onSessionExpired();
      const data = (await res.json().catch(() => null)) as {
        refunds?: PendingRefund[];
        message?: string;
      } | null;
      if (!res.ok || !data?.refunds)
        return setList({
          state: 'error',
          message: data?.message ?? 'The refund requests could not be loaded.',
        });
      setList({ state: 'ready', refunds: data.refunds });
    } catch {
      setList({
        state: 'error',
        message: 'The console is not reachable right now.',
      });
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(refund: PendingRefund, decision: Decision) {
    setDeciding(refund.id);
    setStatus('');
    try {
      const res = await fetch(
        `/api/operator/refunds/${encodeURIComponent(refund.id)}/${decision}`,
        { method: 'POST' },
      );
      if (res.status === 401) return onSessionExpired();
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (res.ok) {
        setList((current) =>
          current.state === 'ready'
            ? {
                state: 'ready',
                refunds: current.refunds.filter((r) => r.id !== refund.id),
              }
            : current,
        );
        setStatus(
          `${decision === 'approve' ? 'Approved' : 'Rejected'} refund ${refund.id} for order ${refund.orderId}.`,
        );
      } else if (res.status === 404 || res.status === 409) {
        setStatus(
          `${data?.message ?? 'That request changed.'} The list was refreshed.`,
        );
        await load();
      } else {
        setStatus(data?.message ?? 'The decision could not be saved.');
      }
    } catch {
      setStatus('The console is not reachable right now.');
    } finally {
      setDeciding(null);
      // The decided row (and its buttons) may be gone; keep keyboard focus on the page.
      headingRef.current?.focus();
    }
  }

  return (
    <main className="operator">
      <div className="operator-toolbar">
        <h2 ref={headingRef} tabIndex={-1}>
          Refund requests waiting for approval
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          disabled={list.state === 'loading'}
        >
          Refresh
        </button>
      </div>
      <p className="operator-status" role="status">
        {status}
      </p>

      {list.state === 'loading' && <p className="muted">Loading…</p>}
      {list.state === 'error' && (
        <p className="error">
          {list.message}{' '}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {list.state === 'ready' && list.refunds.length === 0 && (
        <p className="muted">No refund requests are waiting.</p>
      )}
      {list.state === 'ready' && list.refunds.length > 0 && (
        <ul className="refunds">
          {list.refunds.map((refund) => (
            <li key={refund.id} className="refund">
              <dl>
                <dt>Order</dt>
                <dd>{refund.orderId}</dd>
                <dt>Customer</dt>
                <dd>{refund.customerId}</dd>
                <dt>Amount</dt>
                <dd>${refund.amount}</dd>
                <dt>Submitted</dt>
                <dd>{time.format(new Date(refund.createdAt))}</dd>
              </dl>
              <figure>
                <figcaption>Customer&apos;s words (unverified)</figcaption>
                <blockquote>{refund.reason}</blockquote>
              </figure>
              <div className="refund-actions">
                <button
                  type="button"
                  onClick={() => void decide(refund, 'approve')}
                  disabled={deciding === refund.id}
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void decide(refund, 'reject')}
                  disabled={deciding === refund.id}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

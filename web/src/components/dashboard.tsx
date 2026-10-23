'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DEMO_VIEWER } from '@/lib/demo-customers';
import { type MetricsWindow, WINDOWS } from '@/lib/observability';
import { EvalsSection } from './evals-section';
import { MetricsSection } from './metrics-section';
import { TracesSection } from './traces-section';

type Session =
  { state: 'loading' } | { state: 'out' } | { state: 'in'; email: string };

const WINDOW_LABELS: Record<MetricsWindow, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** The dashboard page: its own viewer login, separate from the customer and operator sessions. */
export function Dashboard({
  langfuseProjectUrl,
}: {
  langfuseProjectUrl: string | undefined;
}) {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>('7d');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/viewer/session')
      .then(async (res) =>
        res.ok ? ((await res.json()) as { email: string }) : null,
      )
      .catch(() => null)
      .then((data) => {
        if (!cancelled)
          setSession(
            data ? { state: 'in', email: data.email } : { state: 'out' },
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSessionExpired = useCallback(() => {
    setNotice('Your viewer session has ended. Log in again.');
    setSession({ state: 'out' });
  }, []);

  async function login() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/viewer/login', { method: 'POST' });
      if (res.ok) {
        setNotice(null);
        setSession({ state: 'in', email: DEMO_VIEWER.email });
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      setError(data?.message ?? 'The login failed. Please try again.');
    } catch {
      setError('The console is not reachable right now.');
    } finally {
      setPending(false);
    }
  }

  async function logout() {
    await fetch('/api/viewer/logout', { method: 'POST' }).catch(
      () => undefined,
    );
    setSession({ state: 'out' });
  }

  if (session.state === 'loading') return <p className="centered">Loading…</p>;

  if (session.state === 'out')
    return (
      <main className="login">
        <h1>Observability dashboard</h1>
        <p>
          Latency, cost, tokens, errors and failovers of the agent, every stored
          trace, and the eval scorecard. Read-only.
        </p>
        {notice && <p className="notice">{notice}</p>}
        <button type="button" onClick={login} disabled={pending}>
          Log in as {DEMO_VIEWER.name} ({DEMO_VIEWER.email})
        </button>
        <p role="alert" className="error">
          {error}
        </p>
        <p>
          <Link href="/">Customer chat</Link> ·{' '}
          <Link href="/operator">Operator console</Link>
        </p>
      </main>
    );

  return (
    <div className="dashboard-layout">
      <header className="chat-header">
        <h1>Observability dashboard</h1>
        <label className="window-select">
          Window{' '}
          <select
            value={metricsWindow}
            onChange={(event) =>
              setMetricsWindow(event.target.value as MetricsWindow)
            }
          >
            {(Object.keys(WINDOWS) as MetricsWindow[]).map((key) => (
              <option key={key} value={key}>
                {WINDOW_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <span>Logged in as {session.email}</span>
        <Link href="/">Customer chat</Link>
        <Link href="/operator">Operator console</Link>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <main className="dashboard">
        <MetricsSection
          metricsWindow={metricsWindow}
          onSessionExpired={onSessionExpired}
        />
        <TracesSection
          langfuseProjectUrl={langfuseProjectUrl}
          onSessionExpired={onSessionExpired}
        />
        <EvalsSection onSessionExpired={onSessionExpired} />
      </main>
    </div>
  );
}

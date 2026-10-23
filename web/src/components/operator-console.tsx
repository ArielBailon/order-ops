'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DEMO_OPERATOR } from '@/lib/demo-customers';
import { OperatorRefunds } from './operator-refunds';

type Session =
  { state: 'loading' } | { state: 'out' } | { state: 'in'; email: string };

/** The operator page: its own login, separate from the customer chat's session. */
export function OperatorConsole() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/operator/session')
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

  async function login() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/login', { method: 'POST' });
      if (res.ok) {
        setNotice(null);
        setSession({ state: 'in', email: DEMO_OPERATOR.email });
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
    await fetch('/api/operator/logout', { method: 'POST' }).catch(
      () => undefined,
    );
    setSession({ state: 'out' });
  }

  if (session.state === 'loading') return <p className="centered">Loading…</p>;

  if (session.state === 'out')
    return (
      <main className="login">
        <h1>Operator console</h1>
        <p>
          Review the refund requests the agent sent for approval. Approving or
          rejecting one updates the customer&apos;s conversation.
        </p>
        {notice && <p className="notice">{notice}</p>}
        <button type="button" onClick={login} disabled={pending}>
          Log in as {DEMO_OPERATOR.name} ({DEMO_OPERATOR.email})
        </button>
        <p role="alert" className="error">
          {error}
        </p>
        <p>
          <Link href="/">Back to the customer chat</Link>
        </p>
      </main>
    );

  return (
    <div className="operator-layout">
      <header className="chat-header">
        <h1>Operator console</h1>
        <span>Logged in as {session.email}</span>
        <Link href="/">Customer chat</Link>
        <Link href="/dashboard">Dashboard</Link>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <OperatorRefunds
        onSessionExpired={() => {
          setNotice('Your operator session has ended. Log in again.');
          setSession({ state: 'out' });
        }}
      />
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DEMO_CUSTOMERS } from '@/lib/demo-customers';

export function LoginView({
  notice,
  onLoggedIn,
}: {
  notice: string | null;
  onLoggedIn: (email: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function login(email: string) {
    setPending(email);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) return onLoggedIn(email);
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      setError(data?.message ?? 'The login failed. Please try again.');
    } catch {
      setError('The console is not reachable right now.');
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="login">
      <h1>OrderOps demo console</h1>
      <p>
        Log in as a demo customer to chat with the support agent and watch what
        it does.
      </p>
      {notice && <p className="notice">{notice}</p>}
      <ul className="customers">
        {DEMO_CUSTOMERS.map((customer) => (
          <li key={customer.email}>
            <button
              type="button"
              onClick={() => login(customer.email)}
              disabled={pending !== null}
            >
              <strong>{customer.name}</strong>
              <span>{customer.email}</span>
              {pending === customer.email && <span>Logging in…</span>}
            </button>
          </li>
        ))}
      </ul>
      <p role="alert" className="error">
        {error}
      </p>
      <p>
        Reviewing refunds? Open the{' '}
        <Link href="/operator">operator console</Link> in another tab, or the{' '}
        <Link href="/dashboard">observability dashboard</Link>.
      </p>
    </main>
  );
}

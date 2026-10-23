'use client';

import { useEffect, useState } from 'react';
import { ChatView } from './chat-view';
import { LoginView } from './login-view';

type Session = { state: 'loading' } | { state: 'out' } | { state: 'in'; email: string };

/** Shows the login view or the chat, depending on the server-side session cookie. */
export function Console() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session')
      .then(async (res) => (res.ok ? ((await res.json()) as { email: string }) : null))
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setSession(data ? { state: 'in', email: data.email } : { state: 'out' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (session.state === 'loading') return <p className="centered">Loading…</p>;

  if (session.state === 'out')
    return (
      <LoginView
        notice={notice}
        onLoggedIn={(email) => {
          setNotice(null);
          setSession({ state: 'in', email });
        }}
      />
    );

  return (
    <ChatView
      email={session.email}
      onLoggedOut={() => setSession({ state: 'out' })}
      onSessionExpired={() => {
        setNotice('Your session has ended. Log in again.');
        setSession({ state: 'out' });
      }}
    />
  );
}

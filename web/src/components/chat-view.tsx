'use client';

import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  type AssistantMessage,
  conversationReducer,
  emptyConversation,
  toChatEvent,
} from '@/lib/conversation';
import { type Inline, parseMarkdown } from '@/lib/markdown';
import { readSse } from '@/lib/sse';
import { TimelinePanel } from './timeline-panel';

const EXAMPLES = [
  'Where is my most recent order?',
  'What is your return policy?',
];
const MAX_LENGTH = 2000;
/** How often a refund request waiting for an operator is checked. */
const POLL_MS = 5000;

export function ChatView({
  email,
  onLoggedOut,
  onSessionExpired,
}: {
  email: string;
  onLoggedOut: () => void;
  onSessionExpired: () => void;
}) {
  const [conversation, dispatch] = useReducer(
    conversationReducer,
    emptyConversation,
  );
  const [draft, setDraft] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const replies = conversation.messages.filter(
    (message): message is AssistantMessage => message.role === 'assistant',
  );
  const streaming = replies.some((reply) => reply.status === 'streaming');
  const selected =
    replies.find((reply) => reply.id === selectedId) ?? replies.at(-1);

  useEffect(() => {
    inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);

  // Watches refund requests waiting for an operator until each is decided or gone. The
  // effect restarts whenever the watched set changes and stops on reset, logout and unmount.
  const watchKey = conversation.watching.join(',');
  useEffect(() => {
    if (!watchKey) return;
    const ids = watchKey.split(',');
    let stopped = false;
    async function check(id: string) {
      try {
        const res = await fetch(`/api/refunds/${encodeURIComponent(id)}`, {
          cache: 'no-store',
        });
        if (stopped) return;
        if (res.status === 401) {
          stopped = true;
          return onSessionExpired();
        }
        if (res.status === 404)
          return dispatch({ type: 'refund_unwatched', refundId: id });
        if (!res.ok) return;
        const data = (await res.json()) as {
          status?: string;
          message?: string | null;
        };
        if (stopped || !data.message) return;
        if (data.status === 'approved' || data.status === 'rejected') {
          dispatch({
            type: 'refund_decided',
            refundId: id,
            updateId: crypto.randomUUID(),
            text: data.message,
          });
          setStatus(data.message);
        }
      } catch {
        // A failed check is retried on the next tick without a visible error.
      }
    }
    const timer = setInterval(() => {
      for (const id of ids) void check(id);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watchKey, onSessionExpired]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    const assistantId = crypto.randomUUID();
    dispatch({
      type: 'send',
      userId: crypto.randomUUID(),
      assistantId,
      text: message,
    });
    setSelectedId(null);
    setDraft('');
    setStatus('The agent is replying…');
    // An example button disappears once the conversation starts; keep focus in the input.
    inputRef.current?.focus();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, threadId: conversation.threadId }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        controller.abort();
        return onSessionExpired();
      }
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        const error = data?.message ?? 'The agent could not answer right now.';
        dispatch({ type: 'fail', assistantId, message: error });
        setStatus(error);
        return;
      }
      await readSse(res.body, (sse) => {
        const event = toChatEvent(sse);
        if (!event) return;
        dispatch({ type: 'event', assistantId, event });
        if (event.type === 'final') setStatus('The agent replied.');
        if (event.type === 'error') setStatus(event.data.message);
      });
      dispatch({ type: 'end', assistantId });
    } catch {
      if (controller.signal.aborted) {
        dispatch({ type: 'end', assistantId });
        setStatus('The reply was stopped.');
      } else {
        const error = 'The console lost the connection to the agent.';
        dispatch({ type: 'fail', assistantId, message: error });
        setStatus(error);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  }

  function newConversation() {
    abortRef.current?.abort();
    dispatch({ type: 'reset' });
    setSelectedId(null);
    setStatus('');
    inputRef.current?.focus();
  }

  async function logout() {
    abortRef.current?.abort();
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    onLoggedOut();
  }

  return (
    <div className="chat-layout">
      <header className="chat-header">
        <h1>OrderOps demo console</h1>
        <span>Logged in as {email}</span>
        <button type="button" onClick={newConversation}>
          New conversation
        </button>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>

      <main className="chat">
        {conversation.messages.length === 0 ? (
          <div className="empty">
            <p>
              Ask about your orders, a refund, or the store policies. For
              example:
            </p>
            <ul>
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button type="button" onClick={() => void send(example)}>
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="messages">
            {conversation.messages.map((message) =>
              message.role === 'user' ? (
                <li key={message.id} className="message user">
                  <p>{message.text}</p>
                </li>
              ) : message.role === 'operator' ? (
                <li key={message.id} className="message operator">
                  <p className="message-label">Operator update</p>
                  <p>{message.text}</p>
                </li>
              ) : (
                <li
                  key={message.id}
                  className={`message assistant ${message.id === selected?.id ? 'selected' : ''}`}
                >
                  {message.text && <ReplyText text={message.text} />}
                  {message.status === 'streaming' && !message.text && (
                    <p className="muted">Thinking…</p>
                  )}
                  {message.approval && (
                    <p className="approval">
                      Refund request for order {message.approval.orderId} ($
                      {message.approval.amount}) waits for operator approval.
                    </p>
                  )}
                  {message.status === 'failed' && (
                    <p className="error">{message.error}</p>
                  )}
                  {message.status === 'interrupted' && (
                    <p className="muted">The reply was cut off.</p>
                  )}
                  <button
                    type="button"
                    className="timeline-toggle"
                    aria-pressed={message.id === selected?.id}
                    onClick={() => setSelectedId(message.id)}
                  >
                    Show timeline
                  </button>
                </li>
              ),
            )}
          </ol>
        )}

        <form className="composer" onSubmit={onSubmit}>
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            ref={inputRef}
            value={draft}
            maxLength={MAX_LENGTH}
            rows={2}
            // readOnly instead of disabled keeps focus in the field while a reply streams.
            readOnly={streaming}
            aria-describedby="composer-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <span id="composer-hint" className="muted">
            Enter sends, Shift+Enter adds a line. {draft.length}/{MAX_LENGTH}
          </span>
          <button type="submit" disabled={streaming || !draft.trim()}>
            Send
          </button>
        </form>
        <p className="visually-hidden" aria-live="polite">
          {status}
        </p>
      </main>

      <aside className="timeline" aria-label="Agent timeline">
        <TimelinePanel reply={selected} />
      </aside>
    </div>
  );
}

/** An agent reply with its markdown rendered; every string goes in as React text, never HTML. */
function ReplyText({ text }: { text: string }) {
  return parseMarkdown(text).map((block, index) => {
    if (block.type === 'list') {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          <InlineText inlines={item} />
        </li>
      ));
      return block.ordered ? (
        <ol key={index} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={index}>{items}</ul>
      );
    }
    return (
      <p key={index}>
        {block.type === 'heading' ? (
          <strong>
            <InlineText inlines={block.inlines} />
          </strong>
        ) : (
          <InlineText inlines={block.inlines} />
        )}
      </p>
    );
  });
}

function InlineText({ inlines }: { inlines: Inline[] }) {
  return inlines.map((inline, index) =>
    inline.type === 'strong' ? (
      <strong key={index}>{inline.text}</strong>
    ) : inline.type === 'code' ? (
      <code key={index}>{inline.text}</code>
    ) : (
      inline.text
    ),
  );
}

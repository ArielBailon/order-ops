import type { AssistantMessage } from '@/lib/conversation';

const number = new Intl.NumberFormat('en-US');

/** What the agent did for one reply: live tool calls while streaming, the trace afterwards. */
export function TimelinePanel({ reply }: { reply: AssistantMessage | undefined }) {
  if (!reply)
    return (
      <>
        <h2>Agent timeline</h2>
        <p className="muted">Send a message to see the route, tools, model, tokens, cost and latency of each reply.</p>
      </>
    );

  const trace = reply.trace;
  return (
    <>
      <h2>Agent timeline</h2>
      {!trace && (
        <p className="muted">
          {reply.status === 'streaming'
            ? 'Running…'
            : 'No trace was received for this reply.'}
        </p>
      )}
      <dl>
        <dt>Tools</dt>
        <dd>{(trace?.tools ?? reply.tools).join(', ') || 'none'}</dd>
        {trace && (
          <>
            <dt>Route</dt>
            <dd>{trace.route ?? 'none'}</dd>
            <dt>Provider / model</dt>
            <dd>
              {trace.provider ?? 'none'} / {trace.model ?? 'none'}
            </dd>
            <dt>Failovers</dt>
            <dd>{trace.failovers}</dd>
            <dt>Tokens</dt>
            <dd>
              {number.format(trace.tokens.input)} in, {number.format(trace.tokens.output)} out,{' '}
              {number.format(trace.tokens.cacheRead)} cache read,{' '}
              {number.format(trace.tokens.cacheWrite)} cache write
            </dd>
            <dt>Cost</dt>
            <dd>
              {trace.costUsd === null ? 'not priced' : `$${trace.costUsd}`}
              {trace.unpriced > 0 && ` (${trace.unpriced} call(s) not priced)`}
            </dd>
            <dt>Latency</dt>
            <dd>{number.format(trace.latencyMs)} ms</dd>
            <dt>Status</dt>
            <dd>{trace.status}</dd>
            <dt>Trace id</dt>
            <dd>
              <code>{trace.id}</code>
            </dd>
          </>
        )}
      </dl>
    </>
  );
}

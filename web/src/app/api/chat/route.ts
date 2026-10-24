import type { NextRequest } from 'next/server';
import { rateLimited, tooManyRequests } from '@/lib/rate-limit';
import {
  clearSession,
  gatewayConfig,
  jsonError,
  readJsonObject,
  TOKEN_COOKIE,
} from '@/lib/server';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Forwards one chat turn to the gateway and streams its SSE reply back unchanged. */
export async function POST(request: NextRequest): Promise<Response> {
  const limited = rateLimited(request, 'chat');
  if (limited) return limited;
  const token = request.cookies.get(TOKEN_COOKIE)?.value;
  if (!token) return jsonError(401, 'Your session has ended. Log in again.');
  const body = await readJsonObject(request);
  if (!body) return jsonError(400, 'Send a JSON body.');
  const { message, threadId } = body;
  if (
    typeof message !== 'string' ||
    message.trim().length < 1 ||
    message.trim().length > 2000
  )
    return jsonError(400, 'Write a message of 1 to 2000 characters.');
  if (
    threadId !== undefined &&
    (typeof threadId !== 'string' || !UUID.test(threadId))
  )
    return jsonError(400, 'The conversation id is not valid.');
  const config = gatewayConfig();
  if (!config) return jsonError(500, 'The console is not configured.');

  let upstream: Response;
  try {
    upstream = await fetch(`${config.apiUrl}/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ message, threadId }),
      // Closing the browser request aborts the gateway request and its stream.
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return jsonError(502, 'The agent is not reachable right now.');
  }
  if (upstream.status === 401) {
    const response = jsonError(401, 'Your session has ended. Log in again.');
    clearSession(response);
    return response;
  }
  // The gateway's per-customer backstop: shown with the console's own text and wait time.
  if (upstream.status === 429) {
    const seconds = Number(upstream.headers.get('retry-after'));
    return tooManyRequests(
      Number.isInteger(seconds) && seconds >= 1 ? seconds : 60,
    );
  }
  if (upstream.status === 400)
    return jsonError(400, 'The agent did not accept that message.');
  if (!upstream.ok || !upstream.body)
    return jsonError(502, 'The agent could not answer right now.');

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type':
        upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
    },
  });
}

import { type NextRequest, NextResponse } from 'next/server';

/** A customer and an operator can be logged in side by side, each with its own cookies. */
export type SessionKind = 'customer' | 'operator';

const COOKIES: Record<SessionKind, { token: string; email: string }> = {
  customer: { token: 'orderops_token', email: 'orderops_email' },
  operator: {
    token: 'orderops_operator_token',
    email: 'orderops_operator_email',
  },
};

export const TOKEN_COOKIE = COOKIES.customer.token;
export const EMAIL_COOKIE = COOKIES.customer.email;

/** Refund ids as the gateway creates them (`ref_<uuid>`); anything else never leaves the console. */
export const REFUND_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Server-only settings. Null when `DEMO_PASSWORD` is missing, so routes can fail cleanly. */
export function gatewayConfig(
  env: Record<string, string | undefined> = process.env,
): { apiUrl: string; password: string } | null {
  if (!env.DEMO_PASSWORD) return null;
  return {
    apiUrl: (env.API_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    password: env.DEMO_PASSWORD,
  };
}

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ message }, { status });
}

/** The JSON object body of a request, or null when it is not JSON or not an object. */
export async function readJsonObject(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  };
}

export function sessionToken(
  request: NextRequest,
  kind: SessionKind,
): string | undefined {
  return request.cookies.get(COOKIES[kind].token)?.value || undefined;
}

export function sessionEmail(
  request: NextRequest,
  kind: SessionKind,
): string | undefined {
  return request.cookies.get(COOKIES[kind].email)?.value || undefined;
}

/** Stores the gateway JWT where browser JavaScript cannot read it. */
export function setSession(
  response: NextResponse,
  session: { token: string; email: string; maxAge: number },
  kind: SessionKind = 'customer',
): void {
  const options = cookieOptions(session.maxAge);
  response.cookies.set(COOKIES[kind].token, session.token, options);
  response.cookies.set(COOKIES[kind].email, session.email, options);
}

export function clearSession(
  response: NextResponse,
  kind: SessionKind = 'customer',
): void {
  response.cookies.set(COOKIES[kind].token, '', cookieOptions(0));
  response.cookies.set(COOKIES[kind].email, '', cookieOptions(0));
}

/**
 * Logs `email` in at the gateway with the demo password and stores the session. Callers
 * decide which emails are allowed; this never takes an email from an unchecked source.
 */
export async function gatewayLogin(
  email: string,
  kind: SessionKind,
): Promise<NextResponse> {
  const config = gatewayConfig();
  if (!config) return jsonError(500, 'The console is not configured.');

  let upstream: Response;
  try {
    upstream = await fetch(`${config.apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: config.password }),
      cache: 'no-store',
    });
  } catch {
    return jsonError(502, 'The agent is not reachable right now.');
  }
  if (upstream.status === 401)
    return jsonError(401, 'The demo login was rejected.');
  if (!upstream.ok) return jsonError(502, 'The agent could not log you in.');

  const data = (await upstream.json().catch(() => null)) as {
    accessToken?: unknown;
    expiresIn?: unknown;
  } | null;
  if (
    typeof data?.accessToken !== 'string' ||
    typeof data.expiresIn !== 'number'
  )
    return jsonError(502, 'The agent could not log you in.');

  const response = NextResponse.json({ email });
  setSession(
    response,
    { token: data.accessToken, email, maxAge: data.expiresIn },
    kind,
  );
  return response;
}

/**
 * Calls one fixed gateway path with the session's token and returns its JSON body. A 401
 * ends that session; statuses listed in `messages` pass through with a fixed text.
 */
export async function forwardJson(
  request: NextRequest,
  kind: SessionKind,
  path: string,
  method: 'GET' | 'POST',
  messages: Partial<Record<number, string>> = {},
): Promise<NextResponse> {
  const token = sessionToken(request, kind);
  if (!token) return jsonError(401, 'Your session has ended. Log in again.');
  const config = gatewayConfig();
  if (!config) return jsonError(500, 'The console is not configured.');

  let upstream: Response;
  try {
    upstream = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    return jsonError(502, 'The agent is not reachable right now.');
  }
  if (upstream.status === 401) {
    const response = jsonError(401, 'Your session has ended. Log in again.');
    clearSession(response, kind);
    return response;
  }
  const passThrough = messages[upstream.status];
  if (passThrough) return jsonError(upstream.status, passThrough);
  const body: unknown = upstream.ok
    ? await upstream.json().catch(() => undefined)
    : undefined;
  if (body === undefined)
    return jsonError(502, 'The agent could not answer right now.');
  return NextResponse.json(body);
}

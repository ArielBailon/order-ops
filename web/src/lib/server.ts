import { type NextRequest, NextResponse } from 'next/server';

export const TOKEN_COOKIE = 'orderops_token';
export const EMAIL_COOKIE = 'orderops_email';

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

/** Stores the gateway JWT where browser JavaScript cannot read it. */
export function setSession(
  response: NextResponse,
  session: { token: string; email: string; maxAge: number },
): void {
  response.cookies.set(
    TOKEN_COOKIE,
    session.token,
    cookieOptions(session.maxAge),
  );
  response.cookies.set(
    EMAIL_COOKIE,
    session.email,
    cookieOptions(session.maxAge),
  );
}

export function clearSession(response: NextResponse): void {
  response.cookies.set(TOKEN_COOKIE, '', cookieOptions(0));
  response.cookies.set(EMAIL_COOKIE, '', cookieOptions(0));
}

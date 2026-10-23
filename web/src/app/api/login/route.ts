import { type NextRequest, NextResponse } from 'next/server';
import { isDemoCustomer } from '@/lib/demo-customers';
import {
  gatewayConfig,
  jsonError,
  readJsonObject,
  setSession,
} from '@/lib/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readJsonObject(request);
  if (!body) return jsonError(400, 'Send a JSON body.');
  const { email } = body;
  // Only the seeded customers: the shared demo password also opens operator and viewer accounts.
  if (!isDemoCustomer(email))
    return jsonError(400, 'Choose one of the demo customers.');
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
  setSession(response, {
    token: data.accessToken,
    email,
    maxAge: data.expiresIn,
  });
  return response;
}

import type { NextRequest, NextResponse } from 'next/server';
import { isDemoCustomer } from '@/lib/demo-customers';
import { gatewayLogin, jsonError, readJsonObject } from '@/lib/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await readJsonObject(request);
  if (!body) return jsonError(400, 'Send a JSON body.');
  const { email } = body;
  // Only the seeded customers: the shared demo password also opens operator and viewer accounts.
  if (!isDemoCustomer(email))
    return jsonError(400, 'Choose one of the demo customers.');
  return gatewayLogin(email, 'customer');
}

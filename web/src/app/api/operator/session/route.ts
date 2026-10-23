import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_OPERATOR } from '@/lib/demo-customers';
import { jsonError, sessionEmail, sessionToken } from '@/lib/server';

export function GET(request: NextRequest): NextResponse {
  const email = sessionEmail(request, 'operator');
  if (!sessionToken(request, 'operator') || email !== DEMO_OPERATOR.email)
    return jsonError(401, 'Not logged in.');
  return NextResponse.json({ email });
}

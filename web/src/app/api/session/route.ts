import { type NextRequest, NextResponse } from 'next/server';
import { isDemoCustomer } from '@/lib/demo-customers';
import { EMAIL_COOKIE, jsonError, TOKEN_COOKIE } from '@/lib/server';

export function GET(request: NextRequest): NextResponse {
  const email = request.cookies.get(EMAIL_COOKIE)?.value;
  if (!request.cookies.get(TOKEN_COOKIE)?.value || !isDemoCustomer(email))
    return jsonError(401, 'Not logged in.');
  return NextResponse.json({ email });
}

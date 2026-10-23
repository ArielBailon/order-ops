import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_VIEWER } from '@/lib/demo-customers';
import { jsonError, sessionEmail, sessionToken } from '@/lib/server';

export function GET(request: NextRequest): NextResponse {
  const email = sessionEmail(request, 'viewer');
  if (!sessionToken(request, 'viewer') || email !== DEMO_VIEWER.email)
    return jsonError(401, 'Not logged in.');
  return NextResponse.json({ email });
}

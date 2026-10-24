import type { NextRequest, NextResponse } from 'next/server';
import { DEMO_OPERATOR } from '@/lib/demo-customers';
import { rateLimited } from '@/lib/rate-limit';
import { gatewayLogin } from '@/lib/server';

/** Logs in as the seeded operator only; the request body is ignored. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return (
    rateLimited(request, 'login') ??
    gatewayLogin(DEMO_OPERATOR.email, 'operator')
  );
}

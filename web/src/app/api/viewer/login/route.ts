import type { NextRequest, NextResponse } from 'next/server';
import { DEMO_VIEWER } from '@/lib/demo-customers';
import { rateLimited } from '@/lib/rate-limit';
import { gatewayLogin } from '@/lib/server';

/** Logs in as the seeded read-only viewer only; the request body is ignored. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  return (
    rateLimited(request, 'login') ?? gatewayLogin(DEMO_VIEWER.email, 'viewer')
  );
}

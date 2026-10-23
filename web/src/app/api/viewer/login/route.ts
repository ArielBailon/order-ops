import type { NextResponse } from 'next/server';
import { DEMO_VIEWER } from '@/lib/demo-customers';
import { gatewayLogin } from '@/lib/server';

/** Logs in as the seeded read-only viewer only; the request body is ignored. */
export function POST(): Promise<NextResponse> {
  return gatewayLogin(DEMO_VIEWER.email, 'viewer');
}

import type { NextResponse } from 'next/server';
import { DEMO_OPERATOR } from '@/lib/demo-customers';
import { gatewayLogin } from '@/lib/server';

/** Logs in as the seeded operator only; the request body is ignored. */
export function POST(): Promise<NextResponse> {
  return gatewayLogin(DEMO_OPERATOR.email, 'operator');
}

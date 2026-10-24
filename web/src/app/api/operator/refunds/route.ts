import type { NextRequest, NextResponse } from 'next/server';
import { rateLimited } from '@/lib/rate-limit';
import { forwardJson } from '@/lib/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return (
    rateLimited(request, 'refunds') ??
    forwardJson(request, 'operator', '/refunds/pending', 'GET')
  );
}

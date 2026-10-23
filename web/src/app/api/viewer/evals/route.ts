import type { NextRequest, NextResponse } from 'next/server';
import { forwardJson, VIEWER_FORBIDDEN } from '@/lib/server';

export function GET(request: NextRequest): Promise<NextResponse> {
  return forwardJson(
    request,
    'viewer',
    '/observability/evals/latest',
    'GET',
    VIEWER_FORBIDDEN,
  );
}

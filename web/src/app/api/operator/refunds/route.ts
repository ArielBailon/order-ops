import type { NextRequest, NextResponse } from 'next/server';
import { forwardJson } from '@/lib/server';

export function GET(request: NextRequest): Promise<NextResponse> {
  return forwardJson(request, 'operator', '/refunds/pending', 'GET');
}

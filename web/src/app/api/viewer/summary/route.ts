import type { NextRequest, NextResponse } from 'next/server';
import { isWindow, sinceFor } from '@/lib/observability';
import { forwardJson, jsonError, VIEWER_FORBIDDEN } from '@/lib/server';

export function GET(
  request: NextRequest,
): Promise<NextResponse> | NextResponse {
  const window = request.nextUrl.searchParams.get('window') ?? '7d';
  if (!isWindow(window)) return jsonError(400, 'Unknown time window.');
  const since = sinceFor(window, new Date());
  return forwardJson(
    request,
    'viewer',
    `/observability/summary?${new URLSearchParams({ since })}`,
    'GET',
    VIEWER_FORBIDDEN,
  );
}

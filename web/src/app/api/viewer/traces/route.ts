import type { NextRequest, NextResponse } from 'next/server';
import { forwardJson, jsonError, UUID, VIEWER_FORBIDDEN } from '@/lib/server';

const ROUTES = new Set(['faq', 'order', 'refund', 'out_of_scope']);
const STATUSES = new Set(['ok', 'error', 'aborted']);
const ALLOWED = new Set(['route', 'status', 'before']);

/** One page of traces. Only `route`, `status` and `before` are accepted, each checked first. */
export function GET(
  request: NextRequest,
): Promise<NextResponse> | NextResponse {
  const query = request.nextUrl.searchParams;
  for (const name of query.keys())
    if (!ALLOWED.has(name)) return jsonError(400, 'Unknown filter.');
  const forwarded = new URLSearchParams({ limit: '50' });
  const route = query.get('route');
  const status = query.get('status');
  const before = query.get('before');
  if (route !== null) {
    if (!ROUTES.has(route)) return jsonError(400, 'Unknown route filter.');
    forwarded.set('route', route);
  }
  if (status !== null) {
    if (!STATUSES.has(status)) return jsonError(400, 'Unknown status filter.');
    forwarded.set('status', status);
  }
  if (before !== null) {
    if (!UUID.test(before)) return jsonError(400, 'Unknown page cursor.');
    forwarded.set('before', before);
  }
  return forwardJson(
    request,
    'viewer',
    `/observability/traces?${forwarded}`,
    'GET',
    { ...VIEWER_FORBIDDEN, 400: 'The gateway rejected the filters.' },
  );
}

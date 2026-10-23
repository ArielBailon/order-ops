import type { NextRequest, NextResponse } from 'next/server';
import { forwardJson, jsonError, UUID, VIEWER_FORBIDDEN } from '@/lib/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return jsonError(400, 'Unknown trace.');
  return forwardJson(
    request,
    'viewer',
    `/observability/traces/${encodeURIComponent(id)}`,
    'GET',
    { ...VIEWER_FORBIDDEN, 404: 'That trace does not exist.' },
  );
}

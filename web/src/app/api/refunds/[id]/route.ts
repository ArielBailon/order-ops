import type { NextRequest, NextResponse } from 'next/server';
import { rateLimited } from '@/lib/rate-limit';
import { forwardJson, jsonError, REFUND_ID } from '@/lib/server';

/** The status of one of the logged-in customer's own refund requests. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const limited = rateLimited(request, 'refunds');
  if (limited) return limited;
  const { id } = await params;
  if (!REFUND_ID.test(id)) return jsonError(400, 'Unknown refund request.');
  return forwardJson(
    request,
    'customer',
    `/refunds/mine/${encodeURIComponent(id)}`,
    'GET',
    { 404: 'Refund request not found.' },
  );
}

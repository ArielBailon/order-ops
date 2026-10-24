import type { NextRequest, NextResponse } from 'next/server';
import { rateLimited } from '@/lib/rate-limit';
import { forwardJson, jsonError, REFUND_ID } from '@/lib/server';

const DECISIONS = new Set(['approve', 'reject']);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; decision: string }> },
): Promise<NextResponse> {
  const limited = rateLimited(request, 'refunds');
  if (limited) return limited;
  const { id, decision } = await params;
  if (!DECISIONS.has(decision) || !REFUND_ID.test(id))
    return jsonError(400, 'Unknown refund request or decision.');
  return forwardJson(
    request,
    'operator',
    `/refunds/${encodeURIComponent(id)}/${decision}`,
    'POST',
    {
      403: 'Operators cannot decide their own refund request.',
      404: 'That refund request no longer exists.',
      409: 'That refund request was already decided.',
    },
  );
}

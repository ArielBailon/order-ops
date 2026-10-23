import { NextResponse } from 'next/server';
import { clearSession } from '@/lib/server';

export function POST(): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  clearSession(response, 'operator');
  return response;
}

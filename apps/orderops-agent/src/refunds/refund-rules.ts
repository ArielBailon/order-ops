import type { Order } from '../chat/chat.schemas.js';

/** Returns are accepted within this many days of delivery (`policies/returns.md`). */
export const REFUND_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RefundRuleCode =
  | 'not_delivered'
  | 'window_expired'
  | 'amount_exceeds_total'
  | 'already_refunded'
  | 'open_request_exists';

export type RefundVerdict = { ok: true } | { ok: false; code: RefundRuleCode };

/** Parses a money string such as "89.90", "5" or "5.5" into integer cents; no floats involved. */
export function toCents(money: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(money);
  if (!match) throw new RangeError('Invalid money amount');
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Largest amount the `RefundRequest.amount` column (DECIMAL(10,2)) can hold. */
const MAX_CENTS = 9_999_999_999;

/** True for a well-formed money string above zero that fits the column. */
export function isStorableAmount(money: string): boolean {
  try {
    const cents = toCents(money);
    return cents > 0 && cents <= MAX_CENTS;
  } catch {
    return false;
  }
}

export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

export interface RefundCheck {
  order: Pick<Order, 'status' | 'total' | 'deliveredAt'>;
  amountCents: number;
  /** An operator already approved a refund for this order. */
  alreadyRefunded: boolean;
  openRequestExists: boolean;
  now: Date;
}

/** Fixed rule order: the first failing rule decides the code. */
export function evaluateRefund({
  order,
  amountCents,
  alreadyRefunded,
  openRequestExists,
  now,
}: RefundCheck): RefundVerdict {
  if (order.status !== 'delivered' || !order.deliveredAt)
    return { ok: false, code: 'not_delivered' };
  const elapsedMs = now.getTime() - new Date(order.deliveredAt).getTime();
  if (elapsedMs > REFUND_WINDOW_DAYS * DAY_MS)
    return { ok: false, code: 'window_expired' };
  if (amountCents > toCents(order.total))
    return { ok: false, code: 'amount_exceeds_total' };
  if (alreadyRefunded) return { ok: false, code: 'already_refunded' };
  if (openRequestExists) return { ok: false, code: 'open_request_exists' };
  return { ok: true };
}

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import type { RefundRuleCode } from './refund-rules.js';

export const REFUND_STORE = Symbol('REFUND_STORE');

/** Statuses 4a can create; `approved` and `rejected` arrive with operator approval (4b). */
export type StoredRefundStatus = 'pending_approval' | 'auto_rejected';

export interface NewRefund {
  orderId: string;
  customerId: string;
  /** Money string with two decimals, for example "89.90". */
  amount: string;
  reason: string;
  status: StoredRefundStatus;
  /** Rule code, set only for `auto_rejected`. */
  decisionReason?: RefundRuleCode;
}

export interface RefundRecord {
  id: string;
  status: StoredRefundStatus;
}

export type CreateRefundResult =
  | { ok: true; refund: RefundRecord }
  | { ok: false; code: 'open_request_exists'; existing: RefundRecord };

export interface RefundStore {
  findOpenForOrder(orderId: string): Promise<RefundRecord | null>;
  create(input: NewRefund): Promise<CreateRefundResult>;
}

/** Prisma reports a unique-index violation (including the partial index) as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

@Injectable()
export class PrismaRefundStore implements RefundStore {
  constructor(private readonly prisma: PrismaService) {}

  async findOpenForOrder(orderId: string): Promise<RefundRecord | null> {
    const row = await this.prisma.refundRequest.findFirst({
      where: { orderId, status: 'pending_approval' },
      select: { id: true },
    });
    return row ? { id: row.id, status: 'pending_approval' } : null;
  }

  async create(input: NewRefund): Promise<CreateRefundResult> {
    const id = `ref_${randomUUID()}`;
    try {
      await this.prisma.refundRequest.create({
        data: {
          id,
          orderId: input.orderId,
          customerId: input.customerId,
          amount: input.amount,
          reason: input.reason,
          status: input.status,
          decidedBy: input.status === 'auto_rejected' ? 'system' : null,
          decisionReason: input.decisionReason ?? null,
        },
      });
    } catch (error) {
      // The partial unique index rejects a second open request for one order.
      // Anything else, or a failed lookup, surfaces the original error.
      if (input.status !== 'pending_approval' || !isUniqueViolation(error))
        throw error;
      const existing = await this.findOpenForOrder(input.orderId).catch(
        () => null,
      );
      if (!existing) throw error;
      return { ok: false, code: 'open_request_exists', existing };
    }
    return { ok: true, refund: { id, status: input.status } };
  }
}

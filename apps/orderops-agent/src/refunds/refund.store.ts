import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import type { RefundRuleCode } from './refund-rules.js';

export const REFUND_STORE = Symbol('REFUND_STORE');

/** Statuses a new request can start with; operators later move `pending_approval` to a `Decision`. */
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
  /** Checkpoint thread key, so an operator decision can resume the paused thread. */
  threadKey?: string;
}

export interface RefundRecord {
  id: string;
  status: StoredRefundStatus;
}

export type CreateRefundResult =
  | { ok: true; refund: RefundRecord }
  | { ok: false; code: 'open_request_exists'; existing: RefundRecord };

export type Decision = 'approved' | 'rejected';

export interface DecidedRefund {
  id: string;
  orderId: string;
  customerId: string;
  /** Money string with two decimals, for example "89.90". */
  amount: string;
  status: Decision;
  threadKey: string | null;
}

export type DecideResult =
  | { ok: true; refund: DecidedRefund }
  | { ok: false; code: 'not_found' | 'not_pending' | 'own_request' };

export interface PendingRefund {
  id: string;
  orderId: string;
  customerId: string;
  amount: string;
  /** Untrusted customer text; show it to operators as quoted data. */
  reason: string;
  createdAt: string;
}

export interface RefundStore {
  findOpenForOrder(orderId: string): Promise<RefundRecord | null>;
  create(input: NewRefund): Promise<CreateRefundResult>;
  /** Moves a pending request to `decision` in one conditional update; an operator cannot decide their own request. */
  decide(input: {
    id: string;
    decision: Decision;
    operatorId: string;
  }): Promise<DecideResult>;
  /** Pending requests, oldest first. */
  listPending(): Promise<PendingRefund[]>;
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
          threadKey: input.threadKey ?? null,
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

  async decide({
    id,
    decision,
    operatorId,
  }: {
    id: string;
    decision: Decision;
    operatorId: string;
  }): Promise<DecideResult> {
    const { count } = await this.prisma.refundRequest.updateMany({
      where: {
        id,
        status: 'pending_approval',
        customerId: { not: operatorId },
      },
      data: { status: decision, decidedBy: operatorId },
    });
    const row = await this.prisma.refundRequest.findUnique({
      where: { id },
      select: {
        id: true,
        orderId: true,
        customerId: true,
        amount: true,
        status: true,
        threadKey: true,
      },
    });
    if (count === 1 && row)
      return {
        ok: true,
        refund: {
          id: row.id,
          orderId: row.orderId,
          customerId: row.customerId,
          amount: row.amount.toFixed(2),
          status: decision,
          threadKey: row.threadKey,
        },
      };
    if (!row) return { ok: false, code: 'not_found' };
    // Still pending after a zero-row update: only the own-request condition can have blocked it.
    return {
      ok: false,
      code: row.status === 'pending_approval' ? 'own_request' : 'not_pending',
    };
  }

  async listPending(): Promise<PendingRefund[]> {
    const rows = await this.prisma.refundRequest.findMany({
      where: { status: 'pending_approval' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        orderId: true,
        customerId: true,
        amount: true,
        reason: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      customerId: row.customerId,
      amount: row.amount.toFixed(2),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

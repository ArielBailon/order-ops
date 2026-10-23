import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  type AuthenticatedCustomer,
  CurrentCustomer,
  JwtAuthGuard,
  ZodValidationPipe,
} from '@app/auth';
import { z } from 'zod';
import { REFUND_REPLIES } from '../agent/refund-route.js';
import {
  type CustomerRefund,
  REFUND_STORE,
  type RefundStore,
} from '../refunds/refund.store.js';

const refundIdSchema = z.string().min(1).max(100);

export interface MyRefundResponse extends CustomerRefund {
  /** The fixed decision text the thread receives, once an operator decided; else null. */
  message: string | null;
}

/** Lets a customer watch their own refund request; operators decide under `/refunds`. */
@Controller('refunds/mine')
@UseGuards(JwtAuthGuard)
export class MyRefundsController {
  constructor(@Inject(REFUND_STORE) private readonly refunds: RefundStore) {}

  @Get(':id')
  async find(
    @Param('id', new ZodValidationPipe(refundIdSchema)) id: string,
    @CurrentCustomer() { customerId }: AuthenticatedCustomer,
  ): Promise<MyRefundResponse> {
    // Another customer's request is reported exactly like an unknown id.
    const refund = await this.refunds.findForCustomer(id, customerId);
    if (!refund) throw new NotFoundException('Refund request not found');
    const text =
      refund.status === 'approved'
        ? REFUND_REPLIES.approved
        : refund.status === 'rejected'
          ? REFUND_REPLIES.declined
          : null;
    return {
      ...refund,
      message: text ? text(refund.id, refund.amount, refund.orderId) : null,
    };
  }
}

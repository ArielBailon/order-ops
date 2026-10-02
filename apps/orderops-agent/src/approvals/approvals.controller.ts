import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  type AuthenticatedCustomer,
  CurrentCustomer,
  JwtAuthGuard,
  OperatorGuard,
  ZodValidationPipe,
} from '@app/auth';
import { z } from 'zod';
import { ChatService } from '../chat/chat.service.js';
import {
  type Decision,
  REFUND_STORE,
  type PendingRefund,
  type RefundStore,
} from '../refunds/refund.store.js';

const refundIdSchema = z.string().min(1).max(100);

export interface DecisionResponse {
  id: string;
  status: Decision;
  decidedBy: string;
}

@Controller('refunds')
@UseGuards(JwtAuthGuard, OperatorGuard)
export class ApprovalsController {
  private readonly logger = new Logger(ApprovalsController.name);

  constructor(
    @Inject(REFUND_STORE) private readonly refunds: RefundStore,
    private readonly chat: ChatService,
  ) {}

  @Get('pending')
  async pending(): Promise<{ refunds: PendingRefund[] }> {
    return { refunds: await this.refunds.listPending() };
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Param('id', new ZodValidationPipe(refundIdSchema)) id: string,
    @CurrentCustomer() operator: AuthenticatedCustomer,
  ): Promise<DecisionResponse> {
    return this.decide(id, 'approved', operator.customerId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id', new ZodValidationPipe(refundIdSchema)) id: string,
    @CurrentCustomer() operator: AuthenticatedCustomer,
  ): Promise<DecisionResponse> {
    return this.decide(id, 'rejected', operator.customerId);
  }

  /** The stored decision is the source of truth; resuming the thread afterwards is best effort. */
  private async decide(
    id: string,
    decision: Decision,
    operatorId: string,
  ): Promise<DecisionResponse> {
    const result = await this.refunds.decide({ id, decision, operatorId });
    if (!result.ok) {
      if (result.code === 'not_found')
        throw new NotFoundException('Refund request not found');
      if (result.code === 'own_request')
        throw new ForbiddenException('You cannot decide your own request');
      throw new ConflictException('Refund request is not pending approval');
    }

    const { refund } = result;
    if (refund.threadKey) {
      try {
        await this.chat.resumeRefund(
          refund.threadKey,
          refund.customerId,
          refund,
          decision,
        );
      } catch (error) {
        this.logger.warn(
          `thread resume failed for ${refund.id}: ${(error as Error).name}`,
        );
      }
    }
    return { id: refund.id, status: refund.status, decidedBy: operatorId };
  }
}

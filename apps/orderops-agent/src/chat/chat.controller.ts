import {
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  type AuthenticatedCustomer,
  CurrentCustomer,
  JwtAuthGuard,
  ZodValidationPipe,
} from '@app/auth';
import type { Response } from 'express';
import {
  type ChatRequest,
  chatRequestSchema,
  formatSseEvent,
} from './chat.schemas.js';
import { ChatService } from './chat.service.js';
import { CHAT_RATE_LIMIT, type FixedWindowLimiter } from './rate-limit.js';
import { SseConnections } from './sse-connections.js';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly connections: SseConnections,
    @Inject(CHAT_RATE_LIMIT) private readonly limiter: FixedWindowLimiter,
  ) {}

  @Post()
  async stream(
    @Body(new ZodValidationPipe(chatRequestSchema))
    { message, threadId }: ChatRequest,
    @CurrentCustomer() { customerId }: AuthenticatedCustomer,
    @Headers('authorization') authorization: string,
    @Res() res: Response,
  ): Promise<void> {
    // Before the SSE headers: a refused message never reaches the agent and stores no trace.
    const limit = this.limiter.hit(customerId);
    if (!limit.allowed) {
      res
        .status(429)
        .set('Retry-After', String(limit.retryAfterSeconds))
        .json({
          statusCode: 429,
          message: `Too many chat messages. Try again in ${limit.retryAfterSeconds} seconds.`,
        });
      return;
    }

    // JwtAuthGuard already verified this header as `Bearer <token>`.
    const token = authorization.split(' ')[1];
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const done = this.connections.track(res, abort);

    const turn = {
      message,
      token,
      customerId,
      threadId: threadId ?? randomUUID(),
    };
    try {
      for await (const event of this.chat.reply(turn, abort.signal)) {
        if (abort.signal.aborted) break;
        res.write(formatSseEvent(event));
      }
      res.end();
    } finally {
      done();
    }
  }
}

import {
  Body,
  Controller,
  Headers,
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

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  async stream(
    @Body(new ZodValidationPipe(chatRequestSchema))
    { message, threadId }: ChatRequest,
    @CurrentCustomer() { customerId }: AuthenticatedCustomer,
    @Headers('authorization') authorization: string,
    @Res() res: Response,
  ): Promise<void> {
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

    const turn = {
      message,
      token,
      customerId,
      threadId: threadId ?? randomUUID(),
    };
    for await (const event of this.chat.reply(turn, abort.signal)) {
      if (abort.signal.aborted) break;
      res.write(formatSseEvent(event));
    }
    res.end();
  }
}

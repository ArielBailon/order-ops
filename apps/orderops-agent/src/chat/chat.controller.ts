import {
  Body,
  Controller,
  Headers,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, ZodValidationPipe } from '@app/auth';
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
    @Body(new ZodValidationPipe(chatRequestSchema)) { message }: ChatRequest,
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

    for await (const event of this.chat.reply(message, token, abort.signal)) {
      if (abort.signal.aborted) break;
      res.write(formatSseEvent(event));
    }
    res.end();
  }
}

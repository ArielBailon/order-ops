import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import type { Response } from 'express';
import { CHAT_ERROR_MESSAGES, formatSseEvent } from './chat.schemas.js';

interface OpenStream {
  res: Response;
  abort: AbortController;
}

/** Tracks open SSE streams so a shutdown can end them instead of waiting on them. */
@Injectable()
export class SseConnections implements BeforeApplicationShutdown {
  private readonly open = new Set<OpenStream>();
  private shuttingDown = false;

  track(res: Response, abort: AbortController): void {
    const stream = { res, abort };
    // A request that arrives during the drain would otherwise hold the server close open.
    if (this.shuttingDown) {
      this.end(stream);
      return;
    }
    this.open.add(stream);
    res.once('close', () => this.open.delete(stream));
  }

  /** Runs before Nest closes the HTTP server, which would otherwise wait on every open stream. */
  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
    for (const stream of this.open) this.end(stream);
    this.open.clear();
  }

  private end({ res, abort }: OpenStream): void {
    abort.abort();
    if (res.writableEnded) return;
    res.write(
      formatSseEvent({
        type: 'error',
        data: {
          code: 'shutting_down',
          message: CHAT_ERROR_MESSAGES.shutting_down,
        },
      }),
    );
    res.end();
  }
}

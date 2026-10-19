import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import type { Response } from 'express';
import { CHAT_ERROR_MESSAGES, formatSseEvent } from './chat.schemas.js';
import { ChatService } from './chat.service.js';

interface OpenStream {
  res: Response;
  abort: AbortController;
}

/** How long a shutdown waits for interrupted turns, and again for their trace writes. */
export const DRAIN_TIMEOUT_MS = 5000;

/**
 * Tracks open SSE streams so a shutdown can end them instead of waiting on them, then wait
 * (bounded) for the interrupted turns to finish before the database is disconnected.
 */
@Injectable()
export class SseConnections implements BeforeApplicationShutdown {
  private readonly open = new Set<OpenStream>();
  private readonly unfinished = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(private readonly chat: ChatService) {}

  /** Returns `done`, which the handler calls once its turn has fully unwound. */
  track(res: Response, abort: AbortController): () => void {
    const stream = { res, abort };
    let done!: () => void;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    // A request that arrives during the drain would otherwise hold the server close open.
    if (this.shuttingDown) {
      this.end(stream);
      done();
      return done;
    }
    this.open.add(stream);
    this.unfinished.add(finished);
    void finished.then(() => this.unfinished.delete(finished));
    res.once('close', () => this.open.delete(stream));
    return done;
  }

  /** Runs before Nest closes the HTTP server, which would otherwise wait on every open stream. */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const stream of this.open) this.end(stream);
    this.open.clear();
    await this.bounded(Promise.allSettled(this.unfinished));
    await this.bounded(this.chat.flushTraces());
  }

  private async bounded(work: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
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

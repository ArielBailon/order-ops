import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.controller.js';
import type { ChatEvent } from './chat.schemas.js';
import type { ChatService } from './chat.service.js';
import { FixedWindowLimiter } from './rate-limit.js';
import type { SseConnections } from './sse-connections.js';

class FakeResponse extends EventEmitter {
  calls: string[];
  written: string[] = [];
  constructor(calls: string[]) {
    super();
    this.calls = calls;
  }
  status() {
    return this;
  }
  set() {
    return this;
  }
  flushHeaders() {}
  write(chunk: string): boolean {
    this.written.push(chunk);
    this.calls.push('write');
    return true;
  }
  end(): void {
    this.calls.push('end');
  }
}

const token = (text: string): ChatEvent => ({ type: 'token', data: { text } });

function setup(reply: () => AsyncGenerator<ChatEvent>) {
  const calls: string[] = [];
  const done = vi.fn(() => {
    calls.push('done');
  });
  const connections = { track: vi.fn(() => done) };
  const controller = new ChatController(
    { reply } as unknown as ChatService,
    connections as unknown as SseConnections,
    new FixedWindowLimiter(100, 60_000),
  );
  const res = new FakeResponse(calls);
  const stream = () =>
    controller.stream(
      { message: 'where is my order?' },
      { customerId: 'cus_ana', role: 'customer' },
      'Bearer tok',
      res as unknown as Response,
    );
  return { calls, done, connections, res, stream };
}

describe('ChatController.stream', () => {
  it('writes the events, ends the response, then releases the stream', async () => {
    const { calls, done, connections, res, stream } = setup(async function* () {
      yield token('a');
      yield token('b');
    });

    await stream();

    expect(connections.track).toHaveBeenCalledOnce();
    expect(res.written).toEqual([
      'event: token\ndata: {"text":"a"}\n\n',
      'event: token\ndata: {"text":"b"}\n\n',
    ]);
    expect(done).toHaveBeenCalledOnce();
    expect(calls).toEqual(['write', 'write', 'end', 'done']);
  });

  it('still releases the stream when the reply throws', async () => {
    const { done, stream } = setup(async function* () {
      yield token('a');
      throw new Error('graph exploded');
    });

    await expect(stream()).rejects.toThrow('graph exploded');

    expect(done).toHaveBeenCalledOnce();
  });

  it('stops writing and releases the stream when the client closes mid-stream', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { done, res, stream } = setup(async function* () {
      yield token('a');
      await gate;
      yield token('b');
    });

    const running = stream();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.written).toHaveLength(1);

    res.emit('close');
    release();
    await running;

    expect(res.written).toHaveLength(1);
    expect(done).toHaveBeenCalledOnce();
  });
});

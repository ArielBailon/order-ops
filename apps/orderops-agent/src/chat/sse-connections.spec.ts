import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatService } from './chat.service.js';
import { DRAIN_TIMEOUT_MS, SseConnections } from './sse-connections.js';

class FakeResponse extends EventEmitter {
  writableEnded = false;
  written: string[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
}

function setup(flushTraces: () => Promise<void> = async () => undefined) {
  const flush = vi.fn(flushTraces);
  const connections = new SseConnections({
    flushTraces: flush,
  } as unknown as ChatService);
  return { connections, flush };
}

function open(connections: SseConnections) {
  const res = new FakeResponse();
  const abort = new AbortController();
  const done = connections.track(res as unknown as Response, abort);
  return { res, abort, done };
}

/** Lets pending promise callbacks run without advancing fake timers. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SseConnections', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts, notifies and ends every open stream on shutdown', async () => {
    const { connections } = setup();
    const a = open(connections);
    const b = open(connections);

    const shutdown = connections.beforeApplicationShutdown();

    for (const { res, abort } of [a, b]) {
      expect(abort.signal.aborted).toBe(true);
      expect(res.writableEnded).toBe(true);
      expect(res.written).toHaveLength(1);
      expect(res.written[0]).toMatch(/^event: error\n/);
      expect(res.written[0]).toContain('"code":"shutting_down"');
    }
    a.done();
    b.done();
    await shutdown;
  });

  it('leaves a stream that already closed alone', async () => {
    const { connections } = setup();
    const closed = open(connections);
    closed.res.emit('close');
    closed.done();

    await connections.beforeApplicationShutdown();

    expect(closed.res.written).toEqual([]);
    expect(closed.abort.signal.aborted).toBe(false);
  });

  it('ends a stream that is tracked after shutdown has started, without waiting for it', async () => {
    const { connections } = setup();
    const shutdown = connections.beforeApplicationShutdown();
    await shutdown;

    const late = open(connections);

    expect(late.abort.signal.aborted).toBe(true);
    expect(late.res.writableEnded).toBe(true);
    expect(late.res.written).toHaveLength(1);
    expect(late.res.written[0]).toContain('"code":"shutting_down"');
  });

  it('does not write to a stream that was already ended', async () => {
    const { connections } = setup();
    const ended = open(connections);
    ended.res.writableEnded = true;

    const shutdown = connections.beforeApplicationShutdown();
    ended.done();
    await shutdown;

    expect(ended.res.written).toEqual([]);
    expect(ended.abort.signal.aborted).toBe(true);
  });

  it('waits for every interrupted turn to call done, then for the trace flush', async () => {
    const order: string[] = [];
    const { connections, flush } = setup(async () => {
      order.push('flush');
    });
    const a = open(connections);
    const b = open(connections);

    let finished = false;
    const shutdown = connections.beforeApplicationShutdown().then(() => {
      finished = true;
    });

    a.done();
    await settle();
    expect(finished).toBe(false);
    expect(flush).not.toHaveBeenCalled();

    order.push('b done');
    b.done();
    await shutdown;

    expect(order).toEqual(['b done', 'flush']);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('stops waiting for a turn that never finishes after the drain timeout', async () => {
    vi.useFakeTimers();
    const { connections, flush } = setup();
    open(connections); // never calls done

    let finished = false;
    const shutdown = connections.beforeApplicationShutdown().then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(finished).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('stops waiting for a trace flush that never settles after the drain timeout', async () => {
    vi.useFakeTimers();
    const { connections } = setup(() => new Promise<void>(() => undefined));

    const shutdown = connections.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);

    await expect(shutdown).resolves.toBeUndefined();
  });
});

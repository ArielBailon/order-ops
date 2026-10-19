import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { SseConnections } from './sse-connections.js';

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

function open(connections: SseConnections) {
  const res = new FakeResponse();
  const abort = new AbortController();
  connections.track(res as unknown as Response, abort);
  return { res, abort };
}

describe('SseConnections', () => {
  it('aborts, notifies and ends every open stream on shutdown', () => {
    const connections = new SseConnections();
    const a = open(connections);
    const b = open(connections);

    connections.beforeApplicationShutdown();

    for (const { res, abort } of [a, b]) {
      expect(abort.signal.aborted).toBe(true);
      expect(res.writableEnded).toBe(true);
      expect(res.written).toHaveLength(1);
      expect(res.written[0]).toMatch(/^event: error\n/);
      expect(res.written[0]).toContain('"code":"shutting_down"');
    }
  });

  it('leaves a stream that already closed alone', () => {
    const connections = new SseConnections();
    const closed = open(connections);
    closed.res.emit('close');

    connections.beforeApplicationShutdown();

    expect(closed.res.written).toEqual([]);
    expect(closed.abort.signal.aborted).toBe(false);
  });

  it('ends a stream that is tracked after shutdown has started', () => {
    const connections = new SseConnections();
    connections.beforeApplicationShutdown();

    const late = open(connections);

    expect(late.abort.signal.aborted).toBe(true);
    expect(late.res.writableEnded).toBe(true);
    expect(late.res.written).toHaveLength(1);
    expect(late.res.written[0]).toContain('"code":"shutting_down"');
  });

  it('does not write to a stream that was already ended', () => {
    const connections = new SseConnections();
    const ended = open(connections);
    ended.res.writableEnded = true;

    connections.beforeApplicationShutdown();

    expect(ended.res.written).toEqual([]);
    expect(ended.abort.signal.aborted).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createSseParser, readSse, type SseMessage } from './sse';

function parse(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = createSseParser((message) => out.push(message));
  for (const chunk of chunks) parser.push(chunk);
  return out;
}

const stream =
  'event: token\ndata: {"text":"Hi"}\n\n' +
  'event: final\ndata: {"answer":"Hi there"}\n\n';

describe('createSseParser', () => {
  it('parses several events in one chunk', () => {
    expect(parse([stream])).toEqual([
      { event: 'token', data: '{"text":"Hi"}' },
      { event: 'final', data: '{"answer":"Hi there"}' },
    ]);
  });

  it('gives the same events however the chunks split the text', () => {
    const whole = parse([stream]);
    for (let cut = 1; cut < stream.length; cut++)
      expect(parse([stream.slice(0, cut), stream.slice(cut)])).toEqual(whole);
    expect(parse(stream.split(''))).toEqual(whole);
  });

  it('accepts CRLF line endings, including one split across chunks', () => {
    expect(parse(['event: token\r\ndata: {"text":"a"}\r', '\n\r\n'])).toEqual([
      { event: 'token', data: '{"text":"a"}' },
    ]);
  });

  it('holds back an event until its blank line arrives', () => {
    expect(parse(['event: token\ndata: {"text":"a"}\n'])).toEqual([]);
  });

  it('joins multi-line data and ignores comments', () => {
    expect(parse([': keep-alive\n\ndata: a\ndata: b\n\n'])).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });
});

describe('readSse', () => {
  it('decodes a byte stream, including a character split across chunks', async () => {
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"café"}\n\n');
    const split = bytes.indexOf(0xc3) + 1; // inside the two-byte "é"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    const out: SseMessage[] = [];

    await readSse(body, (message) => out.push(message));

    expect(out).toEqual([{ event: 'token', data: '{"text":"café"}' }]);
  });
});

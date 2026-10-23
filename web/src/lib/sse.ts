export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental parser for a `text/event-stream` body: feed it decoded chunks in order and it
 * calls `onMessage` once per complete event, however the chunks split the text.
 */
export function createSseParser(onMessage: (message: SseMessage) => void) {
  let buffer = '';
  return {
    push(chunk: string): void {
      // A CRLF split across two chunks is normalized once both halves are in the buffer.
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:'))
            data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) onMessage({ event, data: data.join('\n') });
      }
    },
  };
}

/** Reads a whole SSE body, calling `onMessage` for each event as it arrives. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const parser = createSseParser(onMessage);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    // `stream: true` keeps a multi-byte character split across chunks for the next read.
    parser.push(decoder.decode(value, { stream: true }));
  }
}

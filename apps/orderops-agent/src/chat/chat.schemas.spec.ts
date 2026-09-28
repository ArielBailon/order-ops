import {
  chatRequestSchema,
  finalAnswerSchema,
  formatSseEvent,
  orderSchema,
} from './chat.schemas.js';
import { ORDER_FIXTURE } from './order.fixture.js';

describe('chatRequestSchema', () => {
  it('trims the message', () => {
    expect(
      chatRequestSchema.parse({ message: '  where is my order?  ' }),
    ).toEqual({
      message: 'where is my order?',
    });
  });

  it.each([
    ['missing', {}],
    ['blank', { message: '   ' }],
    ['too long', { message: 'a'.repeat(2001) }],
    ['not a string', { message: 42 }],
  ])('rejects a %s message', (_label, body) => {
    expect(chatRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('finalAnswerSchema', () => {
  it('requires a non-empty answer and an id list', () => {
    expect(
      finalAnswerSchema.safeParse({ answer: 'ok', orderIds: [] }).success,
    ).toBe(true);
    expect(
      finalAnswerSchema.safeParse({ answer: '', orderIds: [] }).success,
    ).toBe(false);
    expect(finalAnswerSchema.safeParse({ answer: 'ok' }).success).toBe(false);
  });
});

describe('orderSchema', () => {
  it('accepts an orders-service order', () => {
    expect(orderSchema.parse(ORDER_FIXTURE)).toEqual(ORDER_FIXTURE);
  });

  it.each([
    ['unknown status', { status: 'lost' }],
    ['numeric money', { total: 39.9 }],
    ['bad date', { createdAt: 'yesterday' }],
  ])('rejects %s', (_label, patch) => {
    expect(orderSchema.safeParse({ ...ORDER_FIXTURE, ...patch }).success).toBe(
      false,
    );
  });
});

describe('formatSseEvent', () => {
  it('writes one event with single-line JSON data', () => {
    expect(
      formatSseEvent({ type: 'token', data: { text: 'line one\nline two' } }),
    ).toBe('event: token\ndata: {"text":"line one\\nline two"}\n\n');
  });
});

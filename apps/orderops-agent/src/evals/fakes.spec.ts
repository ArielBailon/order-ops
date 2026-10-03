import { fileURLToPath } from 'node:url';
import { loadPolicyChunks } from '../faq/policy-chunks.js';
import {
  createFakeOrders,
  InMemoryRefundStore,
  InMemoryUserMemory,
  KeywordPolicySearch,
  tokenFor,
} from './fakes.js';
import { ORDERS } from './fixtures.js';

const signal = new AbortController().signal;

describe('createFakeOrders', () => {
  const orders = createFakeOrders();

  it('does not let a customer read another customer order', async () => {
    expect(await orders.getOrder(tokenFor('ana'), 'ORD-2001', signal)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await orders.getOrder(tokenFor('ana'), 'ORD-9999', signal)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('returns an own order by id', async () => {
    const result = await orders.getOrder(tokenFor('ben'), 'ORD-2001', signal);
    expect(result.ok && result.data.customerId).toBe('cus_ben');
  });

  it('lists only the caller own orders', async () => {
    const result = await orders.listOrders(tokenFor('cora'), signal);
    expect(result.ok && result.data.map((o) => o.id)).toEqual([
      'ORD-3001',
      'ORD-3002',
    ]);
  });

  it('covers delivered, shipped, pending and processing orders', () => {
    expect(new Set(ORDERS.map((o) => o.status))).toEqual(
      new Set(['delivered', 'shipped', 'pending', 'processing']),
    );
  });
});

describe('InMemoryRefundStore', () => {
  const base = {
    orderId: 'ORD-1001',
    customerId: 'cus_ana',
    amount: '89.90',
    reason: 'broken',
  };

  it('allows one open request per order, like the real store', async () => {
    const store = new InMemoryRefundStore();
    const first = await store.create({ ...base, status: 'pending_approval' });
    const second = await store.create({ ...base, status: 'pending_approval' });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      code: 'open_request_exists',
      existing: { status: 'pending_approval' },
    });
    expect((await store.findOpenForOrder('ORD-1001'))?.id).toBe(
      first.ok && first.refund.id,
    );
  });

  it('does not count an auto-rejected request as open', async () => {
    const store = new InMemoryRefundStore();
    await store.create({
      ...base,
      status: 'auto_rejected',
      decisionReason: 'window_expired',
    });
    expect(await store.findOpenForOrder('ORD-1001')).toBeNull();
  });
});

describe('InMemoryUserMemory', () => {
  it('keeps facts per customer', async () => {
    const memory = new InMemoryUserMemory();
    await memory.add('cus_ana', ['Prefers email']);
    expect(await memory.get('cus_ana')).toEqual(['Prefers email']);
    expect(await memory.get('cus_ben')).toEqual([]);
  });
});

describe('KeywordPolicySearch', () => {
  it('ranks the returns-policy chunk first for a returns question', async () => {
    const chunks = await loadPolicyChunks(
      fileURLToPath(new URL('../../policies', import.meta.url)),
    );
    const search = new KeywordPolicySearch(chunks);

    const [top] = await search.similaritySearch(
      'How many days do I have to return an item?',
      4,
    );
    expect(top.metadata).toEqual({
      source: 'returns',
      section: 'Return window',
    });
    expect(await search.similaritySearch('zzz qqq', 4)).toEqual([]);
  });
});

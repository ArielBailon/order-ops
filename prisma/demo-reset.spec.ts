import { DEMO_ACCOUNTS } from './demo-data.js';
import { formatSummary, resetDemo, type ResetClient } from './demo-reset.js';

const NOW = new Date('2026-10-24T04:00:00.000Z');

/** Collects tagged-template raw SQL as text plus its bound values. */
function rawCall(strings: TemplateStringsArray, values: unknown[]) {
  return { sql: strings.join('?').replace(/\s+/g, ' ').trim(), values };
}

function fakeClient(missingTables: string[] = []) {
  const executed: { sql: string; values: unknown[] }[] = [];
  const client = {
    customer: { upsert: vi.fn(async (_args: any) => ({})) },
    order: { upsert: vi.fn(async (_args: any) => ({})) },
    refundRequest: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    userMemory: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $queryRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const table = String(values[0]).replace('public.', '');
        return [{ exists: !missingTables.includes(table) }];
      },
    ),
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        executed.push(rawCall(strings, values));
        return 3;
      },
    ),
  };
  return { client, executed, tx: client as unknown as ResetClient };
}

describe('resetDemo', () => {
  it('upserts the five accounts and seven orders with relative dates', async () => {
    const { client, tx } = fakeClient();
    await resetDemo(tx, NOW, 'hash');

    expect(client.customer.upsert).toHaveBeenCalledTimes(5);
    expect(
      client.customer.upsert.mock.calls.map(([args]: any[]) => args.where.id),
    ).toEqual(DEMO_ACCOUNTS.map((a) => a.id));
    expect(client.customer.upsert.mock.calls[0][0]).toMatchObject({
      update: { passwordHash: 'hash', role: 'customer' },
    });
    expect(client.order.upsert).toHaveBeenCalledTimes(7);
    expect(client.order.upsert.mock.calls[0][0]).toMatchObject({
      where: { id: 'ORD-1001' },
      update: { deliveredAt: new Date('2026-10-19T04:00:00.000Z') },
    });
  });

  it('deletes refunds and memory of exactly the three demo customers', async () => {
    const { client, tx } = fakeClient();
    await resetDemo(tx, NOW, 'hash');
    const where = {
      where: { customerId: { in: ['cus_ana', 'cus_ben', 'cus_cora'] } },
    };
    expect(client.refundRequest.deleteMany).toHaveBeenCalledExactlyOnceWith(
      where,
    );
    expect(client.userMemory.deleteMany).toHaveBeenCalledExactlyOnceWith(where);
  });

  it('deletes only the demo customers threads, with the prefix as a bound parameter', async () => {
    const { executed, tx } = fakeClient();
    const summary = await resetDemo(tx, NOW, 'hash');

    expect(executed).toEqual(
      ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes'].flatMap(
        (table) =>
          ['cus_ana:%', 'cus_ben:%', 'cus_cora:%'].map((prefix) => ({
            sql: `DELETE FROM ${table} WHERE thread_id LIKE ?`,
            values: [prefix],
          })),
      ),
    );
    expect(summary).toEqual({
      accounts: 5,
      orders: 7,
      refunds: 2,
      memories: 1,
      checkpointRows: 27,
    });
  });

  it('skips a checkpoint table the gateway has not created yet', async () => {
    const { executed, tx } = fakeClient(['checkpoint_writes']);
    const summary = await resetDemo(tx, NOW, 'hash');
    expect(
      executed.some((call) => call.sql.includes('checkpoint_writes')),
    ).toBe(false);
    expect(summary.checkpointRows).toBe(18);
  });

  it('touches nothing else: no trace, other customer or broader delete', async () => {
    const { client, tx } = fakeClient();
    await resetDemo(tx, NOW, 'hash');
    expect(Object.keys(client).sort()).toEqual(
      [
        '$executeRaw',
        '$queryRaw',
        'customer',
        'order',
        'refundRequest',
        'userMemory',
      ].sort(),
    );
    // Every raw delete is scoped by a demo customer's thread prefix.
    for (const call of client.$executeRaw.mock.calls) {
      expect(String(call[1])).toMatch(/^cus_(ana|ben|cora):%$/);
    }
  });
});

describe('formatSummary', () => {
  it('reports counts only', () => {
    expect(
      formatSummary({
        accounts: 5,
        orders: 7,
        refunds: 2,
        memories: 1,
        checkpointRows: 27,
      }),
    ).toBe(
      'Demo reset: 5 accounts, 7 orders, 2 refund requests, 1 memories, 27 checkpoint rows removed',
    );
  });
});

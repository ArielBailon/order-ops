import type { PrismaService } from '@app/prisma';
import { MAX_FACTS } from './facts.js';
import { PrismaUserMemoryStore } from './user-memory.store.js';

describe('PrismaUserMemoryStore', () => {
  const calls: string[] = [];
  const userMemory = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };
  const tx = {
    $executeRaw: vi.fn(),
    userMemory,
  };
  const prisma = {
    userMemory,
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<void>) =>
      run(tx),
    ),
  };
  const store = new PrismaUserMemoryStore(prisma as unknown as PrismaService);

  beforeEach(() => {
    calls.length = 0;
    tx.$executeRaw.mockReset().mockImplementation(async () => {
      calls.push('lock');
    });
    userMemory.findUnique.mockReset().mockImplementation(async () => {
      calls.push('read');
      return { facts: ['Likes tea.'] };
    });
    userMemory.upsert.mockReset().mockImplementation(async () => {
      calls.push('write');
    });
    prisma.$transaction.mockClear();
  });

  it('locks the customer before reading and writing, all in one transaction', async () => {
    await store.add('cus_ana', ['Prefers email.']);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['lock', 'read', 'write']);
    const [strings, ...values] = tx.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual(['cus_ana']);
  });

  it('merges the new facts into the stored ones', async () => {
    await store.add('cus_ana', ['likes TEA.', 'Prefers email.']);

    expect(userMemory.upsert).toHaveBeenCalledWith({
      where: { customerId: 'cus_ana' },
      create: {
        customerId: 'cus_ana',
        facts: ['Likes tea.', 'Prefers email.'],
      },
      update: { facts: ['Likes tea.', 'Prefers email.'] },
    });
  });

  it('creates the row for a customer without stored facts', async () => {
    userMemory.findUnique.mockResolvedValue(null);

    await store.add('cus_new', ['Prefers email.']);

    expect(userMemory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { customerId: 'cus_new', facts: ['Prefers email.'] },
      }),
    );
  });

  it('keeps only the newest facts', async () => {
    const stored = Array.from({ length: MAX_FACTS }, (_, i) => `Old ${i}.`);
    userMemory.findUnique.mockResolvedValue({ facts: stored });

    await store.add('cus_ana', ['Newest.']);

    const { update } = userMemory.upsert.mock.calls[0][0];
    expect(update.facts).toHaveLength(MAX_FACTS);
    expect(update.facts.at(-1)).toBe('Newest.');
  });

  it('reads stored facts without a transaction', async () => {
    expect(await store.get('cus_ana')).toEqual(['Likes tea.']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import type { Document } from '@langchain/core/documents';
import type { Order } from '../chat/chat.schemas.js';
import type { OrdersClient, OrdersResult } from '../chat/orders.client.js';
import type { PolicySearch } from '../faq/faq.service.js';
import { mergeFacts } from '../memory/facts.js';
import type { UserMemoryStore } from '../memory/user-memory.store.js';
import type {
  CreateRefundResult,
  CustomerRefund,
  DecideResult,
  NewRefund,
  PendingRefund,
  RefundRecord,
  RefundStore,
} from '../refunds/refund.store.js';
import { CUSTOMER_IDS, type EvalCustomer, ORDERS } from './fixtures.js';

/** The eval "token" is the customer id; the fake resolves orders from it. */
export const tokenFor = (customer: EvalCustomer) => CUSTOMER_IDS[customer];

/**
 * Like orders-service: a token only ever sees its own customer's orders, and any
 * other order id is `not_found`.
 */
export function createFakeOrders(orders: readonly Order[] = ORDERS) {
  const fake = {
    listOrders: async (token: string): Promise<OrdersResult<Order[]>> => ({
      ok: true,
      data: orders.filter((o) => o.customerId === token),
    }),
    getOrder: async (
      token: string,
      orderId: string,
    ): Promise<OrdersResult<Order>> => {
      const found = orders.find(
        (o) => o.id === orderId && o.customerId === token,
      );
      return found
        ? { ok: true, data: found }
        : { ok: false, error: 'not_found' };
    },
  };
  // OrdersClient has private members, so a structural fake needs one cast.
  return fake as unknown as OrdersClient;
}

interface StoredRefund extends NewRefund {
  id: string;
  decidedBy: string | null;
}

/** In-memory `RefundStore` with the real one's one-open-request-per-order rule. */
export class InMemoryRefundStore implements RefundStore {
  readonly rows: StoredRefund[] = [];

  async findOpenForOrder(orderId: string): Promise<RefundRecord | null> {
    const row = this.rows.find(
      (r) => r.orderId === orderId && r.status === 'pending_approval',
    );
    return row ? { id: row.id, status: 'pending_approval' } : null;
  }

  async findForCustomer(
    id: string,
    customerId: string,
  ): Promise<CustomerRefund | null> {
    const row = this.rows.find(
      (r) => r.id === id && r.customerId === customerId,
    );
    return row
      ? {
          id: row.id,
          orderId: row.orderId,
          amount: row.amount,
          status: row.status,
        }
      : null;
  }

  /** Operator decisions are not part of the eval, so nothing is ever approved. */
  async hasApprovedForOrder(): Promise<boolean> {
    return false;
  }

  async create(input: NewRefund): Promise<CreateRefundResult> {
    if (input.status === 'pending_approval') {
      const existing = await this.findOpenForOrder(input.orderId);
      if (existing) return { ok: false, code: 'open_request_exists', existing };
    }
    const id = `ref_${randomUUID()}`;
    this.rows.push({
      ...input,
      id,
      decidedBy: input.status === 'auto_rejected' ? 'system' : null,
    });
    return { ok: true, refund: { id, status: input.status } };
  }

  async decide(): Promise<DecideResult> {
    throw new Error('operator decisions are not part of the eval');
  }

  async listPending(): Promise<PendingRefund[]> {
    return [];
  }
}

export class InMemoryUserMemory implements UserMemoryStore {
  private readonly facts = new Map<string, string[]>();

  async get(customerId: string): Promise<string[]> {
    return this.facts.get(customerId) ?? [];
  }

  async add(customerId: string, added: string[]): Promise<void> {
    this.facts.set(customerId, mergeFacts(await this.get(customerId), added));
  }
}

const STOP_WORDS = new Set(
  'the and for are but not you your can how what when does did have has with that this from there any many much will our its who why where'.split(
    ' ',
  ),
);

/** Lowercased words of at least 3 letters, minus stop words, with a trailing "s" dropped. */
const terms = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((w) => !STOP_WORDS.has(w))
    .map((w) => (w.endsWith('s') ? w.slice(0, -1) : w));

/**
 * Keyword stand-in for the pgvector search: ranks chunks by how many distinct query
 * terms they contain. The eval scores the agent, not retrieval.
 */
export class KeywordPolicySearch implements PolicySearch {
  private readonly indexed: { doc: Document; words: Set<string> }[];

  constructor(chunks: Document[]) {
    this.indexed = chunks.map((doc) => ({
      doc,
      words: new Set(terms(doc.pageContent)),
    }));
  }

  async similaritySearch(query: string, k: number): Promise<Document[]> {
    const wanted = new Set(terms(query));
    return this.indexed
      .map(({ doc, words }) => ({
        doc,
        score: [...wanted].filter((w) => words.has(w)).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ doc }) => doc);
  }
}

import type { Order } from './chat.schemas.js';

/** Test fixture shaped like an orders-service response. */
export const ORDER_FIXTURE: Order = {
  id: 'ord_1001',
  customerId: 'cus_ana',
  items: [{ sku: 'SKU-1', name: 'Kettle', quantity: 1, unitPrice: '39.90' }],
  total: '39.90',
  status: 'shipped',
  createdAt: '2026-09-01T10:00:00.000Z',
  shippedAt: '2026-09-02T10:00:00.000Z',
  deliveredAt: null,
};

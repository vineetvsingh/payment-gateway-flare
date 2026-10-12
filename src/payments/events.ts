import type { Db } from '../db.js';
import { newId, nowSeconds } from '../lib/ids.js';

/**
 * The event log: one row per thing that happened to a payment, refund or payout. The dashboard
 * builds each payment's timeline from it.
 */
export type EventType =
  | 'payment.created'
  | 'payment.requires_action'
  | 'payment.authorized'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.canceled'
  | 'refund.pending'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'payout.paid';

/** Records an event. Call inside the same transaction as the change it describes. */
export function emitEvent(db: Db, merchantId: string, type: EventType, object: unknown): string {
  const id = newId('evt');
  db.run(
    'INSERT INTO events (id, merchant_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)',
    id, merchantId, type, JSON.stringify({ object }), nowSeconds(),
  );
  return id;
}

export interface EventRow {
  id: string;
  merchant_id: string;
  type: string;
  data: string;
  created_at: number;
}

export const serializeEvent = (e: EventRow) => ({
  id: e.id,
  object: 'event',
  type: e.type,
  created: e.created_at,
  data: JSON.parse(e.data),
});

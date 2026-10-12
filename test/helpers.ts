import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp, type AppOptions } from '../src/app.js';
import { Db } from '../src/db.js';
import type { CreatePaymentInput } from '../src/payments/gateway.js';
import { Vault } from '../src/payments/vault.js';

export const PASSWORD = 'correct-horse-battery';
/** What the API would send: plain JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = (value: unknown): any => JSON.parse(JSON.stringify(value));

export const futureCard = (number: string) => ({ number, exp_month: 12, exp_year: new Date().getFullYear() + 2, cvc: '123' });

/**
 * A fresh in-memory site with one streamer ("Acme", owner@acme.test) signed in to the dashboard.
 * Payments are created directly on the gateway, the way the donation form does.
 */
export async function setup(options: Partial<AppOptions> = {}) {
  const db = new Db(':memory:');
  const { app, gateway, donations } = createApp(db, new Vault(randomBytes(32)), { baseUrl: 'http://gw.test', ...options });
  const dash = request.agent(app);
  const signup = await dash.post('/dashboard-api/signup')
    .send({ name: 'Acme', email: 'owner@acme.test', password: PASSWORD, handle: 'acme' });
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  const merchant = signup.body.merchant as { id: string };

  async function createPayment(input: Partial<CreatePaymentInput> = {}) {
    const payment = await gateway.createPayment(merchant.id, { amount: 50000, currency: 'inr', ...input });
    return asJson(gateway.serializePayment(payment));
  }

  const payByCard = (p: { id: string; client_secret: string }, number = '4242424242424242') =>
    request(app).post(`/checkout-api/payments/${p.id}/confirm`).send({ client_secret: p.client_secret, card: futureCard(number) });

  const startUpi = (p: { id: string; client_secret: string }, body: Record<string, unknown>) =>
    request(app).post(`/checkout-api/payments/${p.id}/upi`).send({ client_secret: p.client_secret, ...body });

  const getPayment = async (id: string) => asJson(gateway.serializePayment(gateway.getPayment(merchant.id, id)));

  /** Event types for this account, newest first. */
  const eventTypes = () => db.all<{ type: string }>(
    'SELECT type FROM events WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC', merchant.id,
  ).map((e) => e.type);

  /** Every ledger transaction must balance, and the balance must agree with the ledger. */
  function assertLedgerConsistent() {
    const unbalanced = db.all(
      `SELECT txn_id FROM ledger_entries GROUP BY txn_id
       HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) != 0`,
    );
    assert.deepEqual(unbalanced, []);
    const fromLedger = db.get<{ v: number }>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0) AS v
         FROM ledger_entries WHERE account = 'merchant_balance' AND merchant_id = ?`, merchant.id,
    )!.v;
    const fromBalanceTxns = db.get<{ v: number }>(
      'SELECT COALESCE(SUM(net), 0) AS v FROM balance_transactions WHERE merchant_id = ?', merchant.id,
    )!.v;
    assert.equal(fromLedger, fromBalanceTxns);
  }

  return { db, app, gateway, donations, merchant, dash, createPayment, payByCard, startUpi, getPayment, eventTypes, assertLedgerConsistent };
}

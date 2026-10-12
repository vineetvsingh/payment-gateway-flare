import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RazorpayPayment, RazorpayRefund } from '../src/payments/razorpay.js';

/**
 * An in-process stand-in for Razorpay's REST API, with just enough behaviour for the gateway's
 * integration: orders, payments made against them, capture, refunds, and HTTP Basic auth.
 * `pay()` plays the customer completing Razorpay Checkout.
 */
export async function startFakeRazorpay() {
  const keyId = `rzp_test_${randomBytes(7).toString('hex')}`;
  const keySecret = randomBytes(12).toString('hex');
  const orders = new Map<string, { id: string; amount: number; currency: string; receipt: string; notes: Record<string, string> }>();
  const payments = new Map<string, RazorpayPayment>();
  const refunds = new Map<string, RazorpayRefund>();
  const calls: string[] = [];
  /** `rateLimited`: how many of the next requests get HTTP 429 (with Retry-After: 0, to keep tests fast). */
  const state = { refundStatus: 'processed' as RazorpayRefund['status'], down: false, rateLimited: 0 };
  const id = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;
  const now = () => Math.floor(Date.now() / 1000);
  const fail = (res: express.Response, status: number, description: string) =>
    res.status(status).json({ error: { code: 'BAD_REQUEST_ERROR', description } });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    calls.push(`${req.method} ${req.path}`);
    if (state.down) return fail(res, 503, 'Service unavailable');
    if (state.rateLimited > 0) {
      state.rateLimited--;
      return res.status(429).set('Retry-After', '0').json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Too many requests' } });
    }
    const expected = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    if (req.get('Authorization') !== expected) return res.status(401).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
    next();
  });

  app.get('/v1/orders', (_req, res) => res.json({ entity: 'collection', count: orders.size, items: [...orders.values()].slice(0, 1) }));

  app.post('/v1/orders', (req, res) => {
    if (!Number.isInteger(req.body.amount) || req.body.amount < 100) return fail(res, 400, 'Order amount less than minimum amount allowed');
    const order = { id: id('order'), amount: req.body.amount, currency: req.body.currency, receipt: req.body.receipt, notes: req.body.notes ?? {} };
    orders.set(order.id, order);
    res.json({ ...order, entity: 'order', status: 'created', amount_paid: 0, amount_due: order.amount, attempts: 0, created_at: now() });
  });

  // Like the real list endpoint, card details aren't expanded here.
  app.get('/v1/orders/:id/payments', (req, res) => {
    const items = [...payments.values()].filter((p) => p.order_id === req.params.id).map(({ card: _card, ...p }) => p);
    res.json({ entity: 'collection', count: items.length, items });
  });

  app.get('/v1/payments/:id', (req, res) => {
    const p = payments.get(req.params.id);
    if (!p) return fail(res, 400, 'The id provided does not exist');
    const { card, ...rest } = p;
    res.json(req.query['expand[]'] === 'card' || req.query.expand ? p : { ...rest, card_id: card ? 'card_x' : null });
  });

  app.post('/v1/payments/:id/capture', (req, res) => {
    const p = payments.get(req.params.id);
    if (!p) return fail(res, 400, 'The id provided does not exist');
    if (p.status !== 'authorized') return fail(res, 400, 'This payment has already been captured');
    if (req.body.amount !== p.amount) return fail(res, 400, 'Capture amount must be equal to the amount authorized');
    Object.assign(p, { status: 'captured', captured: true, ...fees(p.amount) });
    res.json(p);
  });

  app.post('/v1/payments/:id/refund', (req, res) => {
    const p = payments.get(req.params.id);
    if (!p || p.status !== 'captured' && p.status !== 'refunded') return fail(res, 400, 'Payment is not captured');
    const amount = req.body.amount ?? p.amount - p.amount_refunded;
    if (amount > p.amount - p.amount_refunded) return fail(res, 400, 'The refund amount provided is greater than amount captured');
    p.amount_refunded += amount;
    if (p.amount_refunded === p.amount) p.status = 'refunded';
    const refund: RazorpayRefund = { id: id('rfnd'), entity: 'refund', amount, currency: p.currency, payment_id: p.id, status: state.refundStatus, created_at: now() };
    refunds.set(refund.id, refund);
    res.json({ ...refund, receipt: req.body.receipt, notes: req.body.notes });
  });

  app.get('/v1/refunds/:id', (req, res) => {
    const r = refunds.get(req.params.id);
    return r ? res.json(r) : fail(res, 400, 'The id provided does not exist');
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Razorpay's fee: 2% plus 18% GST on it. */
  function fees(amount: number) {
    const fee = Math.round(amount * 0.02);
    const tax = Math.round(fee * 0.18);
    return { fee: fee + tax, tax };
  }

  /**
   * The customer completes (or fails) Razorpay Checkout for an order. Returns what Checkout hands
   * the browser on success: the payment id and its signature.
   */
  function pay(orderId: string, opts: {
    status?: 'captured' | 'authorized' | 'failed';
    method?: 'card' | 'upi' | 'netbanking';
    card?: { last4: string; network: string };
  } = {}) {
    const order = orders.get(orderId);
    if (!order) throw new Error(`no order ${orderId}`);
    const status = opts.status ?? 'captured';
    const method = opts.method ?? 'card';
    const payment: RazorpayPayment = {
      id: id('pay'), entity: 'payment', amount: order.amount, currency: order.currency, status, order_id: orderId, method,
      captured: status === 'captured', amount_refunded: 0, fee: null, tax: null,
      card: method === 'card' ? { last4: '1007', network: 'Visa', type: 'debit', ...opts.card } : null,
      vpa: method === 'upi' ? 'asha@okicici' : null,
      bank: method === 'netbanking' ? 'HDFC' : null,
      error_code: status === 'failed' ? 'BAD_REQUEST_ERROR' : null,
      error_description: status === 'failed' ? 'Your payment could not be completed as this transaction was declined by your bank.' : null,
      error_reason: status === 'failed' ? 'payment_declined' : null,
      created_at: now() + payments.size, // keeps attempts in order within the same second
    };
    if (status === 'captured') Object.assign(payment, fees(payment.amount));
    payments.set(payment.id, payment);
    const signature = createHmac('sha256', keySecret).update(`${orderId}|${payment.id}`).digest('hex');
    return { razorpay_payment_id: payment.id, razorpay_order_id: orderId, razorpay_signature: signature };
  }

  return {
    keyId, keySecret, baseUrl, orders, payments, refunds, calls, state, pay, fees,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeRazorpay = Awaited<ReturnType<typeof startFakeRazorpay>>;

/** Signs a webhook body the way Razorpay does. */
export const signWebhook = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

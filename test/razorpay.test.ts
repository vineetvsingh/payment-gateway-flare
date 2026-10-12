import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { startFakeRazorpay, signWebhook, type FakeRazorpay } from './fake-razorpay.js';
import { futureCard, setup } from './helpers.js';

const WEBHOOK_SECRET = 'whsec-from-razorpay-dashboard';
let rzp: FakeRazorpay;

before(async () => { rzp = await startFakeRazorpay(); });
after(async () => { await rzp.close(); });

const connect = (ctx: Awaited<ReturnType<typeof setup>>, body: object) => ctx.dash.post('/dashboard-api/provider/razorpay').send(body);

/** A streamer with their Razorpay account connected. */
async function connected(options: { baseUrl?: string } = {}) {
  const ctx = await setup({ razorpayApiBase: rzp.baseUrl, ...options });
  const res = await connect(ctx, { key_id: rzp.keyId, key_secret: rzp.keySecret, webhook_secret: WEBHOOK_SECRET });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const checkoutView = async (p: { id: string; client_secret: string }) =>
    (await request(ctx.app).get(`/checkout-api/payments/${p.id}?client_secret=${p.client_secret}`)).body;
  /** What the hosted checkout page sends when Razorpay Checkout calls back (or with no result: closed/failed). */
  const complete = (p: { id: string; client_secret: string }, result: Record<string, string> = {}) =>
    request(ctx.app).post(`/checkout-api/payments/${p.id}/razorpay/complete`).send({ client_secret: p.client_secret, ...result });
  const webhook = (event: string, payload: object, eventId = `evt_${Math.random()}`, secret = WEBHOOK_SECRET) => {
    const body = JSON.stringify({ entity: 'event', event, contains: Object.keys(payload), payload, created_at: 0 });
    return request(ctx.app).post(`/webhooks/razorpay/${ctx.merchant.id}`)
      .set('Content-Type', 'application/json').set('X-Razorpay-Signature', signWebhook(body, secret))
      .set('X-Razorpay-Event-Id', eventId).send(body);
  };
  const orderOf = async (p: { id: string }) => (await ctx.getPayment(p.id)).razorpay.order_id as string;
  const refund = (p: { id: string }, body: object = {}) => ctx.dash.post(`/dashboard-api/payments/${p.id}/refund`).send(body);
  const refundStatus = (id: string) => ctx.db.get<{ status: string }>('SELECT status FROM refunds WHERE id = ?', id)!.status;
  /** The donation form, which creates the payment. */
  const donate = () => request(ctx.app).post('/donate-api/profiles/acme/donations').send({ amount: 5000, method: 'upi' });
  return { ...ctx, checkoutView, complete, webhook, orderOf, refund, refundStatus, donate };
}

describe('connecting Razorpay', () => {
  it('checks the keys with Razorpay and never stores or returns the secret in plain text', async () => {
    const ctx = await setup({ razorpayApiBase: rzp.baseUrl });
    const wrong = await connect(ctx, { key_id: rzp.keyId, key_secret: 'not-the-secret' });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'razorpay_authentication_failed');
    assert.equal((await connect(ctx, { key_id: 'nope', key_secret: 'xxxxxxxxxx' })).body.error.param, 'key_id');

    const ok = await connect(ctx, { key_id: rzp.keyId, key_secret: rzp.keySecret });
    assert.equal(ok.body.provider, 'razorpay');
    assert.deepEqual(ok.body.razorpay, { key_id: rzp.keyId, mode: 'test', webhook_configured: false });
    assert.ok(!JSON.stringify(ok.body).includes(rzp.keySecret));
    assert.ok(!JSON.stringify(ctx.db.all('SELECT * FROM merchants')).includes(rzp.keySecret), 'the secret is encrypted at rest');

    const off = await ctx.dash.post('/dashboard-api/provider/razorpay/disconnect').send({});
    assert.deepEqual([off.body.provider, off.body.razorpay], ['simulator', null]);
  });

  it('refuses live keys unless the gateway is served over HTTPS', async () => {
    const ctx = await setup({ razorpayApiBase: rzp.baseUrl });
    const res = await connect(ctx, { key_id: 'rzp_live_abc123', key_secret: 'whatever-secret' });
    assert.equal(res.body.error.code, 'https_required');
  });
});

describe('payments through Razorpay', () => {
  it('creates a Razorpay order and gives checkout only what it needs to open Razorpay Checkout', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment({ amount: 49900, description: 'Kettle' });
    const orderId = await ctx.orderOf(payment);
    assert.deepEqual({ ...rzp.orders.get(orderId) }, { id: orderId, amount: 49900, currency: 'INR', receipt: payment.id, notes: { gateway_payment_id: payment.id } });

    const view = await ctx.checkoutView(payment);
    assert.equal(view.provider, 'razorpay');
    assert.deepEqual(view.payment_method_types, []);
    assert.equal(view.razorpay.key_id, rzp.keyId);
    assert.equal(view.razorpay.order_id, orderId);
    assert.ok(!JSON.stringify(view).includes(rzp.keySecret));

    // The simulator's own card form and UPI flow are switched off for this payment.
    const card = await request(ctx.app).post(`/checkout-api/payments/${payment.id}/confirm`).send({ client_secret: payment.client_secret, card: futureCard('4242424242424242') });
    assert.equal(card.body.error.code, 'use_razorpay_checkout');
    assert.equal((await ctx.startUpi(payment, { flow: 'qr' })).body.error.code, 'use_razorpay_checkout');
  });

  it('records a successful checkout from what Razorpay reports, with the real fee', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment({ amount: 100000 });
    const result = rzp.pay(await ctx.orderOf(payment), { card: { last4: '1007', network: 'Visa' } });

    const done = await ctx.complete(payment, result);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, 'succeeded');
    const p = await ctx.getPayment(payment.id);
    assert.deepEqual([p.fee, p.net], [2360, 97640]); // 2% + 18% GST on the fee
    assert.deepEqual(p.payment_method.card, { brand: 'visa', last4: '1007', exp_month: null, exp_year: null, fingerprint: null });
    assert.equal(p.razorpay.payment_id, result.razorpay_payment_id);
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM payment_methods WHERE encrypted_pan IS NOT NULL")!.n, 0,
      'no card number ever reaches this gateway');

    // Calling again (a double-click, a retry, a webhook) changes nothing.
    await ctx.complete(payment, result);
    assert.equal(ctx.eventTypes().filter((t) => t === 'payment.succeeded').length, 1);
    ctx.assertLedgerConsistent();
  });

  it('rejects a forged success callback and trusts only Razorpay', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment();
    const forged = await ctx.complete(payment, { razorpay_payment_id: 'pay_fake', razorpay_signature: 'deadbeef' });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, 'invalid_signature');
    // Even a validly signed id for a payment that failed doesn't make the order paid.
    const failed = rzp.pay(await ctx.orderOf(payment), { status: 'failed' });
    assert.equal((await ctx.complete(payment, failed)).body.status, 'requires_payment_method');
  });

  it('records each failed attempt once, then the success', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment();
    const orderId = await ctx.orderOf(payment);
    rzp.pay(orderId, { status: 'failed' });
    const afterFailure = (await ctx.complete(payment)).body;
    assert.equal(afterFailure.status, 'requires_payment_method');
    assert.equal(afterFailure.last_error.code, 'payment_declined');
    await ctx.complete(payment); // modal closed: nothing new
    rzp.pay(orderId, { method: 'upi' });
    assert.equal((await ctx.complete(payment)).body.status, 'succeeded');
    assert.equal((await ctx.getPayment(payment.id)).payment_method.upi.vpa, 'asha@okicici');
    assert.equal(ctx.eventTypes().filter((t) => t === 'payment.failed').length, 1);
  });

  it('captures authorized payments: automatically, or later for manual capture (full amount only)', async () => {
    const ctx = await connected();
    const auto = await ctx.createPayment();
    rzp.pay(await ctx.orderOf(auto), { status: 'authorized' });
    assert.equal((await ctx.complete(auto)).body.status, 'succeeded');
    assert.ok(rzp.calls.some((c) => c.endsWith('/capture')));

    const manual = await ctx.createPayment({ capture_method: 'manual', amount: 20000 });
    rzp.pay(await ctx.orderOf(manual), { status: 'authorized', method: 'netbanking' });
    assert.equal((await ctx.complete(manual)).body.status, 'requires_capture');
    assert.equal((await ctx.getPayment(manual.id)).payment_method.bank, 'HDFC');
    const partial = await ctx.dash.post(`/dashboard-api/payments/${manual.id}/capture`).send({ amount: 100 });
    assert.equal(partial.body.error.code, 'partial_capture_unsupported');
    const captured = await ctx.dash.post(`/dashboard-api/payments/${manual.id}/capture`).send({});
    assert.equal(captured.body.status, 'succeeded');
    assert.equal(captured.body.fee, 472);
    ctx.assertLedgerConsistent();
  });

  it('finds payments the browser never reported, through reconciliation', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment();
    rzp.pay(await ctx.orderOf(payment)); // the customer paid, then closed the tab
    await ctx.gateway.reconcileRazorpay();
    assert.equal((await ctx.getPayment(payment.id)).status, 'succeeded');
  });

  it('refunds a payment that was paid in an old tab after the merchant canceled it', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment();
    await ctx.dash.post(`/dashboard-api/payments/${payment.id}/cancel`).send({});
    const result = rzp.pay(await ctx.orderOf(payment));
    const res = await ctx.complete(payment, result);
    assert.equal(res.body.status, 'canceled');
    assert.equal(rzp.payments.get(result.razorpay_payment_id)!.status, 'refunded');
  });

  it('reports Razorpay outages as retryable 502s', async () => {
    const ctx = await connected();
    rzp.state.down = true;
    try {
      const res = await ctx.donate();
      assert.equal(res.status, 502);
      assert.equal(res.body.error.code, 'razorpay_unavailable');
    } finally {
      rzp.state.down = false;
    }
    assert.equal((await ctx.donate()).status, 201, 'trying again works once Razorpay is back');
  });

  it('waits and retries when Razorpay rate-limits, and says so clearly if it keeps happening', async () => {
    const ctx = await connected();
    rzp.state.rateLimited = 2;
    const retried = await ctx.donate();
    assert.equal(retried.status, 201, JSON.stringify(retried.body));

    rzp.state.rateLimited = 3;
    try {
      const limited = await connect(ctx, { key_id: rzp.keyId, key_secret: rzp.keySecret });
      assert.equal(limited.status, 503);
      assert.equal(limited.body.error.code, 'razorpay_rate_limited');
    } finally {
      rzp.state.rateLimited = 0;
    }
  });

  it('leaves payouts to Razorpay', async () => {
    const ctx = await connected();
    assert.equal((await ctx.dash.post('/dashboard-api/payouts').send({})).body.error.code, 'payouts_by_razorpay');
  });
});

describe('refunds through Razorpay', () => {
  it('refunds at once when Razorpay processes it immediately', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment({ amount: 10000 });
    const paid = rzp.pay(await ctx.orderOf(payment));
    await ctx.complete(payment, paid);
    const refund = await ctx.refund(payment, { amount: 4000 });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    assert.equal(refund.body.status, 'succeeded');
    const atRazorpay = [...rzp.refunds.values()].filter((r) => r.payment_id === paid.razorpay_payment_id);
    assert.deepEqual(atRazorpay.map((r) => r.amount), [4000]);
    ctx.assertLedgerConsistent();
  });

  it('tracks a pending refund until Razorpay processes it or it fails', async () => {
    const ctx = await connected();
    rzp.state.refundStatus = 'pending';
    try {
      const payment = await ctx.createPayment({ amount: 10000 });
      await ctx.complete(payment, rzp.pay(await ctx.orderOf(payment)));
      const first = (await ctx.refund(payment, { amount: 3000 })).body;
      const second = (await ctx.refund(payment, { amount: 2000 })).body;
      assert.deepEqual([first.status, second.status], ['pending', 'pending']);
      assert.equal((await ctx.getPayment(payment.id)).amount_refunded, 5000);

      // Razorpay finishes one by itself (seen by the reconciliation job)...
      const rr1 = ctx.db.get<{ provider_refund_id: string }>('SELECT provider_refund_id FROM refunds WHERE id = ?', first.id)!.provider_refund_id;
      rzp.refunds.get(rr1)!.status = 'processed';
      await ctx.gateway.reconcileRazorpay();
      assert.equal(ctx.refundStatus(first.id), 'succeeded');

      // ...and the other fails, reported by webhook: the money goes back to the merchant.
      const rr2 = ctx.db.get<{ provider_refund_id: string }>('SELECT provider_refund_id FROM refunds WHERE id = ?', second.id)!.provider_refund_id;
      rzp.refunds.get(rr2)!.status = 'failed';
      const hook = await ctx.webhook('refund.failed', { refund: { entity: rzp.refunds.get(rr2) } });
      assert.equal(hook.status, 200);
      assert.equal(ctx.refundStatus(second.id), 'failed');
      assert.equal((await ctx.getPayment(payment.id)).amount_refunded, 3000);
      const types = ctx.eventTypes();
      assert.ok(types.includes('refund.pending') && types.includes('refund.succeeded') && types.includes('refund.failed'));
      ctx.assertLedgerConsistent();
    } finally {
      rzp.state.refundStatus = 'processed';
    }
  });
});

describe('Razorpay webhooks', () => {
  it('accepts only correctly signed events, and applies each event once', async () => {
    const ctx = await connected();
    const payment = await ctx.createPayment();
    const result = rzp.pay(await ctx.orderOf(payment));
    const payload = { payment: { entity: rzp.payments.get(result.razorpay_payment_id) } };

    assert.equal((await ctx.webhook('payment.captured', payload, 'evt_1', 'wrong-secret')).status, 400);
    assert.equal((await ctx.getPayment(payment.id)).status, 'requires_payment_method');

    assert.equal((await ctx.webhook('payment.captured', payload, 'evt_1')).status, 200);
    assert.equal((await ctx.getPayment(payment.id)).status, 'succeeded');
    const syncs = rzp.calls.length;
    assert.equal((await ctx.webhook('payment.captured', payload, 'evt_1')).status, 200);
    assert.equal(rzp.calls.length, syncs, 'a redelivered event is not processed again');
  });

  it('answers 404 for merchants without a webhook secret', async () => {
    const ctx = await setup({ razorpayApiBase: rzp.baseUrl });
    const res = await request(ctx.app).post(`/webhooks/razorpay/${ctx.merchant.id}`).set('Content-Type', 'application/json').send('{}');
    assert.equal(res.status, 404);
  });
});

describe('dashboard with Razorpay', () => {
  it('connects Razorpay and shows the webhook URL to paste into Razorpay', async () => {
    const ctx = await setup({ razorpayApiBase: rzp.baseUrl });
    const agent = request.agent(ctx.app);
    await agent.post('/dashboard-api/login').send({ email: 'owner@acme.test', password: 'correct-horse-battery' });
    const me = (await agent.get('/dashboard-api/me')).body;
    assert.equal(me.razorpay_webhook_url, `http://gw.test/webhooks/razorpay/${ctx.merchant.id}`);
    const res = await agent.post('/dashboard-api/provider/razorpay').send({ key_id: rzp.keyId, key_secret: rzp.keySecret });
    assert.equal(res.body.provider, 'razorpay');
    assert.equal((await agent.get('/dashboard-api/balance')).body.provider, 'razorpay');
  });
});

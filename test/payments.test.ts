import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { futureCard, setup } from './helpers.js';

const VISA_OK = '4242424242424242';
const VISA_DECLINE = '4000000000000002';
const VISA_NO_FUNDS = '4000000000009995';
const VISA_3DS = '4000000000003220';

describe('card payments (test mode)', () => {
  it('succeeds with a good card and never stores the full card number in plain text', async () => {
    const t = await setup();
    const payment = await t.createPayment({ description: 'Tea' });
    assert.equal(payment.status, 'requires_payment_method');
    assert.match(payment.checkout_url, /^http:\/\/gw\.test\/checkout\/pay_/);

    const res = await t.payByCard(payment, VISA_OK);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'succeeded');

    const full = await t.getPayment(payment.id);
    assert.equal(full.amount_captured, 50000);
    assert.equal(full.payment_method?.type, 'card');
    assert.ok(!JSON.stringify(t.db.all('SELECT * FROM payment_methods')).includes(VISA_OK), 'PAN stored in plaintext');
  });

  it('records a decline and lets the donor retry with another card', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    const declined = await t.payByCard(payment, VISA_NO_FUNDS);
    assert.equal(declined.body.status, 'requires_payment_method');
    assert.equal(declined.body.last_error.code, 'insufficient_funds');

    const retry = await t.payByCard(payment, VISA_OK);
    assert.equal(retry.body.status, 'succeeded');
    assert.equal(retry.body.last_error, null);
  });

  it('rejects invalid cards before contacting the processor', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    const badNumber = await t.payByCard(payment, '4242424242424241');
    assert.equal(badNumber.status, 402);
    assert.equal(badNumber.body.error.code, 'invalid_number');

    const expired = await request(t.app).post(`/checkout-api/payments/${payment.id}/confirm`)
      .send({ client_secret: payment.client_secret, card: { ...futureCard(VISA_OK), exp_year: 2020 } });
    assert.equal(expired.body.error.code, 'expired_card');
    assert.equal((await t.getPayment(payment.id)).payment_method, null);
  });

  it('requires the right client secret on the checkout API', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    const res = await t.payByCard({ id: payment.id, client_secret: 'pay_x_secret_wrong' }, VISA_OK);
    assert.equal(res.status, 404);
  });

  it('throttles repeated card attempts but not page loads', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    for (let i = 0; i < 10; i++) {
      assert.equal((await t.payByCard(payment, VISA_DECLINE)).status, 200);
    }
    assert.equal((await t.payByCard(payment, VISA_OK)).status, 429);
    for (let i = 0; i < 15; i++) {
      const res = await request(t.app).get(`/checkout-api/payments/${payment.id}`).query({ client_secret: payment.client_secret });
      assert.equal(res.status, 200);
    }
  });

  it('cannot be paid twice', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    await t.payByCard(payment, VISA_OK);
    const again = await t.payByCard(payment, VISA_OK);
    assert.equal(again.status, 409);
    assert.equal((await t.getPayment(payment.id)).amount_captured, 50000);
  });
});

describe('3-D Secure', () => {
  it('requires authentication, then succeeds', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    const res = await t.payByCard(payment, VISA_3DS);
    assert.equal(res.body.status, 'requires_action');
    assert.match(res.body.next_action.url, /\/3ds\/pay_/);

    const done = await request(t.app).post(`/checkout-api/payments/${payment.id}/authenticate`)
      .send({ client_secret: payment.client_secret, result: 'approve' });
    assert.equal(done.body.status, 'succeeded');
  });

  it('fails the attempt when the cardholder fails the challenge', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    await t.payByCard(payment, VISA_3DS);
    const done = await request(t.app).post(`/checkout-api/payments/${payment.id}/authenticate`)
      .send({ client_secret: payment.client_secret, result: 'fail' });
    assert.equal(done.body.status, 'requires_payment_method');
    assert.equal(done.body.last_error.code, 'authentication_failed');
  });
});

describe('capture, cancel and refunds', () => {
  it('authorizes, partially captures, and refunds up to the captured amount', async () => {
    const t = await setup();
    const payment = await t.createPayment({ amount: 10000, capture_method: 'manual' });
    const authorized = await t.payByCard(payment, VISA_OK);
    assert.equal(authorized.body.status, 'requires_capture');

    const tooMuch = await t.dash.post(`/dashboard-api/payments/${payment.id}/capture`).send({ amount: 20000 });
    assert.equal(tooMuch.status, 400);

    const captured = await t.dash.post(`/dashboard-api/payments/${payment.id}/capture`).send({ amount: 8000 });
    assert.equal(captured.body.status, 'succeeded');
    assert.equal(captured.body.amount_captured, 8000);
    assert.equal(captured.body.amount_capturable, 0);

    const refund = (body: object) => t.dash.post(`/dashboard-api/payments/${payment.id}/refund`).send(body);
    assert.equal((await refund({ amount: 3000 })).status, 200);
    const over = await refund({ amount: 6000 });
    assert.equal(over.status, 400);
    assert.equal(over.body.error.code, 'amount_too_large');

    const rest = await refund({});
    assert.equal(rest.body.amount, 5000);
    assert.equal((await t.getPayment(payment.id)).amount_refunded, 8000);
    assert.equal((await refund({})).status, 409);
  });

  it('cancels an authorization and blocks later capture', async () => {
    const t = await setup();
    const payment = await t.createPayment({ capture_method: 'manual' });
    await t.payByCard(payment, VISA_OK);
    const canceled = await t.dash.post(`/dashboard-api/payments/${payment.id}/cancel`).send({});
    assert.equal(canceled.body.status, 'canceled');
    assert.equal((await t.dash.post(`/dashboard-api/payments/${payment.id}/capture`).send({})).status, 409);
  });

  it('cannot refund a payment that has not succeeded', async () => {
    const t = await setup();
    const payment = await t.createPayment();
    assert.equal((await t.dash.post(`/dashboard-api/payments/${payment.id}/refund`).send({})).status, 409);
  });
});

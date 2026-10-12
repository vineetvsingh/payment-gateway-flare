import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { nowSeconds } from '../src/lib/ids.js';
import { setup } from './helpers.js';

const refOf = (res: request.Response) => res.body.next_action.simulator_url.split('/').pop() as string;

describe('UPI collect requests', () => {
  it('waits for the payer, then succeeds when they approve with their PIN', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const started = await t.startUpi(p, { flow: 'collect', vpa: ' Success@UPI ' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, 'requires_action');
    assert.equal(started.body.next_action.type, 'upi_collect');
    assert.equal(started.body.next_action.vpa, 'success@upi');

    const ref = refOf(started);
    const appView = await request(t.app).get(`/upi-api/requests/${ref}`);
    assert.equal(appView.body.payee, 'Acme');
    assert.equal(appView.body.status, 'pending');

    const badPin = await request(t.app).post(`/upi-api/requests/${ref}/approve`).send({ pin: '12' });
    assert.equal(badPin.status, 400);
    assert.equal((await t.getPayment(p.id)).status, 'requires_action', 'a bad PIN does not end the request');

    const ok = await request(t.app).post(`/upi-api/requests/${ref}/approve`).send({ pin: '123456' });
    assert.equal(ok.body.status, 'approved');
    const payment = await t.getPayment(p.id);
    assert.equal(payment.status, 'succeeded');
    assert.deepEqual(payment.payment_method.upi, { vpa: 'success@upi', flow: 'collect' });

    const again = await request(t.app).post(`/upi-api/requests/${ref}/approve`).send({ pin: '123456' });
    assert.equal(again.status, 409);
  });

  it('validates the UPI ID before sending a request', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const malformed = await t.startUpi(p, { flow: 'collect', vpa: 'not-a-vpa' });
    assert.equal(malformed.status, 402);
    assert.equal(malformed.body.error.code, 'invalid_vpa');
    const missing = await t.startUpi(p, { flow: 'collect', vpa: 'invalid@upi' });
    assert.equal(missing.body.error.code, 'vpa_not_found');
    assert.equal((await t.getPayment(p.id)).status, 'requires_payment_method');
  });

  it("fails immediately when the payer's bank declines", async () => {
    const t = await setup();
    const res = await t.startUpi(await t.createPayment(), { flow: 'collect', vpa: 'failure@upi' });
    assert.equal(res.body.status, 'requires_payment_method');
    assert.equal(res.body.last_error.code, 'upi_declined');
  });

  it('fails with insufficient funds on approval', async () => {
    const t = await setup();
    const res = await t.startUpi(await t.createPayment(), { flow: 'collect', vpa: 'nofunds@upi' });
    const done = await request(t.app).post(`/upi-api/requests/${refOf(res)}/approve`).send({ pin: '1234' });
    assert.equal(done.body.status, 'declined');
  });

  it('lets the customer pay by card after declining in the app', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const res = await t.startUpi(p, { flow: 'collect', vpa: 'someone@okaxis' });
    await request(t.app).post(`/upi-api/requests/${refOf(res)}/decline`).send({});
    const declined = await t.getPayment(p.id);
    assert.equal(declined.last_error.code, 'upi_declined_by_payer');

    const card = await t.payByCard(p);
    assert.equal(card.body.status, 'succeeded');
    assert.equal(card.body.payment_method.type, 'card');
  });

  it('lets the customer cancel a pending request from checkout', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const res = await t.startUpi(p, { flow: 'collect', vpa: 'someone@okaxis' });
    const canceled = await request(t.app).post(`/checkout-api/payments/${p.id}/upi/cancel`).send({ client_secret: p.client_secret });
    assert.equal(canceled.body.status, 'requires_payment_method');
    const late = await request(t.app).post(`/upi-api/requests/${refOf(res)}/approve`).send({ pin: '1234' });
    assert.equal(late.status, 409, 'an abandoned request cannot be approved later');
  });

  it('expires requests the payer never answers', async () => {
    const t = await setup({ upiExpirySeconds: 60 });
    const p = await t.createPayment();
    const res = await t.startUpi(p, { flow: 'collect', vpa: 'success@upi' });

    assert.equal(t.gateway.expireUpiRequests(nowSeconds()), 0, 'not yet');
    assert.equal(t.gateway.expireUpiRequests(nowSeconds() + 61), 1);
    const payment = await t.getPayment(p.id);
    assert.equal(payment.status, 'requires_payment_method');
    assert.equal(payment.last_error.code, 'upi_request_expired');
    const late = await request(t.app).post(`/upi-api/requests/${refOf(res)}/approve`).send({ pin: '1234' });
    assert.equal(late.status, 409);
  });

  it('rejects approval after expiry even before the background job runs', async () => {
    const t = await setup({ upiExpirySeconds: -1 });
    const p = await t.createPayment();
    const res = await t.startUpi(p, { flow: 'collect', vpa: 'success@upi' });
    const late = await request(t.app).post(`/upi-api/requests/${refOf(res)}/approve`).send({ pin: '1234' });
    assert.equal(late.status, 409);
    assert.equal((await t.getPayment(p.id)).last_error.code, 'upi_request_expired');
  });
});

describe('UPI QR', () => {
  it('shows a QR code and records the payer VPA from their app', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const res = await t.startUpi(p, { flow: 'qr' });
    assert.equal(res.body.next_action.type, 'upi_qr');

    const svg = await request(t.app).get(new URL(res.body.next_action.qr_code_svg_url).pathname);
    assert.equal(svg.status, 200);
    assert.match(svg.headers['content-type'], /image\/svg\+xml/);
    assert.match(Buffer.from(svg.body).toString('utf8'), /<svg/);

    await request(t.app).post(`/upi-api/requests/${refOf(res)}/approve`).send({ pin: '1234', payer_vpa: 'ravi@okhdfc' });
    const payment = await t.getPayment(p.id);
    assert.equal(payment.status, 'succeeded');
    assert.equal(payment.payment_method.upi.vpa, 'ravi@okhdfc');
  });
});

describe('UPI availability', () => {
  it('is offered only for INR payments with automatic capture', async () => {
    const t = await setup();
    const usd = await t.createPayment({ currency: 'usd' });
    const manual = await t.createPayment({ capture_method: 'manual' });
    const inr = await t.createPayment();
    for (const p of [usd, manual]) {
      const view = await request(t.app).get(`/checkout-api/payments/${p.id}`).query({ client_secret: p.client_secret });
      assert.deepEqual(view.body.payment_method_types, ['card']);
      assert.equal((await t.startUpi(p, { flow: 'qr' })).status, 400);
    }
    const view = await request(t.app).get(`/checkout-api/payments/${inr.id}`).query({ client_secret: inr.client_secret });
    assert.deepEqual(view.body.payment_method_types, ['card', 'upi']);
  });
});

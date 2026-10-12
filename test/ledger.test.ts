import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;
const balancePage = async (t: Ctx) => (await t.dash.get('/dashboard-api/balance')).body;
const balanceOf = async (t: Ctx, currency = 'inr') =>
  (await balancePage(t)).balances.find((b: { currency: string }) => b.currency === currency) ?? { available: 0, pending: 0 };
const payout = (t: Ctx, body: object = {}) => t.dash.post('/dashboard-api/payouts').send(body);

describe('ledger and fees', () => {
  it('charges 2% on cards and holds funds as pending until settlement', async () => {
    const t = await setup();
    const p = await t.createPayment({ amount: 50000 });
    await t.payByCard(p);

    const payment = await t.getPayment(p.id);
    assert.equal(payment.fee, 1000);
    assert.equal(payment.net, 49000);
    assert.deepEqual(await balanceOf(t), { currency: 'inr', available: 0, pending: 49000 });
    t.assertLedgerConsistent();
  });

  it('charges no fee on UPI (zero MDR)', async () => {
    const t = await setup({ settlementDelaySeconds: 0 });
    const p = await t.createPayment({ amount: 20000 });
    const started = await t.startUpi(p, { flow: 'collect', vpa: 'success@upi' });
    const ref = started.body.next_action.simulator_url.split('/').pop();
    const approved = await request(t.app).post(`/upi-api/requests/${ref}/approve`).send({ pin: '1234' });
    assert.equal(approved.body.status, 'approved');
    assert.equal((await t.getPayment(p.id)).fee, 0);
    assert.deepEqual(await balanceOf(t), { currency: 'inr', available: 20000, pending: 0 });
    t.assertLedgerConsistent();
  });

  it('bases the fee on the captured amount for partial captures', async () => {
    const t = await setup();
    const p = await t.createPayment({ amount: 10000, capture_method: 'manual' });
    await t.payByCard(p);
    assert.equal((await t.getPayment(p.id)).fee, null, 'no fee before capture');
    await t.dash.post(`/dashboard-api/payments/${p.id}/capture`).send({ amount: 5000 });
    assert.equal((await t.getPayment(p.id)).fee, 100);
    t.assertLedgerConsistent();
  });

  it('keeps balances per currency', async () => {
    const t = await setup({ settlementDelaySeconds: 0 });
    await t.payByCard(await t.createPayment({ amount: 10000, currency: 'inr' }));
    await t.payByCard(await t.createPayment({ amount: 3000, currency: 'usd' }));
    assert.deepEqual((await balancePage(t)).balances, [
      { currency: 'inr', available: 9800, pending: 0 },
      { currency: 'usd', available: 2940, pending: 0 },
    ]);
  });
});

describe('payouts', () => {
  it('pays out only available funds', async () => {
    const t = await setup({ settlementDelaySeconds: 0 });
    await t.payByCard(await t.createPayment({ amount: 10000 }));

    const tooMuch = await payout(t, { amount: 9801 });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, 'balance_insufficient');

    const paid = await payout(t);
    assert.equal(paid.status, 201);
    assert.equal(paid.body.amount, 9800);
    assert.equal(paid.body.status, 'paid');
    assert.deepEqual(await balanceOf(t), { currency: 'inr', available: 0, pending: 0 });

    assert.equal((await payout(t)).status, 400, 'nothing left to pay out');
    assert.equal((await balancePage(t)).payouts.length, 1);
    assert.equal(t.eventTypes()[0], 'payout.paid');
    t.assertLedgerConsistent();
  });

  it('cannot pay out pending funds', async () => {
    const t = await setup();
    await t.payByCard(await t.createPayment());
    assert.equal((await payout(t)).status, 400);
  });

  it('lets a refund after a payout take the balance negative, like real gateways do', async () => {
    const t = await setup({ settlementDelaySeconds: 0 });
    const p = await t.createPayment({ amount: 10000 });
    await t.payByCard(p);
    await payout(t);
    assert.equal((await t.dash.post(`/dashboard-api/payments/${p.id}/refund`).send({})).status, 200);
    assert.deepEqual(await balanceOf(t), { currency: 'inr', available: -10000, pending: 0 });

    const history = (await balancePage(t)).balance_transactions.map((b: { type: string; net: number }) => [b.type, b.net]);
    assert.deepEqual(history, [['refund', -10000], ['payout', -9800], ['payment', 9800]]);
    t.assertLedgerConsistent();
  });
});

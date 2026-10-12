import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { PASSWORD, setup } from './helpers.js';

async function loggedIn(t: Awaited<ReturnType<typeof setup>>) {
  const agent = request.agent(t.app);
  const res = await agent.post('/dashboard-api/login').send({ email: 'OWNER@acme.test', password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return agent;
}

describe('dashboard auth', () => {
  it('logs in with email and password and sets a hardened session cookie', async () => {
    const t = await setup();
    const wrong = await request(t.app).post('/dashboard-api/login').send({ email: 'owner@acme.test', password: 'nope-nope' });
    assert.equal(wrong.status, 401);
    const unknown = await request(t.app).post('/dashboard-api/login').send({ email: 'who@acme.test', password: PASSWORD });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.message, wrong.body.error.message, 'does not reveal which emails exist');

    const ok = await request(t.app).post('/dashboard-api/login').send({ email: 'owner@acme.test', password: PASSWORD });
    const cookie = ok.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!JSON.stringify(t.db.all('SELECT * FROM dashboard_sessions')).includes(cookie.split(';')[0].split('=')[1]),
      'only a hash of the session token is stored');
  });

  it('requires a session, and logout ends it', async () => {
    const t = await setup();
    assert.equal((await request(t.app).get('/dashboard-api/me')).status, 401);
    const agent = await loggedIn(t);
    assert.equal((await agent.get('/dashboard-api/me')).body.email, 'owner@acme.test');
    await agent.post('/dashboard-api/logout').send({});
    assert.equal((await agent.get('/dashboard-api/me')).status, 401);
  });

  it('rejects non-JSON POSTs (CSRF defence)', async () => {
    const t = await setup();
    const agent = await loggedIn(t);
    const res = await agent.post('/dashboard-api/payouts').type('form').send('currency=inr');
    assert.equal(res.status, 415);
  });

  it('signs up streamers and refuses duplicate emails', async () => {
    const t = await setup();
    const agent = request.agent(t.app);
    const res = await agent.post('/dashboard-api/signup')
      .send({ name: 'New Streamer', email: 'new@stream.test', password: 'long-enough-pw', handle: 'newbie' });
    assert.equal(res.status, 201);
    const me = (await agent.get('/dashboard-api/me')).body;
    assert.deepEqual([me.name, me.handle], ['New Streamer', 'newbie']);
    assert.ok(!('secret_key' in res.body), 'there are no API keys any more');

    const dup = await request(t.app).post('/dashboard-api/signup').send({ name: 'X', email: 'owner@acme.test', password: 'long-enough-pw', handle: 'xx_x' });
    assert.equal(dup.status, 409);
    const short = await request(t.app).post('/dashboard-api/signup').send({ name: 'X', email: 'x@stream.test', password: 'short', handle: 'xx_x' });
    assert.equal(short.status, 400);
    const noHandle = await request(t.app).post('/dashboard-api/signup').send({ name: 'X', email: 'x@stream.test', password: 'long-enough-pw' });
    assert.equal(noHandle.body.error.param, 'handle');
  });
});

describe('dashboard data', () => {
  it('summarises volume, fees and balances', async () => {
    const t = await setup();
    await t.payByCard(await t.createPayment({ amount: 10000 }));
    await t.payByCard(await t.createPayment({ amount: 20000 }));
    await t.payByCard(await t.createPayment(), '4000000000000002');

    const overview = (await (await loggedIn(t)).get('/dashboard-api/overview')).body;
    assert.equal(overview.currency, 'inr');
    assert.equal(overview.totals.gross, 30000);
    assert.equal(overview.totals.fees, 600);
    assert.equal(overview.totals.succeeded, 2);
    assert.equal(overview.totals.failed, 1);
    assert.equal(overview.daily.length, 1);
    assert.equal(overview.daily[0].volume, 30000);
    assert.equal(overview.balances[0].pending, 29400);
    assert.equal(overview.recent_payments.length, 3);
  });

  it('filters and searches payments', async () => {
    const t = await setup();
    await t.payByCard(await t.createPayment({ description: 'Masala chai' }));
    await t.payByCard(await t.createPayment({ description: 'Kettle' }), '4000000000009995');
    await t.createPayment({ description: 'Mugs' });
    const agent = await loggedIn(t);
    const descriptions = async (qs: string) =>
      (await agent.get(`/dashboard-api/payments?${qs}`)).body.data.map((p: { description: string }) => p.description);

    assert.deepEqual(await descriptions('status=succeeded'), ['Masala chai']);
    assert.deepEqual(await descriptions('status=failed'), ['Kettle']);
    assert.deepEqual(await descriptions('status=incomplete'), ['Mugs']);
    assert.deepEqual(await descriptions('q=chai'), ['Masala chai']);
    assert.deepEqual(await descriptions('q=%25'), [], 'LIKE wildcards are escaped');
  });

  it('shows a payment timeline and refunds from the dashboard', async () => {
    const t = await setup();
    const p = await t.createPayment({ amount: 10000 });
    await t.payByCard(p);
    const agent = await loggedIn(t);

    const refund = await agent.post(`/dashboard-api/payments/${p.id}/refund`).send({ amount: 2500, reason: 'requested_by_customer' });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));

    const detail = (await agent.get(`/dashboard-api/payments/${p.id}`)).body;
    assert.deepEqual(detail.events.map((e: { type: string }) => e.type), ['payment.created', 'payment.succeeded', 'refund.succeeded']);
    assert.deepEqual(detail.balance_transactions.map((b: { type: string; net: number }) => [b.type, b.net]), [['payment', 9800], ['refund', -2500]]);
    assert.equal(detail.refunds[0].amount, 2500);
    t.assertLedgerConsistent();
  });

  it('does not show other merchants their data', async () => {
    const t = await setup();
    const p = await t.createPayment();
    const other = request.agent(t.app);
    await other.post('/dashboard-api/signup').send({ name: 'Other', email: 'other@stream.test', password: 'long-enough-pw', handle: 'other' });
    assert.equal((await other.get(`/dashboard-api/payments/${p.id}`)).status, 404);
    assert.equal((await other.post(`/dashboard-api/payments/${p.id}/cancel`).send({})).status, 404);
  });
});

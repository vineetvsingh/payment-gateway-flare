import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { moderate, parseBlockedWords, spokenText } from '../src/donations/moderation.js';
import { hindiSpeech } from '../src/donations/speech.js';
import { setup } from './helpers.js';

const PASSWORD = 'stream-pass-123';
const servers: { close: () => void }[] = [];
after(() => servers.forEach((s) => s.close()));

/** A gateway with a streamer ("vinethegamer") signed in to the dashboard. Alerts run 100x faster. */
async function streamer(opts: { moderation?: 'auto' | 'manual' } = {}) {
  const ctx = await setup({ donations: { timeScale: 0.01, alertGapMs: 0 } });
  const dash = request.agent(ctx.app);
  const signup = await dash.post('/dashboard-api/signup')
    .send({ name: 'VineTheGamer', email: 'vine@stream.test', password: PASSWORD, handle: 'VineTheGamer' });
  assert.equal(signup.status, 201, JSON.stringify(signup.body));
  if (opts.moderation) await dash.post('/dashboard-api/profile').send({ moderation: opts.moderation });
  const profile = (await dash.get('/dashboard-api/profile')).body;

  const donate = (body: Record<string, unknown>, handle = 'vinethegamer') =>
    request(ctx.app).post(`/donate-api/profiles/${handle}/donations`).send({ method: 'upi', ...body });
  /** Donates and pays at the hosted checkout with a card. Returns the donation id. */
  async function donateAndPay(body: Record<string, unknown>) {
    const res = await donate({ method: 'card', ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const url = new URL(res.body.checkout_url);
    const paid = await ctx.payByCard({ id: url.pathname.split('/').pop()!, client_secret: url.searchParams.get('client_secret')! });
    assert.equal(paid.body.status, 'succeeded', JSON.stringify(paid.body));
    return res.body.donation_id as string;
  }
  async function overlay(token = new URL(profile.overlay_urls.alerts).pathname.split('/').pop()!) {
    const server = ctx.app.listen(0);
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/overlay-api/${token}/stream`);
    return { status: res.status, events: res.ok ? eventReader(res) : null };
  }
  return { ...ctx, dash, profile, donate, donateAndPay, overlay };
}

/** Reads Server-Sent Events one at a time. */
function eventReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // One read at a time: a read that outlives a timeout is reused, so its data is never lost.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next = async (timeoutMs = 3000): Promise<any> => {
    for (;;) {
      const match = /^data: (.*)$/m.exec(buffer);
      if (match) {
        buffer = buffer.slice(match.index + match[0].length);
        return JSON.parse(match[1]);
      }
      pending ??= reader.read();
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no event in time')), timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      pending = null;
      if (chunk.done) throw new Error('stream closed');
      buffer += decoder.decode(chunk.value);
    }
  };
  /** Skips events until one of `type` arrives. */
  const until = async (type: string) => {
    for (;;) {
      const event = await next();
      if (event.type === type) return event;
    }
  };
  return { next, until, close: () => reader.cancel() };
}

describe('message filter', () => {
  it('masks swearing, even disguised, and keeps normal messages as they are', () => {
    assert.deepEqual(moderate('Great stream bhai, love from Pune!'), { text: 'Great stream bhai, love from Pune!', flagged: false });
    for (const rude of ['what the fuck', 'sh1t game', 'f.u.c.k this', 'fuuuuuck', 'you chutiya']) {
      const result = moderate(rude);
      assert.ok(result.flagged, rude);
      assert.match(result.text, /\*/, rude);
    }
  });

  it('removes links, calms repeated letters, and honours the streamer\'s own words', () => {
    assert.deepEqual(moderate('visit www.scam.example and bit.ly/xyz'), { text: 'visit [link removed] and [link removed]', flagged: true });
    assert.equal(moderate('noooooooo way').text, 'nooo way');
    assert.ok(moderate('go play valorant', parseBlockedWords('Valorant, fortnite')).flagged);
    assert.equal(spokenText('nice **** [link removed] stream'), 'nice stream');
  });

  it('understands Hindi written in Devanagari, with or without the dot in ड़', () => {
    assert.deepEqual(moderate('भाई आज की स्ट्रीम बहुत मज़ेदार है!'), { text: 'भाई आज की स्ट्रीम बहुत मज़ेदार है!', flagged: false });
    for (const rude of ['तू चूतिया है', 'भोसड़ीके', 'भोसडीके']) assert.ok(moderate(rude).flagged, rude);
    assert.ok(moderate('यह शब्द नहीं', parseBlockedWords('शब्द')).flagged);
  });
});

describe('reading Hindi and Hinglish aloud', () => {
  it('leaves English messages to the English voice', () => {
    for (const english of ['Love the stream, keep it up!', 'GG bhai, love the stream and keep grinding', 'please do more streams bhai']) {
      assert.equal(hindiSpeech(english), null, english);
    }
  });

  it('writes the Hindi words of Hinglish in Devanagari and keeps the English ones', () => {
    assert.equal(hindiSpeech('Bhai aaj ka stream ekdum mast hai, aise hi khelte raho!'), 'भाई आज का stream एकदम मस्त है, ऐसे ही खेलते रहो!');
    assert.equal(hindiSpeech('Bhaiii maaast clutch tha, bohot badhiya'), 'भाई मस्त clutch था, बहुत बढ़िया');
    assert.equal(hindiSpeech('kya h bhai, stream me maza aa gaya'), 'क्या है भाई, stream में मज़ा आ गया');
  });

  it('reads words like "to" and "hi" as Hindi only next to Hindi', () => {
    assert.equal(hindiSpeech('bhai tu to op hai yaar'), 'भाई तू तो op है यार');
    assert.equal(hindiSpeech('Welcome to the stream bhai, kya haal hai'), 'Welcome to the stream भाई, क्या हाल है');
    assert.equal(hindiSpeech('Hi bhai! Main bhi khelunga kal'), 'Hi भाई! मैं भी खेलूँगा कल');
  });

  it('sends Devanagari as it is', () => {
    assert.equal(hindiSpeech('भाई आज की स्ट्रीम बहुत मज़ेदार है!'), 'भाई आज की स्ट्रीम बहुत मज़ेदार है!');
  });
});

describe('streamer accounts', () => {
  it('signs a streamer up with a public page, and keeps page names unique', async () => {
    const ctx = await streamer();
    assert.equal(ctx.profile.handle, 'vinethegamer');
    assert.equal(ctx.profile.donation_url, 'http://gw.test/donate/vinethegamer');
    assert.match(ctx.profile.overlay_urls.voice, /^http:\/\/gw\.test\/overlay\/ovl_\w+\/voice$/);

    const page = (await request(ctx.app).get('/donate-api/profiles/VINETHEGAMER')).body;
    assert.deepEqual([page.display_name, page.methods, page.min_amount, page.test_mode], ['VineTheGamer', ['upi', 'card'], 1000, true]);

    const again = await request(ctx.app).post('/dashboard-api/signup')
      .send({ name: 'Other', email: 'o@stream.test', password: PASSWORD, handle: 'vinethegamer' });
    assert.equal(again.body.error.code, 'handle_taken');
    const bad = await request(ctx.app).post('/dashboard-api/signup')
      .send({ name: 'Other', email: 'o@stream.test', password: PASSWORD, handle: 'no spaces!' });
    assert.equal(bad.body.error.param, 'handle');
    assert.equal((await request(ctx.app).get('/donate-api/profiles/nobody')).status, 404);
    // A failed sign-up (the page name was taken) leaves no half-made account behind.
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM merchants WHERE email = 'o@stream.test'")!.n, 0);
  });
});

describe('donations', () => {
  it('turns the form into a payment, and the donation counts only once it is paid', async () => {
    const ctx = await streamer();
    assert.equal((await ctx.donate({ amount: 500 })).body.error.code, 'amount_out_of_range');
    assert.equal((await ctx.donate({ amount: 5000, method: 'wallet' })).body.error.code, 'method_unavailable');
    assert.equal((await ctx.donate({ amount: 5000, message: 'x'.repeat(201) })).body.error.param, 'message');

    const res = await ctx.donate({ name: 'Asha', amount: 20000, message: 'GG!' });
    assert.equal(res.status, 201);
    const url = new URL(res.body.checkout_url);
    const checkout = (await request(ctx.app).get(`/checkout-api/payments/${url.pathname.split('/').pop()}?client_secret=${url.searchParams.get('client_secret')}`)).body;
    assert.equal(checkout.preferred_method, 'upi');
    assert.equal(checkout.description, 'Donation to VineTheGamer');
    assert.equal(checkout.return_url, `http://gw.test/donate/vinethegamer/thanks/${res.body.donation_id}`);

    const unpaid = (await request(ctx.app).get(`/donate-api/donations/${res.body.donation_id}`)).body;
    assert.deepEqual([unpaid.status, unpaid.on_stream], ['awaiting_payment', 'no']);
    assert.deepEqual((await ctx.dash.get('/dashboard-api/donations')).body.data, []);

    const id = await ctx.donateAndPay({ name: 'Asha', amount: 20000, message: 'GG!' });
    const paid = (await request(ctx.app).get(`/donate-api/donations/${id}`)).body;
    assert.deepEqual([paid.status, paid.payment_status, paid.on_stream, paid.donor_name], ['paid', 'succeeded', 'yes', 'Asha']);
    const list = (await ctx.dash.get('/dashboard-api/donations')).body;
    assert.deepEqual(list.data.map((d: { donor_name: string; alert_status: string; tts: boolean }) => [d.donor_name, d.alert_status, d.tts]),
      [['Asha', 'queued', true]]);
  });

  it('holds flagged messages, or every message in manual mode, for the streamer to approve', async () => {
    const ctx = await streamer();
    const rude = await ctx.donateAndPay({ name: 'Troll', amount: 5000, message: 'this game is shit, visit spam.com' });
    const anonymous = await ctx.donateAndPay({ amount: 5000 });
    const [second, first] = (await ctx.dash.get('/dashboard-api/donations')).body.data;
    assert.equal(first.id, rude);
    assert.equal(first.alert_status, 'pending_review');
    assert.equal(first.message, 'this game is ****, visit [link removed]');
    assert.equal(first.original_message, 'this game is shit, visit spam.com');
    assert.deepEqual([second.id, second.donor_name, second.alert_status, second.tts], [anonymous, 'Anonymous', 'queued', false]);

    assert.equal((await ctx.dash.post(`/dashboard-api/donations/${rude}/approve`).send({})).status, 200);
    assert.equal((await ctx.dash.post(`/dashboard-api/donations/${rude}/approve`).send({})).status, 409);

    const manual = await streamer({ moderation: 'manual' });
    await manual.donateAndPay({ amount: 5000, message: 'hello' });
    assert.equal((await manual.dash.get('/dashboard-api/donations')).body.data[0].alert_status, 'pending_review');
  });
});

describe('stream overlay', () => {
  it('plays paid donations one at a time on every open overlay, with the voice text', async () => {
    const ctx = await streamer();
    const overlay = await ctx.overlay();
    assert.equal(overlay.status, 200);
    const events = overlay.events!;

    await ctx.donateAndPay({ name: 'Asha', amount: 10000, message: 'Love the stream!' });
    await ctx.donateAndPay({ name: 'Vik', amount: 2000, message: 'small one' });
    const first = await events.until('alert');
    assert.deepEqual(first.alert, {
      id: first.alert.id, donor_name: 'Asha', amount: 10000, currency: 'inr',
      message: 'Love the stream!', spoken: 'Love the stream!', spoken_hindi: null, donation_name: 'Flare', test: false,
    });
    assert.equal((await events.next()).type, 'clear');
    const second = (await events.until('alert'));
    assert.deepEqual([second.alert.donor_name, second.alert.spoken], ['Vik', null]); // under ₹50: shown, not read aloud

    await ctx.donateAndPay({ name: 'Rahul', amount: 10000, message: 'Bhai aaj ka stream ekdum mast hai' });
    const hinglish = (await events.until('alert')).alert;
    assert.deepEqual([hinglish.spoken, hinglish.spoken_hindi], ['Bhai aaj ka stream ekdum mast hai', 'भाई आज का stream एकदम मस्त है']);

    // The streamer's own name for a donation reaches the voice: "Rahul sent an Angoor."
    assert.equal((await ctx.dash.post('/dashboard-api/profile').send({ donation_name: '  Angoor ' })).body.donation_name, 'Angoor');
    assert.equal((await ctx.dash.post('/dashboard-api/profile').send({ donation_name: ' ' })).status, 400);
    await ctx.donateAndPay({ name: 'Rahul', amount: 10000, message: 'nice' });
    assert.equal((await events.until('alert')).alert.donation_name, 'Angoor');
    events.close();
    const shown = (await ctx.dash.get('/dashboard-api/donations')).body.data.map((d: { alert_status: string }) => d.alert_status);
    assert.deepEqual(shown, ['shown', 'shown', 'shown', 'shown']);
  });

  it('waits while paused or while no overlay is open, and plays test alerts', async () => {
    const ctx = await streamer();
    await ctx.donateAndPay({ name: 'Early', amount: 5000, message: 'before the stream' });
    assert.equal((await ctx.dash.get('/dashboard-api/donations')).body.queue.queued, 1, 'nothing plays with no overlay open');

    await ctx.dash.post('/dashboard-api/alerts/pause').send({ paused: true });
    const events = (await ctx.overlay()).events!;
    assert.deepEqual(await events.next(), { type: 'hello', donation_name: 'Flare' });
    await ctx.dash.post('/dashboard-api/alerts/test').send({});
    await assert.rejects(events.next(300), /no event/);

    await ctx.dash.post('/dashboard-api/alerts/pause').send({ paused: false });
    const test = (await events.until('alert'));
    assert.equal(test.alert.test, true);
    const real = (await events.until('alert'));
    assert.equal(real.alert.donor_name, 'Early');
    events.close();
  });

  it('rejects unknown overlay links, and rotating the link cuts the old one off', async () => {
    const ctx = await streamer();
    assert.equal((await ctx.overlay('ovl_wrong')).status, 404);
    const old = new URL(ctx.profile.overlay_urls.alerts).pathname.split('/').pop()!;
    const rotated = (await ctx.dash.post('/dashboard-api/profile/overlay-token/rotate').send({})).body;
    assert.notEqual(rotated.overlay_urls.alerts, ctx.profile.overlay_urls.alerts);
    assert.equal((await ctx.overlay(old)).status, 404);
  });
});

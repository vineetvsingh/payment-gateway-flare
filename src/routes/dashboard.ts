import { randomBytes } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { MAX_DONATION, type Donations } from '../donations/donations.js';
import { ApiError } from '../lib/errors.js';
import { nowSeconds, sha256 } from '../lib/ids.js';
import { verifyPassword } from '../lib/passwords.js';
import { serializeEvent, type EventRow } from '../payments/events.js';
import {
  serializeMerchant, serializePayout, serializeRefund, type Gateway, type MerchantRow,
} from '../payments/gateway.js';
import { serializeBalanceTransaction, type BalanceTransactionRow } from '../payments/ledger.js';
import { connectRazorpaySchema } from '../payments/razorpay.js';
import { rateLimit } from './middleware.js';

/*
 * Backend for the streamer dashboard (public/dashboard). Streamers log in with
 * email and password and get a session cookie.
 *
 * CSRF: the cookie is SameSite=Strict and every POST must be application/json, which a cross-site
 * HTML form cannot send without a CORS preflight that this server never approves.
 */
const COOKIE = 'gw_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  password: z.string().min(8, 'must be at least 8 characters').max(200),
  // The public page name: /donate/<handle>.
  handle: z.string().max(30),
});
const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().optional(),
  status: z.enum(['succeeded', 'refunded', 'uncaptured', 'failed', 'incomplete', 'canceled']).optional(),
  q: z.string().trim().max(100).optional(),
});
const amountSchema = z.object({ amount: z.number().int().positive().optional() });
const refundSchema = amountSchema.extend({ reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional() });
const payoutSchema = z.object({ currency: z.string().length(3).default('inr'), amount: z.number().int().positive().optional() });

const profileSchema = z.object({
  handle: z.string().max(30).optional(),
  display_name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  min_amount: z.number().int().min(100).max(MAX_DONATION).optional(),
  tts_min_amount: z.number().int().min(0).max(MAX_DONATION).optional(),
  tts_enabled: z.boolean().optional(),
  moderation: z.enum(['auto', 'manual']).optional(),
  blocked_words: z.string().max(2000).optional(),
  alert_seconds: z.number().int().min(3).max(30).optional(),
  donation_name: z.string().trim().min(1).max(30).optional(),
});

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const merchantOf = (res: Response): MerchantRow => res.locals.merchant as MerchantRow;

export function dashboardRouter(gateway: Gateway, donations: Donations): Router {
  const db = gateway.db;
  const router = Router();

  router.use((req, _res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      throw new ApiError(415, 'invalid_request_error', 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
    }
    next();
  });

  // ------------------------------------------------------------ sign in / out

  function startSession(req: Request, res: Response, merchantId: string): void {
    const token = randomBytes(32).toString('base64url');
    db.run('DELETE FROM dashboard_sessions WHERE expires_at <= ?', nowSeconds());
    db.run(
      'INSERT INTO dashboard_sessions (token_hash, merchant_id, expires_at) VALUES (?, ?, ?)',
      sha256(token), merchantId, nowSeconds() + SESSION_TTL_SECONDS,
    );
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: SESSION_TTL_SECONDS * 1000,
    });
  }

  const authLimit = rateLimit({ windowMs: 60_000, max: 10 });

  router.post('/signup', authLimit, (req, res) => {
    const merchant = donations.signup(signupSchema.parse(req.body));
    startSession(req, res, merchant.id);
    res.status(201).json({ merchant: serializeMerchant(merchant) });
  });

  router.post('/login', authLimit, (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const merchant = gateway.findLoginByEmail(email);
    if (!verifyPassword(password, merchant?.password_hash ?? null) || !merchant) {
      throw new ApiError(401, 'authentication_error', 'invalid_login', 'Incorrect email or password.');
    }
    startSession(req, res, merchant.id);
    res.json({ merchant: serializeMerchant(merchant) });
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) db.run('DELETE FROM dashboard_sessions WHERE token_hash = ?', sha256(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  const requireSession: RequestHandler = (req, res, next) => {
    const token = readCookie(req, COOKIE);
    const session = token
      ? db.get<{ merchant_id: string }>(
          'SELECT merchant_id FROM dashboard_sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), nowSeconds(),
        )
      : undefined;
    if (!session) throw new ApiError(401, 'authentication_error', 'not_logged_in', 'Please log in.');
    res.locals.merchant = gateway.getMerchant(session.merchant_id);
    res.set('Cache-Control', 'no-store');
    next();
  };
  router.use(requireSession);

  router.get('/me', (_req, res) => {
    const merchant = merchantOf(res);
    res.json({
      ...serializeMerchant(merchant),
      handle: donations.profileOf(merchant.id)?.handle ?? null,
      razorpay_webhook_url: gateway.razorpayWebhookUrl(merchant.id),
    });
  });

  // ---------------------------------------------------- profile and alerts

  const profileView = (merchantId: string) => {
    const profile = donations.profileOf(merchantId);
    if (!profile) return null;
    return {
      ...profile,
      tts_enabled: profile.tts_enabled === 1,
      alerts_paused: profile.alerts_paused === 1,
      donation_url: `${gateway.baseUrl}/donate/${profile.handle}`,
      overlay_urls: donations.overlayUrls(profile),
      overlay_token: undefined,
    };
  };

  router.get('/profile', (_req, res) => {
    res.json(profileView(merchantOf(res).id));
  });

  router.post('/profile', (req, res) => {
    donations.updateProfile(merchantOf(res).id, profileSchema.parse(req.body));
    res.json(profileView(merchantOf(res).id));
  });

  router.post('/profile/overlay-token/rotate', (_req, res) => {
    donations.rotateOverlayToken(merchantOf(res).id);
    res.json(profileView(merchantOf(res).id));
  });

  router.get('/donations', (_req, res) => {
    const id = merchantOf(res).id;
    res.json({ data: donations.listDonations(id), queue: donations.queueStatus(id) });
  });

  router.post('/donations/:id/:action', (req, res) => {
    const action = z.enum(['approve', 'reject', 'replay']).parse(req.params.action);
    donations.moderateDonation(merchantOf(res).id, req.params.id, action);
    res.json({ ok: true });
  });

  router.post('/alerts/skip', (_req, res) => {
    donations.hub.skip(merchantOf(res).id);
    res.json({ ok: true });
  });

  router.post('/alerts/test', (req, res) => {
    const { tts } = z.object({ tts: z.boolean().default(true) }).parse(req.body);
    donations.hub.test(merchantOf(res).id, tts);
    res.json(donations.queueStatus(merchantOf(res).id));
  });

  router.post('/alerts/pause', (req, res) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    donations.setPaused(merchantOf(res).id, paused);
    res.json(donations.queueStatus(merchantOf(res).id));
  });

  // ----------------------------------------------------------------- payments

  router.get('/overview', (_req, res) => {
    const merchantId = merchantOf(res).id;
    const days = 14;
    const since = nowSeconds() - days * 86400;
    const currency =
      db.get<{ currency: string }>(
        'SELECT currency FROM payments WHERE merchant_id = ? GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1', merchantId,
      )?.currency ?? 'inr';
    const daily = db.all<{ day: string; volume: number; count: number }>(
      `SELECT date(created_at, 'unixepoch', 'localtime') AS day, SUM(amount) AS volume, COUNT(*) AS count
         FROM balance_transactions
        WHERE merchant_id = ? AND type = 'payment' AND currency = ? AND created_at >= ?
        GROUP BY day ORDER BY day`,
      merchantId, currency, since,
    );
    const totals = db.get<{ gross: number; fees: number; refunded: number }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'payment' THEN amount END), 0) AS gross,
              COALESCE(SUM(fee), 0) AS fees,
              COALESCE(-SUM(CASE WHEN type = 'refund' THEN amount END), 0) AS refunded
         FROM balance_transactions WHERE merchant_id = ? AND currency = ? AND created_at >= ?`,
      merchantId, currency, since,
    )!;
    const counts = db.get<{ succeeded: number; failed: number }>(
      `SELECT COALESCE(SUM(type = 'payment.succeeded'), 0) AS succeeded, COALESCE(SUM(type = 'payment.failed'), 0) AS failed
         FROM events WHERE merchant_id = ? AND created_at >= ?`,
      merchantId, since,
    )!;
    res.json({
      currency,
      days,
      balances: gateway.getBalance(merchantId).balances,
      totals: { ...totals, ...counts },
      daily,
      recent_payments: gateway.listPayments(merchantId, { limit: 6 }).data.map((p) => gateway.serializePayment(p)),
    });
  });

  router.get('/payments', (req, res) => {
    const { limit, starting_after, status, q } = listSchema.parse(req.query);
    const page = gateway.listPayments(merchantOf(res).id, { limit, startingAfter: starting_after, status, query: q || undefined });
    res.json({ data: page.data.map((p) => gateway.serializePayment(p)), has_more: page.has_more });
  });

  router.get('/payments/:id', (req, res) => {
    const merchantId = merchantOf(res).id;
    const payment = gateway.getPayment(merchantId, req.params.id);
    const refunds = gateway.listRefundsForPayment(merchantId, payment.id);
    const events = db.all<EventRow>(
      `SELECT * FROM events
        WHERE merchant_id = ? AND (json_extract(data, '$.object.id') = ? OR json_extract(data, '$.object.payment') = ?)
        ORDER BY created_at, rowid`,
      merchantId, payment.id, payment.id,
    );
    const sources = [payment.id, ...refunds.map((r) => r.id)];
    const balanceTransactions = db.all<BalanceTransactionRow>(
      `SELECT * FROM balance_transactions WHERE merchant_id = ? AND source_id IN (${sources.map(() => '?').join(',')})
        ORDER BY created_at, rowid`,
      merchantId, ...sources,
    );
    res.json({
      payment: gateway.serializePayment(payment),
      refunds: refunds.map(serializeRefund),
      events: events.map(serializeEvent),
      balance_transactions: balanceTransactions.map(serializeBalanceTransaction),
    });
  });

  router.post('/payments/:id/refund', async (req, res) => {
    const input = refundSchema.parse(req.body);
    res.json(serializeRefund(await gateway.createRefund(merchantOf(res).id, { payment: req.params.id, ...input })));
  });

  router.post('/payments/:id/capture', async (req, res) => {
    const { amount } = amountSchema.parse(req.body);
    res.json(gateway.serializePayment(await gateway.capturePayment(merchantOf(res).id, req.params.id, amount)));
  });

  router.post('/payments/:id/cancel', (req, res) => {
    res.json(gateway.serializePayment(gateway.cancelPayment(merchantOf(res).id, req.params.id)));
  });

  // ------------------------------------------------------- balance and payouts

  router.get('/balance', (_req, res) => {
    const merchantId = merchantOf(res).id;
    res.json({
      balances: gateway.getBalance(merchantId).balances,
      settlement_delay_seconds: gateway.settlementDelaySeconds,
      provider: merchantOf(res).provider,
      balance_transactions: gateway.listBalanceTransactions(merchantId, 50).map(serializeBalanceTransaction),
      payouts: gateway.listPayouts(merchantId, 20).map(serializePayout),
    });
  });

  router.post('/payouts', (req, res) => {
    res.status(201).json(serializePayout(gateway.createPayout(merchantOf(res).id, payoutSchema.parse(req.body))));
  });

  // ------------------------------------------------------------------ Razorpay

  router.post('/provider/razorpay', async (req, res) => {
    const input = connectRazorpaySchema.parse(req.body);
    res.json(serializeMerchant(await gateway.connectRazorpay(merchantOf(res).id, input)));
  });

  router.post('/provider/razorpay/disconnect', (_req, res) => {
    res.json(serializeMerchant(gateway.disconnectRazorpay(merchantOf(res).id)));
  });

  return router;
}

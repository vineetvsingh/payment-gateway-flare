import { detectBrand, validateCard, type CardInput } from './card.js';
import type { Db } from '../db.js';
import { ApiError, invalidState, notFound } from '../lib/errors.js';
import { newId, nowSeconds, safeEqual } from '../lib/ids.js';
import {
  feeFor, merchantBalances, recordPaymentCaptured, recordPayout, recordRefund, recordRefundFailed, type BalanceTransactionRow,
} from './ledger.js';
import { hashPassword } from '../lib/passwords.js';
import { authorize, type AuthorizationResult } from './processor.js';
import {
  brandFromNetwork, RAZORPAY_API, RAZORPAY_CHECKOUT_JS, RazorpayClient, RazorpayError, verifyCheckoutSignature,
  verifyWebhookSignature, type RazorpayPayment, type RazorpayRefund,
} from './razorpay.js';
import { approveWithPin, sendCollectRequest, validateVpa, type UpiDecision } from './upi.js';
import type { Vault } from './vault.js';
import { emitEvent } from './events.js';

/*
 * Payment lifecycle:
 *
 *   requires_payment_method --confirm--> requires_action --+  (card: 3-D Secure; UPI: waiting for
 *            ^      |                                       |   the payer to approve in their app)
 *            |      +---------------------------------------+
 *            |                         | approved                         | declined / expired
 *            |                         v                                  |
 *            |         capture_method = automatic --> succeeded           |
 *            |         capture_method = manual    --> requires_capture --capture--> succeeded
 *            +-------------------------------------------------------------+ (retry with another method)
 *
 *   canceled is reachable from any state before succeeded.
 */
export type PaymentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'requires_capture'
  | 'succeeded'
  | 'canceled';

export interface MerchantRow {
  id: string;
  name: string;
  email: string;
  password_hash: string | null;
  provider: Provider;
  razorpay_key_id: string | null;
  /** Encrypted with the vault key. */
  razorpay_key_secret: string | null;
  /** Encrypted with the vault key. */
  razorpay_webhook_secret: string | null;
  created_at: number;
}

/** Who actually moves the money: the built-in simulator (test only), or the merchant's own Razorpay account. */
export type Provider = 'simulator' | 'razorpay';

export interface PaymentRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  capture_method: 'automatic' | 'manual';
  amount_capturable: number;
  amount_captured: number;
  amount_refunded: number;
  client_secret: string;
  payment_method_id: string | null;
  description: string | null;
  metadata: string;
  return_url: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  provider: Provider;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  provider_synced_at: number | null;
  preferred_method: string | null;
  created_at: number;
  updated_at: number;
}

const OPEN_STATUSES: PaymentStatus[] = ['requires_payment_method', 'requires_action'];

export interface PaymentMethodRow {
  id: string;
  merchant_id: string;
  type: 'card' | 'upi' | 'netbanking' | 'wallet' | 'emi' | 'paylater' | 'other';
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  cardholder: string | null;
  fingerprint: string | null;
  encrypted_pan: string | null;
  vpa: string | null;
  upi_flow: 'collect' | 'qr' | null;
  upi_ref: string | null;
  upi_expires_at: number | null;
  bank: string | null;
  wallet: string | null;
  created_at: number;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  reason: string | null;
  /** Simulator refunds succeed at once; Razorpay refunds can be pending for a few days, and occasionally fail. */
  status: 'succeeded' | 'pending' | 'failed';
  provider_refund_id: string | null;
  created_at: number;
}

export interface PayoutRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  destination: string;
  created_at: number;
}

export interface CreatePaymentInput {
  amount: number;
  currency: string;
  capture_method?: 'automatic' | 'manual';
  description?: string;
  metadata?: Record<string, string>;
  return_url?: string;
  /** Which method checkout should open on: the donor's choice on a donation form, for example. */
  preferred_method?: 'card' | 'upi' | 'netbanking' | 'wallet';
}

export type PaymentFilter = 'succeeded' | 'refunded' | 'uncaptured' | 'failed' | 'incomplete' | 'canceled';

const FILTER_SQL: Record<PaymentFilter, string> = {
  succeeded: "status = 'succeeded'",
  refunded: 'amount_refunded > 0',
  uncaptured: "status = 'requires_capture'",
  failed: "status = 'requires_payment_method' AND last_error_code IS NOT NULL",
  incomplete: "status IN ('requires_payment_method', 'requires_action') AND last_error_code IS NULL",
  canceled: "status = 'canceled'",
};

export type UpiStart = { flow: 'collect'; vpa: string } | { flow: 'qr' };

export interface GatewayOptions {
  baseUrl: string;
  /** How long captured funds stay pending before they can be paid out. Real gateways: T+1 to T+3 days. */
  settlementDelaySeconds?: number;
  /** How long a UPI request waits for the payer before it expires. */
  upiExpirySeconds?: number;
  /** Razorpay's API host. Tests point it at a local fake. */
  razorpayApiBase?: string;
  fetchImpl?: typeof fetch;
}

const SIMULATED_BANK_ACCOUNT = 'HDFC Bank •••• 6789 (simulated)';

export class Gateway {
  readonly baseUrl: string;
  readonly settlementDelaySeconds: number;
  readonly upiExpirySeconds: number;
  private readonly razorpayApiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly db: Db,
    private readonly vault: Vault,
    options: GatewayOptions,
  ) {
    this.baseUrl = options.baseUrl;
    this.settlementDelaySeconds = options.settlementDelaySeconds ?? 2 * 24 * 60 * 60;
    this.upiExpirySeconds = options.upiExpirySeconds ?? 5 * 60;
    this.razorpayApiBase = options.razorpayApiBase ?? RAZORPAY_API;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ---------------------------------------------------------------- listeners

  private readonly succeededListeners: ((payment: PaymentRow) => void)[] = [];

  /**
   * Runs `fn` whenever a payment succeeds, inside the same database transaction, so whatever it
   * records (a donation becoming paid, say) commits or rolls back together with the payment.
   */
  onPaymentSucceeded(fn: (payment: PaymentRow) => void): void {
    this.succeededListeners.push(fn);
  }

  private paymentSucceeded(payment: PaymentRow): void {
    for (const fn of this.succeededListeners) fn(payment);
  }

  // ---------------------------------------------------------------- merchants

  /** An account (a streamer). `andThen` runs in the same transaction: it creates their public profile. */
  createMerchant(
    input: { name: string; email: string; password: string },
    andThen?: (merchantId: string) => void,
  ): MerchantRow {
    const merchant: MerchantRow = {
      id: newId('mer'),
      name: input.name,
      email: input.email.toLowerCase(),
      password_hash: hashPassword(input.password),
      provider: 'simulator',
      razorpay_key_id: null,
      razorpay_key_secret: null,
      razorpay_webhook_secret: null,
      created_at: nowSeconds(),
    };
    this.db.transaction(() => {
      if (this.findLoginByEmail(merchant.email)) {
        throw new ApiError(409, 'invalid_request_error', 'email_taken', 'An account with this email already exists.', 'email');
      }
      this.db.run(
        'INSERT INTO merchants (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        merchant.id, merchant.name, merchant.email, merchant.password_hash, merchant.created_at,
      );
      andThen?.(merchant.id);
    });
    return merchant;
  }

  findLoginByEmail(email: string): MerchantRow | undefined {
    return this.db.get<MerchantRow>(
      'SELECT * FROM merchants WHERE email = ? AND password_hash IS NOT NULL', email.toLowerCase(),
    );
  }

  getMerchant(merchantId: string): MerchantRow {
    return this.db.get<MerchantRow>('SELECT * FROM merchants WHERE id = ?', merchantId)!;
  }

  // ------------------------------------------------------- Razorpay connection

  /**
   * Connects the merchant's own Razorpay account. Each merchant brings their own account because
   * collecting money on behalf of other businesses needs an RBI payment aggregator licence.
   * The key secret is checked against Razorpay, then stored encrypted and never returned.
   */
  async connectRazorpay(merchantId: string, input: { key_id: string; key_secret: string; webhook_secret?: string | null }): Promise<MerchantRow> {
    if (input.key_id.startsWith('rzp_live_') && !this.baseUrl.startsWith('https://')) {
      throw new ApiError(400, 'invalid_request_error', 'https_required',
        'Live Razorpay keys need the gateway to be served over HTTPS. Deploy it and set BASE_URL to its https:// address first.', 'key_id');
    }
    try {
      await this.razorpayClient(input.key_id, input.key_secret).verifyCredentials();
    } catch (err) {
      throw toApiError(err);
    }
    this.db.run(
      `UPDATE merchants SET provider = 'razorpay', razorpay_key_id = ?, razorpay_key_secret = ?, razorpay_webhook_secret = ?
        WHERE id = ?`,
      input.key_id, this.vault.encrypt(input.key_secret),
      input.webhook_secret ? this.vault.encrypt(input.webhook_secret) : null, merchantId,
    );
    return this.getMerchant(merchantId);
  }

  /** New payments use the simulator again. Razorpay payments already made can't be refunded until you reconnect. */
  disconnectRazorpay(merchantId: string): MerchantRow {
    this.db.run(
      `UPDATE merchants SET provider = 'simulator', razorpay_key_id = NULL, razorpay_key_secret = NULL, razorpay_webhook_secret = NULL
        WHERE id = ?`,
      merchantId,
    );
    return this.getMerchant(merchantId);
  }

  razorpayWebhookUrl(merchantId: string): string {
    return `${this.baseUrl}/webhooks/razorpay/${merchantId}`;
  }

  private razorpayClient(keyId: string, keySecret: string): RazorpayClient {
    return new RazorpayClient(keyId, keySecret, this.razorpayApiBase, this.fetchImpl);
  }

  private razorpayFor(merchant: MerchantRow): RazorpayClient {
    if (!merchant.razorpay_key_id || !merchant.razorpay_key_secret) {
      throw new ApiError(409, 'invalid_request_error', 'razorpay_not_connected',
        'This payment was made through Razorpay, but no Razorpay account is connected. Reconnect it in the dashboard.');
    }
    return this.razorpayClient(merchant.razorpay_key_id, this.vault.decrypt(merchant.razorpay_key_secret));
  }

  // ----------------------------------------------------------------- payments

  async createPayment(merchantId: string, input: CreatePaymentInput): Promise<PaymentRow> {
    const merchant = this.getMerchant(merchantId);
    const id = newId('pay');
    let orderId: string | null = null;
    if (merchant.provider === 'razorpay') {
      // Network call first, outside any database transaction. An order on its own never charges anyone,
      // so if the insert below fails the stray order is harmless.
      try {
        const order = await this.razorpayFor(merchant).createOrder({
          amount: input.amount, currency: input.currency, receipt: id, notes: { gateway_payment_id: id },
        });
        orderId = order.id;
      } catch (err) {
        throw toApiError(err);
      }
    }
    const now = nowSeconds();
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO payments (id, merchant_id, amount, currency, status, capture_method, client_secret,
                               description, metadata, return_url, provider, provider_order_id, preferred_method,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, 'requires_payment_method', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, merchantId, input.amount, input.currency.toLowerCase(), input.capture_method ?? 'automatic',
        `${id}_secret_${newId('cs', 16).slice(3)}`, input.description ?? null,
        JSON.stringify(input.metadata ?? {}), input.return_url ?? null,
        merchant.provider, orderId, input.preferred_method ?? null, now, now,
      );
      const payment = this.getPayment(merchantId, id);
      emitEvent(this.db, merchantId, 'payment.created', this.serializePayment(payment));
      return payment;
    });
  }

  getPayment(merchantId: string, id: string): PaymentRow {
    const payment = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ? AND merchant_id = ?', id, merchantId);
    if (!payment) throw notFound('payment', id);
    return payment;
  }

  listPayments(
    merchantId: string,
    opts: { limit: number; startingAfter?: string; status?: PaymentFilter; query?: string },
  ): { data: PaymentRow[]; has_more: boolean } {
    const where = ['merchant_id = ?'];
    const params: (string | number)[] = [merchantId];
    if (opts.startingAfter) {
      const cursor = this.getPayment(merchantId, opts.startingAfter);
      where.push('(created_at, id) < (?, ?)');
      params.push(cursor.created_at, cursor.id);
    }
    if (opts.status) where.push(FILTER_SQL[opts.status]);
    if (opts.query) {
      where.push("(id = ? OR description LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')");
      const like = `%${opts.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(opts.query, like, like);
    }
    const rows = this.db.all<PaymentRow>(
      `SELECT * FROM payments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params, opts.limit + 1,
    );
    return { data: rows.slice(0, opts.limit), has_more: rows.length > opts.limit };
  }

  /** Looks up a payment for the hosted checkout, which is authorized by the client secret instead of an API key. */
  getPaymentForClient(id: string, clientSecret: string): PaymentRow {
    const payment = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', id);
    if (!payment || !safeEqual(payment.client_secret, clientSecret)) throw notFound('payment', id);
    return payment;
  }

  /** Simulator: card works everywhere; UPI is INR-only and has no separate authorize/capture step. Razorpay chooses its own. */
  paymentMethodTypes(p: PaymentRow): ('card' | 'upi')[] {
    if (p.provider === 'razorpay') return [];
    return p.currency === 'inr' && p.capture_method === 'automatic' ? ['card', 'upi'] : ['card'];
  }

  /** The simulator's own card form and UPI flow don't apply to Razorpay payments. */
  private assertSimulator(p: PaymentRow): void {
    if (p.provider !== 'simulator') {
      throw new ApiError(400, 'invalid_request_error', 'use_razorpay_checkout', 'This payment is paid through Razorpay Checkout.');
    }
  }

  /** Called from the hosted checkout with raw card details (test mode). */
  confirmPayment(id: string, clientSecret: string, card: CardInput): PaymentRow {
    const pan = validateCard(card);
    return this.db.transaction(() => {
      const payment = this.getPaymentForClient(id, clientSecret);
      this.assertSimulator(payment);
      this.assertStatus(payment, ['requires_payment_method'], 'confirm');

      const pmId = newId('pm');
      this.db.run(
        `INSERT INTO payment_methods (id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan, created_at)
         VALUES (?, ?, 'card', ?, ?, ?, ?, ?, ?, ?, ?)`,
        pmId, payment.merchant_id, detectBrand(pan), pan.slice(-4), card.exp_month,
        card.exp_year < 100 ? 2000 + card.exp_year : card.exp_year, card.name ?? null,
        this.vault.fingerprint(pan), this.vault.encrypt(pan), nowSeconds(),
      );
      this.db.run('UPDATE payments SET payment_method_id = ? WHERE id = ?', pmId, payment.id);

      return this.applyAuthorization({ ...payment, payment_method_id: pmId }, authorize(pan, { authenticated: false }));
    });
  }

  /** Result of the (simulated) 3-D Secure challenge page. */
  completeAuthentication(id: string, clientSecret: string, approved: boolean): PaymentRow {
    return this.db.transaction(() => {
      const payment = this.getPaymentForClient(id, clientSecret);
      this.assertStatus(payment, ['requires_action'], 'authenticate');
      const pm = this.paymentMethod(payment.payment_method_id)!;
      if (pm.type !== 'card') throw invalidState('This payment is not waiting for card authentication.');
      if (!approved) {
        return this.applyAuthorization(payment, {
          outcome: 'declined',
          code: 'authentication_failed',
          message: 'The cardholder failed 3-D Secure authentication.',
        });
      }
      return this.applyAuthorization(payment, authorize(this.vault.decrypt(pm.encrypted_pan!), { authenticated: true }));
    });
  }

  // ---------------------------------------------------------------------- UPI

  /**
   * Starts a UPI payment. "collect" sends a request to the payer's UPI ID; "qr" shows a code
   * the payer scans. Either way the payment waits in requires_action until the payer approves.
   */
  startUpiPayment(id: string, clientSecret: string, input: UpiStart): PaymentRow {
    const vpa = input.flow === 'collect' ? validateVpa(input.vpa) : null;
    return this.db.transaction(() => {
      const payment = this.getPaymentForClient(id, clientSecret);
      this.assertSimulator(payment);
      this.assertStatus(payment, ['requires_payment_method'], 'confirm');
      if (!this.paymentMethodTypes(payment).includes('upi')) {
        throw new ApiError(400, 'invalid_request_error', 'payment_method_unavailable',
          'UPI is only available for INR payments with automatic capture.');
      }
      const pmId = newId('pm');
      const now = nowSeconds();
      this.db.run(
        `INSERT INTO payment_methods (id, merchant_id, type, vpa, upi_flow, upi_ref, upi_expires_at, created_at)
         VALUES (?, ?, 'upi', ?, ?, ?, ?, ?)`,
        pmId, payment.merchant_id, vpa, input.flow, newId('upi', 10), now + this.upiExpirySeconds, now,
      );
      this.db.run('UPDATE payments SET payment_method_id = ? WHERE id = ?', pmId, payment.id);
      const withPm = { ...payment, payment_method_id: pmId };

      return this.applyAuthorization(withPm, upiResult(vpa ? sendCollectRequest(vpa) : { outcome: 'pending' }));
    });
  }

  /** What the simulated UPI app shows for a request reference. */
  getUpiRequest(ref: string) {
    const pm = this.db.get<PaymentMethodRow>("SELECT * FROM payment_methods WHERE upi_ref = ? AND type = 'upi'", ref);
    const payment = pm && this.db.get<PaymentRow>('SELECT * FROM payments WHERE payment_method_id = ?', pm.id);
    if (!pm || !payment) throw notFound('UPI request', ref);
    const pending = payment.status === 'requires_action';
    return {
      ref,
      payee: this.getMerchant(payment.merchant_id).name,
      amount: payment.amount,
      currency: payment.currency,
      description: payment.description,
      flow: pm.upi_flow,
      payer_vpa: pm.vpa,
      status: pending && pm.upi_expires_at! <= nowSeconds() ? 'expired' : pending ? 'pending' : payment.status === 'succeeded' ? 'approved' : 'declined',
      expires_at: pm.upi_expires_at,
    };
  }

  /** The payer approves (with their UPI PIN) or declines in the simulated UPI app. */
  completeUpiRequest(ref: string, input: { approve: boolean; pin?: string; payer_vpa?: string }) {
    const result = this.db.transaction(() => {
      const pm = this.db.get<PaymentMethodRow>("SELECT * FROM payment_methods WHERE upi_ref = ? AND type = 'upi'", ref);
      const payment = pm && this.db.get<PaymentRow>('SELECT * FROM payments WHERE payment_method_id = ?', pm.id);
      if (!pm || !payment) throw notFound('UPI request', ref);
      if (payment.status !== 'requires_action') throw invalidState('This UPI request has already been completed.');
      if (pm.upi_expires_at! <= nowSeconds()) {
        this.expireUpi(payment);
        return 'expired' as const;
      }
      if (!input.approve) {
        return this.applyAuthorization(payment, {
          outcome: 'declined', code: 'upi_declined_by_payer', message: 'The payment was declined in the UPI app.',
        });
      }
      // With QR the gateway learns who paid only when the payer's app responds.
      const vpa = pm.vpa ?? validateVpa(input.payer_vpa ?? 'customer@okbank');
      const decision = approveWithPin(vpa, input.pin ?? '');
      if (!pm.vpa) this.db.run('UPDATE payment_methods SET vpa = ? WHERE id = ?', vpa, pm.id);
      return this.applyAuthorization(payment, upiResult(decision));
    });
    if (result === 'expired') throw invalidState('This UPI request has expired.');
    return result;
  }

  /** The customer gave up waiting (e.g. to pay by card instead). */
  cancelUpiAttempt(id: string, clientSecret: string): PaymentRow {
    return this.db.transaction(() => {
      const payment = this.getPaymentForClient(id, clientSecret);
      this.assertStatus(payment, ['requires_action'], 'cancel the UPI request for');
      if (this.paymentMethod(payment.payment_method_id)?.type !== 'upi') {
        throw invalidState('This payment is not waiting for a UPI approval.');
      }
      return this.applyAuthorization(payment, {
        outcome: 'declined', code: 'upi_request_canceled', message: 'The UPI request was canceled.',
      });
    });
  }

  /** Background job: fail UPI requests the payer never answered. Returns how many expired. */
  expireUpiRequests(now = nowSeconds()): number {
    const stale = this.db.all<PaymentRow>(
      `SELECT p.* FROM payments p JOIN payment_methods pm ON pm.id = p.payment_method_id
        WHERE p.status = 'requires_action' AND pm.type = 'upi' AND pm.upi_expires_at <= ?`,
      now,
    );
    for (const payment of stale) {
      try {
        this.db.transaction(() => this.expireUpi(payment));
      } catch (err) {
        // Lost a race with the payer approving at the last second; their outcome wins.
        if (!(err instanceof ApiError)) throw err;
      }
    }
    return stale.length;
  }

  private expireUpi(payment: PaymentRow): PaymentRow {
    return this.applyAuthorization(payment, {
      outcome: 'declined', code: 'upi_request_expired', message: 'The UPI request expired before it was approved.',
    });
  }

  // -------------------------------------------------------- Razorpay payments

  /**
   * The customer finished (or gave up on) Razorpay Checkout. The signature proves the success callback
   * came from Razorpay, but the payment is recorded only from what Razorpay's API says, never from the browser.
   */
  async completeRazorpayCheckout(
    id: string, clientSecret: string, result: { razorpay_payment_id: string; razorpay_signature: string } | null,
  ): Promise<PaymentRow> {
    const payment = this.getPaymentForClient(id, clientSecret);
    if (payment.provider !== 'razorpay') throw invalidState('This payment is not paid through Razorpay.');
    if (result) {
      const merchant = this.getMerchant(payment.merchant_id);
      const secret = merchant.razorpay_key_secret && this.vault.decrypt(merchant.razorpay_key_secret);
      if (!secret || !verifyCheckoutSignature(payment.provider_order_id!, result.razorpay_payment_id, result.razorpay_signature, secret)) {
        throw new ApiError(400, 'invalid_request_error', 'invalid_signature', "The payment confirmation couldn't be verified.");
      }
    }
    return this.syncRazorpayPayment(payment.id);
  }

  /**
   * Asks Razorpay what happened on this payment's order and records it. Used after Checkout, by the
   * webhook, and by the reconciliation job, so a customer closing the tab at the wrong moment can't
   * leave a paid order unrecorded. Safe to call any number of times.
   */
  async syncRazorpayPayment(paymentId: string): Promise<PaymentRow> {
    const payment = this.paymentById(paymentId);
    if (payment.provider !== 'razorpay' || !payment.provider_order_id) return payment;
    this.db.run('UPDATE payments SET provider_synced_at = ? WHERE id = ?', nowSeconds(), paymentId);
    try {
      const client = this.razorpayFor(this.getMerchant(payment.merchant_id));
      const attempts = await client.orderPayments(payment.provider_order_id);
      const paid = attempts.find((a) => a.status === 'authorized' || a.status === 'captured' || a.status === 'refunded');
      if (paid) {
        let rp = await client.fetchPayment(paid.id);
        if (payment.status === 'canceled') {
          // Paid in a checkout tab left open after the merchant canceled. Give the money back.
          // (An authorized payment that is never captured is refunded by Razorpay automatically.)
          if (rp.status === 'captured' && rp.amount_refunded < rp.amount) {
            await client.refund(rp.id, { amount: rp.amount - rp.amount_refunded, receipt: payment.id, notes: { reason: 'payment_canceled' } });
          }
          return this.paymentById(paymentId);
        }
        if (!OPEN_STATUSES.includes(payment.status)) return payment;
        if (rp.status === 'authorized' && payment.capture_method === 'automatic') {
          rp = await client.capture(rp.id, rp.amount, rp.currency);
        }
        return this.db.transaction(() => this.recordRazorpaySuccess(this.paymentById(paymentId), rp));
      }
      const failed = attempts.filter((a) => a.status === 'failed').sort((a, b) => b.created_at - a.created_at)[0];
      if (failed && payment.status === 'requires_payment_method' && payment.provider_payment_id !== failed.id) {
        return this.db.transaction(() => this.recordRazorpayFailure(this.paymentById(paymentId), failed));
      }
      return payment;
    } catch (err) {
      throw toApiError(err);
    }
  }

  private recordRazorpaySuccess(payment: PaymentRow, rp: RazorpayPayment): PaymentRow {
    if (!OPEN_STATUSES.includes(payment.status)) return payment; // another sync got there first
    const pmId = this.recordRazorpayMethod(payment, rp);
    // Razorpay may already have captured it (the account's auto-capture setting), even for manual capture.
    const captured = rp.status !== 'authorized';
    return this.applyAuthorization(
      { ...payment, payment_method_id: pmId, provider_payment_id: rp.id },
      { outcome: 'approved', authCode: '' },
      { captured, fee: rp.fee ?? 0 },
    );
  }

  private recordRazorpayFailure(payment: PaymentRow, rp: RazorpayPayment): PaymentRow {
    if (payment.status !== 'requires_payment_method' || payment.provider_payment_id === rp.id) return payment;
    const pmId = this.recordRazorpayMethod(payment, rp);
    return this.applyAuthorization({ ...payment, payment_method_id: pmId, provider_payment_id: rp.id }, {
      outcome: 'declined',
      code: (rp.error_reason ?? 'payment_failed').toLowerCase(),
      message: rp.error_description ?? 'The payment failed.',
    });
  }

  /** Stores what Razorpay tells us about how the customer paid. Never the card number: Razorpay keeps that. */
  private recordRazorpayMethod(payment: PaymentRow, rp: RazorpayPayment): string {
    const types = ['card', 'upi', 'netbanking', 'wallet', 'emi', 'paylater'];
    const pmId = newId('pm');
    this.db.run(
      `INSERT INTO payment_methods (id, merchant_id, type, brand, last4, cardholder, vpa, bank, wallet, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pmId, payment.merchant_id, types.includes(rp.method) ? rp.method : 'other',
      rp.card ? brandFromNetwork(rp.card.network) : null, rp.card?.last4 ?? null, rp.card?.name ?? null,
      rp.vpa ?? null, rp.bank ?? null, rp.wallet ?? null, nowSeconds(),
    );
    this.db.run('UPDATE payments SET payment_method_id = ?, provider_payment_id = ? WHERE id = ?', pmId, rp.id, payment.id);
    return pmId;
  }

  /** Brings a pending Razorpay refund up to date: processed, or failed (the money goes back to the merchant). */
  async syncRefund(refundId: string): Promise<RefundRow> {
    const refund = this.db.get<RefundRow>('SELECT * FROM refunds WHERE id = ?', refundId)!;
    if (refund.status !== 'pending' || !refund.provider_refund_id) return refund;
    let rr: RazorpayRefund;
    try {
      rr = await this.razorpayFor(this.getMerchant(refund.merchant_id)).fetchRefund(refund.provider_refund_id);
    } catch (err) {
      throw toApiError(err);
    }
    if (rr.status === 'pending') return refund;
    return this.db.transaction(() => {
      const changed = this.db.run("UPDATE refunds SET status = ? WHERE id = ? AND status = 'pending'",
        rr.status === 'processed' ? 'succeeded' : 'failed', refundId);
      const updated = this.db.get<RefundRow>('SELECT * FROM refunds WHERE id = ?', refundId)!;
      if (!changed) return updated;
      if (rr.status === 'failed') {
        this.db.run('UPDATE payments SET amount_refunded = amount_refunded - ?, updated_at = ? WHERE id = ?',
          refund.amount, nowSeconds(), refund.payment_id);
        recordRefundFailed(this.db, { merchantId: refund.merchant_id, refundId, currency: refund.currency, amount: refund.amount });
      }
      emitEvent(this.db, refund.merchant_id, rr.status === 'processed' ? 'refund.succeeded' : 'refund.failed', serializeRefund(updated));
      return updated;
    });
  }

  /**
   * Background job: asks Razorpay about unpaid payments from the last day and pending refunds, oldest
   * check first. This catches anything a missed webhook or a closed browser tab would otherwise lose.
   */
  async reconcileRazorpay(now = nowSeconds(), limit = 20): Promise<void> {
    const payments = this.db.all<{ id: string }>(
      `SELECT id FROM payments
        WHERE provider = 'razorpay' AND status IN ('requires_payment_method', 'requires_action') AND created_at >= ?
        ORDER BY COALESCE(provider_synced_at, 0), created_at LIMIT ?`,
      now - 24 * 60 * 60, limit,
    );
    const refunds = this.db.all<{ id: string }>(
      "SELECT id FROM refunds WHERE status = 'pending' AND provider_refund_id IS NOT NULL ORDER BY created_at LIMIT ?", limit,
    );
    for (const { id } of payments) await this.syncRazorpayPayment(id).catch((err) => console.error(`[razorpay] sync ${id}:`, err.message));
    for (const { id } of refunds) await this.syncRefund(id).catch((err) => console.error(`[razorpay] refund ${id}:`, err.message));
  }

  /** Razorpay's webhook for a merchant. Throws (so Razorpay retries) only if handling failed. */
  async handleRazorpayWebhook(merchantId: string, rawBody: string, signature: string | undefined, eventId: string | undefined): Promise<void> {
    const merchant = this.db.get<MerchantRow>('SELECT * FROM merchants WHERE id = ?', merchantId);
    if (!merchant?.razorpay_webhook_secret) {
      throw new ApiError(404, 'invalid_request_error', 'webhook_not_configured', 'No Razorpay webhook secret is set for this merchant.');
    }
    if (!verifyWebhookSignature(rawBody, signature, this.vault.decrypt(merchant.razorpay_webhook_secret))) {
      throw new ApiError(400, 'invalid_request_error', 'invalid_signature', 'Webhook signature verification failed.');
    }
    if (eventId && this.db.get('SELECT 1 FROM provider_events WHERE id = ?', eventId)) return; // a redelivery
    const event = JSON.parse(rawBody) as {
      event: string;
      payload: { payment?: { entity: RazorpayPayment }; refund?: { entity: RazorpayRefund } };
    };
    if (event.event.startsWith('payment.') || event.event === 'order.paid') {
      const orderId = event.payload.payment?.entity.order_id;
      const payment = orderId
        ? this.db.get<PaymentRow>('SELECT * FROM payments WHERE provider_order_id = ? AND merchant_id = ?', orderId, merchantId)
        : undefined;
      if (payment) await this.syncRazorpayPayment(payment.id);
    } else if (event.event.startsWith('refund.')) {
      const refund = this.db.get<RefundRow>(
        'SELECT * FROM refunds WHERE provider_refund_id = ? AND merchant_id = ?', event.payload.refund?.entity.id ?? '', merchantId,
      );
      if (refund) await this.syncRefund(refund.id);
    }
    // Remember the event only once it was handled, so a failure above makes Razorpay deliver it again.
    if (eventId) {
      this.db.run('INSERT OR IGNORE INTO provider_events (id, merchant_id, type, received_at) VALUES (?, ?, ?, ?)',
        eventId, merchantId, event.event, nowSeconds());
    }
  }

  private paymentById(id: string): PaymentRow {
    const payment = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', id);
    if (!payment) throw notFound('payment', id);
    return payment;
  }

  // ------------------------------------------------------- capture and cancel

  async capturePayment(merchantId: string, id: string, amount?: number): Promise<PaymentRow> {
    const payment = this.getPayment(merchantId, id);
    if (payment.provider === 'razorpay') {
      this.assertStatus(payment, ['requires_capture'], 'capture');
      if (amount !== undefined && amount !== payment.amount_capturable) {
        throw new ApiError(400, 'invalid_request_error', 'partial_capture_unsupported',
          'Razorpay can only capture the full authorized amount.', 'amount');
      }
      let rp: RazorpayPayment;
      try {
        rp = await this.razorpayFor(this.getMerchant(merchantId)).capture(payment.provider_payment_id!, payment.amount_capturable, payment.currency);
      } catch (err) {
        throw toApiError(err);
      }
      return this.db.transaction(() => this.finishCapture(merchantId, id, payment.amount_capturable, rp.fee ?? 0));
    }
    return this.db.transaction(() => this.finishCapture(merchantId, id, amount));
  }

  private finishCapture(merchantId: string, id: string, amount?: number, fee?: number): PaymentRow {
    const payment = this.getPayment(merchantId, id);
    this.assertStatus(payment, ['requires_capture'], 'capture');
    const toCapture = amount ?? payment.amount_capturable;
    if (toCapture > payment.amount_capturable) {
      throw new ApiError(400, 'invalid_request_error', 'amount_too_large',
        `Cannot capture ${toCapture}; only ${payment.amount_capturable} is capturable.`, 'amount');
    }
    // Capturing less than authorized releases the remainder back to the cardholder.
    this.transition(payment, 'succeeded', { amount_capturable: 0, amount_captured: toCapture });
    this.recordCapture(payment, toCapture, fee);
    const updated = this.getPayment(merchantId, id);
    this.paymentSucceeded(updated);
    emitEvent(this.db, merchantId, 'payment.succeeded', this.serializePayment(updated));
    return updated;
  }

  /** For Razorpay, an authorized payment that is never captured is refunded to the customer by Razorpay. */
  cancelPayment(merchantId: string, id: string): PaymentRow {
    return this.db.transaction(() => {
      const payment = this.getPayment(merchantId, id);
      this.assertStatus(payment, ['requires_payment_method', 'requires_action', 'requires_capture'], 'cancel');
      this.transition(payment, 'canceled', { amount_capturable: 0 });
      const updated = this.getPayment(merchantId, id);
      emitEvent(this.db, merchantId, 'payment.canceled', this.serializePayment(updated));
      return updated;
    });
  }

  // ------------------------------------------------------------------ refunds

  async createRefund(merchantId: string, input: { payment: string; amount?: number; reason?: string }): Promise<RefundRow> {
    const payment = this.getPayment(merchantId, input.payment);
    const amount = this.refundableAmount(payment, input.amount);
    const refundId = newId('rf');
    if (payment.provider !== 'razorpay') {
      return this.db.transaction(() => this.recordNewRefund(merchantId, input, refundId, 'succeeded', null));
    }
    // Ask Razorpay first (outside any transaction); it re-checks the refundable amount itself.
    let rr: RazorpayRefund;
    try {
      rr = await this.razorpayFor(this.getMerchant(merchantId)).refund(payment.provider_payment_id!, {
        amount, receipt: refundId, notes: { gateway_refund_id: refundId },
      });
    } catch (err) {
      throw toApiError(err);
    }
    const status = rr.status === 'processed' ? 'succeeded' : rr.status === 'failed' ? 'failed' : 'pending';
    return this.db.transaction(() => this.recordNewRefund(merchantId, { ...input, amount }, refundId, status, rr.id));
  }

  private refundableAmount(payment: PaymentRow, requested?: number): number {
    if (payment.status !== 'succeeded') {
      throw invalidState(`Payment ${payment.id} has status '${payment.status}' and cannot be refunded.`);
    }
    const refundable = payment.amount_captured - payment.amount_refunded;
    const amount = requested ?? refundable;
    if (refundable === 0) throw invalidState(`Payment ${payment.id} has already been fully refunded.`);
    if (amount > refundable) {
      throw new ApiError(400, 'invalid_request_error', 'amount_too_large',
        `Refund amount ${amount} is greater than the refundable amount ${refundable}.`, 'amount');
    }
    return amount;
  }

  private recordNewRefund(
    merchantId: string, input: { payment: string; amount?: number; reason?: string }, id: string,
    status: RefundRow['status'], providerRefundId: string | null,
  ): RefundRow {
    const payment = this.getPayment(merchantId, input.payment);
    const amount = this.refundableAmount(payment, input.amount);
    const refund: RefundRow = {
      id,
      payment_id: payment.id,
      merchant_id: merchantId,
      amount,
      currency: payment.currency,
      reason: input.reason ?? null,
      status,
      provider_refund_id: providerRefundId,
      created_at: nowSeconds(),
    };
    this.db.run(
      `INSERT INTO refunds (id, payment_id, merchant_id, amount, currency, reason, status, provider_refund_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      refund.id, refund.payment_id, merchantId, refund.amount, refund.currency, refund.reason, refund.status,
      providerRefundId, refund.created_at,
    );
    if (status === 'failed') {
      emitEvent(this.db, merchantId, 'refund.failed', serializeRefund(refund));
      return refund;
    }
    // Guarded update: never let concurrent refunds exceed what was captured.
    const changed = this.db.run(
      `UPDATE payments SET amount_refunded = amount_refunded + ?, updated_at = ?
        WHERE id = ? AND amount_refunded + ? <= amount_captured`,
      amount, nowSeconds(), payment.id, amount,
    );
    if (changed !== 1) throw invalidState('Refund would exceed the captured amount.');
    // A pending refund is already committed, so it leaves the balance now; a failure puts it back.
    recordRefund(this.db, { merchantId, refundId: refund.id, currency: refund.currency, amount });
    emitEvent(this.db, merchantId, status === 'succeeded' ? 'refund.succeeded' : 'refund.pending', serializeRefund(refund));
    return refund;
  }

  listRefundsForPayment(merchantId: string, paymentId: string): RefundRow[] {
    return this.db.all<RefundRow>(
      'SELECT * FROM refunds WHERE merchant_id = ? AND payment_id = ? ORDER BY created_at DESC, rowid DESC',
      merchantId, paymentId,
    );
  }

  // ------------------------------------------------------- balance and payouts

  getBalance(merchantId: string) {
    return { object: 'balance', balances: merchantBalances(this.db, merchantId) };
  }

  listBalanceTransactions(merchantId: string, limit: number): BalanceTransactionRow[] {
    return this.db.all<BalanceTransactionRow>(
      'SELECT * FROM balance_transactions WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      merchantId, limit,
    );
  }

  /** Sends available funds to the merchant's bank account. Defaults to the whole available balance. */
  createPayout(merchantId: string, input: { amount?: number; currency?: string }): PayoutRow {
    if (this.getMerchant(merchantId).provider === 'razorpay') {
      throw new ApiError(400, 'invalid_request_error', 'payouts_by_razorpay',
        'Razorpay settles your money to your bank account itself (usually 2 working days after capture). See Settlements in your Razorpay Dashboard.');
    }
    return this.db.transaction(() => {
      const currency = (input.currency ?? 'inr').toLowerCase();
      const available = merchantBalances(this.db, merchantId).find((b) => b.currency === currency)?.available ?? 0;
      const amount = input.amount ?? available;
      if (amount <= 0) {
        throw new ApiError(400, 'invalid_request_error', 'balance_insufficient', `You have no available ${currency.toUpperCase()} balance to pay out.`);
      }
      if (amount > available) {
        throw new ApiError(400, 'invalid_request_error', 'balance_insufficient',
          `Payout amount ${amount} is greater than the available balance ${available}.`, 'amount');
      }
      const payout: PayoutRow = {
        id: newId('po'),
        merchant_id: merchantId,
        amount,
        currency,
        // A real gateway would send a bank transfer (IMPS/NEFT) and mark it paid when the bank confirms.
        status: 'paid',
        destination: SIMULATED_BANK_ACCOUNT,
        created_at: nowSeconds(),
      };
      this.db.run(
        'INSERT INTO payouts (id, merchant_id, amount, currency, status, destination, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        payout.id, merchantId, amount, currency, payout.status, payout.destination, payout.created_at,
      );
      recordPayout(this.db, { merchantId, payoutId: payout.id, currency, amount });
      emitEvent(this.db, merchantId, 'payout.paid', serializePayout(payout));
      return payout;
    });
  }

  listPayouts(merchantId: string, limit: number): PayoutRow[] {
    return this.db.all<PayoutRow>(
      'SELECT * FROM payouts WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', merchantId, limit,
    );
  }

  // ------------------------------------------------------------ serialization

  checkoutUrl(payment: PaymentRow): string {
    return `${this.baseUrl}/checkout/${payment.id}?client_secret=${payment.client_secret}`;
  }

  upiAppUrl(ref: string): string {
    return `${this.baseUrl}/upi-app/${ref}`;
  }

  serializePayment(p: PaymentRow) {
    const pm = this.paymentMethod(p.payment_method_id);
    const bt = this.db.get<{ fee: number; net: number }>(
      "SELECT fee, net FROM balance_transactions WHERE type = 'payment' AND source_id = ?", p.id,
    );
    return {
      id: p.id,
      object: 'payment',
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      capture_method: p.capture_method,
      amount_capturable: p.amount_capturable,
      amount_captured: p.amount_captured,
      amount_refunded: p.amount_refunded,
      fee: bt?.fee ?? null,
      net: bt?.net ?? null,
      client_secret: p.client_secret,
      checkout_url: this.checkoutUrl(p),
      description: p.description,
      metadata: JSON.parse(p.metadata),
      return_url: p.return_url,
      provider: p.provider,
      razorpay: p.provider === 'razorpay' ? { order_id: p.provider_order_id, payment_id: p.provider_payment_id } : null,
      payment_method: pm ? serializePaymentMethod(pm) : null,
      last_error: p.last_error_code ? { code: p.last_error_code, message: p.last_error_message } : null,
      next_action: p.status === 'requires_action' && pm ? this.nextAction(p, pm) : null,
      created: p.created_at,
      updated: p.updated_at,
    };
  }

  /** The subset the hosted checkout page may see. */
  serializeForClient(p: PaymentRow) {
    const full = this.serializePayment(p);
    const merchant = this.getMerchant(p.merchant_id);
    return {
      id: full.id,
      merchant_name: merchant.name,
      provider: p.provider,
      // What the page needs to open Razorpay Checkout. The key id is public by design; the secret never leaves the server.
      razorpay: p.provider === 'razorpay' && p.status === 'requires_payment_method'
        ? {
            key_id: merchant.razorpay_key_id,
            order_id: p.provider_order_id,
            checkout_js: RAZORPAY_CHECKOUT_JS,
            prefill: { method: p.preferred_method ?? undefined },
          }
        : null,
      amount: full.amount,
      currency: full.currency,
      status: full.status,
      description: full.description,
      return_url: full.return_url,
      payment_method_types: this.paymentMethodTypes(p),
      preferred_method: p.preferred_method,
      payment_method: full.payment_method,
      last_error: full.last_error,
      next_action: full.next_action,
    };
  }

  // ------------------------------------------------------------------ helpers

  private paymentMethod(id: string | null): PaymentMethodRow | undefined {
    return id ? this.db.get<PaymentMethodRow>('SELECT * FROM payment_methods WHERE id = ?', id) : undefined;
  }

  private nextAction(p: PaymentRow, pm: PaymentMethodRow) {
    if (pm.type === 'card') {
      return { type: 'redirect_to_url', url: `${this.baseUrl}/3ds/${p.id}?client_secret=${p.client_secret}` };
    }
    const common = {
      expires_at: pm.upi_expires_at,
      // Test mode only: where to approve the request, standing in for the payer's phone.
      simulator_url: this.upiAppUrl(pm.upi_ref!),
    };
    return pm.upi_flow === 'collect'
      ? { type: 'upi_collect', vpa: pm.vpa, ...common }
      : { type: 'upi_qr', qr_code_svg_url: `${this.baseUrl}/checkout-api/upi-qr/${pm.upi_ref}.svg`, ...common };
  }

  /** `fee` is the processor's actual fee (Razorpay reports it); otherwise the simulator's price list applies. */
  private recordCapture(payment: PaymentRow, captured: number, fee?: number): void {
    const pm = this.paymentMethod(payment.payment_method_id)!;
    recordPaymentCaptured(this.db, {
      merchantId: payment.merchant_id,
      paymentId: payment.id,
      currency: payment.currency,
      captured,
      fee: fee ?? feeFor(pm.type, captured),
      settlementDelaySeconds: this.settlementDelaySeconds,
    });
  }

  /**
   * Moves a payment on after an authorization attempt. `captured` overrides the payment's capture method
   * (the processor may already have captured it), and `fee` is the processor's actual fee.
   */
  private applyAuthorization(payment: PaymentRow, result: AuthorizationResult, opts: { captured?: boolean; fee?: number } = {}): PaymentRow {
    const clearError = { last_error_code: null, last_error_message: null };
    switch (result.outcome) {
      case 'requires_authentication':
        this.transition(payment, 'requires_action', clearError);
        break;
      case 'declined':
        this.transition(payment, 'requires_payment_method', {
          last_error_code: result.code,
          last_error_message: result.message,
        });
        break;
      case 'approved':
        if (opts.captured ?? payment.capture_method === 'automatic') {
          this.transition(payment, 'succeeded', { ...clearError, amount_captured: payment.amount });
          this.recordCapture(payment, payment.amount, opts.fee);
        } else {
          this.transition(payment, 'requires_capture', { ...clearError, amount_capturable: payment.amount });
        }
        break;
    }
    const updated = this.getPayment(payment.merchant_id, payment.id);
    if (updated.status === 'succeeded') this.paymentSucceeded(updated);
    const eventType = {
      requires_authentication: 'payment.requires_action',
      declined: 'payment.failed',
      approved: updated.status === 'succeeded' ? 'payment.succeeded' : 'payment.authorized',
    } as const;
    emitEvent(this.db, payment.merchant_id, eventType[result.outcome], this.serializePayment(updated));
    return updated;
  }

  /** Compare-and-set on status so a stale read can never move a payment backwards. */
  private transition(payment: PaymentRow, to: PaymentStatus, fields: Partial<Record<keyof PaymentRow, string | number | null>> = {}): void {
    const entries = Object.entries(fields);
    const sets = ['status = ?', 'updated_at = ?', ...entries.map(([k]) => `${k} = ?`)].join(', ');
    const changed = this.db.run(
      `UPDATE payments SET ${sets} WHERE id = ? AND status = ?`,
      to, nowSeconds(), ...entries.map(([, v]) => v as string | number | null), payment.id, payment.status,
    );
    if (changed !== 1) throw invalidState(`Payment ${payment.id} changed concurrently; retry the request.`);
  }

  private assertStatus(payment: PaymentRow, allowed: PaymentStatus[], action: string): void {
    if (!allowed.includes(payment.status)) {
      throw invalidState(`You cannot ${action} this payment because it has a status of '${payment.status}'.`);
    }
  }
}

/** UPI outcomes map onto the same state machine as cards: "pending" is the payer-approval step. */
function upiResult(d: UpiDecision): AuthorizationResult {
  if (d.outcome === 'pending') return { outcome: 'requires_authentication' };
  if (d.outcome === 'approved') return { outcome: 'approved', authCode: '' };
  return d;
}

function serializePaymentMethod(pm: PaymentMethodRow) {
  if (pm.type !== 'card' && pm.type !== 'upi') {
    return { id: pm.id, object: 'payment_method', type: pm.type, bank: pm.bank, wallet: pm.wallet, created: pm.created_at };
  }
  if (pm.type === 'upi') {
    return { id: pm.id, object: 'payment_method', type: 'upi' as const, upi: { vpa: pm.vpa, flow: pm.upi_flow } };
  }
  return {
    id: pm.id,
    object: 'payment_method',
    type: 'card' as const,
    card: { brand: pm.brand, last4: pm.last4, exp_month: pm.exp_month, exp_year: pm.exp_year, fingerprint: pm.fingerprint },
    created: pm.created_at,
  };
}

export const serializeRefund = (r: RefundRow) => ({
  id: r.id,
  object: 'refund',
  payment: r.payment_id,
  amount: r.amount,
  currency: r.currency,
  reason: r.reason,
  status: r.status,
  created: r.created_at,
});

export const serializePayout = (p: PayoutRow) => ({
  id: p.id,
  object: 'payout',
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  destination: p.destination,
  created: p.created_at,
});

export const serializeMerchant = (m: MerchantRow) => ({
  id: m.id,
  object: 'merchant',
  name: m.name,
  email: m.email,
  provider: m.provider,
  // Never the Razorpay secrets: only which key is connected.
  razorpay: m.razorpay_key_id
    ? { key_id: m.razorpay_key_id, mode: m.razorpay_key_id.startsWith('rzp_live_') ? 'live' : 'test', webhook_configured: Boolean(m.razorpay_webhook_secret) }
    : null,
  created: m.created_at,
});

function toApiError(err: unknown): unknown {
  return err instanceof RazorpayError ? err.toApiError() : err;
}


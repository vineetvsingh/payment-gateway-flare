import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { safeEqual } from '../lib/ids.js';

/*
 * A small client for Razorpay's REST API (https://razorpay.com/docs/api/), used when a merchant
 * connects their own Razorpay account. Razorpay is the licensed payment aggregator: it collects the
 * card or UPI details in its own checkout, moves the money, and settles it to the merchant's bank.
 * This gateway keeps the orders, ledger, webhooks and dashboard in step with it.
 */

export const RAZORPAY_API = 'https://api.razorpay.com';
export const RAZORPAY_CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';
const TIMEOUT_MS = 15_000;
/** Waits before retrying a rate-limited request: 1s, then 2s (or what Retry-After asks, up to 10s). */
const RETRY_DELAYS_MS = [1000, 2000];

export interface RazorpayOrder {
  id: string;
  entity: 'order';
  amount: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
}

export interface RazorpayPayment {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string | null;
  method: string;
  captured: boolean;
  amount_refunded: number;
  /** Razorpay's fee including GST, in the smallest currency unit. Set once captured. */
  fee: number | null;
  tax: number | null;
  vpa?: string | null;
  bank?: string | null;
  wallet?: string | null;
  email?: string | null;
  contact?: string | null;
  card?: { last4?: string; network?: string; type?: string; issuer?: string | null; name?: string } | null;
  error_code?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
  created_at: number;
}

export interface RazorpayRefund {
  id: string;
  entity: 'refund';
  amount: number;
  currency: string;
  payment_id: string;
  status: 'pending' | 'processed' | 'failed';
  created_at: number;
}

/** A Razorpay API call failed. `status` is Razorpay's HTTP status (0 when it couldn't be reached). */
export class RazorpayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }

  /** What our API returns: bad credentials and rejected requests are 400s, outages are 502s. */
  toApiError(): ApiError {
    if (this.status === 429) {
      return new ApiError(503, 'api_error', 'razorpay_rate_limited',
        'Razorpay is limiting how fast requests can be made with these API keys. Wait a minute, then try again.');
    }
    if (this.status === 401) {
      return new ApiError(400, 'invalid_request_error', 'razorpay_authentication_failed',
        'Razorpay rejected the API keys. Check the Key ID and Key Secret in Razorpay Dashboard → Account & Settings → API Keys.');
    }
    if (this.status >= 400 && this.status < 500) {
      return new ApiError(400, 'invalid_request_error', 'razorpay_request_rejected', `Razorpay: ${this.message}`);
    }
    return new ApiError(502, 'api_error', 'razorpay_unavailable', `Couldn't reach Razorpay: ${this.message}. Try again.`);
  }
}

export const connectRazorpaySchema = z.object({
  key_id: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, 'must look like rzp_test_... or rzp_live_...'),
  key_secret: z.string().trim().min(8).max(200),
  // The secret you typed when adding the webhook in Razorpay Dashboard. Optional: without it the
  // gateway still finds out about payments by asking Razorpay.
  webhook_secret: z.string().trim().min(1).max(200).nullable().optional(),
});

export class RazorpayClient {
  constructor(
    readonly keyId: string,
    private readonly keySecret: string,
    private readonly baseUrl = RAZORPAY_API,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get mode(): 'test' | 'live' {
    return this.keyId.startsWith('rzp_live_') ? 'live' : 'test';
  }

  /**
   * Retries when Razorpay rate-limits us (HTTP 429). That is safe even for POSTs such as refunds,
   * because a rate-limited request is rejected before Razorpay does anything with it.
   */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, body);
      } catch (err) {
        if (!(err instanceof RazorpayError) || err.status !== 429 || attempt >= RETRY_DELAYS_MS.length) throw err;
        const wait = err.retryAfterSeconds !== undefined
          ? Math.min(err.retryAfterSeconds * 1000, 10_000)
          : RETRY_DELAYS_MS[attempt];
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new RazorpayError(0, 'network_error', err instanceof Error ? err.message : String(err));
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; description?: string } };
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new RazorpayError(res.status, json.error?.code ?? 'error', json.error?.description ?? `HTTP ${res.status}`,
        Number.isFinite(retryAfter) && retryAfter >= 0 && res.headers.has('Retry-After') ? retryAfter : undefined);
    }
    return json as T;
  }

  /** Cheapest authenticated call: proves the key pair works. */
  async verifyCredentials(): Promise<void> {
    await this.request('GET', '/v1/orders?count=1');
  }

  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder> {
    return this.request('POST', '/v1/orders', { ...input, currency: input.currency.toUpperCase() });
  }

  /** Every attempt made against an order: failed ones as well as the one that succeeded. */
  async orderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const res = await this.request<{ items: RazorpayPayment[] }>('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`);
    return res.items;
  }

  /** With the card's network and last 4 digits (never the full number). */
  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.request('GET', `/v1/payments/${encodeURIComponent(paymentId)}?expand[]=card`);
  }

  /** Razorpay only captures the full authorized amount. */
  capture(paymentId: string, amount: number, currency: string): Promise<RazorpayPayment> {
    return this.request('POST', `/v1/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: currency.toUpperCase() });
  }

  refund(paymentId: string, input: { amount: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayRefund> {
    return this.request('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refund`, { ...input, speed: 'normal' });
  }

  fetchRefund(refundId: string): Promise<RazorpayRefund> {
    return this.request('GET', `/v1/refunds/${encodeURIComponent(refundId)}`);
  }
}

const hmac = (secret: string, message: string) => createHmac('sha256', secret).update(message).digest('hex');

/**
 * Razorpay Checkout returns `razorpay_signature` = HMAC-SHA256("<order_id>|<payment_id>", key secret).
 * The order id must be the one we stored, not one sent back by the browser.
 */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  return safeEqual(hmac(keySecret, `${orderId}|${paymentId}`), signature);
}

/** `X-Razorpay-Signature` = HMAC-SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, webhookSecret: string): boolean {
  return Boolean(signature) && safeEqual(hmac(webhookSecret, rawBody), signature!);
}

/** Razorpay's card network names, as our brand names. */
export function brandFromNetwork(network: string | undefined): string {
  const n = (network ?? '').toLowerCase();
  if (n.includes('visa')) return 'visa';
  if (n.includes('master')) return 'mastercard';
  if (n.includes('rupay')) return 'rupay';
  if (n.includes('american') || n === 'amex') return 'amex';
  if (n.includes('diners')) return 'diners';
  return n || 'unknown';
}

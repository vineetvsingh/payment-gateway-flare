import type { Db } from '../db.js';
import { ApiError, invalidState, notFound } from '../lib/errors.js';
import type { Gateway, PaymentRow } from '../payments/gateway.js';
import { newId, nowSeconds } from '../lib/ids.js';
import { AlertHub } from './alerts.js';
import { moderate, parseBlockedWords, spokenText } from './moderation.js';

/*
 * Donations to live streamers.
 *
 *   viewer fills the form -> a payment to the streamer
 *   -> pays on the hosted checkout -> payment succeeds -> donation "paid"
 *   -> alert queued (or held for review) -> AlertHub plays it on the streamer's overlay, one at a time
 *
 * An alert only ever exists for a payment the gateway has confirmed, so nobody can put a message on
 * stream without paying.
 */

export interface ProfileRow {
  merchant_id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  min_amount: number;
  tts_min_amount: number;
  tts_enabled: number;
  moderation: 'auto' | 'manual';
  blocked_words: string;
  alert_seconds: number;
  /** What a donation is called on this channel; the voice says "Rahul sent a Flare." */
  donation_name: string;
  alerts_paused: number;
  overlay_token: string;
  created_at: number;
}

export interface DonationRow {
  id: string;
  streamer_id: string;
  payment_id: string;
  donor_name: string;
  message: string;
  original_message: string;
  flagged: number;
  amount: number;
  currency: string;
  status: 'awaiting_payment' | 'paid';
  alert_status: 'none' | 'pending_review' | 'queued' | 'shown' | 'rejected';
  tts: number;
  queued_at: number | null;
  paid_at: number | null;
  shown_at: number | null;
  created_at: number;
}

export type DonationMethod = 'upi' | 'card' | 'netbanking' | 'wallet';

export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;
export const MAX_DONATION = 10_000_000; // ₹1,00,000
export const MAX_MESSAGE = 200;
export const MAX_NAME = 40;

export interface DonationOptions {
  /** Pause between two alerts. */
  alertGapMs?: number;
  /** Multiplies alert durations; tests use a tiny value. */
  timeScale?: number;
  /** 'closed': only the first account can sign up, for a site that runs one channel. */
  signups?: 'open' | 'closed';
  /**
   * Where OBS and the voice tab load the overlay from, when that differs from the public address:
   * http://localhost:3000 when the site runs on the streaming PC behind a tunnel such as ngrok.
   */
  overlayBaseUrl?: string;
}

export class Donations {
  readonly db: Db;
  readonly hub: AlertHub;
  private readonly signupListeners: ((merchantId: string) => void)[] = [];

  private readonly signupsClosed: boolean;
  private readonly overlayBaseUrl: string | undefined;

  constructor(readonly gateway: Gateway, options: DonationOptions = {}) {
    this.signupsClosed = options.signups === 'closed';
    this.overlayBaseUrl = options.overlayBaseUrl?.replace(/\/$/, '');
    this.db = gateway.db;
    this.hub = new AlertHub(this, options);
    gateway.onPaymentSucceeded((payment) => this.markPaid(payment));
  }

  // ---------------------------------------------------------------- profiles

  /** Creates the streamer's account and their public profile together. */
  signup(input: { name: string; email: string; password: string; handle: string }) {
    if (this.signupsClosed && this.db.get('SELECT 1 FROM profiles LIMIT 1')) {
      throw new ApiError(403, 'invalid_request_error', 'signups_closed', 'Sign-ups are closed on this site. Sign in instead.');
    }
    const merchant = this.gateway.createMerchant(
      { name: input.name, email: input.email, password: input.password },
      (merchantId) => this.createProfile(merchantId, { handle: input.handle, display_name: input.name }),
    );
    for (const fn of this.signupListeners) fn(merchant.id);
    return merchant;
  }

  onSignup(fn: (merchantId: string) => void): void {
    this.signupListeners.push(fn);
  }

  /** The site owner's account: the one with this page name or, without one, the only account there is. */
  ownerProfile(handle?: string): ProfileRow | undefined {
    if (handle) return this.db.get<ProfileRow>('SELECT * FROM profiles WHERE handle = ?', handle.trim().toLowerCase());
    const profiles = this.db.all<ProfileRow>('SELECT * FROM profiles LIMIT 2');
    return profiles.length === 1 ? profiles[0] : undefined;
  }

  private createProfile(merchantId: string, input: { handle: string; display_name: string }): ProfileRow {
    const handle = this.checkHandle(input.handle);
    this.db.run(
      'INSERT INTO profiles (merchant_id, handle, display_name, overlay_token, created_at) VALUES (?, ?, ?, ?, ?)',
      merchantId, handle, input.display_name, newId('ovl', 18), nowSeconds(),
    );
    return this.profileOf(merchantId)!;
  }

  private checkHandle(raw: string, exceptMerchantId?: string): string {
    const handle = raw.trim().toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      throw new ApiError(400, 'invalid_request_error', 'parameter_invalid',
        'Your page name can use 3–30 lowercase letters, numbers and underscores.', 'handle');
    }
    const taken = this.db.get<{ merchant_id: string }>('SELECT merchant_id FROM profiles WHERE handle = ?', handle);
    if (taken && taken.merchant_id !== exceptMerchantId) {
      throw new ApiError(409, 'invalid_request_error', 'handle_taken', `The page name "${handle}" is taken. Try another.`, 'handle');
    }
    return handle;
  }

  profileOf(merchantId: string): ProfileRow | undefined {
    return this.db.get<ProfileRow>('SELECT * FROM profiles WHERE merchant_id = ?', merchantId);
  }

  private profileByHandle(handle: string): ProfileRow {
    const profile = this.db.get<ProfileRow>('SELECT * FROM profiles WHERE handle = ?', handle);
    if (!profile) throw notFound('streamer', handle);
    return profile;
  }

  updateProfile(merchantId: string, input: Partial<{
    handle: string; display_name: string; bio: string | null; min_amount: number; tts_min_amount: number;
    tts_enabled: boolean; moderation: 'auto' | 'manual'; blocked_words: string; alert_seconds: number; donation_name: string;
  }>): ProfileRow {
    const current = this.profileOf(merchantId);
    if (!current) throw notFound('profile', merchantId);
    const next = { ...current };
    if (input.handle !== undefined) next.handle = this.checkHandle(input.handle, merchantId);
    for (const key of ['display_name', 'bio', 'min_amount', 'tts_min_amount', 'moderation', 'blocked_words', 'alert_seconds', 'donation_name'] as const) {
      if (input[key] !== undefined) (next as Record<string, unknown>)[key] = input[key];
    }
    if (input.tts_enabled !== undefined) next.tts_enabled = input.tts_enabled ? 1 : 0;
    this.db.run(
      `UPDATE profiles SET handle = ?, display_name = ?, bio = ?, min_amount = ?, tts_min_amount = ?, tts_enabled = ?,
              moderation = ?, blocked_words = ?, alert_seconds = ?, donation_name = ?
        WHERE merchant_id = ?`,
      next.handle, next.display_name, next.bio, next.min_amount, next.tts_min_amount, next.tts_enabled,
      next.moderation, next.blocked_words, next.alert_seconds, next.donation_name, merchantId,
    );
    return this.profileOf(merchantId)!;
  }

  /** The old overlay links stop working at once. */
  rotateOverlayToken(merchantId: string): ProfileRow {
    this.db.run('UPDATE profiles SET overlay_token = ? WHERE merchant_id = ?', newId('ovl', 18), merchantId);
    this.hub.disconnectAll(merchantId);
    return this.profileOf(merchantId)!;
  }

  setPaused(merchantId: string, paused: boolean): void {
    this.db.run('UPDATE profiles SET alerts_paused = ? WHERE merchant_id = ?', paused ? 1 : 0, merchantId);
    if (!paused) this.hub.poke(merchantId);
  }

  streamerByOverlayToken(token: string): ProfileRow {
    const profile = this.db.get<ProfileRow>('SELECT * FROM profiles WHERE overlay_token = ?', token);
    if (!profile) throw notFound('overlay', token);
    return profile;
  }

  overlayUrls(profile: ProfileRow) {
    const base = `${this.overlayBaseUrl ?? this.gateway.baseUrl}/overlay/${profile.overlay_token}`;
    return { alerts: base, voice: `${base}/voice` };
  }

  /** Payment methods the donation form offers, depending on who processes the streamer's payments. */
  methodsFor(merchantId: string): DonationMethod[] {
    return this.gateway.getMerchant(merchantId).provider === 'razorpay' ? ['upi', 'card', 'netbanking', 'wallet'] : ['upi', 'card'];
  }

  /** What the public donation page shows. */
  publicProfile(handle: string) {
    const p = this.profileByHandle(handle);
    return {
      handle: p.handle,
      display_name: p.display_name,
      bio: p.bio,
      min_amount: p.min_amount,
      max_amount: MAX_DONATION,
      tts_min_amount: p.tts_enabled ? p.tts_min_amount : null,
      max_message: MAX_MESSAGE,
      donation_name: p.donation_name,
      methods: this.methodsFor(p.merchant_id),
      test_mode: !this.isLive(p.merchant_id),
    };
  }

  private isLive(merchantId: string): boolean {
    return Boolean(this.gateway.getMerchant(merchantId).razorpay_key_id?.startsWith('rzp_live_'));
  }

  // ----------------------------------------------------------------- donations

  /** A viewer submitted the donation form. Returns where to send them to pay. */
  async createDonation(handle: string, input: {
    name?: string; amount: number; method: DonationMethod; message?: string;
  }) {
    const profile = this.profileByHandle(handle);
    if (input.amount < profile.min_amount || input.amount > MAX_DONATION) {
      throw new ApiError(400, 'invalid_request_error', 'amount_out_of_range',
        `Donations to ${profile.display_name} can be from ₹${profile.min_amount / 100} to ₹${(MAX_DONATION / 100).toLocaleString('en-IN')}.`, 'amount');
    }
    if (!this.methodsFor(profile.merchant_id).includes(input.method)) {
      throw new ApiError(400, 'invalid_request_error', 'method_unavailable', 'That payment method is not available here.', 'method');
    }
    const name = (input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    const original = (input.message ?? '').trim();
    const nameCheck = moderate(name, parseBlockedWords(profile.blocked_words));
    const messageCheck = moderate(original, parseBlockedWords(profile.blocked_words));

    const id = newId('dn');
    const payment = await this.gateway.createPayment(profile.merchant_id, {
      amount: input.amount,
      currency: 'inr',
      description: `Donation to ${profile.display_name}`,
      metadata: { donation_id: id, streamer: profile.handle },
      return_url: `${this.gateway.baseUrl}/donate/${profile.handle}/thanks/${id}`,
      preferred_method: input.method,
    });
    this.db.run(
      `INSERT INTO donations (id, streamer_id, payment_id, donor_name, message, original_message, flagged, amount, currency,
                              status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inr', 'awaiting_payment', ?)`,
      id, profile.merchant_id, payment.id, nameCheck.text || 'Anonymous',
      messageCheck.text, original, nameCheck.flagged || messageCheck.flagged ? 1 : 0, input.amount, nowSeconds(),
    );
    return { donation_id: id, checkout_url: this.gateway.checkoutUrl(payment) };
  }

  /** Called inside the payment's transaction when it succeeds. */
  private markPaid(payment: PaymentRow): void {
    const donation = this.db.get<DonationRow>("SELECT * FROM donations WHERE payment_id = ? AND status = 'awaiting_payment'", payment.id);
    if (!donation) return;
    const profile = this.profileOf(donation.streamer_id)!;
    const needsReview = profile.moderation === 'manual' || donation.flagged === 1;
    const tts = profile.tts_enabled === 1 && donation.amount >= profile.tts_min_amount && spokenText(donation.message) !== '';
    const now = nowSeconds();
    this.db.run(
      `UPDATE donations SET status = 'paid', paid_at = ?, alert_status = ?, queued_at = ?, tts = ? WHERE id = ?`,
      now, needsReview ? 'pending_review' : 'queued', now, tts ? 1 : 0, donation.id,
    );
    // After the transaction commits. If it rolled back instead, the hub simply finds nothing new.
    setImmediate(() => this.hub.poke(donation.streamer_id));
  }

  /** The thank-you page: enough for the donor to see their donation went through, nothing private. */
  publicDonation(id: string) {
    const d = this.db.get<DonationRow & { payment_status: string; display_name: string; handle: string }>(
      `SELECT d.*, p.status AS payment_status, s.display_name, s.handle
         FROM donations d JOIN payments p ON p.id = d.payment_id JOIN profiles s ON s.merchant_id = d.streamer_id
        WHERE d.id = ?`,
      id,
    );
    if (!d) throw notFound('donation', id);
    return {
      id: d.id,
      status: d.status,
      payment_status: d.payment_status,
      amount: d.amount,
      currency: d.currency,
      donor_name: d.donor_name,
      on_stream: d.alert_status === 'queued' || d.alert_status === 'shown' ? 'yes' : d.alert_status === 'pending_review' ? 'review' : 'no',
      streamer: { handle: d.handle, display_name: d.display_name },
    };
  }

  listDonations(streamerId: string, limit = 100) {
    return this.db.all<DonationRow & { payment_status: string; amount_refunded: number }>(
      `SELECT d.*, p.status AS payment_status, p.amount_refunded FROM donations d JOIN payments p ON p.id = d.payment_id
        WHERE d.streamer_id = ? AND d.status = 'paid' ORDER BY d.paid_at DESC, d.rowid DESC LIMIT ?`,
      streamerId, limit,
    ).map((d) => ({
      id: d.id,
      donor_name: d.donor_name,
      amount: d.amount,
      amount_refunded: d.amount_refunded,
      currency: d.currency,
      message: d.message,
      original_message: d.flagged ? d.original_message : null,
      flagged: d.flagged === 1,
      alert_status: d.alert_status,
      tts: d.tts === 1,
      payment: d.payment_id,
      paid_at: d.paid_at,
      shown_at: d.shown_at,
    }));
  }

  /** Approve a held message, reject it, or replay one that was already shown. */
  moderateDonation(streamerId: string, id: string, action: 'approve' | 'reject' | 'replay'): void {
    const from = { approve: ['pending_review'], reject: ['pending_review', 'queued'], replay: ['shown', 'rejected'] }[action];
    const to = action === 'reject' ? 'rejected' : 'queued';
    const changed = this.db.run(
      `UPDATE donations SET alert_status = ?, queued_at = ?
        WHERE id = ? AND streamer_id = ? AND status = 'paid' AND alert_status IN (${from.map(() => '?').join(', ')})`,
      to, nowSeconds(), id, streamerId, ...from,
    );
    if (!changed) throw invalidState(`This alert can't be ${action === 'replay' ? 'replayed' : `${action}d`} now.`);
    this.hub.poke(streamerId);
  }

  queueStatus(streamerId: string) {
    const counts = this.db.get<{ queued: number; review: number }>(
      `SELECT COALESCE(SUM(alert_status = 'queued'), 0) AS queued, COALESCE(SUM(alert_status = 'pending_review'), 0) AS review
         FROM donations WHERE streamer_id = ?`,
      streamerId,
    )!;
    return {
      ...counts,
      paused: this.profileOf(streamerId)?.alerts_paused === 1,
      overlays_connected: this.hub.clientCount(streamerId),
      now_showing: this.hub.nowShowing(streamerId),
    };
  }

  /** Next alert in line, oldest first, and marks it shown. */
  takeNextAlert(streamerId: string): DonationRow | undefined {
    const next = this.db.get<DonationRow>(
      "SELECT * FROM donations WHERE streamer_id = ? AND alert_status = 'queued' ORDER BY queued_at, rowid LIMIT 1", streamerId,
    );
    if (next) this.db.run("UPDATE donations SET alert_status = 'shown', shown_at = ? WHERE id = ?", nowSeconds(), next.id);
    return next;
  }
}

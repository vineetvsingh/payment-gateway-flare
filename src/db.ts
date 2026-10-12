import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// v1 uses IF NOT EXISTS so databases created before migrations existed upgrade cleanly.
const V1_INITIAL = `
CREATE TABLE IF NOT EXISTS merchants (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL,
  secret_key_hash  TEXT NOT NULL UNIQUE,
  secret_key_last4 TEXT NOT NULL,
  publishable_key  TEXT NOT NULL UNIQUE,
  webhook_url      TEXT,
  webhook_secret   TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  brand         TEXT NOT NULL,
  last4         TEXT NOT NULL,
  exp_month     INTEGER NOT NULL,
  exp_year      INTEGER NOT NULL,
  cardholder    TEXT,
  fingerprint   TEXT NOT NULL,
  encrypted_pan TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  amount             INTEGER NOT NULL,
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL,
  capture_method     TEXT NOT NULL,
  amount_capturable  INTEGER NOT NULL DEFAULT 0,
  amount_captured    INTEGER NOT NULL DEFAULT 0,
  amount_refunded    INTEGER NOT NULL DEFAULT 0,
  client_secret      TEXT NOT NULL,
  payment_method_id  TEXT REFERENCES payment_methods(id),
  description        TEXT,
  metadata           TEXT NOT NULL DEFAULT '{}',
  return_url         TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_merchant_created ON payments(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  amount      INTEGER NOT NULL,
  currency    TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id     TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (merchant_id, key)
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  type        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_merchant_created ON events(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id),
  merchant_id        TEXT NOT NULL REFERENCES merchants(id),
  url                TEXT NOT NULL,
  status             TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    INTEGER NOT NULL,
  last_response_code INTEGER,
  last_error         TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
`;

// v2: generic payment methods (cards + UPI), double-entry ledger, payouts, dashboard logins.
const V2_LEDGER_UPI_DASHBOARD = `
CREATE TABLE payment_methods_v2 (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  type           TEXT NOT NULL CHECK (type IN ('card', 'upi')),
  -- card
  brand          TEXT,
  last4          TEXT,
  exp_month      INTEGER,
  exp_year       INTEGER,
  cardholder     TEXT,
  fingerprint    TEXT,
  encrypted_pan  TEXT,
  -- upi
  vpa            TEXT,
  upi_flow       TEXT CHECK (upi_flow IN ('collect', 'qr')),
  upi_ref        TEXT UNIQUE,
  upi_expires_at INTEGER,
  created_at     INTEGER NOT NULL
);
INSERT INTO payment_methods_v2 (id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan, created_at)
  SELECT id, merchant_id, 'card', brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan, created_at
    FROM payment_methods;
DROP TABLE payment_methods;
ALTER TABLE payment_methods_v2 RENAME TO payment_methods;

-- Double-entry ledger. Every txn_id's debits equal its credits.
CREATE TABLE ledger_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id      TEXT NOT NULL,
  merchant_id TEXT REFERENCES merchants(id),
  account     TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ledger_entries_txn ON ledger_entries(txn_id);
CREATE INDEX ledger_entries_account ON ledger_entries(merchant_id, account, currency);

-- Merchant-facing view of each ledger transaction that moves their balance.
CREATE TABLE balance_transactions (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  type         TEXT NOT NULL CHECK (type IN ('payment', 'refund', 'payout')),
  source_id    TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  fee          INTEGER NOT NULL,
  net          INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  available_on INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX balance_transactions_merchant ON balance_transactions(merchant_id, created_at DESC);
CREATE INDEX balance_transactions_source ON balance_transactions(source_id);

CREATE TABLE payouts (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL,
  status      TEXT NOT NULL,
  destination TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX payouts_merchant ON payouts(merchant_id, created_at DESC);

ALTER TABLE merchants ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX merchants_login_email ON merchants(email) WHERE password_hash IS NOT NULL;

CREATE TABLE dashboard_sessions (
  token_hash  TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  expires_at  INTEGER NOT NULL
);
`;

// v3: customers with saved cards, and card disputes (chargebacks).
const V3_CUSTOMERS_DISPUTES = `
CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  email       TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX customers_merchant ON customers(merchant_id, created_at DESC);

-- A card with a customer_id is saved ("attached") and can be charged again.
ALTER TABLE payment_methods ADD COLUMN customer_id TEXT REFERENCES customers(id);
CREATE INDEX payment_methods_customer ON payment_methods(customer_id);
ALTER TABLE payments ADD COLUMN customer_id TEXT REFERENCES customers(id);
-- Set when the customer ticks "save this card"; the card is attached once the payment is authorized.
ALTER TABLE payments ADD COLUMN save_payment_method INTEGER NOT NULL DEFAULT 0;
CREATE INDEX payments_customer ON payments(customer_id, created_at DESC);

CREATE TABLE disputes (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  payment_id      TEXT NOT NULL UNIQUE REFERENCES payments(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  fee             INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('needs_response', 'under_review', 'won', 'lost')),
  evidence        TEXT NOT NULL DEFAULT '{}',
  evidence_due_by INTEGER NOT NULL,
  submitted_at    INTEGER,
  decision_at     INTEGER,
  closed_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX disputes_merchant ON disputes(merchant_id, created_at DESC);
CREATE INDEX disputes_status ON disputes(status);

-- SQLite can't alter a CHECK constraint, so rebuild balance_transactions to allow the dispute types.
CREATE TABLE balance_transactions_v3 (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  type         TEXT NOT NULL CHECK (type IN ('payment', 'refund', 'payout', 'dispute', 'dispute_reversal')),
  source_id    TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  fee          INTEGER NOT NULL,
  net          INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  available_on INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
INSERT INTO balance_transactions_v3 SELECT * FROM balance_transactions;
DROP TABLE balance_transactions;
ALTER TABLE balance_transactions_v3 RENAME TO balance_transactions;
CREATE INDEX balance_transactions_merchant ON balance_transactions(merchant_id, created_at DESC);
CREATE INDEX balance_transactions_source ON balance_transactions(source_id);
`;

// v4: real payments through the merchant's own Razorpay account.
const V4_RAZORPAY = `
-- Which processor a merchant uses. Their Razorpay key secret and webhook secret are encrypted with VAULT_KEY.
ALTER TABLE merchants ADD COLUMN provider TEXT NOT NULL DEFAULT 'simulator';
ALTER TABLE merchants ADD COLUMN razorpay_key_id TEXT;
ALTER TABLE merchants ADD COLUMN razorpay_key_secret TEXT;
ALTER TABLE merchants ADD COLUMN razorpay_webhook_secret TEXT;

-- The processor is fixed per payment, so switching providers never strands a payment in flight.
ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'simulator';
ALTER TABLE payments ADD COLUMN provider_order_id TEXT;
ALTER TABLE payments ADD COLUMN provider_payment_id TEXT;
-- When the reconciliation job last asked the provider about this payment.
ALTER TABLE payments ADD COLUMN provider_synced_at INTEGER;
CREATE INDEX payments_provider_order ON payments(provider_order_id);
CREATE INDEX payments_provider_open ON payments(provider, status, created_at);

ALTER TABLE refunds ADD COLUMN provider_refund_id TEXT;
CREATE INDEX refunds_provider ON refunds(provider_refund_id);
CREATE INDEX refunds_status ON refunds(status);

-- Webhook event ids already handled, so a redelivered event is applied once.
CREATE TABLE provider_events (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Razorpay also takes netbanking and wallets, so widen the type check (another table rebuild).
CREATE TABLE payment_methods_v4 (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  type           TEXT NOT NULL CHECK (type IN ('card', 'upi', 'netbanking', 'wallet', 'emi', 'paylater', 'other')),
  brand          TEXT,
  last4          TEXT,
  exp_month      INTEGER,
  exp_year       INTEGER,
  cardholder     TEXT,
  fingerprint    TEXT,
  encrypted_pan  TEXT,
  vpa            TEXT,
  upi_flow       TEXT CHECK (upi_flow IN ('collect', 'qr')),
  upi_ref        TEXT UNIQUE,
  upi_expires_at INTEGER,
  created_at     INTEGER NOT NULL,
  customer_id    TEXT REFERENCES customers(id),
  bank           TEXT,
  wallet         TEXT
);
INSERT INTO payment_methods_v4 (id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan,
                                vpa, upi_flow, upi_ref, upi_expires_at, created_at, customer_id)
  SELECT id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan,
         vpa, upi_flow, upi_ref, upi_expires_at, created_at, customer_id
    FROM payment_methods;
DROP TABLE payment_methods;
ALTER TABLE payment_methods_v4 RENAME TO payment_methods;
CREATE INDEX payment_methods_customer ON payment_methods(customer_id);

-- A refund Razorpay couldn't complete puts the money back in the merchant's balance.
CREATE TABLE balance_transactions_v4 (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  type         TEXT NOT NULL CHECK (type IN ('payment', 'refund', 'refund_failure', 'payout', 'dispute', 'dispute_reversal')),
  source_id    TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  fee          INTEGER NOT NULL,
  net          INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  available_on INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
INSERT INTO balance_transactions_v4 SELECT * FROM balance_transactions;
DROP TABLE balance_transactions;
ALTER TABLE balance_transactions_v4 RENAME TO balance_transactions;
CREATE INDEX balance_transactions_merchant ON balance_transactions(merchant_id, created_at DESC);
CREATE INDEX balance_transactions_source ON balance_transactions(source_id);
`;

// v5: donations to live streamers, with on-stream alerts, and charity fundraisers.
const V5_DONATIONS = `
-- 'business' (a shop, like the demo store), 'streamer' or 'charity'.
ALTER TABLE merchants ADD COLUMN kind TEXT NOT NULL DEFAULT 'business';

-- The donor's choice on the donation form, used to open checkout on that method.
ALTER TABLE payments ADD COLUMN preferred_method TEXT;

-- Public profile of a streamer or charity, and a streamer's alert settings.
CREATE TABLE profiles (
  merchant_id         TEXT PRIMARY KEY REFERENCES merchants(id),
  handle              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  bio                 TEXT,
  min_amount          INTEGER NOT NULL DEFAULT 1000,
  tts_min_amount      INTEGER NOT NULL DEFAULT 5000,
  tts_enabled         INTEGER NOT NULL DEFAULT 1,
  moderation          TEXT NOT NULL DEFAULT 'auto' CHECK (moderation IN ('auto', 'manual')),
  blocked_words       TEXT NOT NULL DEFAULT '',
  alert_seconds       INTEGER NOT NULL DEFAULT 8,
  alerts_paused       INTEGER NOT NULL DEFAULT 0,
  -- Secret part of the overlay URLs. Anyone with it can watch the alerts, so it can be rotated.
  overlay_token       TEXT UNIQUE,
  registration_number TEXT,
  website             TEXT,
  created_at          INTEGER NOT NULL
);

-- A charity stream: donations go straight to the charity's own account, never through the streamer.
CREATE TABLE fundraisers (
  id          TEXT PRIMARY KEY,
  streamer_id TEXT NOT NULL REFERENCES merchants(id),
  charity_id  TEXT NOT NULL REFERENCES merchants(id),
  title       TEXT NOT NULL,
  description TEXT,
  goal_amount INTEGER NOT NULL CHECK (goal_amount > 0),
  status      TEXT NOT NULL CHECK (status IN ('pending', 'active', 'declined', 'ended')),
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  ended_at    INTEGER
);
CREATE INDEX fundraisers_streamer ON fundraisers(streamer_id, status);
CREATE INDEX fundraisers_charity ON fundraisers(charity_id, status);

CREATE TABLE donations (
  id               TEXT PRIMARY KEY,
  streamer_id      TEXT NOT NULL REFERENCES merchants(id),
  recipient_id     TEXT NOT NULL REFERENCES merchants(id),
  fundraiser_id    TEXT REFERENCES fundraisers(id),
  payment_id       TEXT NOT NULL UNIQUE REFERENCES payments(id),
  donor_name       TEXT NOT NULL,
  -- What appears on stream, after filtering; the donor's own words are kept for the streamer to review.
  message          TEXT NOT NULL DEFAULT '',
  original_message TEXT NOT NULL DEFAULT '',
  flagged          INTEGER NOT NULL DEFAULT 0,
  amount           INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid')),
  alert_status     TEXT NOT NULL DEFAULT 'none' CHECK (alert_status IN ('none', 'pending_review', 'queued', 'shown', 'rejected')),
  tts              INTEGER NOT NULL DEFAULT 0,
  queued_at        INTEGER,
  paid_at          INTEGER,
  shown_at         INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX donations_streamer ON donations(streamer_id, created_at DESC);
CREATE INDEX donations_queue ON donations(streamer_id, alert_status, queued_at);
CREATE INDEX donations_fundraiser ON donations(fundraiser_id);
`;

// v6: donations only. Drops what the online-shop features used: API keys and idempotency, webhooks
// to merchants' servers, saved cards (customers) and disputes.
const V6_DONATIONS_ONLY = `
DROP TABLE webhook_deliveries;
DROP TABLE idempotency_keys;
DROP TABLE disputes;

CREATE TABLE merchants_v6 (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT NOT NULL,
  password_hash           TEXT,
  kind                    TEXT NOT NULL DEFAULT 'streamer',
  provider                TEXT NOT NULL DEFAULT 'simulator',
  razorpay_key_id         TEXT,
  razorpay_key_secret     TEXT,
  razorpay_webhook_secret TEXT,
  created_at              INTEGER NOT NULL
);
INSERT INTO merchants_v6 (id, name, email, password_hash, kind, provider, razorpay_key_id, razorpay_key_secret,
                          razorpay_webhook_secret, created_at)
  SELECT id, name, email, password_hash, kind, provider, razorpay_key_id, razorpay_key_secret, razorpay_webhook_secret, created_at
    FROM merchants;
DROP TABLE merchants;
ALTER TABLE merchants_v6 RENAME TO merchants;
CREATE UNIQUE INDEX merchants_login_email ON merchants(email) WHERE password_hash IS NOT NULL;

CREATE TABLE payment_methods_v6 (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  type           TEXT NOT NULL CHECK (type IN ('card', 'upi', 'netbanking', 'wallet', 'emi', 'paylater', 'other')),
  brand          TEXT,
  last4          TEXT,
  exp_month      INTEGER,
  exp_year       INTEGER,
  cardholder     TEXT,
  fingerprint    TEXT,
  encrypted_pan  TEXT,
  vpa            TEXT,
  upi_flow       TEXT CHECK (upi_flow IN ('collect', 'qr')),
  upi_ref        TEXT UNIQUE,
  upi_expires_at INTEGER,
  bank           TEXT,
  wallet         TEXT,
  created_at     INTEGER NOT NULL
);
INSERT INTO payment_methods_v6 (id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan,
                                vpa, upi_flow, upi_ref, upi_expires_at, bank, wallet, created_at)
  SELECT id, merchant_id, type, brand, last4, exp_month, exp_year, cardholder, fingerprint, encrypted_pan,
         vpa, upi_flow, upi_ref, upi_expires_at, bank, wallet, created_at
    FROM payment_methods;
DROP TABLE payment_methods;
ALTER TABLE payment_methods_v6 RENAME TO payment_methods;

CREATE TABLE payments_v6 (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  amount              INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  status              TEXT NOT NULL,
  capture_method      TEXT NOT NULL,
  amount_capturable   INTEGER NOT NULL DEFAULT 0,
  amount_captured     INTEGER NOT NULL DEFAULT 0,
  amount_refunded     INTEGER NOT NULL DEFAULT 0,
  client_secret       TEXT NOT NULL,
  payment_method_id   TEXT REFERENCES payment_methods(id),
  description         TEXT,
  metadata            TEXT NOT NULL DEFAULT '{}',
  return_url          TEXT,
  last_error_code     TEXT,
  last_error_message  TEXT,
  provider            TEXT NOT NULL DEFAULT 'simulator',
  provider_order_id   TEXT,
  provider_payment_id TEXT,
  provider_synced_at  INTEGER,
  preferred_method    TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
INSERT INTO payments_v6 (id, merchant_id, amount, currency, status, capture_method, amount_capturable, amount_captured,
                         amount_refunded, client_secret, payment_method_id, description, metadata, return_url,
                         last_error_code, last_error_message, provider, provider_order_id, provider_payment_id,
                         provider_synced_at, preferred_method, created_at, updated_at)
  SELECT id, merchant_id, amount, currency, status, capture_method, amount_capturable, amount_captured,
         amount_refunded, client_secret, payment_method_id, description, metadata, return_url,
         last_error_code, last_error_message, provider, provider_order_id, provider_payment_id,
         provider_synced_at, preferred_method, created_at, updated_at
    FROM payments;
DROP TABLE payments;
ALTER TABLE payments_v6 RENAME TO payments;
CREATE INDEX payments_merchant_created ON payments(merchant_id, created_at DESC);
CREATE INDEX payments_provider_order ON payments(provider_order_id);
CREATE INDEX payments_provider_open ON payments(provider, status, created_at);

DROP TABLE customers;
`;

// v7: no more charity streams. Every account is a streamer, and every donation goes to the streamer.
const V7_NO_CHARITY_STREAMS = `
CREATE TABLE donations_v7 (
  id               TEXT PRIMARY KEY,
  streamer_id      TEXT NOT NULL REFERENCES merchants(id),
  payment_id       TEXT NOT NULL UNIQUE REFERENCES payments(id),
  donor_name       TEXT NOT NULL,
  message          TEXT NOT NULL DEFAULT '',
  original_message TEXT NOT NULL DEFAULT '',
  flagged          INTEGER NOT NULL DEFAULT 0,
  amount           INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid')),
  alert_status     TEXT NOT NULL DEFAULT 'none' CHECK (alert_status IN ('none', 'pending_review', 'queued', 'shown', 'rejected')),
  tts              INTEGER NOT NULL DEFAULT 0,
  queued_at        INTEGER,
  paid_at          INTEGER,
  shown_at         INTEGER,
  created_at       INTEGER NOT NULL
);
INSERT INTO donations_v7 (id, streamer_id, payment_id, donor_name, message, original_message, flagged, amount, currency,
                          status, alert_status, tts, queued_at, paid_at, shown_at, created_at)
  SELECT id, streamer_id, payment_id, donor_name, message, original_message, flagged, amount, currency,
         status, alert_status, tts, queued_at, paid_at, shown_at, created_at
    FROM donations;
DROP TABLE donations;
ALTER TABLE donations_v7 RENAME TO donations;
CREATE INDEX donations_streamer ON donations(streamer_id, created_at DESC);
CREATE INDEX donations_queue ON donations(streamer_id, alert_status, queued_at);
DROP TABLE fundraisers;

-- Former charity accounts become ordinary streamer accounts, so they need overlay links too.
UPDATE profiles SET overlay_token = 'ovl_' || lower(hex(randomblob(18))) WHERE overlay_token IS NULL;
ALTER TABLE profiles DROP COLUMN registration_number;
ALTER TABLE profiles DROP COLUMN website;
ALTER TABLE merchants DROP COLUMN kind;
`;

// v8: what the streamer calls a donation, for the voice: "Rahul sent a Flare."
const V8_DONATION_NAME = `
ALTER TABLE profiles ADD COLUMN donation_name TEXT NOT NULL DEFAULT 'Flare';
`;

export const MIGRATIONS = [
  V1_INITIAL, V2_LEDGER_UPI_DASHBOARD, V3_CUSTOMERS_DISPUTES, V4_RAZORPAY, V5_DONATIONS, V6_DONATIONS_ONLY, V7_NO_CHARITY_STREAMS,
  V8_DONATION_NAME,
];

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    try {
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (err) {
      this.raw.close();
      throw err;
    }
  }

  /** Applies pending migrations; PRAGMA user_version records how many have run. */
  private migrate(): void {
    const { user_version: version } = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version >= MIGRATIONS.length) {
      this.raw.exec('PRAGMA foreign_keys = ON');
      return;
    }
    // SQLite's procedure for rebuilding tables: foreign keys off (node:sqlite turns them on by
    // default, and this pragma is ignored inside a transaction), migrate, then verify integrity.
    this.raw.exec('PRAGMA foreign_keys = OFF');
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]);
        const violations = this.raw.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Migration ${v + 1} broke foreign keys: ${JSON.stringify(violations)}`);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
    this.raw.exec('PRAGMA foreign_keys = ON');
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as unknown as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as unknown as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.raw.prepare(sql).run(...params).changes);
  }

  /** Runs fn inside a write transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

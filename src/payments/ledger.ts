import type { Db } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { newId, nowSeconds } from '../lib/ids.js';

/*
 * Double-entry ledger. Each money movement is one ledger transaction whose debits equal its credits,
 * so money is never created or destroyed, only moved between accounts:
 *
 *   account               kind       meaning
 *   processor_receivable  asset      owed to the gateway by the card network / UPI switch
 *   merchant_balance      liability  owed by the gateway to a merchant (one per merchant)
 *   fee_revenue           income     the gateway's fees
 *   payout_clearing       asset      money sent out to merchants' bank accounts
 *
 *   payment captured   debit processor_receivable  credit merchant_balance (net) + fee_revenue (fee)
 *   refund             debit merchant_balance      credit processor_receivable
 *   refund failed      debit processor_receivable  credit merchant_balance (the refund never reached the customer)
 *   payout             debit merchant_balance      credit payout_clearing
 */
export type Account = 'processor_receivable' | 'merchant_balance' | 'fee_revenue' | 'payout_clearing';

interface Entry {
  account: Account;
  direction: 'debit' | 'credit';
  amount: number;
}

export interface BalanceTransactionRow {
  id: string;
  merchant_id: string;
  type: 'payment' | 'refund' | 'refund_failure' | 'payout';
  source_id: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  available_on: number;
  created_at: number;
}

/** Simulator fees. Card: 2%. UPI: 0%, since India mandates zero MDR on UPI merchant payments. Razorpay reports its own fee. */
export function feeFor(methodType: string, amount: number): number {
  return methodType === 'upi' ? 0 : Math.round(amount * 0.02);
}

function post(db: Db, merchantId: string, currency: string, entries: Entry[]): string {
  const nonZero = entries.filter((e) => e.amount > 0);
  const sum = (d: Entry['direction']) => nonZero.filter((e) => e.direction === d).reduce((s, e) => s + e.amount, 0);
  if (sum('debit') !== sum('credit')) {
    throw new ApiError(500, 'api_error', 'ledger_unbalanced', `Ledger transaction does not balance: ${JSON.stringify(entries)}`);
  }
  const txnId = newId('txn');
  const now = nowSeconds();
  for (const e of nonZero) {
    // Gateway-level accounts are still tagged with the merchant, which makes per-merchant audits easy.
    db.run(
      `INSERT INTO ledger_entries (txn_id, merchant_id, account, direction, amount, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      txnId, merchantId, e.account, e.direction, e.amount, currency, now,
    );
  }
  return txnId;
}

function record(db: Db, bt: Omit<BalanceTransactionRow, 'created_at'>): BalanceTransactionRow {
  const row = { ...bt, created_at: nowSeconds() };
  db.run(
    `INSERT INTO balance_transactions (id, merchant_id, type, source_id, amount, fee, net, currency, available_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.merchant_id, row.type, row.source_id, row.amount, row.fee, row.net, row.currency, row.available_on, row.created_at,
  );
  return row;
}

export function recordPaymentCaptured(
  db: Db,
  p: { merchantId: string; paymentId: string; currency: string; captured: number; fee: number; settlementDelaySeconds: number },
): void {
  const net = p.captured - p.fee;
  const id = post(db, p.merchantId, p.currency, [
    { account: 'processor_receivable', direction: 'debit', amount: p.captured },
    { account: 'merchant_balance', direction: 'credit', amount: net },
    { account: 'fee_revenue', direction: 'credit', amount: p.fee },
  ]);
  record(db, {
    id, merchant_id: p.merchantId, type: 'payment', source_id: p.paymentId, amount: p.captured, fee: p.fee, net,
    currency: p.currency, available_on: nowSeconds() + p.settlementDelaySeconds,
  });
}

/** Refunds come out of the merchant's balance immediately; the original fee is not returned. */
export function recordRefund(db: Db, r: { merchantId: string; refundId: string; currency: string; amount: number }): void {
  const id = post(db, r.merchantId, r.currency, [
    { account: 'merchant_balance', direction: 'debit', amount: r.amount },
    { account: 'processor_receivable', direction: 'credit', amount: r.amount },
  ]);
  record(db, {
    id, merchant_id: r.merchantId, type: 'refund', source_id: r.refundId, amount: -r.amount, fee: 0, net: -r.amount,
    currency: r.currency, available_on: nowSeconds(),
  });
}

/** The processor couldn't complete a refund, so the money is back in the merchant's balance. */
export function recordRefundFailed(db: Db, r: { merchantId: string; refundId: string; currency: string; amount: number }): void {
  const id = post(db, r.merchantId, r.currency, [
    { account: 'processor_receivable', direction: 'debit', amount: r.amount },
    { account: 'merchant_balance', direction: 'credit', amount: r.amount },
  ]);
  record(db, {
    id, merchant_id: r.merchantId, type: 'refund_failure', source_id: r.refundId, amount: r.amount, fee: 0, net: r.amount,
    currency: r.currency, available_on: nowSeconds(),
  });
}

export function recordPayout(db: Db, p: { merchantId: string; payoutId: string; currency: string; amount: number }): void {
  const id = post(db, p.merchantId, p.currency, [
    { account: 'merchant_balance', direction: 'debit', amount: p.amount },
    { account: 'payout_clearing', direction: 'credit', amount: p.amount },
  ]);
  record(db, {
    id, merchant_id: p.merchantId, type: 'payout', source_id: p.payoutId, amount: -p.amount, fee: 0, net: -p.amount,
    currency: p.currency, available_on: nowSeconds(),
  });
}

export interface Balance {
  currency: string;
  available: number;
  pending: number;
}

/** Available = settled funds that can be paid out; pending = captured but still inside the settlement delay. */
export function merchantBalances(db: Db, merchantId: string, now = nowSeconds()): Balance[] {
  return db.all<Balance>(
    `SELECT currency,
            COALESCE(SUM(CASE WHEN available_on <= ? THEN net END), 0) AS available,
            COALESCE(SUM(CASE WHEN available_on >  ? THEN net END), 0) AS pending
       FROM balance_transactions WHERE merchant_id = ?
      GROUP BY currency ORDER BY currency`,
    now, now, merchantId,
  );
}

export const serializeBalanceTransaction = (b: BalanceTransactionRow) => ({
  id: b.id,
  object: 'balance_transaction',
  type: b.type,
  source: b.source_id,
  amount: b.amount,
  fee: b.fee,
  net: b.net,
  currency: b.currency,
  available_on: b.available_on,
  created: b.created_at,
});

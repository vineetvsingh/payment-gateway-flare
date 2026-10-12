import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Db, MIGRATIONS } from '../src/db.js';

describe('migrations', () => {
  it('upgrades a database created before migrations existed, keeping its data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-migrate-'));
    const file = path.join(dir, 'old.db');
    try {
      // What the first version of the gateway left on disk: v1 tables, user_version still 0.
      const old = new DatabaseSync(file);
      old.exec(MIGRATIONS[0]);
      old.exec(`
        INSERT INTO merchants VALUES ('mer_1', 'Old Shop', 'o@shop.test', 'hash', 'abcd', 'pk_1', NULL, 'whsec_1', 1);
        INSERT INTO payment_methods VALUES ('pm_1', 'mer_1', 'visa', '4242', 12, 2030, NULL, 'fp', 'sealed', 1);
        INSERT INTO payments (id, merchant_id, amount, currency, status, capture_method, client_secret, payment_method_id, created_at, updated_at)
          VALUES ('pay_1', 'mer_1', 500, 'inr', 'succeeded', 'automatic', 'cs', 'pm_1', 1, 1);
      `);
      old.close();

      const db = new Db(file);
      assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, MIGRATIONS.length);
      const pm = db.get<Record<string, unknown>>('SELECT type, brand, last4, vpa FROM payment_methods WHERE id = ?', 'pm_1');
      assert.deepEqual({ ...pm }, { type: 'card', brand: 'visa', last4: '4242', vpa: null });
      assert.equal(db.get<{ id: string }>('SELECT payment_method_id AS id FROM payments')!.id, 'pm_1');
      assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
      // v6 removed the online-shop features: their tables and columns are gone, the data is kept.
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
      for (const gone of ['customers', 'disputes', 'webhook_deliveries', 'idempotency_keys']) assert.ok(!tables.includes(gone), gone);
      const merchantColumns = db.all<{ name: string }>('PRAGMA table_info(merchants)').map((c) => c.name);
      assert.ok(!merchantColumns.includes('secret_key_hash') && !merchantColumns.includes('webhook_url'));
      assert.equal(db.get<{ name: string }>("SELECT name FROM merchants WHERE id = 'mer_1'")!.name, 'Old Shop');
      db.close();

      // Opening again is a no-op, and foreign keys are enforced afterwards.
      const reopened = new Db(file);
      assert.equal(reopened.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys, 1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps balance history when v3 rebuilds balance_transactions', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gw-migrate-'));
    const file = path.join(dir, 'v2.db');
    try {
      const old = new DatabaseSync(file);
      old.exec('PRAGMA foreign_keys = OFF');
      old.exec(MIGRATIONS[0]);
      old.exec(MIGRATIONS[1]);
      old.exec(`
        PRAGMA user_version = 2;
        INSERT INTO merchants (id, name, email, secret_key_hash, secret_key_last4, publishable_key, webhook_secret, created_at)
          VALUES ('mer_1', 'Shop', 's@shop.test', 'hash', 'abcd', 'pk_1', 'whsec_1', 1);
        INSERT INTO balance_transactions VALUES ('txn_1', 'mer_1', 'payment', 'pay_1', 1000, 20, 980, 'inr', 5, 1);
      `);
      old.close();

      const db = new Db(file);
      assert.deepEqual({ ...db.get<Record<string, unknown>>('SELECT id, net FROM balance_transactions') }, { id: 'txn_1', net: 980 });
      // The rebuilt table accepts the new dispute types.
      db.run(`INSERT INTO balance_transactions VALUES ('txn_2', 'mer_1', 'dispute', 'dp_1', -1000, 250, -1250, 'inr', 5, 2)`);
      assert.ok(db.all("SELECT name FROM sqlite_master WHERE name = 'balance_transactions_source'").length);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

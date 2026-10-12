import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { detectBrand, luhnValid, validateCard } from '../src/payments/card.js';
import { TEST_CARDS } from '../src/payments/processor.js';
import { Vault } from '../src/payments/vault.js';

describe('card validation', () => {
  it('accepts every documented test card', () => {
    for (const number of Object.keys(TEST_CARDS)) assert.ok(luhnValid(number), number);
  });

  it('detects brands', () => {
    assert.equal(detectBrand('4242424242424242'), 'visa');
    assert.equal(detectBrand('5555555555554444'), 'mastercard');
    assert.equal(detectBrand('2223003122003222'), 'mastercard');
    assert.equal(detectBrand('378282246310005'), 'amex');
    assert.equal(detectBrand('6080000000000018'), 'rupay');
  });

  it('requires a 4-digit CVC for Amex', () => {
    const exp = { exp_month: 1, exp_year: 2099 };
    assert.throws(() => validateCard({ number: '378282246310005', cvc: '123', ...exp }), /security code/);
    assert.equal(validateCard({ number: '3782 8224 6310 005', cvc: '1234', ...exp }), '378282246310005');
  });

  it('treats the current month as not yet expired', () => {
    const now = new Date(Date.UTC(2030, 5, 15));
    assert.doesNotThrow(() => validateCard({ number: '4242424242424242', cvc: '123', exp_month: 6, exp_year: 30 }, now));
    assert.throws(() => validateCard({ number: '4242424242424242', cvc: '123', exp_month: 5, exp_year: 30 }, now), /expired/);
  });
});

describe('vault', () => {
  it('round-trips and fingerprints deterministically', () => {
    const vault = new Vault(randomBytes(32));
    const sealed = vault.encrypt('4242424242424242');
    assert.ok(!sealed.includes('4242'));
    assert.notEqual(sealed, vault.encrypt('4242424242424242'), 'IV must be random');
    assert.equal(vault.decrypt(sealed), '4242424242424242');
    assert.equal(vault.fingerprint('4242424242424242'), vault.fingerprint('4242424242424242'));
  });

  it('detects tampering', () => {
    const vault = new Vault(randomBytes(32));
    const [iv, tag, ct] = vault.encrypt('4242424242424242').split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    assert.throws(() => vault.decrypt([iv, tag, flipped.toString('base64')].join('.')));
  });
});

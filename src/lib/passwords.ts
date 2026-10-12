import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/** scrypt with a random salt, stored as `scrypt$<salt hex>$<hash hex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  // Hash something even when there is no account, so response timing doesn't reveal which emails exist.
  const [, saltHex, hashHex] = (stored ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(KEY_LENGTH * 2)}`).split('$');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return timingSafeEqual(actual, Buffer.from(hashHex, 'hex')) && stored !== null;
}

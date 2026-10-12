import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newId = (prefix: string, bytes = 12) => `${prefix}_${randomBytes(bytes).toString('hex')}`;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Card vault: raw card numbers (PANs) are encrypted at rest with AES-256-GCM and are never
 * returned by the API. The CVC is never stored at all (PCI DSS forbids it after authorization).
 */
export class Vault {
  constructor(private readonly key: Buffer) {}

  encrypt(pan: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(pan, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
  }

  decrypt(sealed: string): string {
    const [iv, tag, ciphertext] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Stable, non-reversible identifier for "the same card", e.g. for fraud checks. */
  fingerprint(pan: string): string {
    return createHmac('sha256', this.key).update(`fingerprint:${pan}`).digest('hex').slice(0, 16);
  }
}

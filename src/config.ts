import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  baseUrl: string;
  dbPath: string;
  vaultKey: Buffer;
  /** How often background jobs (UPI request expiry) run, in ms. 0 disables them. */
  jobIntervalMs: number;
  /** How long captured funds stay pending before they can be paid out. */
  settlementDelaySeconds: number;
  /** How long a UPI request waits for the payer's approval. */
  upiExpirySeconds: number;
  /** How often to ask Razorpay about unfinished payments and pending refunds, in ms. */
  providerSyncIntervalMs: number;
  /** Razorpay's API host (only changed for testing). */
  razorpayApiBase: string;
  /** Express "trust proxy": set TRUST_PROXY=1 when running behind one load balancer (Render, Railway, ...). */
  trustProxy: boolean | number | string;
  /** SIGNUPS=closed: only the first account can sign up (yours), so strangers can't make pages on your site. */
  signups: 'open' | 'closed';
  /** OVERLAY_BASE_URL: where OBS loads alerts from, if not BASE_URL (http://localhost:3000 behind ngrok). */
  overlayBaseUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  let vaultKey: Buffer;
  if (env.VAULT_KEY) {
    vaultKey = Buffer.from(env.VAULT_KEY, 'hex');
    if (vaultKey.length !== 32) throw new Error('VAULT_KEY must be 32 bytes of hex (64 characters)');
  } else {
    // Fine for local development, but Razorpay keys become undecryptable after a restart.
    console.warn('[config] VAULT_KEY not set; using an ephemeral key (Razorpay keys are lost on restart)');
    vaultKey = randomBytes(32);
  }
  return {
    port,
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.DB_PATH ?? 'gateway.db',
    vaultKey,
    jobIntervalMs: Number(env.JOB_INTERVAL_MS ?? 1000),
    settlementDelaySeconds: Number(env.SETTLEMENT_DELAY_SECONDS ?? 2 * 24 * 60 * 60),
    upiExpirySeconds: Number(env.UPI_EXPIRY_SECONDS ?? 5 * 60),
    providerSyncIntervalMs: Number(env.PROVIDER_SYNC_INTERVAL_MS ?? 30_000),
    razorpayApiBase: env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    signups: env.SIGNUPS === 'closed' ? 'closed' : 'open',
    overlayBaseUrl: env.OVERLAY_BASE_URL || undefined,
  };
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true' || value === 'false') return value === 'true';
  return /^\d+$/.test(value) ? Number(value) : value;
}

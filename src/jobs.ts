import type { Gateway } from './payments/gateway.js';

/**
 * Background jobs: expiring UPI requests nobody approved (every `intervalMs`), and asking Razorpay
 * about unfinished payments and pending refunds (every `providerSyncIntervalMs`, as it makes HTTP
 * calls). Returns a function that stops them.
 */
export function startBackgroundJobs(gateway: Gateway, intervalMs: number, providerSyncIntervalMs = 30_000): () => void {
  if (intervalMs <= 0) return () => {};
  const expiry = setInterval(() => {
    try {
      gateway.expireUpiRequests();
    } catch (err) {
      console.error('[jobs] UPI expiry failed', err);
    }
  }, intervalMs);
  expiry.unref();

  let syncing = false;
  const reconcile = setInterval(() => {
    if (syncing) return;
    syncing = true;
    gateway.reconcileRazorpay()
      .catch((err) => console.error('[jobs] Razorpay reconciliation failed', err))
      .finally(() => { syncing = false; });
  }, providerSyncIntervalMs);
  reconcile.unref();

  return () => {
    clearInterval(expiry);
    clearInterval(reconcile);
  };
}

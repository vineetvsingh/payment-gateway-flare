import type { Donations } from './donations/donations.js';

/**
 * RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env are the site owner's own keys. Both `npm start` and
 * `npm run demo` connect them to the owner's account: the one whose page name is CHANNEL_HANDLE or, when
 * that isn't set, the only account on the site. Other accounts connect Razorpay from their dashboard.
 *
 * Returns a line for the startup log saying how the owner's donations are paid.
 */
export async function connectOwnerRazorpay(donations: Donations, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return 'test mode (add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to .env to use Razorpay)';

  const owner = donations.ownerProfile(env.CHANNEL_HANDLE);
  if (!owner) {
    return env.CHANNEL_HANDLE
      ? `Razorpay keys found; they connect once the account with page name "${env.CHANNEL_HANDLE}" signs up`
      : 'Razorpay keys found; they connect to the first account that signs up (or set CHANNEL_HANDLE in .env)';
  }

  const mode = keyId.startsWith('rzp_live_') ? 'live' : 'test';
  const describe = `Razorpay (${mode} mode, ${keyId}) for /donate/${owner.handle}`;
  // Already connected with these keys: nothing to check again.
  if (donations.gateway.getMerchant(owner.merchant_id).razorpay_key_id === keyId) return describe;
  try {
    await donations.gateway.connectRazorpay(owner.merchant_id, { key_id: keyId, key_secret: keySecret });
    return describe;
  } catch (err) {
    return `test mode, because Razorpay couldn't be connected: ${err instanceof Error ? err.message : err}`;
  }
}

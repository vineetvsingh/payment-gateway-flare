import express from 'express';
import type { Db } from './db.js';
import { Donations, type DonationOptions } from './donations/donations.js';
import { Gateway, type GatewayOptions } from './payments/gateway.js';
import type { Vault } from './payments/vault.js';
import { checkoutRouter, razorpayWebhookRouter, upiAppRouter } from './routes/checkout.js';
import { dashboardRouter } from './routes/dashboard.js';
import { donateRouter } from './routes/donate.js';
import { checkoutHeaders, errorHandler } from './routes/middleware.js';
import { pagesRouter } from './routes/pages.js';

export interface AppOptions extends GatewayOptions {
  donations?: DonationOptions;
  /**
   * Express's trust proxy setting. Behind a hosting provider's load balancer, set it (e.g. 1) so the
   * rate limits see visitors' real IP addresses and session cookies are marked Secure over HTTPS.
   */
  trustProxy?: boolean | number | string;
}

/**
 *   /donate/<handle>      donation page            /donate-api        its API
 *   /overlay/<token>      OBS alerts and voice     /overlay-api       live alert stream
 *   /checkout/<id>        where donors pay         /checkout-api      its API
 *   /dashboard            streamer dashboard       /dashboard-api     its API
 *   /webhooks/razorpay    Razorpay's webhooks      /3ds, /upi-app     test-mode screens
 */
export function createApp(db: Db, vault: Vault, options: AppOptions) {
  const gateway = new Gateway(db, vault, options);
  const donations = new Donations(gateway, options.donations);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? 'loopback');

  app.use(razorpayWebhookRouter(gateway)); // before the JSON parser: it needs the raw body
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/checkout-api', checkoutRouter(gateway));
  app.use('/upi-api', upiAppRouter(gateway));
  app.use('/dashboard-api', checkoutHeaders, dashboardRouter(gateway, donations));
  app.use(checkoutHeaders, donateRouter(donations));
  app.use(pagesRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: { type: 'invalid_request_error', code: 'route_not_found', message: 'Unrecognized request URL.' } });
  });
  app.use(errorHandler);

  return { app, gateway, donations };
}

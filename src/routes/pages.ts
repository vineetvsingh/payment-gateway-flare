import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type RequestHandler } from 'express';
import { checkoutHeaders, checkoutPageHeaders } from './middleware.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const page = (file: string): RequestHandler => (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, file));
};

/** The HTML pages. Each lives in its own folder under public/, with its script and styles. */
export function pagesRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.redirect('/dashboard');
  });
  router.get('/dashboard', checkoutHeaders, page('dashboard/index.html'));
  router.get(['/donate/:handle', '/donate/:handle/thanks/:id'], checkoutHeaders, page('donate/index.html'));
  router.get(['/overlay/:token', '/overlay/:token/:mode'], checkoutHeaders, page('overlay/index.html'));
  // The checkout page also loads Razorpay Checkout, so it has its own security headers.
  router.get('/checkout/:id', checkoutPageHeaders, page('checkout/index.html'));
  // Test mode: the simulated bank's 3-D Secure page and the payer's UPI app.
  router.get('/3ds/:id', checkoutHeaders, page('test-mode/3ds.html'));
  router.get('/upi-app/:ref', checkoutHeaders, page('test-mode/upi-app.html'));
  router.use('/static', checkoutHeaders, express.static(PUBLIC_DIR, { index: false }));
  return router;
}

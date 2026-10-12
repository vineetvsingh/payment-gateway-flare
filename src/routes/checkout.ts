import express, { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Gateway } from '../payments/gateway.js';
import { TEST_CARDS } from '../payments/processor.js';
import { TEST_VPAS } from '../payments/upi.js';
import { checkoutHeaders, rateLimit } from './middleware.js';

const clientSecretSchema = z.object({ client_secret: z.string().min(1) });

const confirmSchema = clientSecretSchema.extend({
  card: z.object({
    number: z.string().max(30),
    exp_month: z.coerce.number().int(),
    exp_year: z.coerce.number().int(),
    cvc: z.string().max(4),
    name: z.string().max(100).optional(),
  }),
});

const authenticateSchema = clientSecretSchema.extend({ result: z.enum(['approve', 'fail']) });

const upiStartSchema = clientSecretSchema.and(
  z.discriminatedUnion('flow', [
    z.object({ flow: z.literal('collect'), vpa: z.string().max(300) }),
    z.object({ flow: z.literal('qr') }),
  ]),
);

const razorpayCompleteSchema = clientSecretSchema.extend({
  razorpay_payment_id: z.string().max(100).optional(),
  razorpay_signature: z.string().max(200).optional(),
}).refine((b) => Boolean(b.razorpay_payment_id) === Boolean(b.razorpay_signature), {
  path: ['razorpay_signature'], message: 'send both razorpay_payment_id and razorpay_signature, or neither',
});

const upiApproveSchema = z.object({ pin: z.string().max(10), payer_vpa: z.string().max(300).optional() });

/**
 * The hosted checkout's API, used by the payment page. It is authorised by each payment's client
 * secret rather than a login, and card details only ever go from the donor's browser to here.
 */
export function checkoutRouter(gateway: Gateway): Router {
  const checkout = Router();
  checkout.use(checkoutHeaders);
  // Throttle payment attempts, not page loads: that is what card-testing bots hammer.
  checkout.post(['/payments/:id/confirm', '/payments/:id/authenticate', '/payments/:id/upi'], rateLimit({ windowMs: 60_000, max: 10 }));
  checkout.post('/payments/:id/razorpay/complete', rateLimit({ windowMs: 60_000, max: 30 }));

  checkout.get('/payments/:id', (req, res) => {
    const { client_secret } = clientSecretSchema.parse(req.query);
    res.json(gateway.serializeForClient(gateway.getPaymentForClient(req.params.id, client_secret)));
  });

  checkout.post('/payments/:id/confirm', (req, res) => {
    const { client_secret, card } = confirmSchema.parse(req.body);
    res.json(gateway.serializeForClient(gateway.confirmPayment(req.params.id, client_secret, card)));
  });

  checkout.post('/payments/:id/authenticate', (req, res) => {
    const { client_secret, result } = authenticateSchema.parse(req.body);
    res.json(gateway.serializeForClient(gateway.completeAuthentication(req.params.id, client_secret, result === 'approve')));
  });

  checkout.post('/payments/:id/upi', (req, res) => {
    const { client_secret, ...input } = upiStartSchema.parse(req.body);
    res.json(gateway.serializeForClient(gateway.startUpiPayment(req.params.id, client_secret, input)));
  });

  checkout.post('/payments/:id/upi/cancel', (req, res) => {
    const { client_secret } = clientSecretSchema.parse(req.body);
    res.json(gateway.serializeForClient(gateway.cancelUpiAttempt(req.params.id, client_secret)));
  });

  // Razorpay Checkout finished, failed or was closed. With a payment id and signature it reports success;
  // either way the gateway asks Razorpay what actually happened.
  checkout.post('/payments/:id/razorpay/complete', async (req, res) => {
    const { client_secret, razorpay_payment_id, razorpay_signature } = razorpayCompleteSchema.parse(req.body);
    const result = razorpay_payment_id && razorpay_signature ? { razorpay_payment_id, razorpay_signature } : null;
    res.json(gateway.serializeForClient(await gateway.completeRazorpayCheckout(req.params.id, client_secret, result)));
  });

  // The QR points at the simulated UPI app. A real one encodes upi://pay?pa=<merchant VPA>&am=...; we
  // deliberately don't, so a real UPI app scanning it can never send money to a made-up VPA.
  checkout.get('/upi-qr/:ref.svg', async (req, res) => {
    gateway.getUpiRequest(req.params.ref);
    const svg = await QRCode.toString(gateway.upiAppUrl(req.params.ref), { type: 'svg', margin: 1, width: 220 });
    res.type('image/svg+xml').send(svg);
  });

  checkout.get('/test-cards', (_req, res) => {
    res.json(Object.entries(TEST_CARDS).map(([number, c]) => ({ number, description: c.description })));
  });

  checkout.get('/test-vpas', (_req, res) => {
    res.json(Object.entries(TEST_VPAS).map(([vpa, description]) => ({ vpa, description })));
  });

  return checkout;
}

/** Test mode: the simulated UPI app, standing in for the payer's phone. */
export function upiAppRouter(gateway: Gateway): Router {
  const upiApp = Router();
  upiApp.use(checkoutHeaders);
  upiApp.post('/requests/:ref/approve', rateLimit({ windowMs: 60_000, max: 10 }));

  upiApp.get('/requests/:ref', (req, res) => {
    res.json(gateway.getUpiRequest(req.params.ref));
  });

  upiApp.post('/requests/:ref/approve', (req, res) => {
    const { pin, payer_vpa } = upiApproveSchema.parse(req.body);
    gateway.completeUpiRequest(req.params.ref, { approve: true, pin, payer_vpa });
    res.json(gateway.getUpiRequest(req.params.ref));
  });

  upiApp.post('/requests/:ref/decline', (req, res) => {
    gateway.completeUpiRequest(req.params.ref, { approve: false });
    res.json(gateway.getUpiRequest(req.params.ref));
  });

  return upiApp;
}

/** Razorpay's webhooks are signed over the raw body, so this must be mounted before the JSON parser. */
export function razorpayWebhookRouter(gateway: Gateway): Router {
  const router = Router();
  router.post('/webhooks/razorpay/:merchantId', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    await gateway.handleRazorpayWebhook(
      String(req.params.merchantId), body, req.get('X-Razorpay-Signature'), req.get('X-Razorpay-Event-Id'),
    );
    res.json({ ok: true });
  });
  return router;
}

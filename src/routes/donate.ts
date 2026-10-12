import { Router } from 'express';
import { z } from 'zod';
import { MAX_DONATION, MAX_MESSAGE, MAX_NAME, type Donations } from '../donations/donations.js';
import { rateLimit } from './middleware.js';

const donateSchema = z.object({
  name: z.string().max(MAX_NAME).optional(),
  amount: z.number().int().positive().max(MAX_DONATION),
  method: z.enum(['upi', 'card', 'netbanking', 'wallet']),
  message: z.string().max(MAX_MESSAGE, `can be at most ${MAX_MESSAGE} characters`).optional(),
});

/** Public: the donation page's API and the overlay's live event stream. */
export function donateRouter(donations: Donations): Router {
  const router = Router();
  const donateLimit = rateLimit({ windowMs: 60_000, max: 10 });

  router.get('/donate-api/profiles/:handle', (req, res) => {
    res.json(donations.publicProfile(req.params.handle.toLowerCase()));
  });

  router.post('/donate-api/profiles/:handle/donations', donateLimit, async (req, res) => {
    const input = donateSchema.parse(req.body);
    res.status(201).json(await donations.createDonation(String(req.params.handle).toLowerCase(), input));
  });

  router.get('/donate-api/donations/:id', (req, res) => {
    res.json(donations.publicDonation(req.params.id));
  });

  // The token in the URL is the only credential: OBS can't log in.
  router.get('/overlay-api/:token/stream', (req, res) => {
    const profile = donations.streamerByOverlayToken(req.params.token);
    donations.hub.subscribe(profile.merchant_id, req, res);
  });

  return router;
}

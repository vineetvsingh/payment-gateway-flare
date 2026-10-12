import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';

/** Fixed-window, per-IP limiter for public endpoints (slows down card-testing bots and spam). */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      if (hits.size > 10_000) hits.clear();
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new ApiError(429, 'invalid_request_error', 'rate_limited', 'Too many requests. Please slow down.');
    }
    next();
  };
}

/** Security headers for every page and API: everything is locked to our own origin. */
export const checkoutHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
};

/**
 * The hosted checkout page also loads Razorpay Checkout: its script, the iframe it opens, and its
 * calls home. Everything else stays locked to our own origin.
 */
export const checkoutPageHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      // checkout.js also loads Razorpay's fraud-detection script from cdn.razorpay.com.
      "script-src 'self' https://checkout.razorpay.com https://cdn.razorpay.com",
      "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      "connect-src 'self' https://*.razorpay.com",
      "img-src 'self' data: https://*.razorpay.com",
      // Razorpay positions its modal with inline styles.
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
  } else if (err instanceof ZodError) {
    const issue = err.issues[0];
    const param = issue.path.map(String).join('.');
    res.status(400).json(
      new ApiError(400, 'invalid_request_error', 'parameter_invalid', `${param || 'body'}: ${issue.message}`, param || undefined).toJSON(),
    );
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json(new ApiError(400, 'invalid_request_error', 'invalid_json', 'Request body is not valid JSON.').toJSON());
  } else {
    console.error(err);
    res.status(500).json(new ApiError(500, 'api_error', 'internal_error', 'An unexpected error occurred.').toJSON());
  }
};

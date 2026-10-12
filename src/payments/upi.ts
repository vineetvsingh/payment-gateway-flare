import { ApiError } from '../lib/errors.js';

/**
 * Simulated UPI switch (the NPCI side). A real gateway would send the collect request to the
 * payer's PSP bank and get the result back asynchronously. Here, well-known test VPAs pick the outcome.
 */
export const TEST_VPAS: Record<string, string> = {
  'success@upi': 'Request is sent; approve it in the simulated UPI app',
  'nofunds@upi': 'Approval fails with insufficient funds',
  'failure@upi': "Payer's bank declines the request immediately",
  'invalid@upi': 'UPI ID does not exist',
};

const VPA_PATTERN = /^[a-z0-9][a-z0-9.\-_]{1,255}@[a-z][a-z0-9]{1,63}$/;

export const normalizeVpa = (vpa: string) => vpa.trim().toLowerCase();

const upiError = (code: string, message: string) => new ApiError(402, 'card_error', code, message, 'upi[vpa]');

/** Format check and the "verify VPA" lookup real gateways do before raising a collect request. */
export function validateVpa(raw: string): string {
  const vpa = normalizeVpa(raw);
  if (!VPA_PATTERN.test(vpa)) throw upiError('invalid_vpa', 'Enter a valid UPI ID, like name@bank.');
  if (vpa === 'invalid@upi') throw upiError('vpa_not_found', 'This UPI ID does not exist. Check it and try again.');
  return vpa;
}

export type UpiDecision =
  | { outcome: 'pending' }
  | { outcome: 'approved' }
  | { outcome: 'declined'; code: string; message: string };

/** Outcome when the collect request reaches the payer's bank. */
export function sendCollectRequest(vpa: string): UpiDecision {
  if (vpa === 'failure@upi') {
    return { outcome: 'declined', code: 'upi_declined', message: "The payer's bank declined the UPI request." };
  }
  return { outcome: 'pending' };
}

/** Outcome after the payer enters their UPI PIN in their app. */
export function approveWithPin(vpa: string, pin: string): UpiDecision {
  if (!/^(\d{4}|\d{6})$/.test(pin)) {
    throw new ApiError(400, 'invalid_request_error', 'invalid_pin', 'UPI PIN must be 4 or 6 digits.', 'pin');
  }
  if (vpa === 'nofunds@upi') {
    return { outcome: 'declined', code: 'insufficient_funds', message: 'The payer has insufficient funds.' };
  }
  return { outcome: 'approved' };
}

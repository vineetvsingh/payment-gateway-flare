/**
 * Simulated acquirer / card network. A real gateway would forward the authorization request
 * (ISO 8583 or the acquirer's API) here; we decide the outcome from well-known test numbers.
 */

export type AuthorizationResult =
  | { outcome: 'approved'; authCode: string }
  | { outcome: 'declined'; code: string; message: string }
  | { outcome: 'requires_authentication' };

interface TestCard {
  result: AuthorizationResult;
  description: string;
}

const declined = (code: string, message: string): AuthorizationResult => ({ outcome: 'declined', code, message });

export const TEST_CARDS: Record<string, TestCard> = {
  '4242424242424242': { result: { outcome: 'approved', authCode: '' }, description: 'Visa: succeeds' },
  '5555555555554444': { result: { outcome: 'approved', authCode: '' }, description: 'Mastercard: succeeds' },
  '378282246310005': { result: { outcome: 'approved', authCode: '' }, description: 'Amex: succeeds' },
  '6080000000000018': { result: { outcome: 'approved', authCode: '' }, description: 'RuPay: succeeds' },
  '4000000000003220': { result: { outcome: 'requires_authentication' }, description: 'Requires 3-D Secure' },
  '4000000000000002': {
    result: declined('card_declined', 'Your card was declined.'),
    description: 'Generic decline',
  },
  '4000000000009995': {
    result: declined('insufficient_funds', 'Your card has insufficient funds.'),
    description: 'Insufficient funds',
  },
  '4000000000000069': {
    result: declined('expired_card', 'Your card has expired.'),
    description: 'Expired card (issuer side)',
  },
  '4000000000000127': {
    result: declined('incorrect_cvc', "Your card's security code is incorrect."),
    description: 'Incorrect CVC',
  },
  '4100000000000019': {
    result: declined('fraudulent', 'Your card was declined.'),
    description: 'Blocked as fraudulent',
  },
  '4000000000000119': {
    result: declined('processing_error', 'An error occurred while processing your card. Try again.'),
    description: 'Processing error',
  },
};

const authCode = () => Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');

export function authorize(pan: string, { authenticated }: { authenticated: boolean }): AuthorizationResult {
  const result = TEST_CARDS[pan]?.result ?? { outcome: 'approved', authCode: '' };
  if (result.outcome === 'requires_authentication' && authenticated) return { outcome: 'approved', authCode: authCode() };
  if (result.outcome === 'approved') return { outcome: 'approved', authCode: authCode() };
  return result;
}

import { ApiError } from '../lib/errors.js';

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'rupay' | 'discover' | 'unknown';

export interface CardInput {
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
  name?: string;
}

export function luhnValid(pan: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let digit = pan.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectBrand(pan: string): CardBrand {
  if (/^4/.test(pan)) return 'visa';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(pan)) return 'mastercard';
  if (/^(60|65|81|82|508)/.test(pan)) return 'rupay';
  if (/^(6011|64[4-9])/.test(pan)) return 'discover';
  return 'unknown';
}

const cardError = (code: string, message: string, param: string) =>
  new ApiError(402, 'card_error', code, message, param);

/** Validates card details locally, before anything reaches the processor. Returns the normalized PAN. */
export function validateCard(card: CardInput, now = new Date()): string {
  const pan = card.number.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(pan) || !luhnValid(pan)) {
    throw cardError('invalid_number', 'Your card number is invalid.', 'card[number]');
  }
  if (!Number.isInteger(card.exp_month) || card.exp_month < 1 || card.exp_month > 12) {
    throw cardError('invalid_expiry_month', "Your card's expiration month is invalid.", 'card[exp_month]');
  }
  const year = card.exp_year < 100 ? 2000 + card.exp_year : card.exp_year;
  const expired =
    year < now.getUTCFullYear() || (year === now.getUTCFullYear() && card.exp_month < now.getUTCMonth() + 1);
  if (expired) throw cardError('expired_card', 'Your card has expired.', 'card[exp_year]');

  const cvcLength = detectBrand(pan) === 'amex' ? 4 : 3;
  if (!new RegExp(`^\\d{${cvcLength}}$`).test(card.cvc)) {
    throw cardError('invalid_cvc', "Your card's security code is invalid.", 'card[cvc]');
  }
  return pan;
}

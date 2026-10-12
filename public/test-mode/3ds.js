'use strict';

const paymentId = location.pathname.split('/').pop();
const clientSecret = new URLSearchParams(location.search).get('client_secret') ?? '';
const $ = (id) => document.getElementById(id);
const base = `/checkout-api/payments/${encodeURIComponent(paymentId)}`;
const backToCheckout = () =>
  location.replace(`/checkout/${encodeURIComponent(paymentId)}?client_secret=${encodeURIComponent(clientSecret)}`);

async function authenticate(result) {
  $('approve').disabled = $('fail').disabled = true;
  try {
    const res = await fetch(`${base}/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_secret: clientSecret, result }),
    });
    if (!res.ok) throw new Error((await res.json()).error?.message ?? 'Authentication failed');
    backToCheckout();
  } catch (err) {
    $('error').textContent = err.message;
    $('approve').disabled = $('fail').disabled = false;
  }
}

async function main() {
  const res = await fetch(`${base}?client_secret=${encodeURIComponent(clientSecret)}`);
  if (!res.ok) return backToCheckout();
  const payment = await res.json();
  if (payment.status !== 'requires_action') return backToCheckout();
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: payment.currency.toUpperCase() });
  $('amount').textContent = fmt.format(payment.amount / 10 ** fmt.resolvedOptions().maximumFractionDigits);
  $('merchant').textContent = payment.merchant_name;
  $('approve').addEventListener('click', () => authenticate('approve'));
  $('fail').addEventListener('click', () => authenticate('fail'));
}

main();

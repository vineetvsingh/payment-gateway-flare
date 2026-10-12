'use strict';

const ref = location.pathname.split('/').pop();
const $ = (id) => document.getElementById(id);
const base = `/upi-api/requests/${encodeURIComponent(ref)}`;

async function call(path = '', body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? 'Request failed'), json.error);
  return json;
}

function formatAmount(minor, currency) {
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
  return fmt.format(minor / 10 ** fmt.resolvedOptions().maximumFractionDigits);
}

const OUTCOMES = {
  approved: ['✅', 'Payment approved', 'The money is on its way. You can close this page and go back to the checkout.'],
  declined: ['❌', 'Payment not completed', 'The request was declined. Go back to the checkout to try again.'],
  expired: ['⌛', 'Request expired', 'This request timed out. Go back to the checkout to start a new one.'],
};

function render(request) {
  if (request.status !== 'pending') {
    const [icon, title, text] = OUTCOMES[request.status];
    $('request').hidden = true;
    $('done').hidden = false;
    $('done-icon').textContent = icon;
    $('done-title').textContent = title;
    $('done-text').textContent = text;
    return;
  }
  $('request').hidden = false;
  $('payee').textContent = request.payee;
  $('amount').textContent = formatAmount(request.amount, request.currency);
  $('description').textContent = request.description ?? '';
  // A scanned QR doesn't say who is paying; a collect request was sent to a specific UPI ID.
  $('payer-label').hidden = request.flow !== 'qr';
  $('payer-fixed').textContent = request.flow === 'qr' ? '' : `Paying from ${request.payer_vpa}`;
}

async function act(path, body) {
  $('approve').disabled = $('decline').disabled = true;
  $('error').textContent = '';
  try {
    render(await call(path, body));
  } catch (err) {
    $('error').textContent = err.message;
    if (err.code === 'invalid_state') render(await call());
  } finally {
    $('approve').disabled = $('decline').disabled = false;
  }
}

async function main() {
  $('approve-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { pin: $('pin').value };
    if (!$('payer-label').hidden) body.payer_vpa = $('payer-vpa').value;
    act('/approve', body);
  });
  $('decline').addEventListener('click', () => act('/decline', {}));
  try {
    render(await call());
  } catch (err) {
    $('done').hidden = false;
    $('done-icon').textContent = '⚠️';
    $('done-title').textContent = 'Request not found';
    $('done-text').textContent = err.message;
  }
}

main();

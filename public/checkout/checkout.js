'use strict';

const paymentId = location.pathname.split('/').pop();
const clientSecret = new URLSearchParams(location.search).get('client_secret') ?? '';
const $ = (id) => document.getElementById(id);

const api = async (path, body) => {
  // GETs carry the client secret in the query string; POSTs carry it in the body.
  const query = body ? '' : `?client_secret=${encodeURIComponent(clientSecret)}`;
  const res = await fetch(`/checkout-api/payments/${encodeURIComponent(paymentId)}${path}${query}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify({ client_secret: clientSecret, ...body }) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? 'Request failed'), json.error);
  return json;
};

function formatAmount(minor, currency) {
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
  return fmt.format(minor / 10 ** fmt.resolvedOptions().maximumFractionDigits);
}

function detectBrand(pan) {
  if (/^4/.test(pan)) return 'visa';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(pan)) return 'mastercard';
  if (/^(60|65|81|82|508)/.test(pan)) return 'rupay';
  return '';
}

// ------------------------------------------------------------------- views

const SECTIONS = ['method-tabs', 'pay-form', 'upi-panel', 'razorpay-panel', 'upi-wait', 'result', 'test-cards'];
const show = (...ids) => SECTIONS.forEach((id) => { $(id).hidden = !ids.includes(id); });

let method = 'card';
let methodTypes = ['card'];
let current = null;
let firstRender = true;
let pollTimer;
let countdownTimer;

function stopWaiting() {
  clearInterval(pollTimer);
  clearInterval(countdownTimer);
  pollTimer = countdownTimer = undefined;
}

function showResult(icon, title, text) {
  stopWaiting();
  show('result');
  $('result-icon').textContent = icon;
  $('result-title').textContent = title;
  $('result-text').textContent = text;
}

function selectMethod(next) {
  method = next;
  for (const tab of $('method-tabs').querySelectorAll('[role="tab"]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.method === method));
  }
  const ids = ['pay-form', 'upi-panel'].filter((id) => (id === 'pay-form') === (method === 'card'));
  show(...(methodTypes.length > 1 ? ['method-tabs'] : []), ...ids, 'test-cards');
  renderTestValues();
}

function redirectToMerchant(payment) {
  if (!payment.return_url) return;
  const url = new URL(payment.return_url);
  url.searchParams.set('payment_id', payment.id);
  setTimeout(() => location.assign(url.toString()), 1500);
}

function describeMethod(pm) {
  if (pm?.type === 'upi') return pm.upi.vpa ? `UPI (${pm.upi.vpa})` : 'UPI';
  if (pm?.type === 'card') return `${pm.card.brand} •••• ${pm.card.last4}`;
  if (pm?.type === 'netbanking') return `netbanking${pm.bank ? ` (${pm.bank})` : ''}`;
  if (pm?.type === 'wallet') return `${pm.wallet ?? 'a'} wallet`;
  return pm?.type ?? 'card';
}

/** Moves the page to whatever the payment's current status calls for. */
function render(payment) {
  $('merchant').textContent = payment.merchant_name;
  $('amount').textContent = formatAmount(payment.amount, payment.currency);
  $('description').textContent = payment.description ?? '';
  $('pay-button').textContent = `Pay ${formatAmount(payment.amount, payment.currency)}`;
  methodTypes = payment.payment_method_types;
  current = payment;
  const returning = payment.return_url ? ' Returning you to the store…' : '';

  switch (payment.status) {
    case 'succeeded':
    case 'requires_capture':
      showResult('✅', 'Payment successful', `Paid with ${describeMethod(payment.payment_method)}.${returning}`);
      redirectToMerchant(payment);
      return;
    case 'requires_action':
      if (payment.next_action.type === 'redirect_to_url') {
        location.assign(payment.next_action.url);
      } else {
        showUpiWait(payment);
      }
      return;
    case 'canceled':
      showResult('⛔', 'Payment canceled', 'This payment is no longer active.');
      return;
    default: {
      stopWaiting();
      if (payment.provider === 'razorpay') {
        show('razorpay-panel');
        $('razorpay-pay').textContent = `Pay ${formatAmount(payment.amount, payment.currency)}`;
        $('razorpay-test-hint').hidden = !payment.razorpay?.key_id.startsWith('rzp_test_');
        $('razorpay-error').textContent = payment.last_error?.message ?? '';
        return;
      }
      const failedWithUpi = payment.payment_method?.type === 'upi';
      // Open on the method chosen before checkout (e.g. on a donation form), the first time only.
      if (firstRender && methodTypes.includes(payment.preferred_method)) method = payment.preferred_method;
      firstRender = false;
      selectMethod(failedWithUpi && methodTypes.includes('upi') ? 'upi' : method);
      const message = payment.last_error?.message ?? '';
      $('error').textContent = method === 'card' ? message : '';
      $('upi-error').textContent = method === 'upi' ? message : '';
    }
  }
}

// --------------------------------------------------------------------- card

function setupCardInputs() {
  $('number').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 19);
    e.target.value = digits.replace(/(.{4})(?=.)/g, '$1 ');
    $('brand').textContent = detectBrand(digits);
  });
  $('expiry').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
  });
  $('cvc').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
}

const FIELD_FOR_PARAM = {
  'card[number]': 'number',
  'card[exp_month]': 'expiry',
  'card[exp_year]': 'expiry',
  'card[cvc]': 'cvc',
};

async function submitCard(event) {
  event.preventDefault();
  for (const id of ['number', 'expiry', 'cvc']) $(id).removeAttribute('aria-invalid');
  const [month, year] = $('expiry').value.split('/').map((s) => Number(s.trim()));
  const button = $('pay-button');
  button.disabled = true;
  $('error').textContent = '';
  try {
    render(await api('/confirm', {
      card: {
        number: $('number').value.replace(/\s/g, ''),
        exp_month: month || 0,
        exp_year: year || 0,
        cvc: $('cvc').value,
        name: $('name').value || undefined,
      },
    }));
  } catch (err) {
    $('error').textContent = err.message;
    const field = FIELD_FOR_PARAM[err.param];
    if (field) $(field).setAttribute('aria-invalid', 'true');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------- UPI

async function startUpi(body, button) {
  button.disabled = true;
  $('upi-error').textContent = '';
  $('vpa').removeAttribute('aria-invalid');
  try {
    render(await api('/upi', body));
  } catch (err) {
    $('upi-error').textContent = err.message;
    if (err.param === 'upi[vpa]') $('vpa').setAttribute('aria-invalid', 'true');
  } finally {
    button.disabled = false;
  }
}

function showUpiWait(payment) {
  const action = payment.next_action;
  const isQr = action.type === 'upi_qr';
  show('upi-wait');
  $('upi-qr-img').hidden = !isQr;
  $('upi-spinner').hidden = isQr;
  if (isQr && $('upi-qr-img').getAttribute('src') !== action.qr_code_svg_url) $('upi-qr-img').src = action.qr_code_svg_url;
  $('upi-wait-title').textContent = isQr ? 'Scan with any UPI app' : 'Approve the payment in your UPI app';
  $('upi-wait-text').textContent = isQr
    ? `Pay ${formatAmount(payment.amount, payment.currency)} to ${payment.merchant_name}`
    : `We sent a payment request to ${action.vpa}. Open your UPI app and enter your PIN to approve it.`;
  $('upi-sim-link').href = action.simulator_url;

  if (!countdownTimer) {
    const tick = () => {
      const left = Math.max(0, action.expires_at - Math.floor(Date.now() / 1000));
      $('upi-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
  if (!pollTimer) {
    // The payer approves on another device, so poll the gateway for the outcome.
    pollTimer = setInterval(async () => {
      try {
        const latest = await api('');
        if (latest.status !== 'requires_action') render(latest);
      } catch {
        // Transient network error: keep polling.
      }
    }, 2000);
  }
}

async function cancelUpi() {
  $('upi-cancel').disabled = true;
  try {
    stopWaiting();
    render(await api('/upi/cancel', {}));
    $('upi-error').textContent = '';
  } catch (err) {
    render(await api(''));
  } finally {
    $('upi-cancel').disabled = false;
  }
}

// ----------------------------------------------------------------- Razorpay

let razorpayScript;

function loadRazorpay(src) {
  razorpayScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => {
      razorpayScript = undefined;
      reject(new Error("Couldn't load Razorpay Checkout. Check your connection and try again."));
    };
    document.head.append(script);
  });
  return razorpayScript;
}

/** Opens Razorpay's own checkout window. The card or UPI details are entered there, never on this page. */
async function payWithRazorpay() {
  const button = $('razorpay-pay');
  button.disabled = true;
  $('razorpay-error').textContent = '';
  try {
    const { razorpay } = current;
    await loadRazorpay(razorpay.checkout_js);
    const checkout = new window.Razorpay({
      key: razorpay.key_id,
      order_id: razorpay.order_id,
      amount: current.amount,
      currency: current.currency.toUpperCase(),
      name: current.merchant_name,
      description: current.description ?? undefined,
      prefill: razorpay.prefill,
      theme: { color: '#4f46e5' },
      handler: (response) => finishRazorpay({
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      }),
      // Closed without paying, or after failed attempts: ask the gateway what happened.
      modal: { ondismiss: () => finishRazorpay({}) },
    });
    // On a failure Razorpay shows the reason and lets the customer try again in the same window.
    checkout.on('payment.failed', () => {});
    checkout.open();
  } catch (err) {
    $('razorpay-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/** The gateway checks with Razorpay itself, so what the browser reports is only a hint. */
async function finishRazorpay(result) {
  const button = $('razorpay-pay');
  button.disabled = true;
  button.textContent = 'Confirming your payment…';
  try {
    render(await api('/razorpay/complete', result));
  } catch (err) {
    $('razorpay-error').textContent = err.message;
    button.textContent = `Pay ${formatAmount(current.amount, current.currency)}`;
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------- test values

let testCards = [];
let testVpas = [];

function testButton(label, description, onClick) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  const code = document.createElement('code');
  code.textContent = label;
  const desc = document.createElement('span');
  desc.textContent = description;
  btn.append(code, desc);
  btn.addEventListener('click', onClick);
  li.append(btn);
  return li;
}

function renderTestValues() {
  const list = $('test-card-list');
  list.replaceChildren();
  if (method === 'card') {
    $('test-title').textContent = 'Test cards';
    $('test-hint').textContent = 'Click one to fill the form. Use any future expiry date and any CVC.';
    for (const card of testCards) {
      const pretty = card.number.replace(/(.{4})(?=.)/g, '$1 ');
      list.append(testButton(pretty, card.description, () => {
        $('number').value = pretty;
        $('brand').textContent = detectBrand(card.number);
        $('expiry').value = `12 / ${String(new Date().getFullYear() + 3).slice(2)}`;
        $('cvc').value = card.number.startsWith('3') ? '1234' : '123';
        $('name').value = 'Test Customer';
      }));
    }
  } else {
    $('test-title').textContent = 'Test UPI IDs';
    $('test-hint').textContent = 'Click one to fill the form. Any other valid UPI ID also works; approve it in the simulated app.';
    for (const { vpa, description } of testVpas) {
      list.append(testButton(vpa, description, () => { $('vpa').value = vpa; }));
    }
  }
}

async function loadTestValues() {
  [testCards, testVpas] = await Promise.all([
    fetch('/checkout-api/test-cards').then((r) => r.json()),
    fetch('/checkout-api/test-vpas').then((r) => r.json()),
  ]);
  renderTestValues();
}

// --------------------------------------------------------------------- main

async function main() {
  setupCardInputs();
  $('pay-form').addEventListener('submit', submitCard);
  $('upi-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startUpi({ flow: 'collect', vpa: $('vpa').value }, $('upi-pay-button'));
  });
  $('upi-qr-button').addEventListener('click', (e) => startUpi({ flow: 'qr' }, e.currentTarget));
  $('upi-cancel').addEventListener('click', cancelUpi);
  $('razorpay-pay').addEventListener('click', payWithRazorpay);
  for (const tab of $('method-tabs').querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => selectMethod(tab.dataset.method));
  }
  try {
    render(await api(''));
    if (current.provider !== 'razorpay') await loadTestValues();
  } catch (err) {
    console.error(err);
    $('merchant').textContent = '';
    if (err.code === 'resource_missing') {
      showResult('⚠️', 'Payment not found', 'This checkout link is invalid or has expired.');
    } else {
      showResult('⚠️', 'Something went wrong', err.message);
    }
  }
}

main();

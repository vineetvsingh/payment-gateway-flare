'use strict';

const [, , handle, mode, donationId] = location.pathname.split('/').map(decodeURIComponent);
const $ = (id) => document.getElementById(id);

const rupees = (paise) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);

const METHOD_LABELS = { upi: 'UPI', card: 'Card', netbanking: 'Netbanking', wallet: 'Wallet' };
const PRESETS = [50, 100, 200, 500];

async function getJson(url, options) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? 'Something went wrong. Please try again.'), json.error ?? {}, { status: res.status });
  return json;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

/** A radio button drawn as a tile (`amount`) or a pill (`method`). */
function choice(kind, name, value, label, checked, onChange) {
  return el('label', { class: kind },
    el('input', { type: 'radio', name, value, checked, onchange: onChange }),
    el('span', {}, label));
}

function showHeader(profile) {
  document.title = `Donate to ${profile.display_name}`;
  $('masthead').hidden = false;
  $('streamer-name').textContent = profile.display_name;
  $('streamer-bio').textContent = profile.bio ?? '';
  $('test-badge').hidden = !profile.test_mode;
}

// ------------------------------------------------------------------- the form

let profile;

function selectedAmount() {
  const typed = $('amount').value.replace(/[^\d.]/g, '');
  if (typed) return Math.round(Number(typed) * 100);
  const preset = document.querySelector('input[name="preset"]:checked');
  return preset ? Number(preset.value) * 100 : 0;
}

function updateButton() {
  const amount = selectedAmount();
  $('submit').textContent = amount > 0 ? `Donate ${rupees(amount)}` : 'Donate';
  updatePreview();
}

/** Restarts a CSS animation class, so it plays again on every change. */
function replay(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

/**
 * "a ₹500 Flare" but "an ₹800 Flare": the article follows how the amount is said, in Indian numbering
 * (eight hundred, eleven thousand, eighteen lakh).
 */
function articleFor(paise) {
  const n = Math.floor(paise / 100);
  const lead = String(n >= 1e7 ? Math.floor(n / 1e7) : n >= 1e5 ? Math.floor(n / 1e5) : n >= 1e3 ? Math.floor(n / 1e3) : n >= 100 ? Math.floor(n / 100) : n);
  return lead.startsWith('8') || lead === '11' || lead === '18' ? 'an' : 'a';
}

/** The alert as it will appear on stream, updated as the donor types. */
let lastPreviewAmount = null;
function updatePreview() {
  const amount = selectedAmount();
  const message = $('message').value.replace(/\s+/g, ' ').trim();
  $('preview-name').textContent = $('name').value.trim() || 'Anonymous';
  $('preview-article').textContent = articleFor(amount || profile.min_amount);
  $('preview-amount').textContent = rupees(amount || profile.min_amount);
  $('preview-donation-name').textContent = profile.donation_name;
  $('preview-message').textContent = message;
  const voice = profile.tts_min_amount != null && amount >= profile.tts_min_amount && message;
  $('preview-voice').textContent = !message
    ? 'Add a message and it shows up on the card.'
    : voice
      ? '🔊 Your message will be read aloud. Hindi and Hinglish work too.'
      : profile.tts_min_amount != null
        ? `Shown on screen. Messages are read aloud from ${rupees(profile.tts_min_amount)}.`
        : 'Shown on screen.';
  // A new amount springs the card and rolls the number in (not on first load: the page entrance handles that).
  if (lastPreviewAmount !== null && amount !== lastPreviewAmount) {
    replay(document.querySelector('.alert-card'), 'bump');
    replay($('preview-amount'), 'tick');
  }
  lastPreviewAmount = amount;
}

function renderForm() {
  const min = profile.min_amount / 100;
  const presets = PRESETS.filter((p) => p >= min);
  if (!presets.includes(min) && presets.length < 4) presets.unshift(min);
  const initial = presets.includes(100) ? 100 : presets[0];
  $('presets').replaceChildren(...presets.slice(0, 4).map((p) =>
    choice('amount', 'preset', String(p), rupees(p * 100), p === initial, () => { $('amount').value = ''; updateButton(); })));
  $('amount-hint').textContent = `Minimum ${rupees(profile.min_amount)}`;

  $('methods').replaceChildren(...profile.methods.map((m, i) => choice('method', 'method', m, METHOD_LABELS[m] ?? m, i === 0)));

  $('tts-hint').textContent = profile.tts_min_amount != null ? `Read aloud from ${rupees(profile.tts_min_amount)}` : '';

  $('message').addEventListener('input', () => {
    const n = $('message').value.length;
    $('counter').textContent = `${n}/${profile.max_message}`;
    $('counter').classList.toggle('near', n >= profile.max_message - 20);
    updatePreview();
  });
  $('name').addEventListener('input', updatePreview);
  $('amount').addEventListener('input', () => {
    $('amount').value = $('amount').value.replace(/[^\d]/g, '').slice(0, 7);
    for (const r of document.querySelectorAll('input[name="preset"]')) r.checked = false;
    updateButton();
  });
  $('form').addEventListener('submit', submit);
  $('layout').hidden = false;
  updateButton();
}

function showError(text) {
  $('error').textContent = text;
  if (text) replay($('error'), 'show');
}

async function submit(event) {
  event.preventDefault();
  $('error').textContent = '';
  const amount = selectedAmount();
  if (!(amount >= profile.min_amount)) {
    showError(`Please enter at least ${rupees(profile.min_amount)}.`);
    $('amount').focus();
    return;
  }
  if (amount > profile.max_amount) {
    showError(`The most you can donate at once is ${rupees(profile.max_amount)}.`);
    return;
  }
  $('submit').disabled = true;
  $('submit').classList.add('busy');
  $('submit').textContent = 'Opening checkout';
  try {
    const { checkout_url } = await getJson(`/donate-api/profiles/${encodeURIComponent(handle)}/donations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('name').value.trim() || undefined,
        amount,
        method: document.querySelector('input[name="method"]:checked')?.value,
        message: $('message').value.trim() || undefined,
      }),
    });
    location.assign(checkout_url);
  } catch (err) {
    showError(err.status === 429 ? 'Too many tries. Please wait a minute and try again.' : err.message);
    $('submit').classList.remove('busy');
    $('submit').disabled = false;
    updateButton();
  }
}

// ---------------------------------------------------------------- thank you

async function showThanks() {
  $('thanks-again').href = `/donate/${encodeURIComponent(handle)}`;
  const started = Date.now();
  const show = (icon, title, text, again) => {
    $('thanks').hidden = false;
    $('thanks-icon').replaceChildren(icon === 'spinner' ? el('div', { class: 'spinner', 'aria-hidden': 'true' }) : icon);
    $('thanks-title').textContent = title;
    $('thanks-text').textContent = text;
    $('thanks-again').hidden = !again;
    $('thanks-again').textContent = again ?? '';
  };
  for (;;) {
    const d = await getJson(`/donate-api/donations/${encodeURIComponent(donationId)}`);
    if (d.payment_status === 'succeeded') {
      const name = d.donor_name === 'Anonymous' ? '' : `, ${d.donor_name}`;
      const onStream = {
        yes: 'Your message will appear on stream in a moment.',
        review: `Your message will appear on stream once ${d.streamer.display_name} approves it.`,
        no: '',
      }[d.on_stream];
      show('🌿', `Thank you${name}!`, `Your ${rupees(d.amount)} donation to ${d.streamer.display_name} went through. ${onStream}`, 'Donate again');
      return;
    }
    if (d.payment_status === 'canceled' || Date.now() - started > 30_000) {
      show('⏳', "We haven't received your payment",
        'If money was taken, it will show up here shortly or be refunded automatically. Otherwise you can try again.', 'Try again');
      return;
    }
    show('spinner', 'Confirming your payment…', 'This usually takes a few seconds.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  try {
    profile = await getJson(`/donate-api/profiles/${encodeURIComponent(handle ?? '')}`);
    showHeader(profile);
    $('loading').hidden = true;
    if (mode === 'thanks' && donationId) await showThanks();
    else renderForm();
  } catch (err) {
    $('loading').hidden = true;
    if (err.status === 404) $('missing').hidden = false;
    else {
      $('missing').hidden = false;
      $('missing').querySelector('h2').textContent = 'Something went wrong';
      $('missing').querySelector('p').textContent = err.message;
    }
  }
}

main();

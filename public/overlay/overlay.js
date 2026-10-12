'use strict';

// /overlay/<token>          alerts, for OBS's Browser Source
// /overlay/<token>/voice    reads alerts aloud; open in Edge or Chrome
const [, , token, mode = 'alerts'] = location.pathname.split('/');
const $ = (id) => document.getElementById(id);
const inObs = Boolean(window.obsstudio); // OBS's browser source defines this
const rupees = (paise) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);

/**
 * "a ₹500 Flare" but "an ₹800 Flare": the article follows how the amount is said, in Indian numbering
 * (eight hundred, eleven thousand, eighteen lakh).
 */
function articleFor(paise) {
  const n = Math.floor(paise / 100);
  const lead = String(n >= 1e7 ? Math.floor(n / 1e7) : n >= 1e5 ? Math.floor(n / 1e5) : n >= 1e3 ? Math.floor(n / 1e3) : n >= 100 ? Math.floor(n / 100) : n);
  return lead.startsWith('8') || lead === '11' || lead === '18' ? 'an' : 'a';
}

/** A note for whoever opens the page in a normal browser. Never shown inside OBS, so never on stream. */
function hint(text) {
  $('hint').hidden = inObs || !text;
  $('hint').textContent = text ?? '';
}

// ------------------------------------------------------------- live events

function connect(handlers) {
  const source = new EventSource(`/overlay-api/${encodeURIComponent(token)}/stream`);
  source.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handlers[event.type]?.(event);
  };
  source.onopen = () => handlers.open?.();
  source.onerror = () => {
    // A closed stream that isn't retrying means the link is wrong or was replaced.
    if (source.readyState === EventSource.CLOSED) handlers.dead?.();
    else handlers.retrying?.();
  };
}

// ------------------------------------------------------------------ alerts

let hideTimer;

function showAlert({ alert, duration_ms }) {
  clearTimeout(hideTimer);
  const card = $('alert');
  $('alert-name').textContent = alert.donor_name;
  $('alert-article').textContent = articleFor(alert.amount);
  $('alert-amount').textContent = rupees(alert.amount);
  $('alert-donation-name').textContent = alert.donation_name ?? 'Flare';
  $('alert-message').textContent = alert.message;
  card.classList.remove('leaving');
  card.hidden = false;
  // Restart the entrance animation for back-to-back alerts.
  void card.offsetWidth;
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  hideTimer = setTimeout(hideAlert, duration_ms + 2000); // a fallback in case the "clear" event is lost
}

function hideAlert() {
  const card = $('alert');
  if (card.hidden) return;
  card.classList.add('leaving');
  setTimeout(() => { card.hidden = true; card.classList.remove('leaving'); }, 360);
}

function startAlerts() {
  $('alert-stage').hidden = false;
  connect({
    open: () => hint('Connected. Donation alerts will appear on this page. Add it to OBS as a Browser Source (width 1920, height 1080). Keep this link private.'),
    alert: (e) => { showAlert(e); if (!inObs) $('hint').hidden = true; },
    clear: hideAlert,
    dead: () => hint("This overlay link doesn't work any more. Copy the current link from your dashboard (Stream setup)."),
    retrying: () => hint('Connection lost. Reconnecting…'),
  });
}

// ------------------------------------------------------------------- voice

const synth = window.speechSynthesis;
let voiceOn = false;
let voices = [];
const spokenIds = new Set();
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('alert-voice') ?? '{}'); } catch { return {}; }
})();
const savePrefs = () => {
  try { localStorage.setItem('alert-voice', JSON.stringify(prefs)); } catch { /* private mode: not remembered */ }
};

function status(text) {
  $('voice-status').textContent = text;
}

/** Voices that sound alike in both languages, so the voice doesn't change between English and Hindi messages. */
const PARTNERS = [[/Neerja/i, /Swara|स्वरा/], [/Prabhat/i, /Madhur|मधुर/]];

const selected = (id) => voices.find((v) => v.name === $(id).value);

function fillVoices(id, list, preferred) {
  const select = $(id);
  select.replaceChildren(...list.map((v) => {
    const option = document.createElement('option');
    option.value = v.name;
    option.textContent = v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' (natural)');
    return option;
  }));
  select.disabled = !list.length;
  const choice = list.find((v) => v.name === preferred) ?? list[0];
  if (choice) select.value = choice.name;
}

/** The best match for the first pattern that finds one. */
const best = (list, ...patterns) => patterns.map((p) => list.find((v) => p.test(v.name))).find(Boolean);

/** Indian English first; for Hindi, the voice that matches the English one. */
function loadVoices() {
  voices = synth.getVoices();
  const rank = (v) => (/^en-IN/i.test(v.lang) ? 0 : /Natural/.test(v.name) ? 1 : 2);
  const english = voices.filter((v) => /^en/i.test(v.lang)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const hindi = voices.filter((v) => /^hi/i.test(v.lang)).sort((a, b) => /Natural/.test(b.name) - /Natural/.test(a.name));
  fillVoices('voice-en', english, prefs.voice ?? best(english, /Neerja/i, /Natural/)?.name);
  fillVoices('voice-hi', hindi, prefs.voiceHi ?? partnerOf(hindi)?.name);
  $('voice-hi-missing').hidden = hindi.length > 0 || !voices.length;
}

function partnerOf(hindi) {
  const english = $('voice-en').value;
  const pair = PARTNERS.find(([en]) => en.test(english));
  return (pair && best(hindi, pair[1])) ?? best(hindi, /Swara|स्वरा/, /Natural/);
}

function speak(text, hindi = false) {
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = hindi ? selected('voice-hi') : selected('voice-en');
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = Number($('voice-rate').value);
  utterance.onend = () => { if (!synth.speaking) status('Voice is on. Waiting for donations…'); };
  utterance.onerror = (e) => {
    if (e.error === 'not-allowed') status('The browser blocked the sound. Click anywhere on this page, then play a test line.');
    else if (e.error !== 'interrupted' && e.error !== 'canceled') status(`The voice stopped (${e.error}). Try another voice.`);
  };
  status(`Speaking: “${text}”`);
  synth.speak(utterance);
}

/** What the streamer calls a donation ("Flare"); the server sends it when the voice tab connects. */
let donationName = 'Flare';

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * 125000 -> "one lakh twenty-five thousand". In words, so the Hindi voice also says the amount in English
 * (given digits, it would say "पाँच सौ" in the middle of an English sentence).
 */
function inWords(n) {
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, word] of [[1e7, 'crore'], [1e5, 'lakh'], [1e3, 'thousand'], [100, 'hundred']]) {
    if (n >= size) {
      parts.push(`${inWords(Math.floor(n / size))} ${word}`);
      n %= size;
    }
  }
  if (n) parts.push(n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  return parts.join(' ');
}

/** "Rahul sent a five hundred rupee Flare.", matching the alert on screen ("Rahul sent a ₹500 Flare"). */
function introFor(alert) {
  const name = alert.donation_name ?? donationName;
  const rupees = Math.floor(alert.amount / 100);
  const paise = alert.amount % 100;
  if (paise) return `${alert.donor_name} sent ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} of ${inWords(rupees)} rupees and ${inWords(paise)} paise.`;
  return `${alert.donor_name} sent ${articleFor(alert.amount)} ${inWords(rupees)} rupee ${name}.`;
}

/** The intro, then the message: Hindi and Hinglish messages go to the Hindi voice, everything else to the English one. */
function say(alert) {
  const intro = introFor(alert);
  if (alert.spoken_hindi && selected('voice-hi')) speak(`${intro} ${alert.spoken_hindi}`, true);
  else speak(`${intro} ${alert.spoken}`);
}

const TEST_LINES = {
  english: { donor_name: 'Asha', amount: 10000, spoken: 'Love the stream, keep it up!', spoken_hindi: null },
  hindi: {
    donor_name: 'Rahul', amount: 50000, spoken: 'Aaj ki stream bahut mazedaar thi, aise hi khelte raho!',
    spoken_hindi: 'आज की स्ट्रीम बहुत मज़ेदार थी, ऐसे ही खेलते रहो!',
  },
  // As a donor would type it, and as it's rewritten for the Hindi voice.
  hinglish: {
    donor_name: 'Rahul', amount: 80000, spoken: 'Bhai aaj ka stream ekdum mast hai, aise hi khelte raho!',
    spoken_hindi: 'भाई आज का stream एकदम मस्त है, ऐसे ही खेलते रहो!',
  },
};

function sayAlert({ alert }) {
  if (spokenIds.has(alert.id)) return; // the same alert again after a reconnect
  spokenIds.add(alert.id);
  if (!alert.spoken) return; // below the read-aloud amount
  if (!voiceOn) {
    status('A donation arrived, but the voice is off. Click "Start voice".');
    return;
  }
  say(alert);
}

function startVoice() {
  document.title = 'Alert voice';
  document.body.classList.add('voice-mode');
  $('voice').hidden = false;
  if (!synth) {
    status("This browser can't speak. Open this page in Microsoft Edge or Google Chrome.");
    $('voice-start').disabled = true;
    return;
  }
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
  $('voice-rate').value = prefs.rate ?? 1;
  $('voice-rate-value').textContent = `${Number($('voice-rate').value).toFixed(2)}×`;
  $('voice-en').addEventListener('change', () => {
    prefs.voice = $('voice-en').value;
    // Until a Hindi voice is picked by hand, it follows the English one.
    if (!prefs.voiceHi) {
      const hindi = voices.filter((v) => /^hi/i.test(v.lang));
      const partner = partnerOf(hindi);
      if (partner) $('voice-hi').value = partner.name;
    }
    savePrefs();
  });
  $('voice-hi').addEventListener('change', () => { prefs.voiceHi = $('voice-hi').value; savePrefs(); });
  $('voice-rate').addEventListener('input', () => {
    prefs.rate = Number($('voice-rate').value);
    $('voice-rate-value').textContent = `${prefs.rate.toFixed(2)}×`;
    savePrefs();
  });
  // Browsers only allow speech after a click on the page, hence this button.
  $('voice-start').addEventListener('click', () => {
    voiceOn = true;
    $('voice-start').textContent = 'Voice is on ✓';
    $('voice-start').classList.add('on');
    $('voice-settings').hidden = false;
    if (!voices.length) loadVoices();
    speak('Voice alerts are on.');
  });
  for (const button of document.querySelectorAll('[data-test]')) {
    button.addEventListener('click', () => say(TEST_LINES[button.dataset.test]));
  }
  connect({
    open: () => status(voiceOn ? 'Voice is on. Waiting for donations…' : 'Connected. Click "Start voice" to turn the voice on.'),
    hello: (e) => { donationName = e.donation_name; },
    alert: sayAlert,
    dead: () => status("This link doesn't work any more. Copy the current voice link from your dashboard (Stream setup)."),
    retrying: () => status('Connection lost. Reconnecting…'),
  });
}

if (mode === 'voice') startVoice();
else startAlerts();

'use strict';

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);

/** Builds DOM nodes. Strings become text nodes, so merchant data can never inject markup. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return el;
}

class Unauthorized extends Error {}

async function api(path, body) {
  const res = await fetch(`/dashboard-api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/signup')) throw new Unauthorized();
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? `Request failed (${res.status})`), json.error);
  return json;
}

const fractionDigits = (currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits;

function money(minor, currency) {
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() });
  return fmt.format(minor / 10 ** fmt.resolvedOptions().maximumFractionDigits);
}

function compactMoney(minor, currency) {
  const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 });
  return fmt.format(minor / 10 ** fractionDigits(currency));
}

const toMinor = (major, currency) => Math.round(Number(major) * 10 ** fractionDigits(currency));
const toMajor = (minor, currency) => (minor / 10 ** fractionDigits(currency)).toFixed(fractionDigits(currency));

const dateTime = (seconds) =>
  new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function relative(seconds) {
  const diff = seconds - Math.floor(Date.now() / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed; select the text and copy it manually');
  }
}

// ----------------------------------------------------------- status labels

/** Status is always icon + label + color, never color alone. */
function paymentStatus(p) {
  if (p.status === 'succeeded' && p.amount_refunded > 0) {
    return p.amount_refunded >= p.amount_captured ? ['neutral', '↩', 'Refunded'] : ['neutral', '↩', 'Partially refunded'];
  }
  return {
    succeeded: ['good', '✓', 'Succeeded'],
    requires_capture: ['warn', '◷', 'Uncaptured'],
    requires_action: ['neutral', '…', 'Waiting on donor'],
    canceled: ['neutral', '⊘', 'Canceled'],
    requires_payment_method: p.last_error ? ['bad', '✕', 'Failed'] : ['neutral', '○', 'Incomplete'],
  }[p.status];
}

const BALANCE_TYPES = { payment: 'Payment', refund: 'Refund', refund_failure: 'Refund failed', payout: 'Payout' };

function sourceLink(t) {
  if (t.type === 'payment') return h('a', { href: `#/payments/${t.source}` }, h('code', {}, t.source));
  return h('code', {}, t.source);
}

const badge = ([tone, icon, label]) => h('span', { class: `status ${tone}` }, h('span', { 'aria-hidden': 'true' }, icon), label);

function methodLabel(pm) {
  if (!pm) return '—';
  if (pm.type === 'upi') return `UPI · ${pm.upi.vpa ?? 'QR'}`;
  if (pm.type === 'card') return `${pm.card.brand[0].toUpperCase()}${pm.card.brand.slice(1)} •••• ${pm.card.last4}`;
  if (pm.type === 'netbanking') return `Netbanking${pm.bank ? ` · ${pm.bank}` : ''}`;
  if (pm.type === 'wallet') return `Wallet${pm.wallet ? ` · ${pm.wallet}` : ''}`;
  return pm.type === 'emi' ? 'EMI' : pm.type === 'paylater' ? 'Pay later' : 'Other';
}

const REFUND_STATUS = {
  succeeded: ['good', '✓', 'Succeeded'],
  pending: ['warn', '◷', 'Pending'],
  failed: ['bad', '✕', 'Failed'],
};

const EVENT_LABELS = {
  'payment.created': 'Payment created',
  'payment.requires_action': 'Waiting for the donor to approve',
  'payment.authorized': 'Payment authorized',
  'payment.succeeded': 'Payment succeeded',
  'payment.failed': 'Payment attempt failed',
  'payment.canceled': 'Payment canceled',
  'refund.pending': 'Refund requested',
  'refund.succeeded': 'Refund issued',
  'refund.failed': 'Refund failed',
  'payout.paid': 'Payout sent',
};

// -------------------------------------------------------------------- shell

let me = null;
let currentRefresh;
let chartObserver;

function setRefresh(fn) {
  currentRefresh = fn;
}

setInterval(() => {
  if (currentRefresh && document.visibilityState === 'visible' && !$('dialog').open) {
    currentRefresh().catch(handleError);
  }
}, 5000);

function handleError(err) {
  if (err instanceof Unauthorized) return showAuth();
  console.error(err);
  toast(err.message);
}

function showAuth() {
  me = null;
  setRefresh(null);
  $('shell').hidden = true;
  $('auth').hidden = false;
  $('auth-email').focus();
}

async function showShell() {
  me = await api('/me');
  $('auth').hidden = true;
  $('shell').hidden = false;
  $('merchant-name').textContent = me.name;
  $('merchant-email').textContent = me.email;
  refreshStreamingBadges();
  setModeBadge();
  route();
}

/** TEST unless a live Razorpay account is connected: then real money moves. */
function setModeBadge() {
  const live = me?.razorpay?.mode === 'live';
  $('mode-badge').textContent = live ? 'LIVE' : 'TEST';
  $('mode-badge').classList.toggle('live', live);
}

const ROUTES = [
  [/^#\/?$/, 'home', viewHome],
  [/^#\/payments\/?$/, 'payments', viewPayments],
  [/^#\/payments\/([\w]+)$/, 'payments', viewPayment],
  [/^#\/balance\/?$/, 'balance', viewBalance],
  [/^#\/provider\/?$/, 'provider', viewProvider],
  [/^#\/donations\/?$/, 'donations', viewDonations],
  [/^#\/stream\/?$/, 'stream', viewStreamSetup],
];

async function route() {
  if (!me) return;
  const hash = location.hash || '#/';
  const [pattern, nav, view] = ROUTES.find(([re]) => re.test(hash)) ?? ROUTES[0];
  const params = hash.match(pattern)?.slice(1) ?? [];
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  setRefresh(null);
  const container = $('view');
  container.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    await view(container, ...params);
  } catch (err) {
    handleError(err);
    if (!(err instanceof Unauthorized)) container.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('p', { class: 'label' }, label), h('p', { class: 'value' }, value), sub && h('p', { class: 'sub' }, sub));
}

function table(headers, rows, empty) {
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, headers.map(([label, cls]) => h('th', { class: cls }, label)))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'empty', colspan: headers.length }, empty)))));
}

function paymentRow(p) {
  return h('tr', { class: 'clickable', tabindex: '0', onclick: () => { location.hash = `#/payments/${p.id}`; },
    onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#/payments/${p.id}`; } },
    h('td', { class: 'amount' }, money(p.amount, p.currency)),
    h('td', {}, badge(paymentStatus(p))),
    h('td', {}, h('span', { class: 'desc' }, p.description ?? h('span', { class: 'muted' }, p.id))),
    h('td', { class: 'muted' }, methodLabel(p.payment_method)),
    h('td', { class: 'muted num' }, dateTime(p.created)));
}

const PAYMENT_HEADERS = [['Amount', 'amount'], ['Status'], ['Description'], ['Payment method'], ['Date']];

// --------------------------------------------------------------------- home

async function viewHome(container) {
  const render = async () => {
    const o = await api('/overview');
    const cur = o.currency;
    const balance = o.balances.find((b) => b.currency === cur) ?? { available: 0, pending: 0 };
    const chartWrap = h('div', { class: 'chart-wrap' });
    const tableView = h('div', { hidden: true });
    let showTable = false;
    const toggle = h('button', { type: 'button', class: 'small', 'aria-pressed': 'false', onclick: () => {
      showTable = !showTable;
      toggle.setAttribute('aria-pressed', String(showTable));
      toggle.textContent = showTable ? 'View as chart' : 'View as table';
      chartWrap.hidden = showTable;
      tableView.hidden = !showTable;
    } }, 'View as table');

    const days = lastDays(o.days, o.daily);
    tableView.append(table([['Day'], ['Payments', 'amount'], ['Volume', 'amount']],
      days.map((d) => h('tr', {}, h('td', {}, d.label), h('td', { class: 'amount' }, d.count), h('td', { class: 'amount' }, money(d.volume, cur)))), ''));

    container.replaceChildren(
      pageHead('Home', `Last ${o.days} days · ${cur.toUpperCase()}`),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' },
          h('div', {},
            h('p', { class: 'hero-label' }, 'Gross volume'),
            h('p', { class: 'hero num' }, money(o.totals.gross, cur)),
            h('p', { class: 'muted small' }, `${o.totals.succeeded} successful payments · ${money(o.totals.gross - o.totals.fees, cur)} after fees`)),
          toggle),
        chartWrap, tableView),
      h('div', { class: 'tiles' },
        tile('Available to pay out', money(balance.available, cur), h('a', { href: '#/balance' }, 'Balance & payouts →')),
        tile('Pending', money(balance.pending, cur), 'Settling to your balance'),
        tile('Fees', money(o.totals.fees, cur), me.provider === 'razorpay' ? "Razorpay's fees, including GST" : 'Simulator: cards 2% · UPI free'),
        tile('Refunded', money(o.totals.refunded, cur)),
        tile('Failed attempts', String(o.totals.failed), 'Declines, expired UPI requests')),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Recent payments'), h('a', { href: '#/payments' }, 'View all →')),
        table(PAYMENT_HEADERS, o.recent_payments.map(paymentRow), 'No payments yet. Make a purchase in the demo store to see one here.')),
    );
    drawVolumeChart(chartWrap, days, cur);
  };
  await render();
  setRefresh(render);
}

function lastDays(count, daily) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    out.push({
      key,
      label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      volume: row?.volume ?? 0,
      count: row?.count ?? 0,
    });
  }
  return out;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * exp).find((m) => m >= value);
}

/** Single-series column chart: one hue, thin columns with 4px rounded tops, hairline grid, hover tooltip. */
function drawVolumeChart(wrap, days, currency) {
  const draw = () => {
    const width = Math.max(wrap.clientWidth, 280);
    const height = 220;
    const pad = { top: 12, right: 8, bottom: 26, left: 56 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(...days.map((d) => d.volume)));
    const y = (v) => pad.top + plotH - (v / max) * plotH;
    const slot = plotW / days.length;
    const barW = Math.min(24, slot * 0.6);
    const labelEvery = Math.ceil(48 / slot);

    const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': `Daily payment volume, last ${days.length} days` });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg.append(
        s('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }),
        s('text', { class: 'axis-label', x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, i === 0 ? '0' : compactMoney(v, currency)));
    }
    const tip = h('div', { class: 'tooltip', hidden: true });
    days.forEach((d, i) => {
      const cx = pad.left + slot * i + slot / 2;
      const x = cx - barW / 2;
      const top = y(d.volume);
      const barH = pad.top + plotH - top;
      const hover = s('rect', { class: 'slot-hover', x: pad.left + slot * i + 1, y: pad.top, width: slot - 2, height: plotH, opacity: 0 });
      svg.append(hover);
      if (barH > 0) {
        const r = Math.min(4, barH, barW / 2);
        const base = pad.top + plotH;
        svg.append(s('path', { class: 'bar', d: `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z` }));
      }
      if (i % labelEvery === (days.length - 1) % labelEvery) {
        svg.append(s('text', { class: 'axis-label', x: cx, y: height - 8, 'text-anchor': 'middle' }, d.label));
      }
      // The hit target is the whole column slot, much bigger than the bar itself.
      svg.append(s('rect', { class: 'hit', x: pad.left + slot * i, y: pad.top, width: slot, height: plotH,
        onmouseenter: () => {
          hover.setAttribute('opacity', 1);
          tip.replaceChildren(h('strong', {}, money(d.volume, currency)), `${d.label} · ${d.count} payment${d.count === 1 ? '' : 's'}`);
          tip.hidden = false;
          const scale = wrap.clientWidth / width;
          tip.style.left = `${cx * scale}px`;
          tip.style.top = `${Math.min(top, pad.top + plotH - 4) * scale}px`;
        },
        onmouseleave: () => { hover.setAttribute('opacity', 0); tip.hidden = true; } }));
    });
    wrap.replaceChildren(svg, tip);
  };
  draw();
  chartObserver?.disconnect();
  chartObserver = new ResizeObserver(() => draw());
  chartObserver.observe(wrap);
}

// ----------------------------------------------------------------- payments

const FILTERS = [
  ['', 'All'], ['succeeded', 'Succeeded'], ['refunded', 'Refunded'], ['uncaptured', 'Uncaptured'],
  ['failed', 'Failed'], ['incomplete', 'Incomplete'], ['canceled', 'Canceled'],
];
const paymentsState = { status: '', q: '' };

async function viewPayments(container) {
  let rows = [];
  let hasMore = false;
  const tbodyHost = h('div');
  const more = h('button', { type: 'button', hidden: true, onclick: () => load(true).catch(handleError) }, 'Load more');

  async function load(append = false) {
    const params = new URLSearchParams({ limit: '20' });
    if (paymentsState.status) params.set('status', paymentsState.status);
    if (paymentsState.q) params.set('q', paymentsState.q);
    if (append && rows.length) params.set('starting_after', rows.at(-1).id);
    const page = await api(`/payments?${params}`);
    rows = append ? rows.concat(page.data) : page.data;
    hasMore = page.has_more;
    tbodyHost.replaceChildren(table(PAYMENT_HEADERS, rows.map(paymentRow),
      paymentsState.status || paymentsState.q ? 'No payments match these filters.' : 'No payments yet.'));
    more.hidden = !hasMore;
  }

  const segmented = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter by status' },
    FILTERS.map(([value, label]) => h('button', { type: 'button', 'aria-pressed': String(paymentsState.status === value), onclick: (e) => {
      paymentsState.status = value;
      for (const b of segmented.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
      load().catch(handleError);
    } }, label)));
  let debounce;
  const search = h('input', { type: 'search', placeholder: 'Search by ID, description or metadata', value: paymentsState.q,
    'aria-label': 'Search payments',
    oninput: (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { paymentsState.q = e.target.value.trim(); load().catch(handleError); }, 300);
    } });

  container.replaceChildren(
    pageHead('Payments', 'Every payment donors started, including unfinished ones, newest first.'),
    h('section', { class: 'panel' }, h('div', { class: 'toolbar' }, segmented, search), tbodyHost, h('p', {}, more)),
  );
  await load();
  // Only auto-refresh the first page, so "Load more" results don't jump around.
  setRefresh(async () => { if (rows.length <= 20) await load(); });
}

async function viewPayment(container, id) {
  const render = async () => {
    const { payment: p, refunds, events, balance_transactions: bts } = await api(`/payments/${encodeURIComponent(id)}`);
    const cur = p.currency;
    const refundable = p.amount_captured - p.amount_refunded;
    const actions = [];
    if (p.status === 'succeeded' && refundable > 0) {
      actions.push(h('button', { type: 'button', onclick: () => refundDialog(p, refundable, render) }, 'Refund'));
    }
    if (p.status === 'requires_capture') {
      actions.push(h('button', { type: 'button', class: 'primary', onclick: () => captureDialog(p, render) }, 'Capture'));
    }
    if (['requires_payment_method', 'requires_action', 'requires_capture'].includes(p.status)) {
      actions.push(h('button', { type: 'button', class: 'danger', onclick: () => confirmDialog({
        title: 'Cancel this payment?',
        body: p.status === 'requires_capture'
          ? 'The authorization is released and the donor will not be charged.'
          : 'The donor will no longer be able to pay with this checkout link.',
        confirm: 'Cancel payment',
        danger: true,
        action: async () => { await api(`/payments/${p.id}/cancel`, {}); toast('Payment canceled'); await render(); },
      }) }, 'Cancel payment'));
    }

    const metadata = Object.entries(p.metadata);
    container.replaceChildren(
      h('a', { href: '#/payments', class: 'back' }, '← Payments'),
      h('div', { class: 'page-head' },
        h('div', {},
          h('p', { class: 'hero-label' }, 'Payment'),
          h('div', { class: 'actions' }, h('h1', { class: 'num' }, money(p.amount, cur)), badge(paymentStatus(p))),
          h('p', { class: 'muted' }, p.description ?? '')),
        h('div', { class: 'actions' }, actions)),
      h('div', { class: 'detail-grid' },
        h('div', {},
          h('section', { class: 'panel' }, h('h2', {}, 'Timeline'),
            h('ol', { class: 'timeline' }, events.map((e) => h('li', {},
              h('div', {}, EVENT_LABELS[e.type] ?? e.type,
                e.type === 'refund.succeeded' ? ` · ${money(e.data.object.amount, cur)}` : '',
                e.type === 'payment.failed' && e.data.object.last_error ? h('span', { class: 'muted' }, ` · ${e.data.object.last_error.message}`) : ''),
              h('div', { class: 'when' }, `${dateTime(e.created)} · `, h('code', {}, e.type)))))),
          h('section', { class: 'panel' }, h('h2', {}, 'Money movement'),
            table([['Type'], ['Gross', 'amount'], ['Fee', 'amount'], ['Net', 'amount'], ['Available']],
              bts.map((b) => h('tr', {},
                h('td', {}, BALANCE_TYPES[b.type] ?? b.type),
                h('td', { class: 'amount' }, money(b.amount, cur)),
                h('td', { class: 'amount' }, b.fee ? money(-b.fee, cur) : '—'),
                h('td', { class: 'amount' }, money(b.net, cur)),
                h('td', { class: 'muted' }, availability(b.available_on)))),
              'No money has moved yet.')),
          refunds.length ? h('section', { class: 'panel' }, h('h2', {}, 'Refunds'),
            table([['Amount', 'amount'], ['Reason'], ['Status'], ['Date']], refunds.map((r) => h('tr', {},
              h('td', { class: 'amount' }, money(r.amount, cur)),
              h('td', {}, r.reason ? r.reason.replaceAll('_', ' ') : '—'),
              h('td', {}, badge(REFUND_STATUS[r.status] ?? REFUND_STATUS.succeeded)),
              h('td', { class: 'muted' }, dateTime(r.created)))), '')) : null),
        h('section', { class: 'panel' }, h('h2', {}, 'Details'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'ID'), h('dd', {}, h('code', {}, p.id)),
            h('dt', {}, 'Created'), h('dd', {}, dateTime(p.created)),
            h('dt', {}, 'Payment method'), h('dd', {}, methodLabel(p.payment_method)),
            h('dt', {}, 'Processor'), h('dd', {}, p.provider === 'razorpay' ? 'Razorpay' : 'Simulator (test only)'),
            p.razorpay && [h('dt', {}, 'Razorpay order'), h('dd', {}, h('code', {}, p.razorpay.order_id))],
            p.razorpay?.payment_id && [h('dt', {}, 'Razorpay payment'), h('dd', {}, h('code', {}, p.razorpay.payment_id))],
            h('dt', {}, 'Capture'), h('dd', {}, p.capture_method === 'manual' ? 'Manual (authorize first)' : 'Automatic'),
            h('dt', {}, 'Captured'), h('dd', { class: 'num' }, money(p.amount_captured, cur)),
            h('dt', {}, 'Refunded'), h('dd', { class: 'num' }, money(p.amount_refunded, cur)),
            h('dt', {}, 'Fee'), h('dd', { class: 'num' }, p.fee == null ? '—' : money(p.fee, cur)),
            h('dt', {}, 'Net'), h('dd', { class: 'num' }, p.net == null ? '—' : money(p.net, cur)),
            p.last_error && [h('dt', {}, 'Last error'), h('dd', {}, p.last_error.message, ' ', h('code', {}, p.last_error.code))],
            metadata.length && [h('dt', {}, 'Metadata'), h('dd', {}, metadata.map(([k, v]) => h('div', {}, h('code', {}, k), ': ', v)))]))),
    );
  };
  await render();
  setRefresh(render);
}

function availability(availableOn) {
  return availableOn <= Date.now() / 1000 ? 'Available' : `Pending · ${relative(availableOn)}`;
}

// ------------------------------------------------------------------ dialogs

function openDialog(build) {
  const dialog = $('dialog');
  const form = $('dialog-form');
  form.replaceChildren(...build(() => dialog.close()));
  dialog.showModal();
  form.querySelector('input, select, button.primary')?.focus();
}

function dialogFrame({ title, intro, fields = [], confirm, danger, action, close }) {
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: danger ? 'primary danger-fill' : 'primary' }, confirm);
  const form = $('dialog-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      await action();
      close();
    } catch (err) {
      if (err instanceof Unauthorized) { close(); return showAuth(); }
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };
  return [
    h('h2', {}, title),
    intro && h('p', { class: 'muted' }, intro),
    ...fields,
    error,
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', onclick: close }, 'Back'), submit),
  ];
}

const confirmDialog = (opts) => openDialog((close) => dialogFrame({ ...opts, intro: opts.body, close }));

function refundDialog(p, refundable, after) {
  const cur = p.currency;
  const amount = h('input', { type: 'number', min: '0', step: String(1 / 10 ** fractionDigits(cur)), value: toMajor(refundable, cur), required: true });
  const reason = h('select', {},
    h('option', { value: 'requested_by_customer' }, 'Requested by the donor'),
    h('option', { value: 'duplicate' }, 'Duplicate'),
    h('option', { value: 'fraudulent' }, 'Fraudulent'));
  openDialog((close) => dialogFrame({
    title: 'Refund payment',
    intro: `Up to ${money(refundable, cur)} can be refunded. Refunds come out of your balance; the original fee isn't returned.`,
    fields: [h('label', {}, `Amount (${cur.toUpperCase()})`, amount), h('label', {}, 'Reason', reason)],
    confirm: 'Refund',
    close,
    action: async () => {
      const minor = toMinor(amount.value, cur);
      if (!(minor > 0)) throw new Error('Enter an amount greater than zero.');
      await api(`/payments/${p.id}/refund`, { amount: minor, reason: reason.value });
      toast(`Refunded ${money(minor, cur)}`);
      await after();
    },
  }));
}

function captureDialog(p, after) {
  const cur = p.currency;
  const fullOnly = p.provider === 'razorpay';
  const amount = h('input', { type: 'number', min: '0', step: String(1 / 10 ** fractionDigits(cur)), value: toMajor(p.amount_capturable, cur), disabled: fullOnly });
  openDialog((close) => dialogFrame({
    title: 'Capture payment',
    intro: fullOnly
      ? `${money(p.amount_capturable, cur)} is authorized. Razorpay captures the full authorized amount.`
      : `${money(p.amount_capturable, cur)} is authorized. Capture less to release the rest back to the donor.`,
    fields: [h('label', {}, `Amount to capture (${cur.toUpperCase()})`, amount)],
    confirm: 'Capture',
    close,
    action: async () => {
      const minor = toMinor(amount.value, cur);
      await api(`/payments/${p.id}/capture`, { amount: minor });
      toast(`Captured ${money(minor, cur)}`);
      await after();
    },
  }));
}

// ------------------------------------------------------------------ balance

async function viewBalance(container) {
  const render = async () => {
    const b = await api('/balance');
    const delay = b.settlement_delay_seconds;
    const delayText = delay >= 86400 ? `${Math.round(delay / 86400)} days` : delay >= 3600 ? `${Math.round(delay / 3600)} hours` : `${delay} seconds`;
    const balances = b.balances.length ? b.balances : [{ currency: 'inr', available: 0, pending: 0 }];

    const byRazorpay = b.provider === 'razorpay';
    container.replaceChildren(
      pageHead('Balance & payouts', byRazorpay
        ? 'Razorpay settles your money to your bank account itself, usually 2 working days after capture. This page is your own record of it.'
        : `Funds become available ${delayText} after a payment is captured, then you can pay them out to your bank.`),
      ...balances.map((bal) => h('section', { class: 'panel' },
        h('div', { class: 'panel-head' },
          h('h2', {}, `${bal.currency.toUpperCase()} balance`),
          byRazorpay ? h('span', { class: 'muted small' }, 'Payouts: see Settlements in your Razorpay Dashboard') : h('button', { type: 'button', class: 'primary', disabled: bal.available <= 0, onclick: () => confirmDialog({
            title: `Pay out ${money(bal.available, bal.currency)}?`,
            body: 'The full available balance will be sent to HDFC Bank •••• 6789 (simulated).',
            confirm: 'Pay out',
            action: async () => {
              await api('/payouts', { currency: bal.currency });
              toast(`Payout of ${money(bal.available, bal.currency)} sent`);
              await render();
            },
          }) }, 'Pay out now')),
        h('div', { class: 'tiles' },
          tile('Available', money(bal.available, bal.currency), bal.available < 0 ? 'Negative: refunds exceeded your balance' : 'Ready to pay out'),
          tile('Pending', money(bal.pending, bal.currency), 'Still settling'),
          tile('Total', money(bal.available + bal.pending, bal.currency))))),
      h('section', { class: 'panel' }, h('h2', {}, 'Payouts'),
        table([['Amount', 'amount'], ['Status'], ['Destination'], ['Date']], b.payouts.map((po) => h('tr', {},
          h('td', { class: 'amount' }, money(po.amount, po.currency)),
          h('td', {}, badge(['good', '✓', 'Paid'])),
          h('td', {}, po.destination),
          h('td', { class: 'muted' }, dateTime(po.created)))), 'No payouts yet.')),
      h('section', { class: 'panel' }, h('h2', {}, 'Balance history'),
        table([['Type'], ['Source'], ['Gross', 'amount'], ['Fee', 'amount'], ['Net', 'amount'], ['Available'], ['Date']],
          b.balance_transactions.map((t) => h('tr', {},
            h('td', {}, BALANCE_TYPES[t.type] ?? t.type),
            h('td', {}, sourceLink(t)),
            h('td', { class: 'amount' }, money(t.amount, t.currency)),
            h('td', { class: 'amount' }, t.fee ? money(-t.fee, t.currency) : '—'),
            h('td', { class: 'amount' }, money(t.net, t.currency)),
            h('td', { class: 'muted' }, availability(t.available_on)),
            h('td', { class: 'muted' }, dateTime(t.created)))),
          'Nothing yet. Successful payments, refunds and payouts appear here.')),
    );
  };
  await render();
  setRefresh(render);
}

// ----------------------------------------------------------------- provider

async function viewProvider(container) {
  me = await api('/me');
  setModeBadge();
  const rz = me.razorpay;
  const keyId = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: 'rzp_test_...', value: rz?.key_id ?? '' });
  const keySecret = h('input', { type: 'password', autocomplete: 'off', placeholder: rz ? 'Enter it again to change settings' : '' });
  const webhookSecret = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Optional' });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'primary' }, rz ? 'Save' : 'Connect Razorpay');

  const connect = async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      me = await api('/provider/razorpay', {
        key_id: keyId.value.trim(), key_secret: keySecret.value.trim(), webhook_secret: webhookSecret.value.trim() || null,
      });
      toast(`Connected to Razorpay (${me.razorpay.mode} mode)`);
      await viewProvider(container);
    } catch (err) {
      if (err instanceof Unauthorized) return showAuth();
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };

  const status = rz
    ? h('section', { class: 'panel' },
        h('div', { class: 'panel-head' },
          h('h2', {}, 'Razorpay'),
          h('button', { type: 'button', class: 'small danger', onclick: () => confirmDialog({
            title: 'Disconnect Razorpay?',
            body: "New payments go back to the simulator, where no real money moves. You won't be able to refund Razorpay payments until you reconnect.",
            confirm: 'Disconnect',
            danger: true,
            action: async () => { me = await api('/provider/razorpay/disconnect', {}); toast('Razorpay disconnected'); await viewProvider(container); },
          }) }, 'Disconnect')),
        h('div', { class: 'actions' },
          badge(['good', '✓', 'Connected']),
          badge(rz.mode === 'live' ? ['bad', '₹', 'Live: real money'] : ['neutral', '⚙', 'Test mode'])),
        h('dl', { class: 'kv', style: null },
          h('dt', {}, 'Key ID'), h('dd', {}, h('code', {}, rz.key_id)),
          h('dt', {}, 'Webhook'), h('dd', {}, rz.webhook_configured ? 'Secret saved' : 'Not set up (payments are still confirmed by asking Razorpay)')))
    : h('section', { class: 'panel' },
        h('div', { class: 'actions' }, badge(['neutral', '⚙', 'Simulator'])),
        h('p', {}, 'Payments go to the built-in simulator, so no real money moves. Connect your own Razorpay account to take real card, UPI, netbanking and wallet payments.'));

  container.replaceChildren(
    pageHead('Payment provider', 'Who actually moves the money for your payments.'),
    status,
    h('section', { class: 'panel' },
      h('h2', {}, rz ? 'Change Razorpay settings' : 'Connect your Razorpay account'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Sign up at ', h('a', { href: 'https://razorpay.com', target: '_blank', rel: 'noopener' }, 'razorpay.com'),
          '. Test mode works straight away; live payments need your business KYC to be approved by Razorpay.'),
        h('li', {}, 'In the Razorpay Dashboard, open ', h('strong', {}, 'API Keys'), ' (under Account & Settings) and generate a key. Test keys start with ',
          h('code', {}, 'rzp_test_'), '. Paste the Key ID and Key Secret below.'),
        h('li', {}, 'Optional, once this gateway is online at an https:// address: in Razorpay ', h('strong', {}, 'Webhooks'),
          ', add this URL, choose a secret, and select the payment.* and refund.* events. Then paste the same secret below.',
          h('div', { class: 'secret' }, h('code', {}, me.razorpay_webhook_url),
            h('button', { type: 'button', class: 'small', onclick: () => copy(me.razorpay_webhook_url) }, 'Copy')))),
      h('form', { class: 'form-narrow', onsubmit: connect, novalidate: true },
        h('label', {}, 'Key ID', keyId),
        h('label', {}, 'Key Secret', keySecret),
        h('label', {}, 'Webhook secret', webhookSecret),
        error, submit),
      h('p', { class: 'muted small' }, 'Your Key Secret is checked with Razorpay, then stored encrypted. It is never shown again or sent to a browser.')),
    h('section', { class: 'panel test-values' }, h('h2', {}, 'Paying in test mode'),
      h('p', {}, 'Card ', h('code', {}, '4100 2800 0000 1007'), ' (Visa), any future expiry and any CVV. On the bank page, any OTP of 4 to 10 digits succeeds and a shorter one fails.'),
      h('p', { class: 'muted small' }, "Razorpay's test mode lists more cards and UPI options in its documentation under Test Card Details.")),
  );
}

// --------------------------------------------------------------------- auth

let signingUp = false;

function setAuthMode(signup) {
  signingUp = signup;
  $('auth-title').textContent = signup ? 'Create your account' : 'Sign in to your dashboard';
  $('name-field').hidden = !signup;
  $('handle-field').hidden = !signup;
  $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-switch-text').firstChild.textContent = signup ? 'Already have an account? ' : 'New here? ';
  $('auth-switch').textContent = signup ? 'Sign in' : 'Create an account';
  $('auth-error').textContent = '';
}

async function submitAuth(e) {
  e.preventDefault();
  $('auth-submit').disabled = true;
  $('auth-error').textContent = '';
  try {
    const body = { email: $('auth-email').value.trim(), password: $('auth-password').value };
    if (signingUp) {
      await api('/signup', { ...body, name: $('auth-name').value.trim(), handle: $('auth-handle').value.trim() });
      // New accounts start on the setup page.
      history.replaceState(null, '', '#/stream');
      await showShell();
      toast('Welcome! Follow the steps below to get alerts on stream.');
    } else {
      await api('/login', body);
      await showShell();
    }
    $('auth-password').value = '';
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
}

async function main() {
  $('auth-form').addEventListener('submit', submitAuth);
  $('auth-switch').addEventListener('click', (e) => { e.preventDefault(); setAuthMode(!signingUp); });
  $('auth-handle').addEventListener('input', () => {
    $('auth-handle').value = $('auth-handle').value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  });
  $('logout').addEventListener('click', async () => {
    await api('/logout', {}).catch(() => {});
    // Whoever signs in next starts on Home, not on the previous user's page.
    history.replaceState(null, '', '#/');
    showAuth();
  });
  window.addEventListener('hashchange', () => route());
  try {
    await showShell();
  } catch (err) {
    if (err instanceof Unauthorized) showAuth();
    else handleError(err);
  }
}

main();

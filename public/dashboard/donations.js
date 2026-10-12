'use strict';

/*
 * Dashboard pages for donations and stream setup.
 * Loaded before dashboard.js, whose helpers (h, api, money, pageHead, table, …) these call at run time.
 */

const ALERT_STATUS = {
  pending_review: ['warn', '!', 'Needs review'],
  queued: ['neutral', '◷', 'Waiting'],
  shown: ['good', '✓', 'Shown'],
  rejected: ['bad', '✕', 'Hidden'],
  none: ['neutral', '○', 'Not paid'],
};

const inr = (paise) => money(paise, 'inr');

function setNavBadge(id, count, label) {
  const el = $(id);
  el.hidden = !count;
  el.textContent = String(count);
  el.setAttribute('aria-label', label);
}

async function refreshStreamingBadges() {
  try {
    const { queue } = await api('/donations');
    setNavBadge('review-badge', queue.review, `${queue.review} to review`);
  } catch (err) {
    handleError(err);
  }
}

/** A link with Copy (and Open) buttons. Secret links stay hidden until revealed, in case the screen is on stream. */
function linkBox(url, { secret = false, open = true } = {}) {
  const masked = url.replace(/\/overlay\/[^/]+/, '/overlay/••••••••');
  const code = h('code', {}, secret ? masked : url);
  let shown = !secret;
  return h('div', { class: 'secret' }, code,
    secret && h('button', { type: 'button', class: 'small', onclick: (e) => {
      shown = !shown;
      code.textContent = shown ? url : masked;
      e.currentTarget.textContent = shown ? 'Hide' : 'Show';
    } }, 'Show'),
    h('button', { type: 'button', class: 'small', onclick: () => copy(url) }, 'Copy'),
    open && h('a', { class: 'small-link', href: url, target: '_blank', rel: 'noopener' }, 'Open ↗'));
}

/** Runs a dashboard action, shows the outcome, and redraws the page. */
async function act(path, body, message, redraw) {
  try {
    await api(path, body);
    if (message) toast(message);
    await redraw();
    await refreshStreamingBadges();
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- donations

async function viewDonations(container) {
  const render = async () => {
    const [{ data, queue }, profile] = await Promise.all([api('/donations'), api('/profile')]);
    setNavBadge('review-badge', queue.review, `${queue.review} to review`);
    const now = queue.now_showing;
    const reviews = data.filter((d) => d.alert_status === 'pending_review');

    const live = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h2', {}, 'Live alerts'),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'small', onclick: () => act('/alerts/pause', { paused: !queue.paused },
            queue.paused ? 'Alerts resumed' : 'Alerts paused', render) }, queue.paused ? '▶ Resume alerts' : '⏸ Pause alerts'),
          h('button', { type: 'button', class: 'small', disabled: !now, onclick: () => act('/alerts/skip', {}, 'Skipped', render) }, '⏭ Skip'),
          h('button', { type: 'button', class: 'small', onclick: () => act('/alerts/test', { tts: true }, 'Test alert sent', render) }, 'Send test alert'))),
      h('div', { class: 'live-status' },
        h('span', {}, h('span', { class: `dot ${queue.overlays_connected ? 'on' : ''}`, 'aria-hidden': 'true' }),
          queue.overlays_connected ? `Overlay connected` : 'No overlay open'),
        h('span', { class: 'muted' }, `${queue.queued} waiting`),
        queue.paused && badge(['warn', '⏸', 'Paused'])),
      now
        ? h('div', { class: 'now-showing' }, h('strong', {}, `Now showing: ${now.donor_name} · ${inr(now.amount)}`), now.message && h('div', {}, now.message))
        : !queue.overlays_connected
          ? h('p', { class: 'muted small' }, 'Alerts wait here until your overlay is open in OBS. ', h('a', { href: '#/stream' }, 'Set it up →'))
          : null);

    const review = reviews.length ? h('section', { class: 'panel' },
      h('h2', {}, `Needs your review (${reviews.length})`),
      h('p', { class: 'muted small' }, 'These messages had bad words or links, or you chose to approve every message.'),
      reviews.map((d) => h('div', { class: 'review' },
        h('div', { class: 'panel-head' },
          h('strong', {}, `${d.donor_name} · ${inr(d.amount)}`),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'small primary', onclick: () => act(`/donations/${d.id}/approve`, {}, 'Approved: it will play next', render) }, 'Show on stream'),
            h('button', { type: 'button', class: 'small danger', onclick: () => act(`/donations/${d.id}/reject`, {}, 'Hidden from stream', render) }, 'Hide'))),
        h('div', { class: 'msg' }, d.message ? `Will show: “${d.message}”` : 'No message'),
        d.original_message && h('div', { class: 'original msg' }, `They wrote: “${d.original_message}”`)))) : null;

    container.replaceChildren(
      pageHead('Donations', 'Every paid donation, newest first. Alerts play on your stream one at a time.'),
      live,
      review,
      h('section', { class: 'panel' },
        h('h2', {}, 'Your donation page'),
        h('p', { class: 'muted small' }, 'Share this link with your viewers, for example in your stream description or chat.'),
        linkBox(profile.donation_url)),
      h('section', { class: 'panel' }, h('h2', {}, 'All donations'),
        table([['When'], ['From'], ['Amount', 'amount'], ['Message'], ['On stream'], ['']],
          data.map((d) => h('tr', {},
            h('td', { class: 'muted num' }, dateTime(d.paid_at)),
            h('td', {}, d.donor_name),
            h('td', { class: 'amount' }, inr(d.amount)),
            h('td', {}, h('div', { class: 'msg' }, d.message || h('span', { class: 'muted' }, '—'))),
            h('td', {}, badge(ALERT_STATUS[d.alert_status])),
            h('td', {},
              d.alert_status === 'pending_review'
                ? h('button', { type: 'button', class: 'small', onclick: () => act(`/donations/${d.id}/approve`, {}, 'Approved', render) }, 'Approve')
                : d.alert_status === 'shown' || d.alert_status === 'rejected'
                  ? h('button', { type: 'button', class: 'small', onclick: () => act(`/donations/${d.id}/replay`, {}, 'Will play again', render) }, 'Replay')
                  : null))),
          'No donations yet. Share your donation page with your viewers!')),
    );
  };
  await render();
  setRefresh(render);
}

// ------------------------------------------------------------- stream setup

async function viewStreamSetup(container) {
  const render = async () => {
    const p = await api('/profile');
    const field = (label, input, hint) => h('label', {}, label, input, hint && h('span', { class: 'field-hint' }, hint));

    const name = h('input', { value: p.display_name, maxlength: '60' });
    const handle = h('input', { value: p.handle, maxlength: '30', autocapitalize: 'none', spellcheck: 'false' });
    const bio = h('input', { value: p.bio ?? '', maxlength: '300', placeholder: 'e.g. Valorant every night at 9 PM' });
    const pageError = h('p', { class: 'error', role: 'alert' });

    const minAmount = h('input', { type: 'number', min: '1', step: '1', value: String(p.min_amount / 100) });
    const ttsOn = h('input', { type: 'checkbox', checked: p.tts_enabled });
    const ttsMin = h('input', { type: 'number', min: '0', step: '1', value: String(p.tts_min_amount / 100) });
    const seconds = h('input', { type: 'number', min: '3', max: '30', step: '1', value: String(p.alert_seconds) });
    const donationName = h('input', { value: p.donation_name, maxlength: '30', required: true });
    const donationNameHint = h('span', { class: 'field-hint' });
    const sayDonationName = () => {
      const name = donationName.value.trim() || p.donation_name;
      donationNameHint.textContent = `Alerts show “Rahul sent a ₹500 ${name}”. The voice says “Rahul sent a five hundred rupee ${name}.” and then reads the message.`;
    };
    donationName.addEventListener('input', sayDonationName);
    sayDonationName();
    const modAuto = h('input', { type: 'radio', name: 'moderation', value: 'auto', checked: p.moderation === 'auto' });
    const modManual = h('input', { type: 'radio', name: 'moderation', value: 'manual', checked: p.moderation === 'manual' });
    const blocked = h('textarea', { rows: '2', placeholder: 'Extra words to block, separated by commas' }, p.blocked_words);
    const settingsError = h('p', { class: 'error', role: 'alert' });

    const save = async (body, errorEl, message) => {
      errorEl.textContent = '';
      try {
        await api('/profile', body);
        toast(message);
        await render();
      } catch (err) {
        if (err instanceof Unauthorized) return showAuth();
        errorEl.textContent = err.message;
      }
    };

    container.replaceChildren(
      pageHead('Stream setup', 'Three steps to take donations and show them on your stream.'),

      h('section', { class: 'panel step' }, h('span', { class: 'step-num' }, '1'), h('div', {},
        h('h2', {}, 'Share your donation page'),
        h('p', { class: 'muted small' }, 'Viewers fill in their name, amount, payment method and a message here.'),
        linkBox(p.donation_url),
        h('form', { class: 'settings-grid', novalidate: true, onsubmit: (e) => {
          e.preventDefault();
          save({ display_name: name.value.trim(), handle: handle.value.trim(), bio: bio.value.trim() || null }, pageError, 'Page saved');
        } },
          field('Channel name', name),
          field('Page name', handle, 'Changing it changes your link.'),
          field('About you', bio),
          h('div', {}, pageError, h('button', { type: 'submit', class: 'primary' }, 'Save'))))),

      h('section', { class: 'panel step' }, h('span', { class: 'step-num' }, '2'), h('div', {},
        h('h2', {}, 'Show alerts in OBS'),
        h('ol', { class: 'steps' },
          h('li', {}, 'In OBS, under ', h('strong', {}, 'Sources'), ', click ', h('strong', {}, '+'), ' and choose ', h('strong', {}, 'Browser'), '.'),
          h('li', {}, 'Paste this link as the URL, and set Width ', h('strong', {}, '1920'), ' and Height ', h('strong', {}, '1080'), '.')),
        linkBox(p.overlay_urls.alerts, { secret: true }),
        h('p', {}, h('button', { type: 'button', onclick: () => act('/alerts/test', { tts: true }, 'Test alert sent: check OBS', async () => {}) }, 'Send a test alert')))),

      h('section', { class: 'panel step' }, h('span', { class: 'step-num' }, '3'), h('div', {},
        h('h2', {}, 'Turn on the voice'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Open this link in ', h('strong', {}, 'Microsoft Edge or Google Chrome'), ' and click ', h('strong', {}, 'Start voice'), '. Keep the tab open.'),
          h('li', {}, 'In OBS, add an ', h('strong', {}, 'Application Audio Capture'), ' source and choose that browser window.')),
        linkBox(p.overlay_urls.voice, { secret: true }),
        h('p', { class: 'muted small' }, "OBS's Browser source can't speak by itself, which is why the voice runs in a normal browser tab."))),

      h('section', { class: 'panel' },
        h('h2', {}, 'Alert settings'),
        h('form', { novalidate: true, onsubmit: (e) => {
          e.preventDefault();
          save({
            min_amount: toMinor(minAmount.value, 'inr'),
            tts_enabled: ttsOn.checked,
            tts_min_amount: toMinor(ttsMin.value || '0', 'inr'),
            alert_seconds: Number(seconds.value),
            donation_name: donationName.value.trim() || p.donation_name,
            moderation: modManual.checked ? 'manual' : 'auto',
            blocked_words: blocked.value,
          }, settingsError, 'Settings saved');
        } },
          h('div', { class: 'settings-grid' },
            field('Smallest donation (₹)', minAmount),
            field('Show each alert for at least (seconds)', seconds),
            h('label', {}, 'Name for a donation', donationName, donationNameHint),
            h('div', {},
              h('label', { class: 'inline' }, ttsOn, 'Read messages aloud'),
              field('…for donations of at least (₹)', ttsMin))),
          h('fieldset', { class: 'radio-group' },
            h('legend', { class: 'label-like' }, 'Checking messages'),
            h('label', { class: 'inline' }, modAuto, 'Hold only messages with bad words or links (recommended)'),
            h('label', { class: 'inline' }, modManual, 'I want to approve every message')),
          field('Blocked words', blocked, 'Common swear words in English and Hindi are already blocked.'),
          settingsError,
          h('button', { type: 'submit', class: 'primary' }, 'Save settings'))),

      h('section', { class: 'panel' },
        h('h2', {}, 'Keep your overlay links private'),
        h('p', { class: 'muted small' }, 'Anyone with these links can see your alerts. If one leaks, get new ones; then update the links in OBS.'),
        h('button', { type: 'button', class: 'danger', onclick: () => confirmDialog({
          title: 'Get new overlay links?',
          body: 'Your current alerts and voice links stop working straight away. You will need to paste the new ones into OBS and your browser.',
          confirm: 'Get new links',
          danger: true,
          action: async () => { await api('/profile/overlay-token/rotate', {}); toast('New links ready'); await render(); },
        }) }, 'Get new links…')),
    );
  };
  await render();
}

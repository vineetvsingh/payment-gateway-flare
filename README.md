# Stream Donations

A donation site for live streamers, set up for [VineTheGamer](https://www.youtube.com/@VineTheGamer).
Viewers donate with a message, and the message pops up on the stream and is read aloud.

```
viewer: /donate/<streamer>   name, amount, payment method, message
   -> secure checkout (UPI / card, through Razorpay or the test-mode simulator)
   -> payment confirmed by the server -> message filtered -> queued (or held for review)
   -> OBS overlay shows the alert, the voice tab reads it aloud, one alert at a time
```

It runs on a small payment gateway of its own: payments, refunds, a double-entry ledger with fees and
balances, and 3-D Secure. That gateway runs in two modes:

- **Test mode (simulator)**, the default: no real money moves. Test cards and UPI IDs let you try every flow.
- **Razorpay**: each streamer connects **their own** Razorpay account, and real payments go
  through it. See [Real payments with Razorpay](#real-payments-with-razorpay).

## Quick start

Requires Node.js 22.13+ (it uses the built-in `node:sqlite`, so nothing needs compiling).

```bash
npm install
npm run demo        # open http://localhost:3000/donate/vinethegamer
npm test            # 69 tests
npm start           # the real server; settings come from .env (see .env.example)
```

The demo starts with the **VineTheGamer** account already created. It keeps everything in memory, so
each run starts fresh. It prints:

- **Donation page:** http://localhost:3000/donate/vinethegamer
- **Dashboard:** http://localhost:3000/dashboard, as `vinethegamer@demo.example` / `vine-demo-123`
- **OBS links:** the alerts and voice links, also shown under **Stream setup**.

Change the channel name or add a description under **Dashboard → Stream setup**.

In the demo, donations become available for payout after 30 seconds instead of 2 days. Set `PORT` if 3000 is taken.

## For streamers

Sign up at `/dashboard` and pick a page name. Then open **Stream setup**:

1. **Share your donation page**, `/donate/<your page name>`. Viewers fill in their name (or stay
   anonymous), an amount, a payment method and a message, then press one Donate button. Next to the
   form, a live preview shows exactly how their alert will look on stream as they type.
2. **Show alerts in OBS.** Add a **Browser** source with the alerts link, at 1920×1080. The page is
   transparent, so only the alert card shows.
3. **Turn on the voice.** Open the voice link in **Edge or Chrome** and click **Start voice**. In OBS,
   add **Application Audio Capture** and choose that browser window. OBS's own Browser source has no
   text-to-speech voices, so the voice runs in a normal browser tab. Edge and Chrome include Indian
   English and Hindi voices.

How alerts behave:

- **Paid only.** An alert exists only once the server has confirmed the payment, so nobody can put a
  message on stream without paying.
- **One at a time,** in the order they were paid. The server keeps the clock, so the overlay and the voice
  stay in step, and a reloaded overlay picks up the alert that's showing. Alerts wait
  while no overlay is open or while they're paused.
- **Messages are checked.** Swear words (English and Hindi, including disguised ones like `sh1t` or
  `f.u.c.k`) are masked, links removed, and repeated letters shortened. Any message that needed this
  is **held for review**. You can add your own blocked words, or approve every message by hand.
- **Read aloud** only for donations of at least ₹50 (adjustable). Smaller ones are shown without speech.
  The voice says "Rahul sent a five hundred rupee Flare." and then reads the message: English messages with an Indian English
  voice, Hindi and Hinglish ones with a Hindi voice (Hinglish words are rewritten in Devanagari so they're
  pronounced properly). On screen the alert says "Rahul sent a ₹500 Flare". "Flare" can be renamed
  under **Stream setup → Alert settings**.
- **From the Donations page** you can pause, skip, replay, send a test alert, and approve or hide held
  messages. **Payments** and **Balance & payouts** show the money side: refunds, fees, balance history.
- **Overlay links are secret.** They contain a token, are hidden on the dashboard until you click Show,
  and can be replaced if one leaks.

**Before taking real donations:** your Razorpay account must be approved for this kind of income, and
donations are generally taxable income for the streamer.

## Test mode: cards and UPI

These work on the checkout page whenever Razorpay isn't connected. The checkout lists them too.

**Cards:** use any future expiry date and any CVC (4 digits for Amex).

| Number | Result |
|---|---|
| `4242 4242 4242 4242` | Visa, succeeds |
| `5555 5555 5555 4444` | Mastercard, succeeds |
| `3782 822463 10005` | Amex, succeeds |
| `6080 0000 0000 0018` | RuPay, succeeds |
| `4000 0000 0000 3220` | Requires 3-D Secure (a fake bank page asks you to approve) |
| `4000 0000 0000 0002` | Generic decline |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0069` | Expired card |
| `4000 0000 0000 0127` | Incorrect CVC |
| `4100 0000 0000 0019` | Blocked as fraudulent |
| `4000 0000 0000 0119` | Processing error |

**UPI:** enter a UPI ID, or choose **Show QR code**. A link opens a **simulated UPI app** standing in
for the payer's phone. Enter any 4 or 6 digit PIN there to approve, and the checkout notices by itself.

| UPI ID | Result |
|---|---|
| `success@upi` | Request sent; approve it in the simulated app |
| `nofunds@upi` | Approval fails with insufficient funds |
| `failure@upi` | Payer's bank declines immediately |
| `invalid@upi` | UPI ID doesn't exist (caught before a request is sent) |
| anything else valid | Approve or decline it yourself in the simulated app |

UPI requests expire after 5 minutes (`UPI_EXPIRY_SECONDS`). The QR code points at the simulator, not a
`upi://pay` link, so a real UPI app can never send money to a made-up UPI ID.

Fees in test mode: cards 2%, UPI free (India's zero-fee rule for UPI).

## Real payments with Razorpay

Code alone can't make a site that collects real money. That needs an RBI payment aggregator licence,
a partner bank, PCI DSS certification and card-network tokenization. So **each streamer
connects their own Razorpay account**. Razorpay is the licensed aggregator: it collects the card or UPI
details in its own checkout window and pays out to their bank. This site keeps its donations, ledger,
refunds and dashboard in step with Razorpay.

Taking payments for other people through one account is payment aggregation, which needs that licence and
breaks Razorpay's terms. That's why every account connects its own.

### Try it in test mode (no real money)

1. Sign up at [razorpay.com](https://razorpay.com). Test mode works immediately, with no KYC.
2. In the Razorpay Dashboard, open **API Keys** (under Account & Settings) and generate a test key.
3. Copy `.env.example` to `.env`, then fill in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
4. Run `npm run demo` and donate. Razorpay's window opens. Pay with test card `4100 2800 0000 1007`, any
   future expiry and any CVV. Then on the bank page enter any OTP of 4 to 10 digits.

`npm start` uses the same keys: they're connected to your account (the one named by `CHANNEL_HANDLE`, or
the only account on the site) every time the server starts, or as soon as you sign up. Any other account
connects Razorpay under **Dashboard → Payment provider**.

`npm run demo` and `npm start` differ only where the demo is meant to be throwaway: the demo keeps
everything in memory (so its donations and OBS links reset on every restart), signs you in with a demo
login, and makes donations available for payout after 30 seconds. `npm start` saves everything in
`DB_PATH`.

### How it stays correct

- **No card numbers here.** Razorpay's window collects them. This site stores only the card network and
  last 4 digits Razorpay reports.
- **The browser is never trusted.** The success callback's signature is checked
  (`HMAC-SHA256(order_id|payment_id, key secret)`), but a donation counts only once Razorpay's API
  confirms it, server to server. Razorpay's own fee (including GST) goes into the ledger.
- **Nothing is lost if the tab closes.** A background job asks Razorpay about unfinished payments from
  the last day every 30 seconds (`PROVIDER_SYNC_INTERVAL_MS`), and about pending refunds.
- **Webhooks (optional, once online).** In Razorpay's **Webhooks** settings, add
  `https://<your site>/webhooks/razorpay/<account id>` (shown on the Payment provider page) with the
  `payment.*` and `refund.*` events, and save the same secret in the dashboard. Signatures are checked
  with `X-Razorpay-Signature`, and duplicate events are ignored.
- **Refunds** can stay `pending` for a few days. If one fails, the money goes back to the balance.
  Razorpay pays out to the bank by itself, so the site's own payout button is off.
- **Rate limits.** If Razorpay says "too many requests", the request is retried after a short wait.
- **Keys:** the key secret is checked with Razorpay, stored encrypted with `VAULT_KEY`, and never sent
  to a browser.

### Going live

Real money moves only when **all** of these are true:

1. **Razorpay has activated the account** after KYC (PAN, bank account, website).
2. **The site is online at an https:// address**, with `BASE_URL` set to it. Live keys are refused
   otherwise.
3. **Live keys** (`rzp_live_...`) are connected. The dashboard badge then changes from TEST to LIVE.

## Deploying online

Viewers need to reach the donation page, so the site has to be online at an **https://** address.

### Free: from your own PC with ngrok

The server runs on your streaming PC, and [ngrok](https://ngrok.com) (free account) gives it a fixed public
https address. The donation page works while your PC is on and the site is running.

1. Install ngrok (`winget install Ngrok.Ngrok`), sign up at ngrok.com, and run
   `ngrok config add-authtoken <your token>` once. Your free address is under **Domains** in the ngrok
   dashboard, like `https://<three-words>.ngrok-free.dev`.
2. In `.env`, set:
   - `BASE_URL=https://<three-words>.ngrok-free.dev`
   - `SIGNUPS=closed`, so only your own account can exist on the site
   - `OVERLAY_BASE_URL=http://localhost:3000`, so OBS and the voice tab load alerts from your PC directly
3. Double-click **`go-live.cmd`**. It starts the server and the tunnel. Close both windows to go offline.
4. In the dashboard (**Stream setup**), copy the OBS and voice links again: they now start with
   `http://localhost:3000`.

On ngrok's free plan, each new visitor first sees an ngrok notice ("You are about to visit…") and clicks
**Visit Site** once. OBS never sees it, because it uses the local links.

### On a server It's a
single Node.js process with a SQLite database file, packaged by the `Dockerfile`. Any host that runs a
Docker container with a **persistent volume** works, for example Railway, Render (paid plan, for the
disk) or Fly.io.

1. Create a service from this repository, using the Dockerfile.
2. Mount a persistent volume at `/data`. The database lives at `/data/gateway.db`.
3. Set these environment variables:
   - `BASE_URL`: your https address
   - `VAULT_KEY`: 64 hex characters; see `.env.example`. Keep it forever, or saved Razorpay keys can't
     be read.
   - `TRUST_PROXY=1`, already set in the Dockerfile
   - `SIGNUPS=closed`, so nobody else can sign up after you
4. Open `https://<your address>/dashboard`, sign up, and connect Razorpay under **Payment provider**.

Notes:
- **Keep one instance running.** Live overlays and the alert queue run inside the process, so don't run
  several copies, and choose a plan that doesn't sleep when idle.
- **Back up the database file** regularly.

## Project structure

```
src/
  index.ts            starts the server and background jobs
  app.ts              puts the routes together (the URL map is at the top)
  config.ts  db.ts    settings from the environment; SQLite with versioned migrations
  jobs.ts             UPI request expiry, Razorpay reconciliation
  lib/                errors, ids, password hashing
  payments/           the gateway: payment states, card vault, simulated card network and UPI,
                      Razorpay client, ledger and fees, event log
  donations/          profiles and donations; alerts.ts plays alerts live to OBS;
                      moderation.ts filters messages
  routes/             HTTP: checkout, dashboard, donation page and overlay API, HTML pages
public/
  donate/             the donation page
  overlay/            OBS alerts and voice (one page, two modes)
  checkout/           where donors pay
  dashboard/          the streamer dashboard
  fonts/              Bricolage Grotesque (SIL Open Font License), used by the donation page
  test-mode/          the fake bank (3-D Secure) and fake UPI app screens
examples/demo.ts      the demo, set up for VineTheGamer
test/                 tests, plus a fake Razorpay server
```

Design decisions worth noticing:

- **Every state change is a compare-and-set** (`UPDATE ... WHERE status = ?`) inside a transaction.
  Refunds use a guarded update so they can never exceed what was paid.
- **A donation becomes "paid" in the same database transaction as its payment**, so the two can never
  disagree.
- **Network calls to Razorpay happen outside database transactions,** and everything they report is
  checked again inside one.
- **Every money movement is a double-entry ledger transaction** (debits equal credits). The tests check
  this after every scenario.
- **Dashboard logins** use HttpOnly, SameSite=Strict session cookies (only a hash of the token is
  stored). Passwords are hashed with scrypt, and logins and donations are rate-limited.
- **Every page has a strict Content-Security-Policy** with no inline scripts or styles. The checkout
  additionally allows Razorpay's script and window.

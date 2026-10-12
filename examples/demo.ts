/**
 * Starts the donation site for VineTheGamer (https://www.youtube.com/@VineTheGamer) with an in-memory
 * database, so everything can be tried straight away:
 *
 *   npm run demo   ->  open http://localhost:3000/donate/vinethegamer
 *
 * Donations become available for payout after 30 seconds instead of 2 days. With RAZORPAY_KEY_ID and
 * RAZORPAY_KEY_SECRET (test keys) in .env, payments go through Razorpay's test checkout instead of the
 * built-in simulator. Set PORT if 3000 is taken.
 */
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { startBackgroundJobs } from '../src/jobs.js';
import { connectOwnerRazorpay } from '../src/owner-razorpay.js';
import { Vault } from '../src/payments/vault.js';

const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
const LOGIN = { email: 'vinethegamer@demo.example', password: 'vine-demo-123' };

const config = loadConfig({ SETTLEMENT_DELAY_SECONDS: '30', ...process.env, DB_PATH: ':memory:', BASE_URL: BASE });
const db = new Db(config.dbPath);
const { app, gateway, donations } = createApp(db, new Vault(config.vaultKey), config);

// The demo account. Change the name or add a description under Dashboard -> Stream setup.
const streamer = donations.signup({ name: 'VineTheGamer', email: LOGIN.email, password: LOGIN.password, handle: 'vinethegamer' });

// The same as `npm start`: the Razorpay keys in .env go to this account.
const payments = await connectOwnerRazorpay(donations, { ...process.env, CHANNEL_HANDLE: 'vinethegamer' });

// Razorpay's webhooks can't reach localhost, so ask Razorpay about unfinished payments every 5 seconds.
startBackgroundJobs(gateway, 500, 5000);

const overlay = donations.overlayUrls(donations.profileOf(streamer.id)!);
app.listen(PORT, () => {
  console.log(`Donation page:   ${BASE}/donate/vinethegamer   <- share this with viewers`);
  console.log(`Dashboard:       ${BASE}/dashboard   (${LOGIN.email} / ${LOGIN.password})`);
  console.log(`OBS alerts:      ${overlay.alerts}`);
  console.log(`Voice (browser): ${overlay.voice}`);
  console.log(`Payments:        ${payments}`);
});

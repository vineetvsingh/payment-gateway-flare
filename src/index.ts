import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { startBackgroundJobs } from './jobs.js';
import { connectOwnerRazorpay } from './owner-razorpay.js';
import { Vault } from './payments/vault.js';

const config = loadConfig();
const db = new Db(config.dbPath);
const { app, gateway, donations } = createApp(db, new Vault(config.vaultKey), config);

// Your own Razorpay keys from .env, the same way `npm run demo` uses them. If your account doesn't exist
// yet, they're connected as soon as you sign up.
let ownerConnected = Boolean(donations.ownerProfile(process.env.CHANNEL_HANDLE));
console.log(`Payments: ${await connectOwnerRazorpay(donations)}`);
donations.onSignup(() => {
  if (ownerConnected || !donations.ownerProfile(process.env.CHANNEL_HANDLE)) return;
  ownerConnected = true;
  void connectOwnerRazorpay(donations).then((line) => console.log(`Payments: ${line}`));
});

const server = app.listen(config.port, () => {
  console.log(`Donations server listening on ${config.baseUrl}`);
  console.log(`Dashboard (sign up / log in): ${config.baseUrl}/dashboard`);
});
const stopJobs = startBackgroundJobs(gateway, config.jobIntervalMs, config.providerSyncIntervalMs);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopJobs();
    donations.hub.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

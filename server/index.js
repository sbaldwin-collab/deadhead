import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};
const app = createApp(cfg, { log });

if (!cfg.stripeKey) log.warn("STRIPE_SECRET_KEY not set: bookings run in request mode (no card payment).");
else if (!cfg.stripeWebhookSecret) log.warn("STRIPE_WEBHOOK_SECRET not set: payments rely on the traveler returning from Checkout. Set it for reliable confirmation.");
if (!cfg.resendKey) log.warn("RESEND_API_KEY not set: emails are logged, not sent.");
if (!cfg.adminEmails.length) log.warn("ADMIN_EMAILS not set: nobody can verify operators until you add your email.");

app.server.listen(cfg.port, () => log.info(`${cfg.brand} listening on :${cfg.port} (${cfg.baseUrl})`));
const timer = setInterval(() => app.sweep().catch(err => log.error("[sweep]", err.message)), 60_000);

function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  clearInterval(timer);
  app.server.close(() => { app.db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

import fs from "node:fs";
import path from "node:path";

// Load .env if present (simple KEY=VALUE lines). Real environment variables win.
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const e = process.env;
const num = (v, d) => (v === undefined || v === "" || isNaN(+v) ? d : +v);

export function loadConfig(overrides = {}) {
  const baseUrl = (overrides.baseUrl ?? e.BASE_URL ?? `http://localhost:${num(e.PORT, 8080)}`).replace(/\/$/, "");
  return {
    port: num(e.PORT, 8080),
    baseUrl,
    secureCookies: baseUrl.startsWith("https://"),
    databaseFile: e.DATABASE_FILE || "./data/deadhead.db",
    adminEmails: (e.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    brand: e.BRAND_NAME || "Deadhead",
    supportEmail: e.SUPPORT_EMAIL || "",
    supportPhone: e.SUPPORT_PHONE || "",
    feePct: num(e.PLATFORM_FEE_PCT, 5),
    confirmWindowHours: num(e.CONFIRM_WINDOW_HOURS, 48),
    stripeKey: e.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET || "",
    stripeApiBase: e.STRIPE_API_BASE || "https://api.stripe.com",
    resendKey: e.RESEND_API_KEY || "",
    emailFrom: e.EMAIL_FROM || "Deadhead <bookings@example.com>",
    trustProxy: e.TRUST_PROXY === "1",
    ...overrides,
  };
}

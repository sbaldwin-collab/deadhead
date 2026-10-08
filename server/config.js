// Build runtime config from an environment object (process.env on Node, `env` on Cloudflare).
const num = (v, d) => (v === undefined || v === "" || isNaN(+v) ? d : +v);

export function configFromEnv(e = {}, overrides = {}) {
  const baseUrl = (overrides.baseUrl ?? e.BASE_URL ?? "").replace(/\/$/, "");
  return {
    port: num(e.PORT, 8080),
    baseUrl, // empty = use the origin of incoming requests
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
    emailFrom: e.EMAIL_FROM || "Deadhead <onboarding@resend.dev>",
    pepper: e.PASSWORD_PEPPER || "",
    ...overrides,
  };
}

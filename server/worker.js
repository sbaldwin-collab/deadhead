// Cloudflare Workers entry. Static files in public/ are served by Workers Static Assets;
// /api/* and /healthz run here against D1. A cron trigger runs the minute-by-minute sweep.
import { configFromEnv } from "./config.js";
import { makeD1Db } from "./db.js";
import { createApp } from "./core.js";
import { makeStripe } from "./stripe.js";
import { makeMailer } from "./email.js";

let app = null;
function getApp(env) {
  if (!app) {
    const cfg = configFromEnv(env);
    app = createApp(cfg, { db: makeD1Db(env.DB), stripe: makeStripe({ key: cfg.stripeKey, base: cfg.stripeApiBase }), mail: makeMailer(cfg, console), log: console });
  }
  return app;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/healthz") return getApp(env).handle(request, { ip: request.headers.get("cf-connecting-ip") || "?" });
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(getApp(env).sweep());
  },
};

// Node 22+ entry: serves public/ and the API from one process, with SQLite on disk.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configFromEnv } from "./config.js";
import { makeNodeDb } from "./db.js";
import { createApp, SECURITY_HEADERS } from "./core.js";
import { makeStripe } from "./stripe.js";
import { makeMailer } from "./email.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

function loadDotEnv() {
  const f = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || path.basename(file).startsWith("_")) { res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SECURITY_HEADERS); return res.end("Not found"); }
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  });
}

/** Wrap an app (from createApp) in a Node HTTP server. */
export function createNodeServer(app, { trustProxy = false, log = console } = {}) {
  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const pathname = new URL(req.url, "http://x").pathname;
    try {
      if (!pathname.startsWith("/api/") && pathname !== "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, pathname);
      }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 1_000_000) { res.writeHead(413); return res.end(); } chunks.push(c); }
      const proto = (trustProxy && req.headers["x-forwarded-proto"]) || "http";
      const request = new Request(`${proto}://${req.headers.host || "localhost"}${req.url}`, {
        method: req.method, headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]])),
        body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const ip = (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
      const response = await app.handle(request, { ip });
      const headers = {};
      response.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
      const cookies = response.headers.getSetCookie(); if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      if (pathname !== "/healthz") log.info?.(`${req.method} ${pathname} ${response.status} ${Date.now() - t0}ms`);
    } catch (err) {
      log.error?.(`[node] ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Something went wrong on our side." }));
    }
  });
}

async function main() {
  loadDotEnv();
  const cfg = configFromEnv(process.env);
  const log = { info: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), ...a), error: (...a) => console.error(new Date().toISOString(), ...a) };
  const db = await makeNodeDb(cfg.databaseFile);
  const app = createApp(cfg, { db, stripe: makeStripe({ key: cfg.stripeKey, base: cfg.stripeApiBase }), mail: makeMailer(cfg, log), log });
  if (!cfg.stripeKey) log.warn("STRIPE_SECRET_KEY not set: bookings run in request mode (no card payment).");
  if (!cfg.resendKey) log.warn("RESEND_API_KEY not set: emails are logged, not sent.");
  if (!cfg.adminEmails.length) log.warn("ADMIN_EMAILS not set: the first account to sign up becomes the desk admin.");
  const server = createNodeServer(app, { trustProxy: process.env.TRUST_PROXY === "1", log });
  server.listen(cfg.port, () => log.info(`${cfg.brand} listening on :${cfg.port}`));
  const timer = setInterval(() => app.sweep().catch(err => log.error("[sweep]", err.message)), 60_000);
  const stop = sig => { log.info(`${sig}: shutting down`); clearInterval(timer); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

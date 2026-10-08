// Deadhead application core. Runtime-agnostic: takes a standard Request, returns a Response.
// Used by server/node.js (Node 22 + node:sqlite) and server/worker.js (Cloudflare Workers + D1).
import { randomId, sha256Hex, hashPassword, verifyPassword } from "./crypto.js";
import { verifyWebhook } from "./stripe.js";
import { AP, CL, nm, localToUtc, fmtAt, usd, legBlock, legRetail } from "../public/shared/ref.js";
import { search, publicLeg, benchmark, validateItinerary } from "./search.js";

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => new HttpError(400, msg);

const SID = "dh_sid";
const SESSION_DAYS = 30;
const CHECKOUT_MINUTES = 31;          // Stripe's minimum Checkout lifetime is 30 minutes
const WINDOWS = [0, 2, 4, 8, 24];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const validEmail = e => typeof e === "string" && EMAIL_RE.test(e.trim());
const validPassword = p => typeof p === "string" && p.length >= 10 && p.length <= 200;
const qs = n => Array(n).fill("?").join(",");

const str = (v, max, { required = true, label = "This field" } = {}) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw bad(`${label} is required.`);
  if (s.length > max) throw bad(`${label} must be ${max} characters or fewer.`);
  return s;
};
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
  return n;
};

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}
const cookie = (value, maxAge, secure) => `${SID}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

/** Fixed-window limiter, in memory (per process / per isolate). */
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    let v = hits.get(key);
    if (!v || v.reset < now) { v = { n: 0, reset: now + windowMs }; hits.set(key, v); }
    if (++v.n > max) throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
  };
}

/* ------------ routing ------------ */
function router() {
  const routes = [];
  const add = method => (pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    routes.push({ method, re, keys, handler });
  };
  return {
    get: add("GET"), post: add("POST"), put: add("PUT"), del: add("DELETE"),
    match(method, path) {
      for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(path); if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; }
      return null;
    },
  };
}

export function createApp(cfg, { db, stripe = null, mail, log = console }) {
  const r = router();
  const authLimit = limiter(20, 15 * 60000);
  const bookLimit = limiter(30, 60 * 60000);
  const busy = new Set();
  const state = { base: cfg.baseUrl || "", baseSaved: false };
  const link = hash => `${state.base}/#${hash}`;
  const feeFor = subtotal => Math.round(subtotal * cfg.feePct / 100);
  const isAdmin = u => !!u && (u.role === "admin" || cfg.adminEmails.includes(u.email));

  async function rememberBase(origin) {
    if (cfg.baseUrl || state.baseSaved || !origin) return;
    if (state.base !== origin) { state.base = origin; await db.run("INSERT INTO meta(k,v) VALUES('base_url',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", origin); }
    state.baseSaved = true;
  }

  /* ------------ sessions ------------ */
  async function createSession(userId) {
    const token = randomId(32);
    await db.run("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)", await sha256Hex(token), userId, Date.now() + SESSION_DAYS * 864e5);
    return token;
  }
  async function userForToken(token) {
    if (!token) return null;
    const row = await db.get("SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?", await sha256Hex(token));
    return row && row.s_exp > Date.now() ? row : null;
  }
  async function publicUser(u) {
    if (!u) return null;
    const op = await db.get("SELECT id,status FROM operators WHERE user_id=?", u.id);
    return { id: u.id, email: u.email, name: u.name, phone: u.phone, admin: isAdmin(u), operator: op ? { id: op.id, status: op.status } : null };
  }
  const requireUser = ctx => { if (!ctx.user) throw new HttpError(401, "Sign in to continue."); };
  const requireAdmin = ctx => { requireUser(ctx); if (!isAdmin(ctx.user)) throw new HttpError(403, "Admins only."); };
  async function requireOperator(ctx) {
    requireUser(ctx);
    const op = await db.get("SELECT * FROM operators WHERE user_id=?", ctx.user.id);
    if (!op) throw new HttpError(403, "Set up your operator profile first.");
    if (op.status === "suspended") throw new HttpError(403, "This operator account is suspended. Contact the desk.");
    ctx.op = op;
  }

  /* ------------ booking views (2 queries for any number of bookings) ------------ */
  async function loadBookings(where, params, limit = 200) {
    const bookings = await db.all(`SELECT * FROM bookings WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}`, ...params);
    if (!bookings.length) return [];
    const bls = await db.all(`SELECT bl.*, l.status AS leg_status FROM booking_legs bl LEFT JOIN legs l ON l.id=bl.leg_id
      WHERE bl.booking_id IN (SELECT id FROM bookings WHERE ${where} ORDER BY created_at DESC LIMIT ${limit}) ORDER BY bl.seq`, ...params);
    const by = {};
    for (const bl of bls) (by[bl.booking_id] ||= []).push(bl);
    return bookings.map(b => ({ ...b, _legs: by[b.id] || [] }));
  }
  const loadBooking = async id => (await loadBookings("id=?", [id], 1))[0] || null;
  const legsOf = b => b._legs.map(bl => ({ ...JSON.parse(bl.snapshot), legId: bl.leg_id, operatorId: bl.operator_id, opStatus: bl.op_status, opNote: bl.op_note, legStatus: bl.leg_status || "removed" }));
  const routeOf = b => { const ls = legsOf(b); return ls.length ? [ls[0].o, ...ls.map(l => l.d)].join(" → ") : "your trip"; };
  function view(b, { forOperatorId = null, admin = false, opsById = null } = {}) {
    const legs = legsOf(b).map(l => (forOperatorId ? { ...l, mine: l.operatorId === forOperatorId } : l));
    const showContact = admin || !forOperatorId || b.status === "confirmed";
    const v = {
      id: b.id, status: b.status, pax: b.pax, notes: b.notes, subtotal: b.subtotal, fee: b.fee, total: b.total, retail: b.retail,
      payMode: b.pay_mode, payStatus: b.pay_status, message: b.message, reason: b.reason, expiresAt: b.expires_at,
      createdAt: b.created_at, updatedAt: b.updated_at, legs,
      contact: { name: b.contact_name, phone: showContact ? b.contact_phone : "", email: showContact ? b.contact_email : "" },
      checkoutUrl: !forOperatorId && b.status === "checkout" ? b.checkout_url : undefined,
    };
    if (admin && opsById) v.operators = [...new Set(legs.map(l => l.operatorId))].map(id => opsById[id]).filter(Boolean).map(o => ({ id: o.id, company: o.company, phone: o.phone, email: o.email, cert: o.cert }));
    return v;
  }
  async function operatorsFor(b) {
    const ids = [...new Set(b._legs.map(x => x.operator_id))];
    return ids.length ? db.all(`SELECT * FROM operators WHERE id IN (${qs(ids.length)})`, ...ids) : [];
  }

  /* ------------ booking state machine ------------ */
  async function notifyOperatorsOfRequest(b) {
    const legs = legsOf(b);
    for (const op of await operatorsFor(b)) {
      const mine = legs.filter(l => l.operatorId === op.id);
      await mail({
        to: op.email, subject: `New booking request: ${routeOf(b)}`,
        lines: [`${op.company}, you have a new request for ${mine.length > 1 ? "these legs" : "this leg"}:`,
          ...mine.map(l => `${l.o} → ${l.d} · ${fmtAt(l.depUtc, AP[l.o].tz)} · ${l.type} ${l.tail} · ${usd(l.price)}`),
          `${b.pax} passenger${b.pax > 1 ? "s" : ""}, lead passenger ${b.contact_name}.${b.notes ? ` Notes: ${b.notes}` : ""}`,
          b.pay_mode === "stripe" ? "The traveler's card is authorized. Confirm to capture payment, or decline to release it." : "No payment has been taken. Confirm to lock the booking; the desk will invoice the traveler.",
          `Please respond within ${cfg.confirmWindowHours} hours or the request expires.`],
        cta: { label: "Review request", url: link("operate") },
      });
    }
  }

  async function closeBooking(id, status, reason, actor) {
    if (busy.has(id)) throw new HttpError(409, "This booking is being updated. Try again in a moment.");
    busy.add(id);
    try {
      const b = await loadBooking(id);
      if (!b || !["checkout", "requested"].includes(b.status)) return b;
      let payStatus = b.pay_status;
      if (stripe && b.stripe_pi && b.pay_status === "authorized") {
        try { await stripe.cancelPI(b.stripe_pi); payStatus = "released"; }
        catch (err) { if (err.stripe?.code === "payment_intent_unexpected_state") payStatus = "released"; else { log.error(`[stripe] cancel ${b.stripe_pi}: ${err.message}`); throw new HttpError(502, "The payment provider didn't respond. Nothing changed; try again."); } }
      } else if (stripe && b.status === "checkout" && b.stripe_session) {
        try { await stripe.expireSession(b.stripe_session); } catch (err) { log.warn?.(`[stripe] expire ${b.stripe_session}: ${err.message}`); }
        payStatus = "none";
      }
      const now = Date.now();
      const [res] = await db.batch([
        ["UPDATE bookings SET status=?, pay_status=?, reason=?, updated_at=? WHERE id=? AND status IN ('checkout','requested')", status, payStatus, reason, now, id],
        ["UPDATE legs SET status='open', hold_ref=NULL, updated_at=? WHERE hold_ref=? AND status='held'", now, id],
        ["INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", now, actor, `booking.${status}`, id, reason],
      ]);
      if (!res.changes) return b;
      if (b.status === "requested") {
        await mail({ to: b.contact_email, subject: status === "cancelled" ? `Request cancelled: ${routeOf(b)}` : `Not available: ${routeOf(b)}`,
          lines: [status === "cancelled" ? "Your request has been cancelled." : "Sorry, this flight couldn't be confirmed.", reason ? `Reason: ${reason}` : "",
            b.pay_mode === "stripe" ? "The hold on your card has been released. Your bank may take a few days to show it." : "", "Other empty legs on your route may still be available."].filter(Boolean),
          cta: { label: "Search again", url: link("find") } });
        if (status === "cancelled") for (const op of await operatorsFor(b))
          await mail({ to: op.email, subject: `Request withdrawn: ${routeOf(b)}`, lines: [`The traveler withdrew their request for ${routeOf(b)}. The leg is open again.`], cta: { label: "Open operator portal", url: link("operate") } });
      }
      return { ...b, status };
    } finally { busy.delete(id); }
  }

  async function markRequested(id, piId) {
    const b = await loadBooking(id);
    if (!b) return;
    if (b.status !== "checkout") {
      if (["cancelled", "declined"].includes(b.status) && piId && stripe && b.pay_status !== "released") {
        try { await stripe.cancelPI(piId); } catch (err) { log.warn?.(`[stripe] late cancel ${piId}: ${err.message}`); }
        await db.run("UPDATE bookings SET pay_status='released', stripe_pi=? WHERE id=?", piId, id);
      }
      return;
    }
    const now = Date.now();
    const [res] = await db.batch([
      ["UPDATE bookings SET status='requested', pay_status='authorized', stripe_pi=?, expires_at=?, updated_at=? WHERE id=? AND status='checkout'", piId, now + cfg.confirmWindowHours * 3600e3, now, id],
      ["INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", now, b.user_id, "booking.authorized", id, piId],
    ]);
    if (!res.changes) return;
    await mail({ to: b.contact_email, subject: `Request received: ${routeOf(b)}`,
      lines: [`Thanks, ${b.contact_name}. Your card is authorized for ${usd(b.total)} but not charged yet.`, `The operator confirms within ${cfg.confirmWindowHours} hours. You're only charged once they confirm; if they can't, the hold is released.`],
      cta: { label: "Track your trip", url: link("trips") } });
    await notifyOperatorsOfRequest(b);
  }

  async function confirmBooking(id, actor) {
    if (busy.has(id)) throw new HttpError(409, "This booking is being updated. Try again in a moment.");
    busy.add(id);
    try {
      const b = await loadBooking(id);
      if (!b || b.status !== "requested") return b;
      let payStatus = b.pay_status;
      if (b.pay_mode === "stripe") {
        if (!stripe || !b.stripe_pi) throw new HttpError(500, "Payment isn't set up for this booking. Contact the desk.");
        try { await stripe.capturePI(b.stripe_pi, `capture-${id}`); payStatus = "captured"; }
        catch (err) {
          log.error(`[stripe] capture ${b.stripe_pi}: ${err.message}`);
          await db.audit(actor, "booking.capture_failed", id, err.message);
          throw new HttpError(502, `Payment capture failed: ${err.message}. The booking is still pending; the desk has been notified.`);
        }
      } else payStatus = "invoice";
      const now = Date.now();
      await db.batch([
        ["UPDATE bookings SET status='confirmed', pay_status=?, updated_at=? WHERE id=? AND status='requested'", payStatus, now, id],
        ["UPDATE legs SET status='booked', updated_at=? WHERE hold_ref=?", now, id],
        ["INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", now, actor, "booking.confirmed", id, payStatus],
      ]);
      const legs = legsOf(b), ops = Object.fromEntries((await operatorsFor(b)).map(o => [o.id, o]));
      await mail({ to: b.contact_email, subject: `Confirmed: ${routeOf(b)}`,
        lines: [`You're booked, ${b.contact_name}.`, ...legs.map(l => `${l.o} → ${l.d} · ${fmtAt(l.depUtc, AP[l.o].tz)} · ${l.type} ${l.tail} · operated by ${ops[l.operatorId]?.company} (Part 135 ${ops[l.operatorId]?.cert}), dispatch ${ops[l.operatorId]?.phone}`),
          payStatus === "captured" ? `Charged: ${usd(b.total)}.` : `Total ${usd(b.total)}. The desk will send your invoice.`,
          "Bring government photo ID for every passenger. The operator will contact you with FBO details and crew information."],
        cta: { label: "View trip", url: link("trips") } });
      for (const op of Object.values(ops))
        await mail({ to: op.email, subject: `Booked: ${routeOf(b)}`, lines: [`The booking for ${routeOf(b)} is confirmed${payStatus === "captured" ? " and paid" : ""}.`, `Lead passenger: ${b.contact_name}, ${b.contact_phone}, ${b.contact_email}. ${b.pax} passenger${b.pax > 1 ? "s" : ""}.`, b.notes ? `Notes: ${b.notes}` : ""].filter(Boolean), cta: { label: "Open operator portal", url: link("operate") } });
      return { ...b, status: "confirmed" };
    } finally { busy.delete(id); }
  }

  /** Background work, run every minute. Bounded so one run stays within platform limits. */
  async function sweep() {
    await db.ready();
    if (!state.base) state.base = (await db.get("SELECT v FROM meta WHERE k='base_url'"))?.v || "";
    const now = Date.now();
    for (const b of await db.all("SELECT id,status FROM bookings WHERE status IN ('checkout','requested') AND expires_at < ? LIMIT 3", now)) {
      try {
        if (b.status === "checkout") await closeBooking(b.id, "cancelled", "Checkout was not completed in time.", "system");
        else await closeBooking(b.id, "declined", `The operator did not confirm within ${cfg.confirmWindowHours} hours.`, "system");
      } catch (err) { log.error(`[sweep] ${b.id}: ${err.message}`); }
    }
    // Route alerts for newly posted legs: at most 10 emails per run.
    const legs = await db.all(`SELECT l.* FROM legs l JOIN operators o ON o.id=l.operator_id WHERE l.alerted=0 AND l.status='open' AND o.status='verified' AND l.dep_utc > ? ORDER BY l.created_at LIMIT 10`, now);
    if (legs.length) {
      const alerts = await db.all("SELECT a.*, u.email FROM alerts a JOIN users u ON u.id=a.user_id");
      const near = (rad, x, y) => x === y || (AP[x] && AP[y] && nm(AP[x], AP[y]) * 1.15078 <= rad);
      let budget = 10; const done = [];
      for (const l of legs) {
        const hits = alerts.filter(a => near(a.radius, a.o, l.o) && near(a.radius, a.d, l.d));
        let complete = true;
        for (const a of hits) {
          if (budget <= 0) { complete = false; break; }
          const ins = await db.run("INSERT OR IGNORE INTO alert_hits(alert_id,leg_id,at) VALUES(?,?,?)", a.id, l.id, now);
          if (!ins.changes) continue;
          budget--;
          await mail({ to: a.email, subject: `New empty leg: ${l.o} → ${l.d} for ${usd(l.price)}`,
            lines: [`A leg matching your ${a.o} → ${a.d} alert was just posted.`, `${l.o} → ${l.d} · ${fmtAt(l.dep_utc, AP[l.o].tz)} · ${l.type} · ${l.seats} seats · ${usd(l.price)} (${Math.round((1 - l.price / legRetail(l)) * 100)}% under one-way charter).`],
            cta: { label: "See the leg", url: link("find") } });
        }
        if (!complete) break;
        done.push(l.id);
      }
      if (done.length) await db.run(`UPDATE legs SET alerted=1 WHERE id IN (${qs(done.length)})`, ...done);
    }
    await db.run("DELETE FROM sessions WHERE expires_at < ?", now);
    await db.run("DELETE FROM resets WHERE expires_at < ?", now);
  }

  async function syncCheckout(b) {
    if (!stripe || b.status !== "checkout" || !b.stripe_session) return;
    const s = await stripe.retrieveSession(b.stripe_session);
    const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : s.payment_intent ? await stripe.retrievePI(s.payment_intent) : null;
    if (s.status === "complete" && pi && pi.status === "requires_capture") await markRequested(b.id, pi.id);
    else if (s.status === "expired") await closeBooking(b.id, "cancelled", "Checkout expired.", "stripe");
  }

  /* ================= routes ================= */
  r.get("/healthz", () => ({ ok: true }));
  r.get("/api/ref", () => ({ brand: cfg.brand, feePct: cfg.feePct, payments: !!stripe, confirmWindowHours: cfg.confirmWindowHours, supportEmail: cfg.supportEmail, supportPhone: cfg.supportPhone }));

  const poolLegs = async () => (await db.all(`SELECT l.*, o.company, o.cert FROM legs l JOIN operators o ON o.id=l.operator_id
      WHERE o.status='verified' AND l.status IN ('open','held') AND l.dep_utc > ? LIMIT 5000`, Date.now() + 30 * 60000)).map(publicLeg);

  r.get("/api/search", async ctx => {
    const q = ctx.query;
    const from = AP[q.get("from")] ? q.get("from") : null, to = AP[q.get("to")] ? q.get("to") : null;
    if (!from || !to) throw bad("Pick both airports from the list.");
    if (from === to) throw bad("Departure and arrival airports must differ.");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "") ? q.get("date") : new Date().toISOString().slice(0, 10);
    const params = {
      from, to, date,
      flex: Math.min(14, Math.max(0, parseInt(q.get("flex") ?? "2", 10) || 0)),
      radius: Math.min(200, Math.max(0, parseInt(q.get("radius") ?? "50", 10) || 0)),
      pax: Math.min(19, Math.max(1, parseInt(q.get("pax") ?? "1", 10) || 1)),
      chains: q.get("chains") !== "0", allowCancel: q.get("cancel") !== "0",
    };
    const { results, bench } = search(await poolLegs(), params);
    for (const x of results) { x.fee = feeFor(x.price); x.total = x.price + x.fee; }
    return { query: params, bench, benchClass: benchmark(from, to, params.pax).cls, results };
  });

  r.get("/api/stats", async () => {
    const legs = (await poolLegs()).filter(l => l.status === "open");
    const ops = new Set(legs.map(l => l.operatorId)).size;
    const avgOff = legs.length ? legs.reduce((s, l) => s + (1 - l.price / legRetail(l)), 0) / legs.length : 0;
    const routes = {};
    for (const l of legs) { const k = `${l.o}-${l.d}`; routes[k] ||= { o: l.o, d: l.d, n: 0, from: Infinity }; routes[k].n++; routes[k].from = Math.min(routes[k].from, l.price); }
    return { legs: legs.length, operators: ops, avgOff, top: Object.values(routes).sort((a, b) => b.n - a.n || a.from - b.from).slice(0, 8) };
  });

  /* ------------ auth ------------ */
  r.get("/api/me", async ctx => ({ user: await publicUser(ctx.user) }));

  r.post("/api/auth/signup", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const { email, password, name, phone } = ctx.body || {};
    if (!validEmail(email)) throw bad("Enter a valid email address.");
    if (!validPassword(password)) throw bad("Use a password of at least 10 characters.");
    const nm_ = str(name, 80, { label: "Name" }), ph = str(phone, 30, { required: false, label: "Phone" });
    const em = email.trim().toLowerCase();
    if (await db.get("SELECT 1 AS x FROM users WHERE email=?", em)) throw new HttpError(409, "An account with that email already exists. Sign in instead.");
    // With no ADMIN_EMAILS configured, the first account becomes the desk admin.
    const firstAdmin = !cfg.adminEmails.length && !(await db.get("SELECT 1 AS x FROM users WHERE role='admin' LIMIT 1"));
    const id = randomId();
    const res = await db.run("INSERT OR IGNORE INTO users(id,email,pass,name,phone,role,created_at) VALUES(?,?,?,?,?,?,?)", id, em, await hashPassword(password, { pepper: cfg.pepper }), nm_, ph,
      cfg.adminEmails.includes(em) || firstAdmin ? "admin" : "user", Date.now());
    if (!res.changes) throw new HttpError(409, "An account with that email already exists. Sign in instead.");
    const token = await createSession(id);
    ctx.cookies.push(cookie(token, SESSION_DAYS * 86400, ctx.secure));
    await mail({ to: em, subject: `Welcome to ${cfg.brand}`, lines: [`Hi ${nm_},`, "Your account is ready. Search empty legs, save route alerts, and request flights at a fraction of charter prices.", "Operators: set up your company profile under For operators to start posting legs."], cta: { label: "Find a jet", url: link("find") } });
    return { user: await publicUser(await db.get("SELECT * FROM users WHERE id=?", id)) };
  });

  r.post("/api/auth/login", async ctx => {
    const { email, password } = ctx.body || {};
    authLimit(`ip:${ctx.ip}`); authLimit(`em:${String(email).toLowerCase()}`);
    const u = validEmail(email) ? await db.get("SELECT * FROM users WHERE email=?", email.trim().toLowerCase()) : null;
    if (!u || !(await verifyPassword(String(password || ""), u.pass, { pepper: cfg.pepper }))) throw new HttpError(401, "That email and password don't match.");
    ctx.cookies.push(cookie(await createSession(u.id), SESSION_DAYS * 86400, ctx.secure));
    return { user: await publicUser(u) };
  });

  r.post("/api/auth/logout", async ctx => {
    const t = ctx.cookieMap[SID]; if (t) await db.run("DELETE FROM sessions WHERE id=?", await sha256Hex(t));
    ctx.cookies.push(cookie("", 0, ctx.secure)); return { ok: true };
  });

  r.post("/api/auth/forgot", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const email = String(ctx.body?.email || "").trim().toLowerCase();
    const u = validEmail(email) ? await db.get("SELECT * FROM users WHERE email=?", email) : null;
    if (u) {
      const token = randomId(24);
      await db.run("INSERT INTO resets(id,user_id,expires_at) VALUES(?,?,?)", await sha256Hex(token), u.id, Date.now() + 3600e3);
      await mail({ to: u.email, subject: `Reset your ${cfg.brand} password`, lines: [`Hi ${u.name},`, "Use the link below within one hour to choose a new password. If you didn't ask for this, ignore this email."], cta: { label: "Choose a new password", url: link(`reset-${token}`) } });
    }
    return { ok: true }; // same answer either way, so accounts can't be enumerated
  });

  r.post("/api/auth/reset", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const { token, password } = ctx.body || {};
    if (!validPassword(password)) throw bad("Use a password of at least 10 characters.");
    const row = token ? await db.get("SELECT * FROM resets WHERE id=?", await sha256Hex(String(token))) : null;
    if (!row || row.expires_at < Date.now()) throw bad("This reset link has expired. Request a new one.");
    await db.batch([
      ["UPDATE users SET pass=? WHERE id=?", await hashPassword(password, { pepper: cfg.pepper }), row.user_id],
      ["DELETE FROM resets WHERE user_id=?", row.user_id],
      ["DELETE FROM sessions WHERE user_id=?", row.user_id],
    ]);
    ctx.cookies.push(cookie(await createSession(row.user_id), SESSION_DAYS * 86400, ctx.secure));
    return { user: await publicUser(await db.get("SELECT * FROM users WHERE id=?", row.user_id)) };
  });

  r.put("/api/me", async ctx => {
    requireUser(ctx);
    const name = str(ctx.body?.name, 80, { label: "Name" }), phone = str(ctx.body?.phone, 30, { required: false, label: "Phone" });
    await db.run("UPDATE users SET name=?, phone=? WHERE id=?", name, phone, ctx.user.id);
    return { user: await publicUser({ ...ctx.user, name, phone }) };
  });

  /* ------------ alerts ------------ */
  r.get("/api/alerts", async ctx => {
    requireUser(ctx);
    const alerts = await db.all("SELECT id,o,d,radius,created_at FROM alerts WHERE user_id=? ORDER BY created_at", ctx.user.id);
    const pool = alerts.length ? (await poolLegs()).filter(l => l.status === "open") : [];
    const near = (rad, x, y) => x === y || nm(AP[x], AP[y]) * 1.15078 <= rad;
    return { alerts: alerts.map(a => ({ ...a, live: pool.filter(l => near(a.radius, a.o, l.o) && near(a.radius, a.d, l.d)).length })) };
  });
  r.post("/api/alerts", async ctx => {
    requireUser(ctx);
    const { o, d } = ctx.body || {};
    if (!AP[o] || !AP[d] || o === d) throw bad("Pick two different airports.");
    const radius = int(ctx.body.radius ?? 50, 0, 200, "Radius");
    const existing = await db.all("SELECT o,d FROM alerts WHERE user_id=?", ctx.user.id);
    if (existing.length >= 20) throw bad("You can keep up to 20 alerts. Remove one first.");
    if (existing.some(a => a.o === o && a.d === d)) throw new HttpError(409, `You already have an alert for ${o} → ${d}.`);
    const id = randomId(8);
    await db.run("INSERT INTO alerts(id,user_id,o,d,radius,created_at) VALUES(?,?,?,?,?,?)", id, ctx.user.id, o, d, radius, Date.now());
    return { id };
  });
  r.del("/api/alerts/:id", async ctx => { requireUser(ctx); await db.run("DELETE FROM alerts WHERE id=? AND user_id=?", ctx.params.id, ctx.user.id); return { ok: true }; });

  /* ------------ traveler bookings ------------ */
  r.post("/api/bookings", async ctx => {
    requireUser(ctx); bookLimit(ctx.user.id);
    const body = ctx.body || {};
    const ids = Array.isArray(body.legIds) ? [...new Set(body.legIds.map(String))] : [];
    if (ids.length < 1 || ids.length > 2) throw bad("Choose one leg or a two-leg connection.");
    const pax = int(body.pax, 1, 19, "Passengers");
    const c = body.contact || {};
    const contact = { name: str(c.name, 80, { label: "Lead passenger" }), phone: str(c.phone, 30, { label: "Mobile" }), email: str(c.email, 120, { label: "Email" }) };
    if (!validEmail(contact.email)) throw bad("Enter a valid email address.");
    const notes = str(body.notes, 500, { required: false });
    if (body.accept !== true) throw bad("Please confirm you've read how empty-leg bookings work.");
    const rows = await db.all(`SELECT l.*, o.company, o.cert, o.status AS op_status FROM legs l JOIN operators o ON o.id=l.operator_id WHERE l.id IN (${qs(ids.length)})`, ...ids);
    const byId = Object.fromEntries(rows.map(x => [x.id, x]));
    if (ids.some(id => !byId[id] || byId[id].op_status !== "verified")) throw new HttpError(409, "One of these legs is no longer listed.");
    const legs = ids.map(id => publicLeg(byId[id]));
    const now = Date.now();
    const problem = validateItinerary(legs, pax, now);
    if (problem) throw new HttpError(409, problem);
    const subtotal = legs.reduce((s, l) => s + l.price, 0), fee = feeFor(subtotal), total = subtotal + fee;
    const retail = legs.length === 1 ? legRetail(legs[0]) : benchmark(legs[0].o, legs[1].d, pax).bench;
    const id = randomId(10), payMode = stripe ? "stripe" : "request";
    // Hold every leg atomically: tag them with this booking's id, roll back if any was taken.
    const held = await db.run(`UPDATE legs SET status='held', hold_ref=?, updated_at=? WHERE id IN (${qs(ids.length)}) AND status='open'`, id, now, ...ids);
    if (held.changes !== ids.length) {
      await db.run("UPDATE legs SET status='open', hold_ref=NULL WHERE hold_ref=?", id);
      throw new HttpError(409, "Someone else just started booking one of these legs. Try another result.");
    }
    await db.batch([
      [`INSERT INTO bookings(id,user_id,status,pax,notes,contact_name,contact_phone,contact_email,subtotal,fee,total,retail,pay_mode,pay_status,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.user.id, payMode === "stripe" ? "checkout" : "requested", pax, notes, contact.name, contact.phone, contact.email,
        subtotal, fee, total, retail, payMode, payMode === "stripe" ? "pending" : "none",
        payMode === "stripe" ? now + (CHECKOUT_MINUTES + 4) * 60000 : now + cfg.confirmWindowHours * 3600e3, now, now],
      ...legs.map((l, i) => ["INSERT INTO booking_legs(booking_id,leg_id,operator_id,seq,snapshot) VALUES(?,?,?,?,?)", id, l.id, l.operatorId, i,
        JSON.stringify({ o: l.o, d: l.d, dep: l.dep, depUtc: l.depUtc, type: l.type, cls: l.cls, tail: l.tail, seats: l.seats, price: l.price, company: l.company, cert: l.cert, block: legBlock(l) })]),
      ["INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", now, ctx.user.id, "booking.create", id, JSON.stringify({ legs: ids, total })],
    ]);
    const b = await loadBooking(id);
    if (payMode === "stripe") {
      const route = routeOf(b);
      try {
        const s = await stripe.createCheckout({
          mode: "payment", customer_email: contact.email, client_reference_id: id,
          expires_at: Math.floor(now / 1000) + CHECKOUT_MINUTES * 60,
          line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: total * 100,
            product_data: { name: `Private jet empty leg ${route}`, description: `${legs.map(l => `${l.o}→${l.d} ${l.dep.replace("T", " ")} local, ${l.type}`).join("; ")}. ${pax} pax. Includes ${usd(fee)} service fee.` } } }],
          payment_intent_data: { capture_method: "manual", description: `${cfg.brand} booking ${id}`, metadata: { booking_id: id } },
          metadata: { booking_id: id },
          success_url: `${state.base}/?paid=${id}#trips`, cancel_url: `${state.base}/?unpaid=${id}#trips`,
        }, `checkout-${id}`);
        await db.run("UPDATE bookings SET stripe_session=?, checkout_url=? WHERE id=?", s.id, s.url, id);
        return { booking: view({ ...b, stripe_session: s.id, checkout_url: s.url }), checkoutUrl: s.url };
      } catch (err) {
        log.error(`[stripe] checkout ${id}: ${err.message}`);
        await closeBooking(id, "cancelled", "Payment could not be started.", "system").catch(() => {});
        throw new HttpError(502, "We couldn't start the secure payment page. Nothing was charged; try again in a minute.");
      }
    }
    await mail({ to: contact.email, subject: `Request received: ${routeOf(b)}`, lines: [`Thanks, ${contact.name}. We've sent your request to the operator.`, `They confirm within ${cfg.confirmWindowHours} hours. Nothing is charged until the flight is confirmed and you approve the invoice.`], cta: { label: "Track your trip", url: link("trips") } });
    await notifyOperatorsOfRequest(b);
    return { booking: view(b) };
  });

  r.get("/api/bookings", async ctx => { requireUser(ctx); return { bookings: (await loadBookings("user_id=?", [ctx.user.id])).map(b => view(b)) }; });
  async function myBooking(ctx) { const b = await loadBooking(ctx.params.id); if (!b || b.user_id !== ctx.user.id) throw new HttpError(404, "Booking not found."); return b; }
  r.post("/api/bookings/:id/sync", async ctx => {
    requireUser(ctx); const b = await myBooking(ctx);
    try { await syncCheckout(b); } catch (err) { log.warn?.(`[stripe] sync ${b.id}: ${err.message}`); }
    return { booking: view(await loadBooking(b.id)) };
  });
  r.post("/api/bookings/:id/cancel", async ctx => {
    requireUser(ctx); const b = await myBooking(ctx);
    if (!["checkout", "requested"].includes(b.status)) throw new HttpError(409, b.status === "confirmed" ? "This trip is confirmed. Contact the desk to change or cancel it; the operator's cancellation terms apply." : "This request is already closed.");
    await closeBooking(b.id, "cancelled", "Cancelled by traveler.", ctx.user.id);
    return { booking: view(await loadBooking(b.id)) };
  });

  /* ------------ Stripe webhook ------------ */
  r.post("/api/stripe/webhook", async ctx => {
    let evt;
    try { evt = await verifyWebhook(ctx.raw, ctx.request.headers.get("stripe-signature"), cfg.stripeWebhookSecret); }
    catch (err) { log.warn?.(`[stripe] webhook rejected: ${err.message}`); throw bad("Invalid signature."); }
    const obj = evt.data?.object || {};
    const bookingId = obj.metadata?.booking_id || obj.client_reference_id;
    const b = bookingId ? await db.get("SELECT id,status,pay_status FROM bookings WHERE id=?", bookingId) : null;
    if (!b) return { received: true, ignored: true };
    if (evt.type === "checkout.session.completed") {
      const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      const pi = piId && stripe ? await stripe.retrievePI(piId) : null;
      if (pi && pi.status === "requires_capture") await markRequested(b.id, pi.id);
    } else if (evt.type === "checkout.session.expired") {
      if (b.status === "checkout") await closeBooking(b.id, "cancelled", "Checkout expired.", "stripe");
    } else if (evt.type === "payment_intent.canceled") {
      if (b.status === "requested" && b.pay_status === "authorized") {
        await db.run("UPDATE bookings SET pay_status='released' WHERE id=?", b.id);
        await closeBooking(b.id, "declined", "The card authorization expired or was cancelled.", "stripe");
      }
    }
    return { received: true };
  });

  /* ------------ operators ------------ */
  r.get("/api/operator", async ctx => {
    requireUser(ctx);
    const op = await db.get("SELECT * FROM operators WHERE user_id=?", ctx.user.id);
    if (!op) return { operator: null, legs: [] };
    const legs = (await db.all("SELECT l.*, ? AS company, ? AS cert FROM legs l WHERE operator_id=? AND status!='removed' ORDER BY dep_utc LIMIT 1000", op.company, op.cert, op.id))
      .map(l => ({ ...publicLeg(l), retail: legRetail(l) }));
    return { operator: { id: op.id, company: op.company, cert: op.cert, phone: op.phone, email: op.email, base: op.base, status: op.status }, legs };
  });

  r.post("/api/operator/profile", async ctx => {
    requireUser(ctx);
    const b = ctx.body || {};
    const p = { company: str(b.company, 80, { label: "Operator name" }), cert: str(b.cert, 20, { label: "Certificate number" }).toUpperCase(),
      phone: str(b.phone, 30, { label: "Dispatch phone" }), email: str(b.email, 120, { label: "Charter sales email" }), base: AP[b.base] ? b.base : "" };
    if (!validEmail(p.email)) throw bad("Enter a valid charter sales email.");
    if (!/^[A-Z0-9-]{4,20}$/.test(p.cert)) throw bad("Enter the air carrier certificate number exactly as issued (letters and digits).");
    const now = Date.now(), op = await db.get("SELECT * FROM operators WHERE user_id=?", ctx.user.id);
    if (op) {
      const certChanged = op.cert !== p.cert;
      await db.run("UPDATE operators SET company=?, cert=?, phone=?, email=?, base=?, status=?, updated_at=? WHERE id=?", p.company, p.cert, p.phone, p.email, p.base,
        certChanged && op.status === "verified" ? "pending" : op.status, now, op.id);
    } else {
      const id = randomId(8);
      await db.run("INSERT INTO operators(id,user_id,company,cert,phone,email,base,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, ctx.user.id, p.company, p.cert, p.phone, p.email, p.base, "pending", now, now);
      const admins = new Set([...(await db.all("SELECT email FROM users WHERE role='admin' LIMIT 5")).map(x => x.email), ...cfg.adminEmails]);
      for (const a of admins) await mail({ to: a, subject: `Operator to verify: ${p.company}`, lines: [`${p.company} (Part 135 ${p.cert}) signed up and is waiting for verification.`, `Contact: ${p.phone}, ${p.email}.`], cta: { label: "Open the desk", url: link("admin") } });
    }
    return { ok: true };
  });

  function parseLeg(b, now) {
    const o = AP[b.o] ? b.o : null, d = AP[b.d] ? b.d : null;
    if (!o || !d) throw bad("Pick both airports from the list.");
    if (o === d) throw bad("Departure and arrival airports must differ.");
    const dep = String(b.dep || "");
    const depUtc = localToUtc(dep, AP[o].tz);
    if (!Number.isFinite(depUtc)) throw bad("Enter the departure date and time.");
    if (depUtc < now + 30 * 60000) throw bad("Departure must be at least 30 minutes from now.");
    if (depUtc > now + 366 * 864e5) throw bad("Departure must be within the next year.");
    if (!CL[b.cls]) throw bad("Choose an aircraft class.");
    const window = Number(b.window) || 0; if (!WINDOWS.includes(window)) throw bad("Choose a departure flexibility option.");
    const tail = str(b.tail, 8, { required: false, label: "Tail number" }).toUpperCase();
    if (tail && !/^[A-Z0-9-]{2,8}$/.test(tail)) throw bad("Tail numbers use letters, digits and dashes only.");
    return { o, d, dep_local: dep, dep_utc: depUtc, window_h: window, cls: b.cls, type: str(b.type, 40, { label: "Aircraft type" }), tail,
      seats: int(b.seats, 1, 19, "Seats"), price: int(b.price, 500, 2000000, "Price"), may_cancel: b.mayCancel ? 1 : 0, notes: str(b.notes, 400, { required: false }) };
  }

  r.post("/api/operator/legs", async ctx => {
    await requireOperator(ctx);
    const now = Date.now(), l = parseLeg(ctx.body || {}, now), id = randomId(9);
    if ((await db.get("SELECT COUNT(*) AS n FROM legs WHERE operator_id=? AND status IN ('open','held') AND dep_utc>?", ctx.op.id, now)).n >= 500) throw bad("You have 500 open legs. Withdraw some before posting more.");
    await db.run(`INSERT INTO legs(id,operator_id,o,d,dep_local,dep_utc,window_h,cls,type,tail,seats,price,may_cancel,notes,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`, id, ctx.op.id, l.o, l.d, l.dep_local, l.dep_utc, l.window_h, l.cls, l.type, l.tail, l.seats, l.price, l.may_cancel, l.notes, now, now);
    return { id };
  });

  async function ownLeg(ctx) { const l = await db.get("SELECT * FROM legs WHERE id=? AND operator_id=?", ctx.params.id, ctx.op.id); if (!l) throw new HttpError(404, "Leg not found."); return l; }
  r.put("/api/operator/legs/:id", async ctx => {
    await requireOperator(ctx);
    const cur = await ownLeg(ctx);
    if (cur.status !== "open" && cur.status !== "withdrawn") throw new HttpError(409, "This leg has an active booking and can't be edited.");
    const l = parseLeg(ctx.body || {}, Date.now());
    const res = await db.run(`UPDATE legs SET o=?,d=?,dep_local=?,dep_utc=?,window_h=?,cls=?,type=?,tail=?,seats=?,price=?,may_cancel=?,notes=?,alerted=0,updated_at=? WHERE id=? AND status IN ('open','withdrawn')`,
      l.o, l.d, l.dep_local, l.dep_utc, l.window_h, l.cls, l.type, l.tail, l.seats, l.price, l.may_cancel, l.notes, Date.now(), cur.id);
    if (!res.changes) throw new HttpError(409, "This leg has an active booking and can't be edited.");
    return { ok: true };
  });
  r.post("/api/operator/legs/:id/status", async ctx => {
    await requireOperator(ctx);
    const cur = await ownLeg(ctx), to = ctx.body?.status, now = Date.now();
    const allowed = { withdrawn: ["open"], open: ["withdrawn"], removed: ["withdrawn", "open"] };
    if (!allowed[to]) throw bad("Unknown status.");
    if (to === "removed" && cur.status === "open" && cur.dep_utc > now) throw new HttpError(409, "Withdraw the leg before removing it.");
    if (!allowed[to].includes(cur.status)) throw new HttpError(409, cur.status === "held" ? "A traveler is booking this leg. Confirm or decline the request first." : `A ${cur.status} leg can't be changed to ${to}.`);
    if (to === "open" && cur.dep_utc < now + 30 * 60000) throw new HttpError(409, "This leg has already departed.");
    const res = await db.run(`UPDATE legs SET status=?, alerted=CASE WHEN ?='open' THEN 0 ELSE alerted END, updated_at=? WHERE id=? AND status IN (${qs(allowed[to].length)})`, to, to, now, cur.id, ...allowed[to]);
    if (!res.changes) throw new HttpError(409, "This leg changed. Reload and try again.");
    return { ok: true };
  });

  r.get("/api/operator/bookings", async ctx => {
    await requireOperator(ctx);
    return { bookings: (await loadBookings("id IN (SELECT booking_id FROM booking_legs WHERE operator_id=?) AND status!='checkout'", [ctx.op.id])).map(b => view(b, { forOperatorId: ctx.op.id })) };
  });

  r.post("/api/operator/bookings/:id/respond", async ctx => {
    await requireOperator(ctx);
    const decision = ctx.body?.decision, note = str(ctx.body?.note, 500, { required: false });
    if (!["confirm", "decline"].includes(decision)) throw bad("Choose confirm or decline.");
    const b = await loadBooking(ctx.params.id);
    if (!b || !b._legs.some(x => x.operator_id === ctx.op.id)) throw new HttpError(404, "Booking not found.");
    if (b.status !== "requested") throw new HttpError(409, "This request is no longer waiting on you.");
    if (decision === "decline") {
      await db.run("UPDATE booking_legs SET op_status='declined', op_note=? WHERE booking_id=? AND operator_id=?", note, b.id, ctx.op.id);
      await closeBooking(b.id, "declined", note || `${ctx.op.company} can't operate this flight.`, ctx.user.id);
    } else {
      await db.run("UPDATE booking_legs SET op_status='confirmed', op_note=? WHERE booking_id=? AND operator_id=?", note, b.id, ctx.op.id);
      const others = b._legs.filter(x => x.operator_id !== ctx.op.id && x.op_status !== "confirmed").length;
      if (!others) await confirmBooking(b.id, ctx.user.id);
    }
    return { booking: view(await loadBooking(b.id), { forOperatorId: ctx.op.id }) };
  });

  /* ------------ admin ------------ */
  r.get("/api/admin/overview", async ctx => {
    requireAdmin(ctx);
    const now = Date.now();
    const ops = await db.all(`SELECT o.*, u.email AS account_email, u.name AS account_name,
        (SELECT COUNT(*) FROM legs l WHERE l.operator_id=o.id AND l.status='open' AND l.dep_utc>?) AS open_legs
      FROM operators o JOIN users u ON u.id=o.user_id ORDER BY o.status='pending' DESC, o.created_at DESC LIMIT 500`, now);
    const opsById = Object.fromEntries(ops.map(o => [o.id, o]));
    const bookings = (await loadBookings("status!='checkout' OR expires_at>?", [now], 300)).map(b => view(b, { admin: true, opsById }));
    const t = await db.get(`SELECT (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM bookings WHERE status='confirmed') AS confirmed,
        (SELECT COALESCE(SUM(total),0) FROM bookings WHERE status='confirmed') AS gmv,
        (SELECT COALESCE(SUM(fee),0) FROM bookings WHERE status='confirmed') AS fees,
        (SELECT COUNT(*) FROM legs l JOIN operators o ON o.id=l.operator_id WHERE l.status='open' AND o.status='verified' AND l.dep_utc>?) AS openLegs`, now);
    return {
      operators: ops.map(o => ({ id: o.id, company: o.company, cert: o.cert, phone: o.phone, email: o.email, base: o.base, status: o.status, createdAt: o.created_at, account: { name: o.account_name, email: o.account_email }, openLegs: o.open_legs })),
      bookings, totals: t,
    };
  });

  r.post("/api/admin/operators/:id/status", async ctx => {
    requireAdmin(ctx);
    const to = ctx.body?.status; if (!["verified", "pending", "suspended"].includes(to)) throw bad("Unknown status.");
    const op = await db.get("SELECT * FROM operators WHERE id=?", ctx.params.id); if (!op) throw new HttpError(404, "Operator not found.");
    const now = Date.now();
    await db.batch([
      ["UPDATE operators SET status=?, updated_at=? WHERE id=?", to, now, op.id],
      ...(to === "suspended" ? [["UPDATE legs SET status='withdrawn', updated_at=? WHERE operator_id=? AND status='open'", now, op.id]] : []),
      ["INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", now, ctx.user.id, `operator.${to}`, op.id, null],
    ]);
    if (to === "verified" && op.status !== "verified")
      await mail({ to: op.email, subject: `${op.company} is verified on ${cfg.brand}`, lines: ["Your certificate checked out. Your open legs are now visible to travelers, with the verified badge."], cta: { label: "Post empty legs", url: link("operate") } });
    return { ok: true };
  });

  r.post("/api/admin/bookings/:id/respond", async ctx => {
    requireAdmin(ctx);
    const decision = ctx.body?.decision, note = str(ctx.body?.note, 500, { required: false });
    const b = await db.get("SELECT id,status FROM bookings WHERE id=?", ctx.params.id); if (!b) throw new HttpError(404, "Booking not found.");
    if (!["requested", "checkout"].includes(b.status)) throw new HttpError(409, "This booking is already closed.");
    if (decision === "decline") await closeBooking(b.id, "declined", note || "Not available.", ctx.user.id);
    else if (decision === "confirm") {
      if (b.status !== "requested") throw new HttpError(409, "The traveler hasn't completed payment yet.");
      await db.run("UPDATE booking_legs SET op_status='confirmed', op_note=CASE WHEN op_note='' THEN 'Confirmed by desk' ELSE op_note END WHERE booking_id=?", b.id);
      await confirmBooking(b.id, ctx.user.id);
    } else throw bad("Choose confirm or decline.");
    const nb = await loadBooking(b.id);
    return { booking: view(nb, { admin: true, opsById: Object.fromEntries((await operatorsFor(nb)).map(o => [o.id, o])) }) };
  });

  r.post("/api/admin/bookings/:id/message", async ctx => {
    requireAdmin(ctx);
    const msg = str(ctx.body?.message, 800, { label: "Message" });
    const b = await loadBooking(ctx.params.id); if (!b) throw new HttpError(404, "Booking not found.");
    await db.run("UPDATE bookings SET message=?, updated_at=? WHERE id=?", msg, Date.now(), b.id);
    await mail({ to: b.contact_email, subject: `Update on your trip: ${routeOf(b)}`, lines: [msg], cta: { label: "View trip", url: link("trips") } });
    return { ok: true };
  });

  /* ================= request handler ================= */
  const json = (status, obj, cookies = []) => {
    const h = new Headers({ ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    for (const c of cookies) h.append("Set-Cookie", c);
    return new Response(JSON.stringify(obj ?? {}), { status, headers: h });
  };

  async function handle(request, { ip = "?" } = {}) {
    const url = new URL(request.url);
    try {
      const m = r.match(request.method, url.pathname);
      if (!m) throw new HttpError(404, "Not found.");
      if (request.method !== "GET" && url.pathname !== "/api/stripe/webhook" && request.headers.get("x-requested-with") !== "deadhead")
        throw new HttpError(403, "Request blocked. Reload the page and try again.");
      await db.ready();
      await rememberBase(url.origin);
      const raw = request.method === "GET" ? "" : await request.text();
      if (raw.length > 1_000_000) throw new HttpError(413, "Request too large.");
      let body = null;
      if (raw && url.pathname !== "/api/stripe/webhook") { try { body = JSON.parse(raw); } catch { throw bad("Malformed request."); } }
      const cookieMap = parseCookies(request.headers.get("cookie"));
      const ctx = { request, query: url.searchParams, params: m.params, body, raw, ip, cookieMap, cookies: [], secure: url.protocol === "https:",
        user: m.handler && url.pathname !== "/healthz" ? await userForToken(cookieMap[SID]) : null };
      const out = await m.handler(ctx);
      return json(200, out, ctx.cookies);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(`[error] ${request.method} ${url.pathname}: ${err.stack || err.message}`);
      return json(status, { error: status === 500 ? "Something went wrong on our side. Try again; if it keeps happening, contact support." : err.message });
    }
  }

  return { handle, sweep };
}

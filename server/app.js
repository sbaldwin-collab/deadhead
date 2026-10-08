import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createRouter, readBody, parseCookies, cookie, securityHeaders, serveFile, limiter, HttpError, bad } from "./http.js";
import { newId, hashPassword, verifyPassword, createSession, destroySession, userForToken, isAdmin, publicUser, requireUser, validEmail, validPassword, sha256 } from "./auth.js";
import { makeStripe, verifyWebhook } from "./stripe.js";
import { makeMailer } from "./email.js";
import { AP, CL, CLASSES, AIRPORTS, nm, localToUtc, fmtAt, usd, legBlock, legRetail } from "./ref.js";
import { search, publicLeg, benchmark, validateItinerary } from "./search.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const SID = "dh_sid";
const CHECKOUT_MINUTES = 31;      // Stripe's minimum Checkout lifetime is 30 minutes
const WINDOWS = [0, 2, 4, 8, 24];

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

export function createApp(cfg, deps = {}) {
  const log = deps.log || console;
  const db = deps.db || openDb(cfg.databaseFile);
  const stripe = deps.stripe !== undefined ? deps.stripe : makeStripe({ key: cfg.stripeKey, base: cfg.stripeApiBase });
  const mail = deps.mailer || makeMailer(cfg, log);
  const r = createRouter();
  const authLimit = limiter(20, 15 * 60000);
  const bookLimit = limiter(30, 60 * 60000);
  const busy = new Set(); // per-booking async lock (single-instance deployment)
  const link = hash => `${cfg.baseUrl}/#${hash}`;
  const feeFor = subtotal => Math.round(subtotal * cfg.feePct / 100);

  /* ---------------- helpers ---------------- */
  const legRow = id => db.get("SELECT l.*, o.company, o.cert, o.status AS op_status, o.email AS op_email, o.phone AS op_phone, o.user_id AS op_user FROM legs l JOIN operators o ON o.id=l.operator_id WHERE l.id=?", id);
  const myOperator = ctx => db.get("SELECT * FROM operators WHERE user_id=?", ctx.user.id);
  const requireOperator = ctx => {
    requireUser(ctx);
    const op = myOperator(ctx);
    if (!op) throw new HttpError(403, "Set up your operator profile first.");
    if (op.status === "suspended") throw new HttpError(403, "This operator account is suspended. Contact the desk.");
    ctx.op = op;
  };
  const requireAdmin = ctx => { requireUser(ctx); if (!isAdmin(cfg, ctx.user)) throw new HttpError(403, "Admins only."); };

  function bookingView(b, { forOperatorId = null, admin = false } = {}) {
    const legs = db.all("SELECT * FROM booking_legs WHERE booking_id=? ORDER BY seq", b.id).map(bl => {
      const snap = JSON.parse(bl.snapshot);
      const cur = db.get("SELECT status FROM legs WHERE id=?", bl.leg_id);
      return { ...snap, legId: bl.leg_id, operatorId: bl.operator_id, opStatus: bl.op_status, opNote: bl.op_note, legStatus: cur?.status || "removed", mine: forOperatorId ? bl.operator_id === forOperatorId : undefined };
    });
    const showContact = admin || !forOperatorId || b.status === "confirmed";
    const v = {
      id: b.id, status: b.status, pax: b.pax, notes: b.notes, subtotal: b.subtotal, fee: b.fee, total: b.total, retail: b.retail,
      payMode: b.pay_mode, payStatus: b.pay_status, message: b.message, reason: b.reason, expiresAt: b.expires_at,
      createdAt: b.created_at, updatedAt: b.updated_at, legs,
      contact: { name: b.contact_name, phone: showContact ? b.contact_phone : "", email: showContact ? b.contact_email : "" },
      checkoutUrl: !forOperatorId && b.status === "checkout" ? b.checkout_url : undefined,
    };
    if (admin) v.operators = [...new Set(legs.map(l => l.operatorId))].map(id => db.get("SELECT id,company,phone,email,cert FROM operators WHERE id=?", id));
    return v;
  }
  const routeOf = b => { const ls = db.all("SELECT snapshot FROM booking_legs WHERE booking_id=? ORDER BY seq", b.id).map(x => JSON.parse(x.snapshot)); return [ls[0].o, ...ls.map(l => l.d)].join(" → "); };

  async function notifyOperatorsOfRequest(b) {
    const ops = db.all("SELECT DISTINCT o.* FROM booking_legs bl JOIN operators o ON o.id=bl.operator_id WHERE bl.booking_id=?", b.id);
    for (const op of ops) {
      const mine = db.all("SELECT snapshot FROM booking_legs WHERE booking_id=? AND operator_id=? ORDER BY seq", b.id, op.id).map(x => JSON.parse(x.snapshot));
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

  /** Move a booking to a terminal not-flown state, release its legs and any card authorization. */
  async function closeBooking(id, status, reason, actor) {
    if (busy.has(id)) throw new HttpError(409, "This booking is being updated. Try again in a moment.");
    busy.add(id);
    try {
      const b = db.get("SELECT * FROM bookings WHERE id=?", id);
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
      db.tx(() => {
        db.run("UPDATE bookings SET status=?, pay_status=?, reason=?, updated_at=? WHERE id=?", status, payStatus, reason, now, id);
        for (const bl of db.all("SELECT leg_id FROM booking_legs WHERE booking_id=?", id))
          db.run("UPDATE legs SET status='open', updated_at=? WHERE id=? AND status='held'", now, bl.leg_id);
        db.audit(actor, `booking.${status}`, id, reason);
      });
      const after = db.get("SELECT * FROM bookings WHERE id=?", id);
      if (b.status === "requested") {
        await mail({ to: b.contact_email, subject: status === "cancelled" ? `Request cancelled: ${routeOf(b)}` : `Not available: ${routeOf(b)}`,
          lines: [status === "cancelled" ? "Your request has been cancelled." : "Sorry, this flight couldn't be confirmed.", reason ? `Reason: ${reason}` : "",
            b.pay_mode === "stripe" ? "The hold on your card has been released. Your bank may take a few days to show it." : "", "Other empty legs on your route may still be available."].filter(Boolean),
          cta: { label: "Search again", url: link("find") } });
        if (status === "cancelled") {
          for (const op of db.all("SELECT DISTINCT o.email, o.company FROM booking_legs bl JOIN operators o ON o.id=bl.operator_id WHERE bl.booking_id=?", id))
            await mail({ to: op.email, subject: `Request withdrawn: ${routeOf(b)}`, lines: [`The traveler withdrew their request for ${routeOf(b)}. The leg is open again.`], cta: { label: "Open operator portal", url: link("operate") } });
        }
      }
      return after;
    } finally { busy.delete(id); }
  }

  /** Card authorized (or request mode): booking now waits on operators. Idempotent. */
  async function markRequested(id, piId) {
    const b = db.get("SELECT * FROM bookings WHERE id=?", id);
    if (!b) return;
    if (b.status !== "checkout") {
      if (["cancelled", "declined"].includes(b.status) && piId && stripe) {
        try { await stripe.cancelPI(piId); } catch (err) { log.warn?.(`[stripe] late cancel ${piId}: ${err.message}`); }
        db.run("UPDATE bookings SET pay_status='released', stripe_pi=? WHERE id=?", piId, id);
      }
      return;
    }
    const now = Date.now();
    db.run("UPDATE bookings SET status='requested', pay_status='authorized', stripe_pi=?, expires_at=?, updated_at=? WHERE id=? AND status='checkout'", piId, now + cfg.confirmWindowHours * 3600e3, now, id);
    db.audit(b.user_id, "booking.authorized", id, piId);
    const nb = db.get("SELECT * FROM bookings WHERE id=?", id);
    await mail({ to: nb.contact_email, subject: `Request received: ${routeOf(nb)}`,
      lines: [`Thanks, ${nb.contact_name}. Your card is authorized for ${usd(nb.total)} but not charged yet.`, `The operator confirms within ${cfg.confirmWindowHours} hours. You're only charged once they confirm; if they can't, the hold is released.`],
      cta: { label: "Track your trip", url: link("trips") } });
    await notifyOperatorsOfRequest(nb);
  }

  async function confirmBooking(id, actor) {
    if (busy.has(id)) throw new HttpError(409, "This booking is being updated. Try again in a moment.");
    busy.add(id);
    try {
      const b = db.get("SELECT * FROM bookings WHERE id=?", id);
      if (!b || b.status !== "requested") return b;
      let payStatus = b.pay_status;
      if (b.pay_mode === "stripe") {
        if (!stripe || !b.stripe_pi) throw new HttpError(500, "Payment isn't set up for this booking. Contact the desk.");
        try { await stripe.capturePI(b.stripe_pi, `capture-${id}`); payStatus = "captured"; }
        catch (err) {
          log.error(`[stripe] capture ${b.stripe_pi}: ${err.message}`);
          db.audit(actor, "booking.capture_failed", id, err.message);
          throw new HttpError(502, `Payment capture failed: ${err.message}. The booking is still pending; the desk has been notified.`);
        }
      } else payStatus = "invoice";
      const now = Date.now();
      db.tx(() => {
        db.run("UPDATE bookings SET status='confirmed', pay_status=?, updated_at=? WHERE id=?", payStatus, now, id);
        for (const bl of db.all("SELECT leg_id FROM booking_legs WHERE booking_id=?", id)) db.run("UPDATE legs SET status='booked', updated_at=? WHERE id=?", now, bl.leg_id);
        db.audit(actor, "booking.confirmed", id, payStatus);
      });
      const legs = db.all("SELECT snapshot, operator_id FROM booking_legs WHERE booking_id=? ORDER BY seq", id).map(x => ({ ...JSON.parse(x.snapshot), operatorId: x.operator_id }));
      const ops = Object.fromEntries(db.all("SELECT * FROM operators WHERE id IN (SELECT operator_id FROM booking_legs WHERE booking_id=?)", id).map(o => [o.id, o]));
      await mail({ to: b.contact_email, subject: `Confirmed: ${routeOf(b)}`,
        lines: [`You're booked, ${b.contact_name}.`, ...legs.map(l => `${l.o} → ${l.d} · ${fmtAt(l.depUtc, AP[l.o].tz)} · ${l.type} ${l.tail} · operated by ${ops[l.operatorId]?.company} (Part 135 ${ops[l.operatorId]?.cert}), dispatch ${ops[l.operatorId]?.phone}`),
          payStatus === "captured" ? `Charged: ${usd(b.total)}.` : `Total ${usd(b.total)}. The desk will send your invoice.`,
          "Bring government photo ID for every passenger. The operator will contact you with FBO details and crew information."],
        cta: { label: "View trip", url: link("trips") } });
      for (const op of Object.values(ops))
        await mail({ to: op.email, subject: `Booked: ${routeOf(b)}`, lines: [`The booking for ${routeOf(b)} is confirmed${payStatus === "captured" ? " and paid" : ""}.`, `Lead passenger: ${b.contact_name}, ${b.contact_phone}, ${b.contact_email}. ${b.pax} passenger${b.pax > 1 ? "s" : ""}.`, b.notes ? `Notes: ${b.notes}` : ""].filter(Boolean), cta: { label: "Open operator portal", url: link("operate") } });
      return db.get("SELECT * FROM bookings WHERE id=?", id);
    } finally { busy.delete(id); }
  }

  async function notifyAlertsForLegs(legIds) {
    if (!legIds.length) return;
    const alerts = db.all("SELECT a.*, u.email, u.name FROM alerts a JOIN users u ON u.id=a.user_id");
    if (!alerts.length) return;
    for (const id of legIds) {
      const l = legRow(id);
      if (!l || l.status !== "open" || l.op_status !== "verified" || l.dep_utc < Date.now()) continue;
      for (const a of alerts) {
        if (!AP[a.o] || !AP[a.d]) continue;
        const near = (x, y) => x === y || nm(AP[x], AP[y]) * 1.15078 <= a.radius;
        if (!near(a.o, l.o) || !near(a.d, l.d)) continue;
        const ins = db.run("INSERT OR IGNORE INTO alert_hits(alert_id,leg_id,at) VALUES(?,?,?)", a.id, l.id, Date.now());
        if (ins.changes !== 1) continue;
        await mail({ to: a.email, subject: `New empty leg: ${l.o} → ${l.d} for ${usd(l.price)}`,
          lines: [`A leg matching your ${a.o} → ${a.d} alert was just posted.`, `${l.o} → ${l.d} · ${fmtAt(l.dep_utc, AP[l.o].tz)} · ${l.type} · ${l.seats} seats · ${usd(l.price)} (${Math.round((1 - l.price / legRetail(l)) * 100)}% under one-way retail).`],
          cta: { label: "See the leg", url: link("find") } });
      }
    }
  }

  async function sweep() {
    const now = Date.now();
    for (const b of db.all("SELECT id,status FROM bookings WHERE status IN ('checkout','requested') AND expires_at < ?", now)) {
      try {
        if (b.status === "checkout") await closeBooking(b.id, "cancelled", "Checkout was not completed in time.", "system");
        else await closeBooking(b.id, "declined", `The operator did not confirm within ${cfg.confirmWindowHours} hours.`, "system");
      } catch (err) { log.error(`[sweep] ${b.id}: ${err.message}`); }
    }
    db.run("DELETE FROM sessions WHERE expires_at < ?", now);
    db.run("DELETE FROM resets WHERE expires_at < ?", now);
  }

  async function syncCheckout(b) {
    if (!stripe || b.status !== "checkout" || !b.stripe_session) return;
    const s = await stripe.retrieveSession(b.stripe_session);
    const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : s.payment_intent ? await stripe.retrievePI(s.payment_intent) : null;
    if (s.status === "complete" && pi && pi.status === "requires_capture") await markRequested(b.id, pi.id);
    else if (s.status === "expired") await closeBooking(b.id, "cancelled", "Checkout expired.", "stripe");
  }

  /* ---------------- public ---------------- */
  r.get("/healthz", () => ({ ok: true }));
  r.get("/api/ref", () => ({ brand: cfg.brand, feePct: cfg.feePct, payments: !!stripe, confirmWindowHours: cfg.confirmWindowHours, supportEmail: cfg.supportEmail, supportPhone: cfg.supportPhone }));

  const poolLegs = () => db.all(`SELECT l.*, o.company, o.cert FROM legs l JOIN operators o ON o.id=l.operator_id
      WHERE o.status='verified' AND l.status IN ('open','held') AND l.dep_utc > ?`, Date.now() + 30 * 60000).map(publicLeg);

  r.get("/api/search", ctx => {
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
    const { results, bench } = search(poolLegs(), params);
    for (const x of results) { x.fee = feeFor(x.price); x.total = x.price + x.fee; }
    return { query: params, bench, benchClass: benchmark(from, to, params.pax).cls, results };
  });

  r.get("/api/stats", () => {
    const legs = poolLegs().filter(l => l.status === "open");
    const ops = new Set(legs.map(l => l.operatorId)).size;
    const avgOff = legs.length ? legs.reduce((s, l) => s + (1 - l.price / legRetail(l)), 0) / legs.length : 0;
    const routes = {};
    for (const l of legs) { const k = `${l.o}-${l.d}`; routes[k] = routes[k] || { o: l.o, d: l.d, n: 0, from: Infinity }; routes[k].n++; routes[k].from = Math.min(routes[k].from, l.price); }
    return { legs: legs.length, operators: ops, avgOff, top: Object.values(routes).sort((a, b) => b.n - a.n || a.from - b.from).slice(0, 8) };
  });

  /* ---------------- auth ---------------- */
  r.get("/api/me", ctx => ({ user: publicUser(cfg, db, ctx.user) }));

  r.post("/api/auth/signup", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const { email, password, name, phone } = ctx.body || {};
    if (!validEmail(email)) throw bad("Enter a valid email address.");
    if (!validPassword(password)) throw bad("Use a password of at least 10 characters.");
    const nm_ = str(name, 80, { label: "Name" }), ph = str(phone, 30, { required: false, label: "Phone" });
    const em = email.trim().toLowerCase();
    if (db.get("SELECT 1 FROM users WHERE email=?", em)) throw new HttpError(409, "An account with that email already exists. Sign in instead.");
    const id = newId();
    db.run("INSERT INTO users(id,email,pass,name,phone,role,created_at) VALUES(?,?,?,?,?,?,?)", id, em, await hashPassword(password), nm_, ph, cfg.adminEmails.includes(em) ? "admin" : "user", Date.now());
    db.audit(id, "user.signup", id);
    const s = createSession(db, id);
    ctx.setCookie(cookie(SID, s.token, { maxAge: s.maxAge, secure: cfg.secureCookies }));
    await mail({ to: em, subject: `Welcome to ${cfg.brand}`, lines: [`Hi ${nm_},`, "Your account is ready. Search empty legs, save route alerts, and request flights at a fraction of charter prices.", "Operators: set up your company profile in the Operator portal to start posting legs."], cta: { label: "Find a jet", url: link("find") } });
    return { user: publicUser(cfg, db, db.get("SELECT * FROM users WHERE id=?", id)) };
  });

  r.post("/api/auth/login", async ctx => {
    const { email, password } = ctx.body || {};
    authLimit(`ip:${ctx.ip}`); authLimit(`em:${String(email).toLowerCase()}`);
    const u = validEmail(email) ? db.get("SELECT * FROM users WHERE email=?", email.trim().toLowerCase()) : null;
    if (!u || !(await verifyPassword(String(password || ""), u.pass))) throw new HttpError(401, "That email and password don't match.");
    const s = createSession(db, u.id);
    ctx.setCookie(cookie(SID, s.token, { maxAge: s.maxAge, secure: cfg.secureCookies }));
    return { user: publicUser(cfg, db, u) };
  });

  r.post("/api/auth/logout", ctx => { destroySession(db, ctx.cookies[SID]); ctx.setCookie(cookie(SID, "", { maxAge: 0, secure: cfg.secureCookies })); return { ok: true }; });

  r.post("/api/auth/forgot", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const email = String(ctx.body?.email || "").trim().toLowerCase();
    const u = validEmail(email) ? db.get("SELECT * FROM users WHERE email=?", email) : null;
    if (u) {
      const token = newId(24);
      db.run("INSERT INTO resets(id,user_id,expires_at) VALUES(?,?,?)", sha256(token), u.id, Date.now() + 3600e3);
      await mail({ to: u.email, subject: `Reset your ${cfg.brand} password`, lines: [`Hi ${u.name},`, "Use the link below within one hour to choose a new password. If you didn't ask for this, ignore this email."], cta: { label: "Choose a new password", url: link(`reset-${token}`) } });
    }
    return { ok: true }; // same answer either way, so accounts can't be enumerated
  });

  r.post("/api/auth/reset", async ctx => {
    authLimit(`ip:${ctx.ip}`);
    const { token, password } = ctx.body || {};
    if (!validPassword(password)) throw bad("Use a password of at least 10 characters.");
    const row = token ? db.get("SELECT * FROM resets WHERE id=?", sha256(String(token))) : null;
    if (!row || row.expires_at < Date.now()) throw bad("This reset link has expired. Request a new one.");
    const hash = await hashPassword(password);
    db.tx(() => {
      db.run("UPDATE users SET pass=? WHERE id=?", hash, row.user_id);
      db.run("DELETE FROM resets WHERE user_id=?", row.user_id);
      db.run("DELETE FROM sessions WHERE user_id=?", row.user_id);
    });
    db.audit(row.user_id, "user.reset", row.user_id);
    const s = createSession(db, row.user_id);
    ctx.setCookie(cookie(SID, s.token, { maxAge: s.maxAge, secure: cfg.secureCookies }));
    return { user: publicUser(cfg, db, db.get("SELECT * FROM users WHERE id=?", row.user_id)) };
  });

  r.put("/api/me", ctx => {
    requireUser(ctx);
    const name = str(ctx.body?.name, 80, { label: "Name" }), phone = str(ctx.body?.phone, 30, { required: false, label: "Phone" });
    db.run("UPDATE users SET name=?, phone=? WHERE id=?", name, phone, ctx.user.id);
    return { user: publicUser(cfg, db, db.get("SELECT * FROM users WHERE id=?", ctx.user.id)) };
  });

  /* ---------------- alerts ---------------- */
  r.get("/api/alerts", ctx => {
    requireUser(ctx);
    const pool = poolLegs().filter(l => l.status === "open");
    return { alerts: db.all("SELECT id,o,d,radius,created_at FROM alerts WHERE user_id=? ORDER BY created_at", ctx.user.id).map(a => ({
      ...a, live: pool.filter(l => (l.o === a.o || nm(AP[a.o], AP[l.o]) * 1.15078 <= a.radius) && (l.d === a.d || nm(AP[a.d], AP[l.d]) * 1.15078 <= a.radius)).length })) };
  });
  r.post("/api/alerts", ctx => {
    requireUser(ctx);
    const { o, d } = ctx.body || {};
    if (!AP[o] || !AP[d] || o === d) throw bad("Pick two different airports.");
    const radius = int(ctx.body.radius ?? 50, 0, 200, "Radius");
    if (db.get("SELECT COUNT(*) n FROM alerts WHERE user_id=?", ctx.user.id).n >= 20) throw bad("You can keep up to 20 alerts. Remove one first.");
    if (db.get("SELECT 1 FROM alerts WHERE user_id=? AND o=? AND d=?", ctx.user.id, o, d)) throw new HttpError(409, `You already have an alert for ${o} → ${d}.`);
    const id = newId(8);
    db.run("INSERT INTO alerts(id,user_id,o,d,radius,created_at) VALUES(?,?,?,?,?,?)", id, ctx.user.id, o, d, radius, Date.now());
    return { id };
  });
  r.del("/api/alerts/:id", ctx => { requireUser(ctx); db.run("DELETE FROM alerts WHERE id=? AND user_id=?", ctx.params.id, ctx.user.id); return { ok: true }; });

  /* ---------------- traveler bookings ---------------- */
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
    const rows = ids.map(legRow);
    if (rows.some(x => !x || x.op_status !== "verified")) throw new HttpError(409, "One of these legs is no longer listed.");
    const legs = rows.map(x => ({ ...publicLeg(x) }));
    const now = Date.now();
    const problem = validateItinerary(legs, pax, now);
    if (problem) throw new HttpError(409, problem);
    const subtotal = legs.reduce((s, l) => s + l.price, 0), fee = feeFor(subtotal), total = subtotal + fee;
    const retail = legs.length === 1 ? legRetail(legs[0]) : benchmark(legs[0].o, legs[1].d, pax).bench;
    const id = newId(10), payMode = stripe ? "stripe" : "request";
    db.tx(() => {
      for (const l of legs) {
        const res = db.run("UPDATE legs SET status='held', updated_at=? WHERE id=? AND status='open'", now, l.id);
        if (res.changes !== 1) throw new HttpError(409, `Someone else just started booking the ${l.o} → ${l.d} leg. Try another result.`);
      }
      db.run(`INSERT INTO bookings(id,user_id,status,pax,notes,contact_name,contact_phone,contact_email,subtotal,fee,total,retail,pay_mode,pay_status,expires_at,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ctx.user.id, payMode === "stripe" ? "checkout" : "requested", pax, notes, contact.name, contact.phone, contact.email,
        subtotal, fee, total, retail, payMode, payMode === "stripe" ? "pending" : "none",
        payMode === "stripe" ? now + (CHECKOUT_MINUTES + 4) * 60000 : now + cfg.confirmWindowHours * 3600e3, now, now);
      legs.forEach((l, i) => db.run("INSERT INTO booking_legs(booking_id,leg_id,operator_id,seq,snapshot) VALUES(?,?,?,?,?)", id, l.id, l.operatorId, i,
        JSON.stringify({ o: l.o, d: l.d, dep: l.dep, depUtc: l.depUtc, type: l.type, cls: l.cls, tail: l.tail, seats: l.seats, price: l.price, company: l.company, cert: l.cert, block: legBlock(l) })));
      db.audit(ctx.user.id, "booking.create", id, { legs: ids, total });
    });
    const b = db.get("SELECT * FROM bookings WHERE id=?", id);
    if (payMode === "stripe") {
      const route = [legs[0].o, ...legs.map(l => l.d)].join(" → ");
      try {
        const s = await stripe.createCheckout({
          mode: "payment", customer_email: contact.email, client_reference_id: id,
          expires_at: Math.floor(now / 1000) + CHECKOUT_MINUTES * 60,
          line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: total * 100,
            product_data: { name: `Private jet empty leg ${route}`, description: `${legs.map(l => `${l.o}→${l.d} ${l.dep.replace("T", " ")} local, ${l.type}`).join("; ")}. ${pax} pax. Includes ${usd(fee)} service fee.` } } }],
          payment_intent_data: { capture_method: "manual", description: `${cfg.brand} booking ${id}`, metadata: { booking_id: id } },
          metadata: { booking_id: id },
          success_url: `${cfg.baseUrl}/?paid=${id}#trips`, cancel_url: `${cfg.baseUrl}/?unpaid=${id}#trips`,
        }, `checkout-${id}`);
        db.run("UPDATE bookings SET stripe_session=?, checkout_url=? WHERE id=?", s.id, s.url, id);
        return { booking: bookingView(db.get("SELECT * FROM bookings WHERE id=?", id)), checkoutUrl: s.url };
      } catch (err) {
        log.error(`[stripe] checkout ${id}: ${err.message}`);
        await closeBooking(id, "cancelled", "Payment could not be started.", "system").catch(() => {});
        throw new HttpError(502, "We couldn't start the secure payment page. Nothing was charged; try again in a minute.");
      }
    }
    await mail({ to: contact.email, subject: `Request received: ${routeOf(b)}`, lines: [`Thanks, ${contact.name}. We've sent your request to the operator.`, `They confirm within ${cfg.confirmWindowHours} hours. Nothing is charged until the flight is confirmed and you approve the invoice.`], cta: { label: "Track your trip", url: link("trips") } });
    await notifyOperatorsOfRequest(b);
    return { booking: bookingView(b) };
  });

  r.get("/api/bookings", ctx => {
    requireUser(ctx);
    return { bookings: db.all("SELECT * FROM bookings WHERE user_id=? ORDER BY created_at DESC LIMIT 200", ctx.user.id).map(b => bookingView(b)) };
  });
  const myBooking = ctx => { const b = db.get("SELECT * FROM bookings WHERE id=? AND user_id=?", ctx.params.id, ctx.user.id); if (!b) throw new HttpError(404, "Booking not found."); return b; };
  r.post("/api/bookings/:id/sync", async ctx => {
    requireUser(ctx); const b = myBooking(ctx);
    try { await syncCheckout(b); } catch (err) { log.warn?.(`[stripe] sync ${b.id}: ${err.message}`); }
    return { booking: bookingView(db.get("SELECT * FROM bookings WHERE id=?", b.id)) };
  });
  r.post("/api/bookings/:id/cancel", async ctx => {
    requireUser(ctx); const b = myBooking(ctx);
    if (!["checkout", "requested"].includes(b.status)) throw new HttpError(409, b.status === "confirmed" ? "This trip is confirmed. Contact the desk to change or cancel it; the operator's cancellation terms apply." : "This request is already closed.");
    await closeBooking(b.id, "cancelled", "Cancelled by traveler.", ctx.user.id);
    return { booking: bookingView(db.get("SELECT * FROM bookings WHERE id=?", b.id)) };
  });

  /* ---------------- Stripe webhook ---------------- */
  r.post("/api/stripe/webhook", async ctx => {
    let evt;
    try { evt = verifyWebhook(ctx.raw, ctx.req.headers["stripe-signature"], cfg.stripeWebhookSecret); }
    catch (err) { log.warn?.(`[stripe] webhook rejected: ${err.message}`); throw bad("Invalid signature."); }
    const obj = evt.data?.object || {};
    const bookingId = obj.metadata?.booking_id || obj.client_reference_id;
    const b = bookingId ? db.get("SELECT * FROM bookings WHERE id=?", bookingId) : null;
    if (!b) return { received: true, ignored: true };
    if (evt.type === "checkout.session.completed") {
      const piId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      const pi = piId && stripe ? await stripe.retrievePI(piId) : null;
      if (pi && pi.status === "requires_capture") await markRequested(b.id, pi.id);
    } else if (evt.type === "checkout.session.expired") {
      if (b.status === "checkout") await closeBooking(b.id, "cancelled", "Checkout expired.", "stripe");
    } else if (evt.type === "payment_intent.canceled") {
      if (b.status === "requested" && b.pay_status === "authorized") {
        db.run("UPDATE bookings SET pay_status='released' WHERE id=?", b.id);
        await closeBooking(b.id, "declined", "The card authorization expired or was cancelled.", "stripe");
      }
    }
    return { received: true };
  });

  /* ---------------- operators ---------------- */
  const legOut = l => ({ ...publicLeg(l), retail: legRetail(l), activeBooking: db.get("SELECT b.id FROM booking_legs bl JOIN bookings b ON b.id=bl.booking_id WHERE bl.leg_id=? AND b.status IN ('checkout','requested','confirmed') LIMIT 1", l.id)?.id || null });

  r.get("/api/operator", ctx => {
    requireUser(ctx);
    const op = myOperator(ctx);
    if (!op) return { operator: null, legs: [] };
    const legs = db.all("SELECT l.*, ? AS company, ? AS cert FROM legs l WHERE operator_id=? AND status!='removed' ORDER BY dep_utc", op.company, op.cert, op.id).map(legOut);
    return { operator: { id: op.id, company: op.company, cert: op.cert, phone: op.phone, email: op.email, base: op.base, status: op.status }, legs };
  });

  r.post("/api/operator/profile", ctx => {
    requireUser(ctx);
    const b = ctx.body || {};
    const p = { company: str(b.company, 80, { label: "Operator name" }), cert: str(b.cert, 20, { label: "Certificate number" }).toUpperCase(),
      phone: str(b.phone, 30, { label: "Dispatch phone" }), email: str(b.email, 120, { label: "Charter sales email" }), base: AP[b.base] ? b.base : "" };
    if (!validEmail(p.email)) throw bad("Enter a valid charter sales email.");
    if (!/^[A-Z0-9-]{4,20}$/.test(p.cert)) throw bad("Enter the air carrier certificate number exactly as issued (letters and digits).");
    const now = Date.now(), op = myOperator(ctx);
    if (op) {
      const certChanged = op.cert !== p.cert;
      db.run("UPDATE operators SET company=?, cert=?, phone=?, email=?, base=?, status=?, updated_at=? WHERE id=?", p.company, p.cert, p.phone, p.email, p.base,
        certChanged && op.status === "verified" ? "pending" : op.status, now, op.id);
      db.audit(ctx.user.id, "operator.update", op.id, certChanged ? "cert changed; re-verification required" : null);
    } else {
      const id = newId(8);
      db.run("INSERT INTO operators(id,user_id,company,cert,phone,email,base,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, ctx.user.id, p.company, p.cert, p.phone, p.email, p.base, "pending", now, now);
      db.audit(ctx.user.id, "operator.create", id);
      for (const a of db.all("SELECT email FROM users WHERE role='admin'").map(x => x.email).concat(cfg.adminEmails))
        mail({ to: a, subject: `Operator to verify: ${p.company}`, lines: [`${p.company} (Part 135 ${p.cert}) signed up and is waiting for verification.`, `Contact: ${p.phone}, ${p.email}.`], cta: { label: "Open admin", url: link("admin") } });
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
    requireOperator(ctx);
    const now = Date.now(), l = parseLeg(ctx.body || {}, now), id = newId(9);
    if (db.get("SELECT COUNT(*) n FROM legs WHERE operator_id=? AND status IN ('open','held') AND dep_utc>?", ctx.op.id, now).n >= 500) throw bad("You have 500 open legs. Withdraw some before posting more.");
    db.run(`INSERT INTO legs(id,operator_id,o,d,dep_local,dep_utc,window_h,cls,type,tail,seats,price,may_cancel,notes,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', ?, ?)`, id, ctx.op.id, l.o, l.d, l.dep_local, l.dep_utc, l.window_h, l.cls, l.type, l.tail, l.seats, l.price, l.may_cancel, l.notes, now, now);
    db.audit(ctx.user.id, "leg.create", id);
    if (ctx.op.status === "verified") await notifyAlertsForLegs([id]);
    return { id };
  });

  const ownLeg = ctx => { const l = db.get("SELECT * FROM legs WHERE id=? AND operator_id=?", ctx.params.id, ctx.op.id); if (!l) throw new HttpError(404, "Leg not found."); return l; };
  r.put("/api/operator/legs/:id", async ctx => {
    requireOperator(ctx);
    const cur = ownLeg(ctx);
    if (cur.status !== "open" && cur.status !== "withdrawn") throw new HttpError(409, "This leg has an active booking and can't be edited.");
    const l = parseLeg(ctx.body || {}, Date.now());
    db.run(`UPDATE legs SET o=?,d=?,dep_local=?,dep_utc=?,window_h=?,cls=?,type=?,tail=?,seats=?,price=?,may_cancel=?,notes=?,updated_at=? WHERE id=?`,
      l.o, l.d, l.dep_local, l.dep_utc, l.window_h, l.cls, l.type, l.tail, l.seats, l.price, l.may_cancel, l.notes, Date.now(), cur.id);
    db.audit(ctx.user.id, "leg.update", cur.id);
    return { ok: true };
  });
  r.post("/api/operator/legs/:id/status", async ctx => {
    requireOperator(ctx);
    const cur = ownLeg(ctx), to = ctx.body?.status, now = Date.now();
    const allowed = { withdrawn: ["open"], open: ["withdrawn"], removed: ["withdrawn", "open"] };
    if (!allowed[to]) throw bad("Unknown status.");
    if (to === "removed" && cur.status === "open" && cur.dep_utc > now) throw new HttpError(409, "Withdraw the leg before removing it.");
    if (!allowed[to].includes(cur.status)) throw new HttpError(409, cur.status === "held" ? "A traveler is booking this leg. Confirm or decline the request first." : `A ${cur.status} leg can't be changed to ${to}.`);
    if (to === "open" && cur.dep_utc < now + 30 * 60000) throw new HttpError(409, "This leg has already departed.");
    db.run("UPDATE legs SET status=?, updated_at=? WHERE id=?", to, now, cur.id);
    db.audit(ctx.user.id, `leg.${to}`, cur.id);
    if (to === "open" && ctx.op.status === "verified") await notifyAlertsForLegs([cur.id]);
    return { ok: true };
  });

  r.get("/api/operator/bookings", ctx => {
    requireOperator(ctx);
    return { bookings: db.all(`SELECT DISTINCT b.* FROM bookings b JOIN booking_legs bl ON bl.booking_id=b.id WHERE bl.operator_id=? AND b.status!='checkout' ORDER BY b.created_at DESC LIMIT 200`, ctx.op.id)
      .map(b => bookingView(b, { forOperatorId: ctx.op.id })) };
  });

  r.post("/api/operator/bookings/:id/respond", async ctx => {
    requireOperator(ctx);
    const decision = ctx.body?.decision, note = str(ctx.body?.note, 500, { required: false });
    if (!["confirm", "decline"].includes(decision)) throw bad("Choose confirm or decline.");
    const b = db.get("SELECT * FROM bookings WHERE id=?", ctx.params.id);
    const mine = b && db.all("SELECT * FROM booking_legs WHERE booking_id=? AND operator_id=?", b.id, ctx.op.id);
    if (!b || !mine.length) throw new HttpError(404, "Booking not found.");
    if (b.status !== "requested") throw new HttpError(409, "This request is no longer waiting on you.");
    if (decision === "decline") {
      db.run("UPDATE booking_legs SET op_status='declined', op_note=? WHERE booking_id=? AND operator_id=?", note, b.id, ctx.op.id);
      await closeBooking(b.id, "declined", note || `${ctx.op.company} can't operate this flight.`, ctx.user.id);
    } else {
      db.run("UPDATE booking_legs SET op_status='confirmed', op_note=? WHERE booking_id=? AND operator_id=?", note, b.id, ctx.op.id);
      db.audit(ctx.user.id, "booking.op_confirm", b.id, ctx.op.id);
      const pending = db.get("SELECT COUNT(*) n FROM booking_legs WHERE booking_id=? AND op_status!='confirmed'", b.id).n;
      if (!pending) await confirmBooking(b.id, ctx.user.id);
    }
    return { booking: bookingView(db.get("SELECT * FROM bookings WHERE id=?", b.id), { forOperatorId: ctx.op.id }) };
  });

  /* ---------------- admin ---------------- */
  r.get("/api/admin/overview", ctx => {
    requireAdmin(ctx);
    const now = Date.now();
    const operators = db.all("SELECT o.*, u.email AS account_email, u.name AS account_name FROM operators o JOIN users u ON u.id=o.user_id ORDER BY o.status='pending' DESC, o.created_at DESC").map(o => ({
      id: o.id, company: o.company, cert: o.cert, phone: o.phone, email: o.email, base: o.base, status: o.status, createdAt: o.created_at, account: { name: o.account_name, email: o.account_email },
      openLegs: db.get("SELECT COUNT(*) n FROM legs WHERE operator_id=? AND status='open' AND dep_utc>?", o.id, now).n }));
    const bookings = db.all("SELECT * FROM bookings WHERE status!='checkout' OR expires_at>? ORDER BY created_at DESC LIMIT 300", now).map(b => bookingView(b, { admin: true }));
    const gmv = db.get("SELECT COALESCE(SUM(total),0) t, COALESCE(SUM(fee),0) f, COUNT(*) n FROM bookings WHERE status='confirmed'");
    return { operators, bookings, totals: { users: db.get("SELECT COUNT(*) n FROM users").n, confirmed: gmv.n, gmv: gmv.t, fees: gmv.f,
      openLegs: db.get("SELECT COUNT(*) n FROM legs l JOIN operators o ON o.id=l.operator_id WHERE l.status='open' AND o.status='verified' AND l.dep_utc>?", now).n } };
  });

  r.post("/api/admin/operators/:id/status", async ctx => {
    requireAdmin(ctx);
    const to = ctx.body?.status; if (!["verified", "pending", "suspended"].includes(to)) throw bad("Unknown status.");
    const op = db.get("SELECT * FROM operators WHERE id=?", ctx.params.id); if (!op) throw new HttpError(404, "Operator not found.");
    const now = Date.now();
    db.tx(() => {
      db.run("UPDATE operators SET status=?, updated_at=? WHERE id=?", to, now, op.id);
      if (to === "suspended") db.run("UPDATE legs SET status='withdrawn', updated_at=? WHERE operator_id=? AND status='open'", now, op.id);
      db.audit(ctx.user.id, `operator.${to}`, op.id);
    });
    if (to === "verified" && op.status !== "verified") {
      await mail({ to: op.email, subject: `${op.company} is verified on ${cfg.brand}`, lines: ["Your certificate checked out. Your open legs are now visible to travelers, with the verified badge."], cta: { label: "Post empty legs", url: link("operate") } });
      await notifyAlertsForLegs(db.all("SELECT id FROM legs WHERE operator_id=? AND status='open'", op.id).map(x => x.id));
    }
    return { ok: true };
  });

  r.post("/api/admin/bookings/:id/respond", async ctx => {
    requireAdmin(ctx);
    const decision = ctx.body?.decision, note = str(ctx.body?.note, 500, { required: false });
    const b = db.get("SELECT * FROM bookings WHERE id=?", ctx.params.id); if (!b) throw new HttpError(404, "Booking not found.");
    if (!["requested", "checkout"].includes(b.status)) throw new HttpError(409, "This booking is already closed.");
    if (decision === "decline") await closeBooking(b.id, "declined", note || "Not available.", ctx.user.id);
    else if (decision === "confirm") {
      if (b.status !== "requested") throw new HttpError(409, "The traveler hasn't completed payment yet.");
      db.run("UPDATE booking_legs SET op_status='confirmed', op_note=CASE WHEN op_note='' THEN 'Confirmed by desk' ELSE op_note END WHERE booking_id=?", b.id);
      await confirmBooking(b.id, ctx.user.id);
    } else throw bad("Choose confirm or decline.");
    return { booking: bookingView(db.get("SELECT * FROM bookings WHERE id=?", b.id), { admin: true }) };
  });

  r.post("/api/admin/bookings/:id/message", async ctx => {
    requireAdmin(ctx);
    const msg = str(ctx.body?.message, 800, { label: "Message" });
    const b = db.get("SELECT * FROM bookings WHERE id=?", ctx.params.id); if (!b) throw new HttpError(404, "Booking not found.");
    db.run("UPDATE bookings SET message=?, updated_at=? WHERE id=?", msg, Date.now(), b.id);
    db.audit(ctx.user.id, "booking.message", b.id, msg);
    await mail({ to: b.contact_email, subject: `Update on your trip: ${routeOf(b)}`, lines: [msg], cta: { label: "View trip", url: link("trips") } });
    return { ok: true };
  });

  /* ---------------- server ---------------- */
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://x");
    const pathname = url.pathname;
    securityHeaders(res, cfg.secureCookies);
    const done = status => { if (!pathname.startsWith("/assets") && pathname !== "/healthz") log.info?.(`${req.method} ${pathname} ${status} ${Date.now() - t0}ms`); };
    try {
      if (req.method === "GET" && !pathname.startsWith("/api/") && pathname !== "/healthz") {
        if (pathname === "/shared/ref.js") return serveFile(res, path.join(ROOT, "server", "ref.js"));
        const rel = pathname === "/" ? "index.html" : pathname.slice(1);
        const file = path.resolve(PUBLIC, rel);
        if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, "Not found");
        return serveFile(res, file);
      }
      const m = r.match(req.method, pathname);
      if (!m) throw new HttpError(404, "Not found.");
      if (req.method !== "GET" && pathname !== "/api/stripe/webhook" && req.headers["x-requested-with"] !== "deadhead")
        throw new HttpError(403, "Request blocked. Reload the page and try again.");
      const raw = req.method === "GET" ? Buffer.alloc(0) : await readBody(req);
      let body = null;
      if (raw.length && pathname !== "/api/stripe/webhook") { try { body = JSON.parse(raw.toString("utf8")); } catch { throw bad("Malformed request."); } }
      const cookies = parseCookies(req.headers.cookie);
      const ip = (cfg.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
      const setCookies = [];
      const ctx = { req, res, query: url.searchParams, params: m.params, body, raw, cookies, ip, user: userForToken(db, cookies[SID]), setCookie: c => setCookies.push(c) };
      let out;
      for (const h of m.handlers) out = await h(ctx);
      if (setCookies.length) res.setHeader("Set-Cookie", setCookies);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(out ?? {}));
      done(200);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(`[error] ${req.method} ${pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: status === 500 ? "Something went wrong on our side. Try again; if it keeps happening, contact support." : err.message, ...(err.extra || {}) }));
      } else res.end();
      done(status);
    }
  });

  return { server, db, sweep, stripe, cfg };
}

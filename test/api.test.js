import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { signWebhook, verifyWebhook, formEncode } from "../server/stripe.js";
import { outbox } from "../server/email.js";
import { localToUtc, AP } from "../server/ref.js";

const quiet = { info() {}, warn() {}, error: (...a) => console.error(...a) };
const WHSEC = "whsec_test_123";

/* ---------- mock Stripe API ---------- */
function startStripeMock() {
  const sessions = {}, pis = {}; let n = 0; const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const url = new URL(req.url, "http://x"); calls.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization, idem: req.headers["idempotency-key"] });
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      let m;
      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const p = new URLSearchParams(body); const id = `cs_${++n}`;
        sessions[id] = { id, status: "open", url: `https://checkout.stripe.test/${id}`, payment_intent: null, metadata: { booking_id: p.get("metadata[booking_id]") }, amount: +p.get("line_items[0][price_data][unit_amount]"), capture: p.get("payment_intent_data[capture_method]") };
        return send(200, sessions[id]);
      }
      if ((m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname)) && req.method === "GET") {
        const s = sessions[m[1]]; return s ? send(200, { ...s, payment_intent: s.payment_intent ? pis[s.payment_intent] : null }) : send(404, { error: { message: "no such session" } });
      }
      if ((m = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname))) { sessions[m[1]].status = "expired"; return send(200, sessions[m[1]]); }
      if ((m = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname))) return send(200, pis[m[1]]);
      if ((m = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(url.pathname))) { pis[m[1]].status = "succeeded"; return send(200, pis[m[1]]); }
      if ((m = /^\/v1\/payment_intents\/([^/]+)\/cancel$/.exec(url.pathname))) { pis[m[1]].status = "canceled"; return send(200, pis[m[1]]); }
      send(404, { error: { message: "unknown route" } });
    });
  });
  return new Promise(r => srv.listen(0, () => r({ srv, sessions, pis, calls, base: `http://127.0.0.1:${srv.address().port}`,
    complete(id) { const pi = `pi_${id}`; pis[pi] = { id: pi, status: "requires_capture", metadata: sessions[id].metadata }; sessions[id].status = "complete"; sessions[id].payment_intent = pi; return pi; } })));
}

/* ---------- client with cookie jar ---------- */
function client(base) {
  let jar = "";
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "deadhead", ...(jar ? { Cookie: jar } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const v = c.split(";")[0]; jar = v.endsWith("=") ? "" : v; }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ...json };
  };
}

async function boot(extra) {
  const cfg = loadConfig({ databaseFile: ":memory:", baseUrl: "http://localhost", adminEmails: ["desk@deadhead.test"], feePct: 5, confirmWindowHours: 48, stripeKey: "", stripeWebhookSecret: WHSEC, ...extra });
  const app = createApp(cfg, { log: quiet });
  await new Promise(r => app.server.listen(0, r));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  return app;
}
const future = (days, hhmm = "10:30") => { const d = new Date(Date.now() + days * 864e5); return d.toISOString().slice(0, 10) + "T" + hhmm; };

async function setupMarket(app) {
  const desk = client(app.base), op = client(app.base), op2 = client(app.base), trav = client(app.base);
  assert.equal((await desk("POST", "/api/auth/signup", { email: "desk@deadhead.test", password: "correct horse battery", name: "Desk" })).user.admin, true);
  await op("POST", "/api/auth/signup", { email: "ops@northline.test", password: "operator-pass-1", name: "Dana Ops" });
  await op2("POST", "/api/auth/signup", { email: "ops@cobalt.test", password: "operator-pass-2", name: "Cole Ops" });
  await trav("POST", "/api/auth/signup", { email: "jane@flyer.test", password: "traveler-pass-1", name: "Jane Flyer", phone: "555-0101" });
  assert.equal((await op("POST", "/api/operator/profile", { company: "Northline Air", cert: "N2LA123K", phone: "555-0100", email: "ops@northline.test", base: "KTEB" })).ok, true);
  assert.equal((await op2("POST", "/api/operator/profile", { company: "Cobalt Jets", cert: "C0BA456J", phone: "555-0200", email: "ops@cobalt.test" })).ok, true);
  return { desk, op, op2, trav };
}

test("stripe webhook signatures verify and reject tampering", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "x" });
  const header = signWebhook(payload, WHSEC);
  assert.equal(verifyWebhook(Buffer.from(payload), header, WHSEC).id, "evt_1");
  assert.throws(() => verifyWebhook(Buffer.from(payload + " "), header, WHSEC), /mismatch/);
  assert.throws(() => verifyWebhook(Buffer.from(payload), signWebhook(payload, WHSEC, Math.floor(Date.now() / 1000) - 1000), WHSEC), /tolerance/);
  assert.equal(formEncode({ a: { b: [{ c: 1 }] }, d: "x y" }), "a%5Bb%5D%5B0%5D%5Bc%5D=1&d=x%20y");
});

test("time zones: local departure converts to UTC across DST", () => {
  assert.equal(new Date(localToUtc("2026-07-01T10:00", AP.KTEB.tz)).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(new Date(localToUtc("2026-12-01T10:00", AP.KTEB.tz)).toISOString(), "2026-12-01T15:00:00.000Z");
  assert.equal(new Date(localToUtc("2026-12-01T10:00", AP.KVNY.tz)).toISOString(), "2026-12-01T18:00:00.000Z");
});

test("request mode: post, verify, search (nearby + two-hop), book, confirm, decline, cancel", async () => {
  const app = await boot();
  try {
    const { desk, op, op2, trav } = await setupMarket(app);
    const anon = client(app.base);

    // CSRF guard
    const blocked = await fetch(app.base + "/api/auth/logout", { method: "POST" });
    assert.equal(blocked.status, 403);

    // Northline posts HPN→BCT; unverified operators are hidden from search
    const l1 = await op("POST", "/api/operator/legs", { o: "KHPN", d: "KBCT", dep: future(3), window: 2, cls: "smid", type: "Challenger 350", tail: "N350NL", seats: 9, price: 14500, notes: "Wi-Fi" });
    assert.ok(l1.id, JSON.stringify(l1));
    let s = await anon("GET", `/api/search?from=KTEB&to=KPBI&date=${future(3).slice(0, 10)}&flex=2&radius=50&pax=4`);
    assert.equal(s.results.length, 0, "unverified legs must not appear");

    // traveler sets an alert, then desk verifies → alert email
    assert.ok((await trav("POST", "/api/alerts", { o: "KTEB", d: "KPBI", radius: 50 })).id);
    const opId = (await desk("GET", "/api/admin/overview")).operators.find(o => o.company === "Northline Air").id;
    const op2Id = (await desk("GET", "/api/admin/overview")).operators.find(o => o.company === "Cobalt Jets").id;
    assert.equal((await trav("POST", `/api/admin/operators/${opId}/status`, { status: "verified" })).status, 403, "non-admin can't verify");
    await desk("POST", `/api/admin/operators/${opId}/status`, { status: "verified" });
    await desk("POST", `/api/admin/operators/${op2Id}/status`, { status: "verified" });
    assert.ok(outbox.some(m => m.to === "jane@flyer.test" && /New empty leg: KHPN → KBCT/.test(m.subject)), "alert email sent");
    assert.equal((await trav("GET", "/api/alerts")).alerts[0].live, 1);

    s = await anon("GET", `/api/search?from=KTEB&to=KPBI&date=${future(3).slice(0, 10)}&flex=2&radius=50&pax=4`);
    assert.equal(s.results.length, 1);
    assert.equal(s.results[0].legs[0].o, "KHPN");
    assert.equal(s.results[0].fee, 725); assert.equal(s.results[0].total, 15225);
    assert.equal(s.results[0].legs[0].tail, "N350NL");
    assert.equal(s.results[0].legs[0].company, "Northline Air");
    assert.equal(s.results[0].legs[0].email, undefined, "operator contact not exposed publicly");
    // too many passengers
    assert.equal((await anon("GET", `/api/search?from=KTEB&to=KPBI&date=${future(3).slice(0, 10)}&pax=12`)).results.length, 0);

    // Two-hop: Northline TEB→PDK, Cobalt PDK→ASE same day with a workable connection
    const a = await op("POST", "/api/operator/legs", { o: "KTEB", d: "KPDK", dep: future(5, "08:00"), window: 0, cls: "mid", type: "Citation XLS+", seats: 8, price: 6000 });
    const b = await op2("POST", "/api/operator/legs", { o: "KPDK", d: "KASE", dep: future(5, "13:00"), window: 0, cls: "smid", type: "Praetor 600", seats: 9, price: 9000 });
    s = await anon("GET", `/api/search?from=KTEB&to=KASE&date=${future(5).slice(0, 10)}&flex=0&radius=0&pax=2`);
    const chain = s.results.find(x => x.legs.length === 2);
    assert.ok(chain, "two-hop found: " + JSON.stringify(s.results.map(r => r.legs.map(l => l.o + l.d))));
    assert.equal(chain.price, 15000);

    // Booking requires sign-in and acceptance
    assert.equal((await anon("POST", "/api/bookings", { legIds: [l1.id], pax: 4, contact: { name: "X", phone: "1", email: "x@y.test" }, accept: true })).status, 401);
    assert.equal((await trav("POST", "/api/bookings", { legIds: [l1.id], pax: 4, contact: { name: "Jane", phone: "555", email: "jane@flyer.test" } })).status, 400);

    // Book single leg → held; second attempt conflicts
    const bk = await trav("POST", "/api/bookings", { legIds: [l1.id], pax: 4, notes: "Two dogs", contact: { name: "Jane Flyer", phone: "555-0101", email: "jane@flyer.test" }, accept: true });
    assert.equal(bk.booking.status, "requested", JSON.stringify(bk));
    assert.equal(bk.booking.total, 15225);
    const again = await trav("POST", "/api/bookings", { legIds: [l1.id], pax: 4, contact: { name: "Jane", phone: "555", email: "jane@flyer.test" }, accept: true });
    assert.equal(again.status, 409);
    s = await anon("GET", `/api/search?from=KTEB&to=KPBI&date=${future(3).slice(0, 10)}&flex=2&radius=50&pax=4`);
    assert.equal(s.results[0].held, true, "held leg shows as held");
    assert.ok(outbox.some(m => m.to === "ops@northline.test" && /New booking request/.test(m.subject)));

    // Operator sees request without traveler phone/email until confirmed; can't edit a held leg
    let ob = await op("GET", "/api/operator/bookings");
    assert.equal(ob.bookings[0].contact.phone, ""); assert.equal(ob.bookings[0].contact.name, "Jane Flyer");
    assert.equal((await op("PUT", `/api/operator/legs/${l1.id}`, { o: "KHPN", d: "KBCT", dep: future(3), cls: "smid", type: "x", seats: 9, price: 1000 })).status, 409);
    // Other operator can't respond
    assert.equal((await op2("POST", `/api/operator/bookings/${bk.booking.id}/respond`, { decision: "confirm" })).status, 404);
    const conf = await op("POST", `/api/operator/bookings/${bk.booking.id}/respond`, { decision: "confirm", note: "Crew assigned" });
    assert.equal(conf.booking.status, "confirmed");
    assert.equal(conf.booking.contact.phone, "555-0101");
    assert.equal((await op("GET", "/api/operator")).legs.find(l => l.id === l1.id).status, "booked");
    assert.ok(outbox.some(m => m.to === "jane@flyer.test" && /^Confirmed:/.test(m.subject)));
    const mine = await trav("GET", "/api/bookings");
    assert.equal(mine.bookings[0].status, "confirmed"); assert.equal(mine.bookings[0].payStatus, "invoice");

    // Two-hop booking: one operator confirms, the other declines → whole booking declined, both legs reopen
    const bk2 = await trav("POST", "/api/bookings", { legIds: [a.id, b.id], pax: 2, contact: { name: "Jane Flyer", phone: "555-0101", email: "jane@flyer.test" }, accept: true });
    assert.equal(bk2.booking.legs.length, 2);
    assert.equal((await op("POST", `/api/operator/bookings/${bk2.booking.id}/respond`, { decision: "confirm" })).booking.status, "requested");
    assert.equal((await op2("POST", `/api/operator/bookings/${bk2.booking.id}/respond`, { decision: "decline", note: "Maintenance" })).booking.status, "declined");
    const legsNow = (await op("GET", "/api/operator")).legs;
    assert.equal(legsNow.find(l => l.id === a.id).status, "open");

    // Traveler cancels a pending request
    const bk3 = await trav("POST", "/api/bookings", { legIds: [a.id], pax: 2, contact: { name: "Jane Flyer", phone: "555-0101", email: "jane@flyer.test" }, accept: true });
    assert.equal((await trav("POST", `/api/bookings/${bk3.booking.id}/cancel`)).booking.status, "cancelled");
    assert.equal((await trav("POST", `/api/bookings/${bk.booking.id}/cancel`)).status, 409, "confirmed trips can't self-cancel");

    // Expiry sweep declines stale requests
    const bk4 = await trav("POST", "/api/bookings", { legIds: [a.id], pax: 2, contact: { name: "Jane Flyer", phone: "555-0101", email: "jane@flyer.test" }, accept: true });
    app.db.run("UPDATE bookings SET expires_at=? WHERE id=?", Date.now() - 1, bk4.booking.id);
    await app.sweep();
    assert.equal((await trav("GET", "/api/bookings")).bookings.find(x => x.id === bk4.booking.id).status, "declined");

    // Leg lifecycle + validation
    assert.equal((await op("POST", "/api/operator/legs", { o: "KTEB", d: "KTEB", dep: future(2), cls: "mid", type: "x", seats: 8, price: 5000 })).status, 400);
    assert.equal((await op("POST", "/api/operator/legs", { o: "KTEB", d: "KBOS", dep: "2020-01-01T10:00", cls: "mid", type: "x", seats: 8, price: 5000 })).status, 400);
    assert.equal((await op("POST", `/api/operator/legs/${a.id}/status`, { status: "withdrawn" })).ok, true);
    assert.equal((await anon("GET", `/api/search?from=KTEB&to=KPDK&date=${future(5).slice(0, 10)}&flex=0&radius=0&pax=2`)).results.length, 0);

    // Suspending an operator withdraws its open legs
    await desk("POST", `/api/admin/operators/${op2Id}/status`, { status: "suspended" });
    assert.equal((await op2("POST", "/api/operator/legs", { o: "KTEB", d: "KBOS", dep: future(2), cls: "mid", type: "x", seats: 8, price: 5000 })).status, 403);

    // Password reset flow
    const forgot = await anon("POST", "/api/auth/forgot", { email: "jane@flyer.test" });
    assert.equal(forgot.ok, true);
    const token = /#reset-([A-Za-z0-9_-]+)/.exec(outbox.filter(m => m.to === "jane@flyer.test").at(-1).text)[1];
    assert.equal((await anon("POST", "/api/auth/reset", { token, password: "brand-new-password" })).user.email, "jane@flyer.test");
    assert.equal((await client(app.base)("POST", "/api/auth/login", { email: "jane@flyer.test", password: "traveler-pass-1" })).status, 401);
    assert.equal((await client(app.base)("POST", "/api/auth/login", { email: "jane@flyer.test", password: "brand-new-password" })).user.name, "Jane Flyer");

    // Admin overview totals
    const ov = await desk("GET", "/api/admin/overview");
    assert.equal(ov.totals.confirmed, 1); assert.equal(ov.totals.gmv, 15225); assert.equal(ov.totals.fees, 725);
  } finally { app.server.close(); }
});

test("stripe mode: checkout with manual capture, webhook authorizes, confirm captures, decline releases", async () => {
  const mock = await startStripeMock();
  const app = await boot({ stripeKey: "sk_test_x", stripeApiBase: mock.base });
  try {
    const { desk, op, trav } = await setupMarket(app);
    const opId = (await desk("GET", "/api/admin/overview")).operators.find(o => o.company === "Northline Air").id;
    await desk("POST", `/api/admin/operators/${opId}/status`, { status: "verified" });
    const leg = await op("POST", "/api/operator/legs", { o: "KVNY", d: "KLAS", dep: future(4), cls: "light", type: "Phenom 300E", seats: 6, price: 4200 });
    const leg2 = await op("POST", "/api/operator/legs", { o: "KLAS", d: "KVNY", dep: future(6), cls: "light", type: "Phenom 300E", seats: 6, price: 3900 });
    assert.equal((await trav("GET", "/api/ref")).payments, true);

    const bk = await trav("POST", "/api/bookings", { legIds: [leg.id], pax: 3, contact: { name: "Jane Flyer", phone: "555", email: "jane@flyer.test" }, accept: true });
    assert.equal(bk.booking.status, "checkout");
    assert.match(bk.checkoutUrl, /^https:\/\/checkout\.stripe\.test\/cs_/);
    const sess = Object.values(mock.sessions)[0];
    assert.equal(sess.amount, (4200 + 210) * 100, "amount in cents incl. fee");
    assert.equal(sess.capture, "manual");
    assert.equal(mock.calls[0].auth, "Bearer sk_test_x");
    assert.ok(mock.calls[0].idem, "idempotency key sent");

    // Bad signature rejected
    const bad = await fetch(app.base + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body: "{}" });
    assert.equal(bad.status, 400);

    // Customer completes checkout → signed webhook → requested + authorized
    const pi = mock.complete(sess.id);
    const evt = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: sess.id, payment_intent: pi, metadata: { booking_id: bk.booking.id } } } });
    const wh = await fetch(app.base + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": signWebhook(evt, WHSEC), "Content-Type": "application/json" }, body: evt });
    assert.equal(wh.status, 200);
    let mine = (await trav("GET", "/api/bookings")).bookings[0];
    assert.equal(mine.status, "requested"); assert.equal(mine.payStatus, "authorized");
    // Duplicate webhook delivery is harmless
    await fetch(app.base + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": signWebhook(evt, WHSEC) }, body: evt });
    assert.equal(outbox.filter(m => m.to === "ops@northline.test" && /New booking request: KVNY/.test(m.subject)).length, 1, "operator notified once");

    // Operator confirms → capture
    const conf = await op("POST", `/api/operator/bookings/${bk.booking.id}/respond`, { decision: "confirm" });
    assert.equal(conf.booking.status, "confirmed"); assert.equal(conf.booking.payStatus, "captured");
    assert.equal(mock.pis[pi].status, "succeeded");

    // Second booking: sync path (no webhook), then desk declines → authorization cancelled
    const bk2 = await trav("POST", "/api/bookings", { legIds: [leg2.id], pax: 2, contact: { name: "Jane Flyer", phone: "555", email: "jane@flyer.test" }, accept: true });
    const sess2 = mock.sessions[Object.keys(mock.sessions).at(-1)];
    const pi2 = mock.complete(sess2.id);
    assert.equal((await trav("POST", `/api/bookings/${bk2.booking.id}/sync`)).booking.status, "requested");
    const dec = await desk("POST", `/api/admin/bookings/${bk2.booking.id}/respond`, { decision: "decline", note: "Crew out of hours" });
    assert.equal(dec.booking.status, "declined"); assert.equal(dec.booking.payStatus, "released");
    assert.equal(mock.pis[pi2].status, "canceled");
    assert.equal((await op("GET", "/api/operator")).legs.find(l => l.id === leg2.id).status, "open");

    // Abandoned checkout is released by the sweeper and the session expired
    const bk3 = await trav("POST", "/api/bookings", { legIds: [leg2.id], pax: 2, contact: { name: "Jane Flyer", phone: "555", email: "jane@flyer.test" }, accept: true });
    app.db.run("UPDATE bookings SET expires_at=? WHERE id=?", Date.now() - 1, bk3.booking.id);
    await app.sweep();
    assert.equal((await trav("GET", "/api/bookings")).bookings.find(b => b.id === bk3.booking.id).status, "cancelled");
    assert.equal(mock.sessions[Object.keys(mock.sessions).at(-1)].status, "expired");
    assert.equal((await op("GET", "/api/operator")).legs.find(l => l.id === leg2.id).status, "open");
  } finally { app.server.close(); mock.srv.close(); }
});

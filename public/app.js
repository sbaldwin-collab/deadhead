import { AIRPORTS, AP, CLASSES, CL, nm, mi, driveMin, fmtAt, fmtDur, usd, apLabel, parseAp, legBlock, legDist, retailFor, blockMin, localToUtc } from "/shared/ref.js";

/* ============ basics ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { me: null, ref: { payments: false, feePct: 5, confirmWindowHours: 48 }, search: null, sort: "price", pendingBook: null, view: "find", adminFilter: "open", timers: [] };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Requested-With": "deadhead" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw Object.assign(new Error("Can't reach Deadhead. Check your connection and try again."), { status: 0 }); }
  let j = {}; try { j = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw Object.assign(new Error(j.error || "Something went wrong. Try again."), { status: res.status });
  return j;
}
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 4200); }
const when = ms => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const pill = (st, label) => `<span class="pill st-${esc(st)}">${esc(label || st)}</span>`;
const TRAVELER_STATUS = { checkout: "Awaiting payment", requested: "Waiting for operator", confirmed: "Confirmed", declined: "Not available", cancelled: "Cancelled" };
const PAY_STATUS = { none: "", pending: "Payment pending", authorized: "Card authorized", captured: "Paid", released: "Hold released", invoice: "Invoice to follow", failed: "Payment failed" };
const LEG_STATUS = { open: "Open", held: "Held", booked: "Booked", withdrawn: "Withdrawn", removed: "Removed", expired: "Departed" };

/* ============ routing ============ */
const VIEWS = { find: "find", trips: "trips", operate: "operate", admin: "admin", signin: "auth", signup: "auth", forgot: "auth", reset: "auth", account: "account", terms: "legal", privacy: "legal", broker: "legal" };
function route() {
  const h = (location.hash || "#find").slice(1);
  const key = h.startsWith("reset-") ? "reset" : (VIEWS[h] ? h : "find");
  S.view = key;
  const sec = VIEWS[key];
  document.querySelectorAll("main > section").forEach(s => (s.hidden = s.dataset.v !== sec));
  document.querySelectorAll("nav.tabs a").forEach(a => { if (a.dataset.view === key) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  S.timers.forEach(clearInterval); S.timers = [];
  const poll = (fn, ms = 30000) => { fn(); S.timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); };
  if (key === "find") { if (!S.search) runSearch(); }
  else if (key === "trips") poll(renderTrips);
  else if (key === "operate") poll(renderOperate);
  else if (key === "admin") poll(renderAdmin);
  else if (key === "account") renderAccount();
  else if (sec === "auth") renderAuth(key, h.startsWith("reset-") ? h.slice(6) : null);
  else if (sec === "legal") renderLegal(key);
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);
const go = h => { if (location.hash === "#" + h) route(); else location.hash = h; };

/* ============ header / account ============ */
function renderAcct() {
  const me = S.me;
  $("#acct").innerHTML = me
    ? `<span class="who">${esc(me.name)}</span><a class="btn ghost sm" href="#account">Account</a>`
    : `<a class="btn ghost sm" href="#signin">Sign in</a><a class="btn sm" href="#signup">Create account</a>`;
  $("#nav-admin").hidden = !me?.admin;
  $("#addAlert").hidden = false;
}
async function refreshBadges() {
  if (!S.me) { ["#b-trips", "#b-op", "#b-admin"].forEach(s => ($(s).hidden = true)); return; }
  try {
    const t = await api("GET", "/api/bookings");
    const n = t.bookings.filter(b => b.status === "requested" || b.status === "checkout").length;
    $("#b-trips").hidden = !n; $("#b-trips").textContent = n;
    if (S.me.operator) {
      const o = await api("GET", "/api/operator/bookings");
      const k = o.bookings.filter(b => b.status === "requested" && b.legs.some(l => l.mine && l.opStatus === "pending")).length;
      $("#b-op").hidden = !k; $("#b-op").textContent = k;
    }
    if (S.me.admin) {
      const a = await api("GET", "/api/admin/overview");
      const k = a.operators.filter(o => o.status === "pending").length + a.bookings.filter(b => b.status === "requested").length;
      $("#b-admin").hidden = !k; $("#b-admin").textContent = k;
    }
  } catch { /* badges are best-effort */ }
}

/* ============ search ============ */
function searchParams() {
  const from = parseAp($("#from").value), to = parseAp($("#to").value);
  return { from, to, date: $("#date").value, flex: $("#flex").value, radius: $("#rad").value, pax: $("#pax").value, chains: $("#o-chain").checked ? 1 : 0, cancel: $("#o-cancel").checked ? 1 : 0 };
}
async function runSearch() {
  const p = searchParams();
  if (!p.from || !p.to) { $("#sumtxt").textContent = "Pick airports from the list"; $("#list").innerHTML = ""; return; }
  if (p.from === p.to) { $("#sumtxt").textContent = "Pick two different airports"; $("#list").innerHTML = ""; return; }
  try { localStorage.setItem("dh_search", JSON.stringify(p)); } catch { /* optional */ }
  $("#sumtxt").textContent = "Searching…";
  try {
    const qs = new URLSearchParams(p).toString();
    S.search = await api("GET", "/api/search?" + qs);
    renderResults();
  } catch (e) { $("#sumtxt").textContent = e.message; $("#list").innerHTML = ""; }
}
function legHTML(l) {
  const bm = legBlock(l), dist = legDist(l);
  return `<div class="leg">
    <div class="ap"><b>${esc(l.o)}</b><span>${esc(AP[l.o].name)}</span><time>${esc(fmtAt(l.depUtc, AP[l.o].tz))}</time></div>
    <div class="path"><span>${Math.round(dist).toLocaleString()} nm · ${fmtDur(bm)}</span>
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true"><line x1="2" y1="7" x2="98" y2="7" stroke="currentColor" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><circle cx="2" cy="7" r="2" fill="currentColor"/><circle cx="98" cy="7" r="2" fill="currentColor"/></svg>
      <span>${esc(l.tail || "")}</span></div>
    <div class="ap r"><b>${esc(l.d)}</b><span>${esc(AP[l.d].name)}</span><time>${esc(fmtAt(l.depUtc + bm * 60000, AP[l.d].tz))}</time></div>
  </div>`;
}
function dealHTML(r, i) {
  const q = S.search.query, l0 = r.legs[0], lN = r.legs[r.legs.length - 1], perSeat = $("#o-seat").checked, pax = q.pax;
  const tags = [r.legs.length > 1 ? `<span class="t mag">Two-leg connection via ${esc(l0.d)}</span>` : `<span class="t">Empty leg</span>`, `<span class="t good">Verified operator${r.legs.length > 1 ? "s" : ""}</span>`];
  if (r.held) tags.push(`<span class="t warn">Another traveler is booking this right now</span>`);
  if (l0.o !== q.from) { const m = mi(AP[q.from], AP[l0.o]); tags.push(`<span class="t sky">Departs ${esc(l0.o)}: ${Math.round(m)} mi from ${esc(q.from)}, ~${driveMin(m)} min drive</span>`); }
  if (lN.d !== q.to) { const m = mi(AP[q.to], AP[lN.d]); tags.push(`<span class="t sky">Lands ${esc(lN.d)}: ${Math.round(m)} mi from ${esc(q.to)}, ~${driveMin(m)} min drive</span>`); }
  if (r.dayOffset) tags.push(`<span class="t">${r.dayOffset > 0 ? "+" : ""}${r.dayOffset} day${Math.abs(r.dayOffset) > 1 ? "s" : ""}</span>`);
  const win = Math.max(...r.legs.map(x => +x.window || 0)); if (win) tags.push(`<span class="t">Departure flexible ${win >= 24 ? "all day" : "±" + win + "h"}</span>`);
  if (r.legs.some(x => x.mayCancel)) tags.push(`<span class="t warn">May cancel if the operator's original trip changes</span>`);
  const legsTxt = r.legs.map(legHTML).join(r.legs.length > 1 ? `<div class="layover">Connection ${fmtDur(r.gap)} at ${esc(l0.d)} · ${esc(AP[l0.d].name)}</div>` : "");
  const metas = r.legs.map(l => `<span><strong>${esc(l.type)}</strong> · ${esc(CL[l.cls]?.label)} · ${+l.seats} seats · ${esc(l.company)} · Part 135 ${esc(l.cert)}</span>`).join("") + r.legs.filter(l => l.notes).map(l => `<span>${esc(l.notes)}</span>`).join("");
  return `<article class="deal">
    <div class="deal-main"><div class="legs">${legsTxt}</div><div class="meta">${metas}</div><div class="tags">${tags.join("")}</div></div>
    <div class="deal-price">
      <span class="retail">${usd(perSeat ? r.retail / pax : r.retail)} retail</span>
      <span class="price">${usd(perSeat ? r.total / pax : r.total)}</span>
      <span class="off">${Math.round(r.off * 100)}% off${perSeat ? " · per seat" : ""}</span>
      <span class="seat">${perSeat ? usd(r.total) + " whole jet" : usd(r.total / pax) + " / seat at " + pax}${S.ref.feePct ? " · incl. fee" : ""}</span>
      <button type="button" class="btn mag" data-book="${i}" ${r.held ? "disabled" : ""}>${r.held ? "On hold" : "Book this jet"}</button>
    </div></article>`;
}
function renderResults() {
  if (!S.search) return;
  const { query: q, results, bench, benchClass } = S.search;
  const keyf = { price: r => r.total, off: r => -r.off, dep: r => r.dep }[S.sort];
  results.sort((a, b) => a.held - b.held || keyf(a) - keyf(b));
  const live = results.filter(r => !r.held);
  if (live.length) {
    const low = Math.min(...live.map(r => r.total)), best = Math.max(...live.map(r => r.off));
    $("#sumtxt").innerHTML = `${live.length} deal${live.length > 1 ? "s" : ""} ${esc(q.from)} → ${esc(q.to)} · from <em>${usd(low)}</em>, up to <em>${Math.round(best * 100)}% off</em>`;
  } else $("#sumtxt").innerHTML = `${esc(q.from)} → ${esc(q.to)} · full charter about <em>${usd(bench)}</em>`;
  $("#list").innerHTML = results.length ? results.map(dealHTML).join("")
    : `<div class="empty"><strong>No empty legs posted for this window yet</strong>Widen the radius or dates, or get an email the moment an operator posts one. A one-way ${esc(CL[benchClass]?.label.toLowerCase())} charter on this route runs about ${usd(bench)}.<br><button class="btn" type="button" id="emptyAlert">Email me for ${esc(q.from)} → ${esc(q.to)}</button><div class="routes" id="topRoutes"></div></div>`;
  const ea = $("#emptyAlert"); if (ea) ea.onclick = addAlert;
  renderTopRoutes();
}
async function loadStats() {
  try {
    S.stats = await api("GET", "/api/stats");
    const s = S.stats;
    $("#stats").innerHTML = s.legs ? `<b style="color:var(--ink)">${s.legs}</b> empty legs open from <b style="color:var(--ink)">${s.operators}</b> verified operator${s.operators > 1 ? "s" : ""}, averaging ${Math.round(s.avgOff * 100)}% under one-way charter.`
      : "Operators are onboarding now. Set an alert and we'll email you when your route posts.";
    renderTopRoutes();
  } catch { $("#stats").textContent = ""; }
}
function renderTopRoutes() {
  const el = $("#topRoutes"); if (!el || !S.stats?.top?.length) return;
  el.innerHTML = `<span class="note" style="flex-basis:100%">Routes with legs open now:</span>` + S.stats.top.map(t => `<button type="button" class="btn ghost sm" data-route="${esc(t.o)}-${esc(t.d)}">${esc(t.o)} → ${esc(t.d)} · from ${usd(t.from)}</button>`).join("");
}

/* ============ alerts ============ */
async function renderAlerts() {
  const el = $("#wl");
  if (!S.me) { el.innerHTML = `<p class="note"><a href="#signin">Sign in</a> to get an email when a leg posts on your route.</p>`; return; }
  try {
    const { alerts } = await api("GET", "/api/alerts");
    el.innerHTML = alerts.length ? alerts.map(a => `<div class="wl-item"><button type="button" class="run" data-run="${esc(a.o)}-${esc(a.d)}-${+a.radius}">${esc(a.o)} → ${esc(a.d)} · ${+a.radius} mi${a.live ? ` · <span class="n">${a.live} open</span>` : ""}</button><button type="button" class="x" data-rm="${esc(a.id)}" aria-label="Remove alert ${esc(a.o)} to ${esc(a.d)}">Remove</button></div>`).join("")
      : `<p class="note">No alerts yet. We email you the moment a matching leg posts.</p>`;
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
async function addAlert() {
  const p = searchParams();
  if (!p.from || !p.to) return toast("Pick both airports first.");
  if (!S.me) { toast("Sign in to save alerts."); return go("signin"); }
  try { await api("POST", "/api/alerts", { o: p.from, d: p.to, radius: +p.radius }); toast(`We'll email you when ${p.from} → ${p.to} posts.`); renderAlerts(); }
  catch (e) { toast(e.message); }
}

/* ============ booking ============ */
function openBooking(r) {
  if (!S.me) { S.pendingBook = r; toast("Create an account or sign in to book. It takes a minute."); return go("signup"); }
  const pax = S.search.query.pax, maxSeats = Math.min(...r.legs.map(l => +l.seats));
  const route = [r.legs[0].o, ...r.legs.map(l => l.d)].join(" → ");
  $("#modalRoot").innerHTML = `<div class="overlay" id="ov"><form class="modal" id="bkForm" role="dialog" aria-modal="true" aria-labelledby="bkTitle" autocomplete="on">
    <h2 id="bkTitle">Book ${esc(route)}</h2>
    <div class="sumbox"><b style="font:700 22px var(--display);letter-spacing:.03em">${esc(route)}</b>
      ${r.legs.map(l => `<span>${esc(l.o)} → ${esc(l.d)} · ${esc(fmtAt(l.depUtc, AP[l.o].tz))} · ${esc(l.type)} · ${esc(l.company)}</span>`).join("")}
      <div class="lines"><span>Aircraft${r.legs.length > 1 ? " (both legs)" : ""}</span><span>${usd(r.price)}</span>${r.fee ? `<span>Service fee</span><span>${usd(r.fee)}</span>` : ""}<b>Total, whole aircraft</b><b>${usd(r.total)}</b></div></div>
    <div class="grid">
      <div class="f s2"><label for="bk-pax">Passengers</label><input id="bk-pax" type="number" min="1" max="${maxSeats}" value="${Math.min(pax, maxSeats)}" required></div>
      <div class="f s4"><label for="bk-name">Lead passenger (as on ID)</label><input id="bk-name" required maxlength="80" autocomplete="name" value="${esc(S.me.name)}"></div>
      <div class="f s3"><label for="bk-phone">Mobile</label><input id="bk-phone" type="tel" required maxlength="30" autocomplete="tel" value="${esc(S.me.phone)}"></div>
      <div class="f s3"><label for="bk-email">Email</label><input id="bk-email" type="email" required maxlength="120" autocomplete="email" value="${esc(S.me.email)}"></div>
      <div class="f s6"><label for="bk-notes">Anything the operator should know</label><textarea id="bk-notes" maxlength="500" placeholder="Pets, extra baggage, ground transport, flexible on time…"></textarea></div>
      <div class="f s6"><label class="chk"><input type="checkbox" id="bk-ack" required> I understand the operator confirms within ${S.ref.confirmWindowHours} hours, that an empty leg can be withdrawn if the operator's original trip changes, and that I agree to the <a href="#terms" target="_blank">Terms</a>.</label></div>
    </div>
    <p class="note">${S.ref.payments ? "Next you'll enter your card on Stripe's secure page. We authorize the total now and charge it only when the operator confirms. If they can't, the hold is released." : "No payment now. When the operator confirms, we send you an invoice."}</p>
    <p class="err" id="bkErr" role="alert"></p>
    <div class="row-actions"><button class="btn mag" type="submit" id="bkSend">${S.ref.payments ? "Continue to secure payment" : "Send booking request"}</button><button class="btn ghost" type="button" id="bkClose">Cancel</button></div>
  </form></div>`;
  const close = () => { $("#modalRoot").innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $("#bkClose").onclick = close; $("#ov").addEventListener("click", e => { if (e.target.id === "ov") close(); });
  $("#bk-name").focus();
  $("#bkForm").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#bkSend"); btn.disabled = true; $("#bkErr").textContent = "";
    try {
      const out = await api("POST", "/api/bookings", { legIds: r.legs.map(l => l.id), pax: +$("#bk-pax").value, notes: $("#bk-notes").value,
        contact: { name: $("#bk-name").value, phone: $("#bk-phone").value, email: $("#bk-email").value }, accept: $("#bk-ack").checked });
      if (out.checkoutUrl) { btn.textContent = "Opening secure payment…"; location.assign(out.checkoutUrl); return; }
      close(); toast("Request sent. The operator has been notified."); S.search = null; go("trips"); refreshBadges();
    } catch (err) { btn.disabled = false; $("#bkErr").textContent = err.message; if (err.status === 409) runSearch(); }
  };
}

/* ============ trips ============ */
function legsBlock(b, { showOp = false } = {}) {
  return b.legs.map(l => `<div><span class="lbl">${esc(l.o)} → ${esc(l.d)}${l.legStatus && showOp ? " · " + pill(l.opStatus, l.opStatus === "pending" ? "Awaiting confirm" : l.opStatus) : ""}</span>
    ${esc(fmtAt(l.depUtc, AP[l.o]?.tz || "UTC"))}<br>${esc(l.type)} ${esc(l.tail)} · ${usd(l.price)}<br>${esc(l.company)} · Part 135 ${esc(l.cert)}${l.opNote ? `<br><i>“${esc(l.opNote)}”</i>` : ""}</div>`).join("");
}
const routeOf = b => [b.legs[0].o, ...b.legs.map(l => l.d)].join(" → ");
async function renderTrips() {
  const el = $("#v-trips");
  if (!S.me) { el.innerHTML = `<div class="empty"><strong>Sign in to see your trips</strong>Your booking requests and confirmations live here.<br><a class="btn" href="#signin">Sign in</a></div>`; return; }
  let data; try { data = await api("GET", "/api/bookings"); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const items = data.bookings;
  el.innerHTML = `<div class="summary"><h2>My trips</h2></div><div class="cards">${items.length ? items.map(b => `<article class="req">
      <div class="req-top"><span class="req-route">${esc(routeOf(b))}</span><span>${pill(b.status, TRAVELER_STATUS[b.status])} ${PAY_STATUS[b.payStatus] ? pill(b.payStatus, PAY_STATUS[b.payStatus]) : ""}</span></div>
      <div class="req-sub">${usd(b.total)} total${b.fee ? ` (incl. ${usd(b.fee)} service fee)` : ""} · ${+b.pax} pax · booked ${esc(when(b.createdAt))}${b.retail ? ` · ${Math.max(0, Math.round((1 - b.subtotal / b.retail) * 100))}% under charter` : ""}</div>
      <div class="req-grid">${legsBlock(b)}</div>
      ${b.status === "requested" ? `<p class="note">The operator confirms by ${esc(when(b.expiresAt))}. ${b.payMode === "stripe" ? "Your card is authorized, not charged." : "Nothing is charged until you approve the invoice."}</p>` : ""}
      ${b.status === "checkout" ? `<p class="note">Your seats are held until ${esc(when(b.expiresAt))} while you complete payment.</p>` : ""}
      ${b.reason && ["declined", "cancelled"].includes(b.status) ? `<p class="note">${esc(b.reason)}</p>` : ""}
      ${b.message ? `<div class="bnote"><span class="lbl">From the Deadhead desk</span><br>${esc(b.message)}</div>` : ""}
      <div class="row-actions">
        ${b.status === "checkout" && b.checkoutUrl ? `<a class="btn mag sm" href="${esc(b.checkoutUrl)}">Complete payment</a>` : ""}
        ${["checkout", "requested"].includes(b.status) ? `<button type="button" class="btn ghost sm" data-cancel="${esc(b.id)}">Cancel request</button>` : ""}
      </div></article>`).join("")
    : `<div class="empty"><strong>No trips yet</strong>Find an empty leg and book the whole jet. Updates from the operator show up here and in your email.<br><a class="btn" href="#find">Find a jet</a></div>`}</div>`;
}

/* ============ operator portal ============ */
let legEdit = null;
async function renderOperate() {
  const el = $("#v-operate");
  if (!S.me) {
    el.innerHTML = `<div class="panel"><h3>List your empty legs</h3><p>Fill repositioning flights that would otherwise fly empty. Post a leg in under a minute; travelers book the whole aircraft, and you confirm before anyone is charged.</p><ul class="tricks" style="margin:10px 0"><li><b>Free to list</b>Travelers pay a service fee; you set your price.</li><li><b>You stay in control</b>Every request needs your confirmation. Decline if the trip no longer works.</li><li><b>Verified only</b>We check every Part 135 certificate before legs go live.</li></ul><div class="row-actions"><a class="btn mag" href="#signup">Create an operator account</a><a class="btn ghost" href="#signin">Sign in</a></div></div>`;
    return;
  }
  if (el.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) return; // don't clobber typing on poll
  let data, bk = { bookings: [] };
  try { data = await api("GET", "/api/operator"); if (data.operator) bk = await api("GET", "/api/operator/bookings"); }
  catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const op = data.operator;
  const profile = `<div class="panel"><h3>${op ? "Company profile" : "Set up your operator profile"}</h3>
    ${op ? "" : `<p class="note" style="margin-bottom:12px">We verify your FAA Part 135 certificate before your legs appear to travelers. You can post legs right away; they go live once you're verified.</p>`}
    <form id="opForm" class="grid" autocomplete="off">
      <div class="f s3"><label for="op-company">Operator name (as on certificate)</label><input id="op-company" required maxlength="80" value="${esc(op?.company)}"></div>
      <div class="f s3"><label for="op-cert">Air carrier certificate no.</label><input id="op-cert" required maxlength="20" value="${esc(op?.cert)}" placeholder="e.g. N2LA123K"><span class="hint">Changing it after verification sends your account back for review.</span></div>
      <div class="f s2"><label for="op-phone">Dispatch phone (24h)</label><input id="op-phone" type="tel" required maxlength="30" value="${esc(op?.phone)}"></div>
      <div class="f s2"><label for="op-email">Booking notifications email</label><input id="op-email" type="email" required maxlength="120" value="${esc(op?.email || S.me.email)}"></div>
      <div class="f s2"><label for="op-base">Home base</label><input id="op-base" list="aps" maxlength="80" value="${esc(op?.base ? apLabel(op.base) : "")}"></div>
      <div class="row-actions s6"><button class="btn" type="submit">${op ? "Save profile" : "Create operator profile"}</button>
        ${op ? (op.status === "verified" ? pill("verified", "Verified") : op.status === "suspended" ? pill("suspended", "Suspended") + ` <span class="note">Contact the desk to restore your account.</span>` : pill("pending", "Awaiting verification") + ` <span class="note">Your legs are saved and go live once we verify your certificate.</span>`) : ""}</div>
    </form></div>`;
  if (!op) { el.innerHTML = profile; wireOpForm(); return; }
  const pending = bk.bookings.filter(b => b.status === "requested" && b.legs.some(l => l.mine && l.opStatus === "pending"));
  const others = bk.bookings.filter(b => !pending.includes(b)).slice(0, 30);
  const reqCard = (b, act) => `<article class="req">
    <div class="req-top"><span class="req-route">${esc(routeOf(b))}</span>${pill(b.status, TRAVELER_STATUS[b.status])}</div>
    <div class="req-sub">${+b.pax} pax · lead passenger ${esc(b.contact.name)} · requested ${esc(when(b.createdAt))}${b.status === "requested" ? ` · respond by ${esc(when(b.expiresAt))}` : ""} · ${b.payMode === "stripe" ? (b.payStatus === "captured" ? "paid" : "card authorized") : "invoice after confirmation"}</div>
    <div class="req-grid">${legsBlock(b, { showOp: true })}${b.notes ? `<div><span class="lbl">Traveler notes</span>${esc(b.notes)}</div>` : ""}${b.contact.phone ? `<div><span class="lbl">Contact</span>${esc(b.contact.phone)}<br>${esc(b.contact.email)}</div>` : ""}</div>
    ${act ? `<div class="f"><label for="on-${esc(b.id)}">Note to traveler (optional)</label><input id="on-${esc(b.id)}" maxlength="500" placeholder="e.g. Wheels up 10:30 from Signature FBO"></div>
      <div class="row-actions"><button class="btn mag sm" type="button" data-respond="confirm" data-id="${esc(b.id)}">Confirm${b.payMode === "stripe" ? " and charge" : ""}</button><button class="btn ghost sm" type="button" data-respond="decline" data-id="${esc(b.id)}">Decline</button></div>` : ""}
  </article>`;
  const now = Date.now();
  const legs = data.legs.map(l => ({ ...l, st: l.depUtc < now && l.status === "open" ? "expired" : l.status }));
  el.innerHTML = `
    <div><div class="summary"><h2>Booking requests</h2></div>
      <div class="cards">${pending.length ? pending.map(b => reqCard(b, true)).join("") : `<div class="empty"><strong>No requests waiting</strong>When a traveler books one of your legs, it appears here and we email ${esc(op.email)}.</div>`}</div></div>
    <div class="panel" id="legPanel"><h3 id="legTitle">Post an empty leg</h3>
      <form id="legForm" class="grid" autocomplete="off">
        <div class="f s3"><label for="lf-o">Departs</label><input id="lf-o" list="aps" required></div>
        <div class="f s3"><label for="lf-d">Arrives</label><input id="lf-d" list="aps" required></div>
        <div class="f s2"><label for="lf-dep">Departure (local time at origin)</label><input id="lf-dep" type="datetime-local" required></div>
        <div class="f s2"><label for="lf-win">Departure flexibility</label><select id="lf-win"><option value="0">Fixed time</option><option value="2">± 2 hours</option><option value="4">± 4 hours</option><option value="8">± 8 hours</option><option value="24">Any time that day</option></select></div>
        <div class="f s2"><label for="lf-cls">Aircraft class</label><select id="lf-cls">${CLASSES.map(c => `<option value="${c.key}" ${c.key === "smid" ? "selected" : ""}>${c.label}</option>`).join("")}</select></div>
        <div class="f s2"><label for="lf-type">Aircraft type</label><input id="lf-type" required maxlength="40" placeholder="e.g. Challenger 350"></div>
        <div class="f s1"><label for="lf-tail">Tail no.</label><input id="lf-tail" maxlength="8" placeholder="N123AB"></div>
        <div class="f s1"><label for="lf-seats">Seats</label><input id="lf-seats" type="number" min="1" max="19" value="9" required></div>
        <div class="f s2"><label for="lf-price">Your price, whole aircraft (USD)</label><input id="lf-price" type="number" min="500" step="100" required></div>
        <div class="f s4"><span class="lbl">Estimate</span><div class="est" id="lfEst">Pick a route to see distance and the charter benchmark.</div></div>
        <div class="f s6"><label class="chk"><input type="checkbox" id="lf-cancel"> This leg depends on a trip that could still change or cancel</label></div>
        <div class="f s6"><label for="lf-notes">Notes for travelers</label><textarea id="lf-notes" maxlength="400" placeholder="Catering, pets, baggage limits, Wi-Fi…"></textarea></div>
        <div class="row-actions s6"><button class="btn mag" type="submit" id="legSave">Post leg</button><button class="btn ghost" type="button" id="legCancel" hidden>Cancel edit</button><p class="err" id="legErr" role="alert"></p></div>
      </form></div>
    <div class="panel"><h3>Your legs</h3>${legs.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Route</th><th>Departs (local)</th><th>Aircraft</th><th>Your price</th><th>Status</th><th></th></tr></thead><tbody>${legs.map(l => `<tr>
        <td class="rt">${esc(l.o)} → ${esc(l.d)}</td><td class="num">${esc(fmtAt(l.depUtc, AP[l.o].tz))}</td>
        <td>${esc(l.type)}<br><span class="note">${esc(CL[l.cls]?.label)} · ${+l.seats} seats ${esc(l.tail)}</span></td>
        <td class="num">${usd(l.price)}<br><span class="note">${Math.round((1 - l.price / l.retail) * 100)}% off</span></td>
        <td>${pill(l.st, LEG_STATUS[l.st])}${op.status !== "verified" && l.st === "open" ? `<br><span class="note">Live after verification</span>` : ""}</td>
        <td><div class="row-actions">${["open", "withdrawn"].includes(l.st) ? `<button class="btn ghost sm" type="button" data-edit="${esc(l.id)}">Edit</button>` : ""}${l.st === "open" ? `<button class="btn ghost sm" type="button" data-lst="withdrawn" data-id="${esc(l.id)}">Withdraw</button>` : ""}${l.st === "withdrawn" && l.depUtc > now ? `<button class="btn ghost sm" type="button" data-lst="open" data-id="${esc(l.id)}">Reopen</button>` : ""}${["withdrawn", "expired"].includes(l.st) ? `<button class="btn ghost sm" type="button" data-lst="removed" data-id="${esc(l.id)}">Remove</button>` : ""}<button class="btn ghost sm" type="button" data-dup="${esc(l.id)}">Duplicate</button></div></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="note">No legs yet. Post your first one above; it takes under a minute.</p>`}</div>
    ${others.length ? `<div><div class="summary"><h2>Past requests</h2></div><div class="cards">${others.map(b => reqCard(b, false)).join("")}</div></div>` : ""}
    ${profile}`;
  S.opLegs = Object.fromEntries(data.legs.map(l => [l.id, l]));
  wireOpForm(); wireLegForm();
  if (legEdit) fillLeg(S.opLegs[legEdit.id] || legEdit, legEdit.edit);
}
function wireOpForm() {
  $("#opForm").onsubmit = async e => {
    e.preventDefault();
    try {
      await api("POST", "/api/operator/profile", { company: $("#op-company").value, cert: $("#op-cert").value, phone: $("#op-phone").value, email: $("#op-email").value, base: parseAp($("#op-base").value) || "" });
      S.me = (await api("GET", "/api/me")).user; toast("Profile saved."); document.activeElement.blur(); renderOperate();
    } catch (err) { toast(err.message); }
  };
}
function legEstimate() {
  const o = parseAp($("#lf-o").value), d = parseAp($("#lf-d").value), c = CL[$("#lf-cls").value], p = +$("#lf-price").value;
  if (!o || !d || o === d || !c) { $("#lfEst").textContent = "Pick a route to see distance and the charter benchmark."; return; }
  const dist = nm(AP[o], AP[d]), r = retailFor(dist, c);
  let t = `${Math.round(dist).toLocaleString()} nm · ~${fmtDur(blockMin(dist, c))} block · one-way charter ≈ ${usd(r)}`;
  if (p > 0) t += ` · your price is <b>${Math.round((1 - p / r) * 100)}% off</b>`;
  if (dist > c.range * 0.95) t += ` · <span style="color:var(--bad)">beyond typical ${esc(c.label.toLowerCase())} range</span>`;
  $("#lfEst").innerHTML = t;
}
function fillLeg(l, edit) {
  legEdit = { ...l, edit };
  $("#lf-o").value = apLabel(l.o); $("#lf-d").value = apLabel(l.d); $("#lf-dep").value = edit ? l.dep : ""; $("#lf-win").value = String(l.window || 0);
  $("#lf-cls").value = l.cls; $("#lf-type").value = l.type; $("#lf-tail").value = l.tail || ""; $("#lf-seats").value = l.seats; $("#lf-price").value = l.price;
  $("#lf-cancel").checked = !!l.mayCancel; $("#lf-notes").value = l.notes || "";
  $("#legTitle").textContent = edit ? `Edit ${l.o} → ${l.d}` : "Post an empty leg"; $("#legSave").textContent = edit ? "Save changes" : "Post leg"; $("#legCancel").hidden = false;
  legEstimate();
}
function wireLegForm() {
  ["#lf-o", "#lf-d", "#lf-cls", "#lf-price"].forEach(s => $(s).addEventListener("input", legEstimate));
  $("#lf-cls").addEventListener("change", () => { $("#lf-seats").value = CL[$("#lf-cls").value].seats; legEstimate(); });
  $("#legCancel").onclick = () => { legEdit = null; renderOperate(); };
  $("#legForm").onsubmit = async e => {
    e.preventDefault(); $("#legErr").textContent = "";
    const body = { o: parseAp($("#lf-o").value), d: parseAp($("#lf-d").value), dep: $("#lf-dep").value, window: +$("#lf-win").value, cls: $("#lf-cls").value, type: $("#lf-type").value,
      tail: $("#lf-tail").value, seats: +$("#lf-seats").value, price: +$("#lf-price").value, mayCancel: $("#lf-cancel").checked, notes: $("#lf-notes").value };
    if (!body.o || !body.d) { $("#legErr").textContent = "Pick both airports from the list. Type the ICAO code or the airport name."; return; }
    const btn = $("#legSave"); btn.disabled = true;
    try {
      if (legEdit?.edit) await api("PUT", `/api/operator/legs/${encodeURIComponent(legEdit.id)}`, body);
      else await api("POST", "/api/operator/legs", body);
      toast(legEdit?.edit ? "Leg updated." : `Posted ${body.o} → ${body.d}.`); legEdit = null; document.activeElement.blur(); renderOperate();
    } catch (err) { $("#legErr").textContent = err.message; btn.disabled = false; }
  };
}
$("#v-operate").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.edit) { fillLeg(S.opLegs[b.dataset.edit], true); $("#legPanel").scrollIntoView({ behavior: "smooth" }); }
  if (b.dataset.dup) { fillLeg(S.opLegs[b.dataset.dup], false); $("#legPanel").scrollIntoView({ behavior: "smooth" }); }
  if (b.dataset.lst) { b.disabled = true; try { await api("POST", `/api/operator/legs/${encodeURIComponent(b.dataset.id)}/status`, { status: b.dataset.lst }); toast({ withdrawn: "Leg withdrawn.", open: "Leg reopened.", removed: "Leg removed." }[b.dataset.lst]); renderOperate(); } catch (err) { toast(err.message); b.disabled = false; } }
  if (b.dataset.respond) {
    const decline = b.dataset.respond === "decline";
    b.disabled = true; b.textContent = decline ? "Declining…" : "Confirming…";
    try { await api("POST", `/api/operator/bookings/${encodeURIComponent(b.dataset.id)}/respond`, { decision: b.dataset.respond, note: $("#on-" + CSS.escape(b.dataset.id))?.value || "" }); toast(decline ? "Declined. The traveler has been told and the leg is open again." : "Confirmed. The traveler has your dispatch number."); renderOperate(); refreshBadges(); }
    catch (err) { toast(err.message); renderOperate(); }
  }
});

/* ============ admin desk ============ */
async function renderAdmin() {
  const el = $("#v-admin");
  if (!S.me?.admin) { el.innerHTML = `<div class="empty"><strong>Desk access only</strong></div>`; return; }
  if (el.contains(document.activeElement) && document.activeElement.matches("input,textarea")) return;
  let a; try { a = await api("GET", "/api/admin/overview"); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const groups = { open: b => ["requested", "checkout"].includes(b.status), confirmed: b => b.status === "confirmed", closed: b => ["declined", "cancelled"].includes(b.status), all: () => true };
  const names = { open: "Open", confirmed: "Confirmed", closed: "Closed", all: "All" };
  const shown = a.bookings.filter(groups[S.adminFilter]);
  const t = a.totals;
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span class="lbl">Open legs (live)</span><b>${t.openLegs}</b></div>
      <div class="kpi"><span class="lbl">Confirmed trips</span><b>${t.confirmed}</b></div>
      <div class="kpi"><span class="lbl">Gross bookings</span><b>${usd(t.gmv)}</b></div>
      <div class="kpi"><span class="lbl">Service fees</span><b>${usd(t.fees)}</b></div>
      <div class="kpi"><span class="lbl">Accounts</span><b>${t.users}</b></div>
    </div>
    <div class="panel"><h3>Operators</h3>${a.operators.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Operator</th><th>Certificate</th><th>Contact</th><th>Open legs</th><th>Status</th><th></th></tr></thead><tbody>${a.operators.map(o => `<tr>
      <td><b>${esc(o.company)}</b><br><span class="note">Account: ${esc(o.account.name)} · ${esc(o.account.email)}${o.base ? ` · base ${esc(o.base)}` : ""}</span></td>
      <td class="num">${esc(o.cert)}</td><td>${esc(o.phone)}<br>${esc(o.email)}</td><td class="num">${o.openLegs}</td><td>${pill(o.status, o.status)}</td>
      <td><div class="row-actions">${o.status !== "verified" ? `<button class="btn sm" type="button" data-op="verified" data-id="${esc(o.id)}">Verify</button>` : ""}${o.status !== "suspended" ? `<button class="btn ghost sm" type="button" data-op="suspended" data-id="${esc(o.id)}">Suspend</button>` : `<button class="btn ghost sm" type="button" data-op="pending" data-id="${esc(o.id)}">Reinstate for review</button>`}</div></td></tr>`).join("")}</tbody></table></div>
      <p class="note" style="margin-top:8px">Before verifying, confirm the certificate in the FAA's Part 135 operator records and check insurance.</p>` : `<p class="note">No operators yet. Send operators to the For operators tab to sign up.</p>`}</div>
    <div><div class="summary"><h2>Bookings</h2><div class="counts">${Object.keys(groups).map(k => `<button type="button" data-af="${k}" aria-pressed="${S.adminFilter === k}">${names[k]} <b>${a.bookings.filter(groups[k]).length}</b></button>`).join("")}</div></div>
      <div class="cards">${shown.length ? shown.map(b => `<article class="req">
        <div class="req-top"><span class="req-route">${esc(routeOf(b))}</span><span>${pill(b.status, TRAVELER_STATUS[b.status])} ${PAY_STATUS[b.payStatus] ? pill(b.payStatus, PAY_STATUS[b.payStatus]) : ""}</span></div>
        <div class="req-sub">${usd(b.total)} (${usd(b.subtotal)} + ${usd(b.fee)} fee) · ${+b.pax} pax · ${esc(when(b.createdAt))} · ref ${esc(b.id)}${["requested", "checkout"].includes(b.status) ? ` · expires ${esc(when(b.expiresAt))}` : ""}</div>
        <div class="req-grid">${legsBlock(b, { showOp: true })}
          <div><span class="lbl">Traveler</span><b>${esc(b.contact.name)}</b><br>${esc(b.contact.phone)}<br>${esc(b.contact.email)}${b.notes ? `<br><i>${esc(b.notes)}</i>` : ""}</div>
          <div><span class="lbl">Operator dispatch</span>${(b.operators || []).map(o => `${esc(o.company)}: ${esc(o.phone)}<br>${esc(o.email)}`).join("<br>")}</div></div>
        ${b.reason ? `<p class="note">${esc(b.reason)}</p>` : ""}
        <div class="f"><label for="am-${esc(b.id)}">Message to traveler (emailed and shown on their trip)</label><textarea id="am-${esc(b.id)}" maxlength="800">${esc(b.message)}</textarea></div>
        <div class="row-actions"><button class="btn sm" type="button" data-msg="${esc(b.id)}">Send message</button>
          ${b.status === "requested" ? `<button class="btn mag sm" type="button" data-adm="confirm" data-id="${esc(b.id)}">Confirm for operator${b.payMode === "stripe" ? " and charge" : ""}</button>` : ""}
          ${["requested", "checkout"].includes(b.status) ? `<button class="btn ghost sm" type="button" data-adm="decline" data-id="${esc(b.id)}">Decline and release</button>` : ""}</div>
      </article>`).join("") : `<div class="empty"><strong>Nothing here</strong>Bookings appear as travelers request them.</div>`}</div></div>`;
}
$("#v-admin").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.af) { S.adminFilter = b.dataset.af; renderAdmin(); return; }
  b.disabled = true;
  try {
    if (b.dataset.op) { await api("POST", `/api/admin/operators/${encodeURIComponent(b.dataset.id)}/status`, { status: b.dataset.op }); toast(`Operator ${b.dataset.op}.`); }
    if (b.dataset.msg) { await api("POST", `/api/admin/bookings/${encodeURIComponent(b.dataset.msg)}/message`, { message: $("#am-" + CSS.escape(b.dataset.msg)).value }); toast("Message sent to the traveler."); }
    if (b.dataset.adm) { await api("POST", `/api/admin/bookings/${encodeURIComponent(b.dataset.id)}/respond`, { decision: b.dataset.adm, note: $("#am-" + CSS.escape(b.dataset.id))?.value || "" }); toast(b.dataset.adm === "confirm" ? "Booking confirmed." : "Declined; legs released."); }
    document.activeElement?.blur(); renderAdmin(); refreshBadges();
  } catch (err) { toast(err.message); b.disabled = false; }
});

/* ============ auth & account ============ */
function renderAuth(kind, token) {
  const el = $("#v-auth");
  const forms = {
    signin: `<h2>Sign in</h2><form class="panel" id="authForm"><div class="f"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <div class="f"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="current-password" required></div>
      <p class="err" id="aErr" role="alert"></p><button class="btn mag" type="submit">Sign in</button>
      <p class="note"><a href="#forgot">Forgot your password?</a> · New here? <a href="#signup">Create an account</a></p></form>`,
    signup: `<h2>Create your account</h2><form class="panel" id="authForm"><div class="f"><label for="a-name">Full name</label><input id="a-name" autocomplete="name" required maxlength="80"></div>
      <div class="f"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <div class="f"><label for="a-phone">Mobile (for trip updates)</label><input id="a-phone" type="tel" autocomplete="tel" maxlength="30"></div>
      <div class="f"><label for="a-pass">Password</label><input id="a-pass" type="password" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters.</span></div>
      <p class="note">One account works for booking and for posting legs as an operator. By creating an account you agree to the <a href="#terms">Terms</a> and <a href="#privacy">Privacy policy</a>.</p>
      <p class="err" id="aErr" role="alert"></p><button class="btn mag" type="submit">Create account</button><p class="note">Have an account? <a href="#signin">Sign in</a></p></form>`,
    forgot: `<h2>Reset your password</h2><form class="panel" id="authForm"><div class="f"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
      <p class="err" id="aErr" role="alert"></p><p class="ok" id="aOk"></p><button class="btn mag" type="submit">Email me a reset link</button><p class="note"><a href="#signin">Back to sign in</a></p></form>`,
    reset: `<h2>Choose a new password</h2><form class="panel" id="authForm"><div class="f"><label for="a-pass">New password</label><input id="a-pass" type="password" autocomplete="new-password" minlength="10" required><span class="hint">At least 10 characters.</span></div>
      <p class="err" id="aErr" role="alert"></p><button class="btn mag" type="submit">Save password and sign in</button></form>`,
  };
  el.innerHTML = `<div class="authbox">${forms[kind]}</div>`;
  el.querySelector("input").focus();
  $("#authForm").onsubmit = async e => {
    e.preventDefault(); $("#aErr").textContent = "";
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      let out;
      if (kind === "signin") out = await api("POST", "/api/auth/login", { email: $("#a-email").value, password: $("#a-pass").value });
      if (kind === "signup") out = await api("POST", "/api/auth/signup", { name: $("#a-name").value, email: $("#a-email").value, phone: $("#a-phone").value, password: $("#a-pass").value });
      if (kind === "reset") out = await api("POST", "/api/auth/reset", { token, password: $("#a-pass").value });
      if (kind === "forgot") { await api("POST", "/api/auth/forgot", { email: $("#a-email").value }); $("#aOk").textContent = "If that email has an account, a reset link is on its way. It works for one hour."; btn.disabled = false; return; }
      S.me = out.user; renderAcct(); renderAlerts(); refreshBadges();
      toast(kind === "signup" ? `Welcome, ${S.me.name.split(" ")[0]}.` : "Signed in.");
      if (S.pendingBook) { const r = S.pendingBook; S.pendingBook = null; location.hash = "find"; setTimeout(() => openBooking(r), 50); }
      else go(sessionStorage.getItem("dh_next") || "find");
    } catch (err) { $("#aErr").textContent = err.message; btn.disabled = false; }
  };
}
function renderAccount() {
  const el = $("#v-account");
  if (!S.me) return go("signin");
  el.innerHTML = `<div class="panel" style="max-width:560px"><h3>Your account</h3><form id="accForm" class="grid">
      <div class="f s6"><label for="ac-name">Full name</label><input id="ac-name" required maxlength="80" value="${esc(S.me.name)}"></div>
      <div class="f s3"><label for="ac-phone">Mobile</label><input id="ac-phone" type="tel" maxlength="30" value="${esc(S.me.phone)}"></div>
      <div class="f s3"><span class="lbl">Email</span><span>${esc(S.me.email)}</span></div>
      <div class="row-actions s6"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="signout">Sign out</button></div></form></div>`;
  $("#accForm").onsubmit = async e => { e.preventDefault(); try { S.me = (await api("PUT", "/api/me", { name: $("#ac-name").value, phone: $("#ac-phone").value })).user; renderAcct(); toast("Saved."); } catch (err) { toast(err.message); } };
  $("#signout").onclick = async () => { await api("POST", "/api/auth/logout").catch(() => {}); S.me = null; renderAcct(); renderAlerts(); refreshBadges(); toast("Signed out."); go("find"); };
}

/* ============ legal ============ */
function renderLegal(kind) {
  const brand = esc(S.ref.brand || "Deadhead"), sup = esc(S.ref.supportEmail || "support");
  const draft = `<p class="draft">Draft for counsel review before launch. Replace this notice once approved.</p>`;
  const pages = {
    broker: `<h2>Air charter broker disclosure</h2>
      <p>${brand} is an air charter broker. ${brand} is not a direct air carrier and does not own or operate aircraft. ${brand} does not have operational control of any aircraft.</p>
      <p>Each flight offered on ${brand} is operated by the FAA-certificated Part 135 air carrier named on the listing and on your confirmation. That carrier has full operational control of the flight, including the aircraft, crew, maintenance, and decisions about safety, weather and routing.</p>
      <p>${brand} arranges the flight on your behalf as your agent. The price you pay includes the operator's price for the aircraft and ${brand}'s service fee, shown separately before you book.</p>
      <p>Questions: ${sup}.</p>`,
    terms: `<h2>Terms of service</h2>${draft}
      <h3>What ${brand} does</h3><p>${brand} lists empty-leg flights posted by FAA Part 135 operators and arranges bookings between travelers and those operators. See the broker disclosure.</p>
      <h3>Booking and payment</h3><p>When you book, we authorize the total on your card. You are charged only when the operator confirms. If the operator declines, or does not confirm within the stated window, the authorization is released.</p>
      <h3>Empty-leg availability</h3><p>An empty leg exists because of another customer's trip. If that trip changes, the operator may change the departure time within the posted flexibility window or withdraw the leg. If a confirmed leg is withdrawn, you receive a full refund. ${brand} is not liable for other travel costs.</p>
      <h3>Cancellations by you</h3><p>You can cancel without charge any time before the operator confirms. After confirmation, the operator's cancellation terms apply; contact ${sup}.</p>
      <h3>Passengers and conduct</h3><p>Every passenger needs valid government photo ID and must follow crew instructions. Operators may refuse carriage for safety reasons.</p>
      <h3>Operators</h3><p>Operators must hold a valid FAA Part 135 certificate, keep required insurance, list accurate aircraft and pricing, and honor confirmed bookings.</p>`,
    privacy: `<h2>Privacy policy</h2>${draft}
      <p>We collect your name, email, phone and the trip details you enter, and share them with the operator of your flight once it is confirmed, so they can operate it. Payment details are handled by Stripe; ${brand} never sees your full card number.</p>
      <p>We send transactional emails about your bookings and the route alerts you set. We don't sell personal information. To delete your account or get a copy of your data, email ${sup}.</p>`,
  };
  $("#v-legal").innerHTML = pages[kind];
}

/* ============ wiring ============ */
$("#aps").innerHTML = AIRPORTS.map(a => `<option value="${esc(apLabel(a.id))}">`).join("");
$("#search").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
["#flex", "#rad", "#pax", "#date", "#o-chain", "#o-cancel", "#from", "#to"].forEach(s => $(s).addEventListener("change", runSearch));
$("#o-seat").addEventListener("change", renderResults);
document.querySelectorAll(".sort button").forEach(b => b.addEventListener("click", () => { S.sort = b.dataset.sort; document.querySelectorAll(".sort button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderResults(); }));
$("#list").addEventListener("click", e => {
  const b = e.target.closest("[data-book]"); if (b) return openBooking(S.search.results[+b.dataset.book]);
  const rt = e.target.closest("[data-route]"); if (rt) { const [o, d] = rt.dataset.route.split("-"); $("#from").value = apLabel(o); $("#to").value = apLabel(d); $("#flex").value = "14"; runSearch(); }
});
$("#addAlert").onclick = addAlert;
$("#wl").addEventListener("click", async e => {
  const rm = e.target.closest("[data-rm]"), run = e.target.closest("[data-run]");
  if (rm) { try { await api("DELETE", `/api/alerts/${encodeURIComponent(rm.dataset.rm)}`); renderAlerts(); } catch (err) { toast(err.message); } }
  if (run) { const [o, d, r] = run.dataset.run.split("-"); $("#from").value = apLabel(o); $("#to").value = apLabel(d); $("#rad").value = r; $("#flex").value = "14"; runSearch(); }
});
$("#v-trips").addEventListener("click", async e => {
  const b = e.target.closest("[data-cancel]"); if (!b) return;
  b.disabled = true;
  try { await api("POST", `/api/bookings/${encodeURIComponent(b.dataset.cancel)}/cancel`); toast("Request cancelled. Any card hold has been released."); renderTrips(); refreshBadges(); }
  catch (err) { toast(err.message); b.disabled = false; }
});

/* ============ boot ============ */
(async () => {
  let saved = null; try { saved = JSON.parse(localStorage.getItem("dh_search") || "null"); } catch { /* none */ }
  const d0 = new Date(); d0.setDate(d0.getDate() + 3);
  $("#from").value = apLabel(saved?.from || "KTEB"); $("#to").value = apLabel(saved?.to || "KPBI");
  $("#date").value = saved?.date && saved.date >= new Date().toISOString().slice(0, 10) ? saved.date : d0.toISOString().slice(0, 10);
  if (saved) { for (const [k, sel] of [["flex", "#flex"], ["radius", "#rad"], ["pax", "#pax"]]) if (saved[k] != null && [...$(sel).options].some(o => o.value === String(saved[k]))) $(sel).value = String(saved[k]); }
  try { S.ref = await api("GET", "/api/ref"); } catch { /* defaults */ }
  if (S.ref.supportEmail || S.ref.supportPhone) $("#support").textContent = `· Support: ${[S.ref.supportEmail, S.ref.supportPhone].filter(Boolean).join(" · ")}`;
  try { S.me = (await api("GET", "/api/me")).user; } catch { S.me = null; }
  renderAcct(); renderAlerts(); loadStats();
  const qs = new URLSearchParams(location.search);
  if (qs.get("paid")) {
    try { const { booking } = await api("POST", `/api/bookings/${encodeURIComponent(qs.get("paid"))}/sync`); toast(booking.status === "requested" ? "Card authorized. The operator has been asked to confirm." : "Payment received. We're confirming with Stripe; refresh in a moment."); } catch { /* shown on trips */ }
    history.replaceState(null, "", "/#trips");
  } else if (qs.get("unpaid")) { toast("Payment wasn't completed. Your hold lasts 30 minutes; finish it from My trips or cancel."); history.replaceState(null, "", "/#trips"); }
  route(); refreshBadges();
  setInterval(() => { if (!document.hidden) refreshBadges(); }, 60000);
})();

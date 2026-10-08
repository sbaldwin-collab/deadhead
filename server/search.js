import { AP, AIRPORTS, CLASSES, nm, mi, retailFor, legBlock, legRetail } from "../public/shared/ref.js";

export const MIN_CONNECTION_MIN = 60;
export const MAX_CONNECTION_MIN = 26 * 60;

export function publicLeg(r) {
  return {
    id: r.id, operatorId: r.operator_id, o: r.o, d: r.d, dep: r.dep_local, depUtc: r.dep_utc, window: r.window_h,
    cls: r.cls, type: r.type, tail: r.tail, seats: r.seats, price: r.price, mayCancel: !!r.may_cancel,
    notes: r.notes, status: r.status, company: r.company, cert: r.cert,
  };
}

/** Full one-way charter benchmark for a route and party size. */
export function benchmark(o, d, pax) {
  const dist = nm(AP[o], AP[d]);
  const cls = CLASSES.find(c => c.key !== "turbo" && c.seats >= pax && c.range >= dist * 1.1) || CLASSES[CLASSES.length - 1];
  return { bench: retailFor(dist, cls), cls: cls.key };
}

/**
 * Find single legs and two-leg chains that get a party from `from` to `to`.
 * pool: public legs (open or held, verified operators, future departures).
 */
export function search(pool, q) {
  const { from, to, date, flex, radius, pax, chains, allowCancel } = q;
  const near = c => new Set(AIRPORTS.filter(a => a.id === c || mi(AP[c], a) <= radius).map(a => a.id));
  const O = near(from), D = near(to);
  const want = Date.parse(date);
  const dayOff = l => Math.round((Date.parse(l.dep.slice(0, 10)) - want) / 864e5);
  const inWin = l => Math.abs(dayOff(l)) <= flex;
  const ok = l => l.seats >= pax && (allowCancel || !l.mayCancel);
  const { bench } = benchmark(from, to, pax);

  const res = [];
  for (const l of pool) if (ok(l) && O.has(l.o) && D.has(l.d) && inWin(l)) res.push({ legs: [l], price: l.price, retail: legRetail(l) });

  if (chains) {
    const byOrigin = {};
    for (const l of pool) (byOrigin[l.o] ||= []).push(l);
    for (const a of pool) {
      if (!ok(a) || !O.has(a.o) || D.has(a.d) || !inWin(a)) continue;
      const arrive = a.depUtc + legBlock(a) * 60000;
      for (const b of byOrigin[a.d] || []) {
        if (!ok(b) || !D.has(b.d) || b.d === a.o) continue;
        const gap = (b.depUtc - arrive) / 60000;
        if (gap < MIN_CONNECTION_MIN || gap > MAX_CONNECTION_MIN) continue;
        const price = a.price + b.price;
        if (price >= bench * 0.9) continue; // only worth showing when clearly cheaper than one charter
        res.push({ legs: [a, b], price, retail: bench, gap: Math.round(gap) });
      }
    }
  }
  for (const r of res) {
    r.off = Math.max(0, 1 - r.price / r.retail);
    r.dep = r.legs[0].depUtc;
    r.held = r.legs.some(l => l.status !== "open");
    r.dayOffset = dayOff(r.legs[0]);
  }
  res.sort((a, b) => a.held - b.held || a.price - b.price);
  return { results: res.slice(0, 60), bench };
}

/** Check a requested itinerary is coherent. Returns an error string or null. */
export function validateItinerary(legs, pax, now) {
  if (!legs.length || legs.length > 2) return "Choose one leg or a two-leg connection.";
  for (const l of legs) {
    if (l.status !== "open") return `The ${l.o} → ${l.d} leg is no longer available.`;
    if (l.depUtc < now + 30 * 60000) return `The ${l.o} → ${l.d} leg departs too soon to book online. Call the operator directly.`;
    if (l.seats < pax) return `The ${l.o} → ${l.d} aircraft seats ${l.seats}; you asked for ${pax}.`;
  }
  if (legs.length === 2) {
    const [a, b] = legs;
    if (a.d !== b.o) return "These legs don't connect at the same airport.";
    const gap = (b.depUtc - (a.depUtc + legBlock(a) * 60000)) / 60000;
    if (gap < MIN_CONNECTION_MIN || gap > MAX_CONNECTION_MIN) return "These legs no longer connect within a workable window.";
  }
  return null;
}

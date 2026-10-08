import crypto from "node:crypto";

// Minimal Stripe REST client (no SDK). Covers exactly what Deadhead uses:
// Checkout Sessions with manual capture, PaymentIntent capture/cancel, and webhook verification.

function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encode(item, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)));
    else if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}
export const formEncode = obj => encode(obj).join("&");

export function makeStripe({ key, base = "https://api.stripe.com" }) {
  if (!key) return null;
  async function call(method, path, params, idempotencyKey) {
    const body = params ? formEncode(params) : "";
    const url = base + path + (method === "GET" && body ? `?${body}` : "");
    const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
    if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch(url, { method, headers, body: method === "GET" ? undefined : body, signal: AbortSignal.timeout(20000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error?.message || `Stripe request failed (${res.status})`);
      err.stripe = json?.error; err.status = res.status; throw err;
    }
    return json;
  }
  return {
    createCheckout: (p, idem) => call("POST", "/v1/checkout/sessions", p, idem),
    retrieveSession: id => call("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`, { expand: ["payment_intent"] }),
    expireSession: id => call("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`),
    retrievePI: id => call("GET", `/v1/payment_intents/${encodeURIComponent(id)}`),
    capturePI: (id, idem) => call("POST", `/v1/payment_intents/${encodeURIComponent(id)}/capture`, null, idem),
    cancelPI: id => call("POST", `/v1/payment_intents/${encodeURIComponent(id)}/cancel`),
  };
}

/** Verify a Stripe-Signature header against the raw request body. Returns the parsed event or throws. */
export function verifyWebhook(rawBody, header, secret, toleranceSec = 300, now = Date.now()) {
  if (!secret) throw new Error("Webhook secret not configured");
  const parts = Object.create(null); const sigs = [];
  for (const kv of String(header || "").split(",")) {
    const [k, v] = kv.split("=");
    if (k === "v1") sigs.push(v); else if (k) parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !sigs.length) throw new Error("Malformed signature header");
  if (Math.abs(now / 1000 - t) > toleranceSec) throw new Error("Signature timestamp outside tolerance");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
  const ok = sigs.some(s => s && s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error("Signature mismatch");
  return JSON.parse(rawBody.toString("utf8"));
}

export function signWebhook(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

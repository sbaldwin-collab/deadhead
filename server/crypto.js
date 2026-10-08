// WebCrypto helpers. Work unchanged in Node 22 and Cloudflare Workers.
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function b64url(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const fromHex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));

export const randomId = (n = 12) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(s) { return hex(await subtle.digest("SHA-256", enc.encode(s))); }
export async function hmacHex(secret, msg) {
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await subtle.sign("HMAC", key, enc.encode(msg)));
}
/** Constant-time string comparison. */
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Passwords: PBKDF2-SHA256. Iterations are stored with each hash so they can be raised later
// without breaking old accounts. The optional pepper (a server secret) is mixed in with HMAC,
// so a leaked database alone can't be brute-forced.
export const DEFAULT_ITERATIONS = 20000; // sized for Cloudflare's free-tier CPU budget
async function derive(pw, salt, iterations, pepper) {
  const material = pepper ? await hmacHex(pepper, pw) : pw;
  const key = await subtle.importKey("raw", enc.encode(material), "PBKDF2", false, ["deriveBits"]);
  return hex(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
export async function hashPassword(pw, { iterations = DEFAULT_ITERATIONS, pepper = "" } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${hex(salt)}$${await derive(pw, salt, iterations, pepper)}${pepper ? "$p" : ""}`;
}
export async function verifyPassword(pw, stored, { pepper = "" } = {}) {
  const [alg, it, saltHex, want, peppered] = String(stored).split("$");
  if (alg !== "pbkdf2" || !it || !saltHex || !want) return false;
  if (peppered === "p" && !pepper) return false;
  return safeEqual(await derive(pw, fromHex(saltHex), +it, peppered === "p" ? pepper : ""), want);
}

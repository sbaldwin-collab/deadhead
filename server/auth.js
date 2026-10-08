import crypto from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./http.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;

export const newId = (n = 12) => crypto.randomBytes(n).toString("base64url");
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = String(stored).split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

/** Session tokens are random; only their SHA-256 is stored. */
export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.run("INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)", sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
  return { token, maxAge: SESSION_DAYS * 86400 };
}
export function destroySession(db, token) { if (token) db.run("DELETE FROM sessions WHERE id=?", sha256(token)); }
export function userForToken(db, token) {
  if (!token) return null;
  const row = db.get("SELECT u.* , s.expires_at s_exp FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?", sha256(token));
  if (!row) return null;
  if (row.s_exp < Date.now()) { db.run("DELETE FROM sessions WHERE id=?", sha256(token)); return null; }
  return row;
}

export const isAdmin = (cfg, user) => !!user && (user.role === "admin" || cfg.adminEmails.includes(user.email));

export function publicUser(cfg, db, u) {
  if (!u) return null;
  const op = db.get("SELECT id,status FROM operators WHERE user_id=?", u.id);
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, admin: isAdmin(cfg, u), operator: op ? { id: op.id, status: op.status } : null };
}

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, "Sign in to continue.");
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
export function validEmail(e) { return typeof e === "string" && EMAIL_RE.test(e.trim()); }
export function validPassword(p) { return typeof p === "string" && p.length >= 10 && p.length <= 200; }

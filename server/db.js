import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Ordered migrations. Never edit a shipped one; append a new entry.
const MIGRATIONS = [
`
CREATE TABLE users(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  pass TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE resets(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE operators(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  company TEXT NOT NULL,
  cert TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE legs(
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  o TEXT NOT NULL, d TEXT NOT NULL,
  dep_local TEXT NOT NULL, dep_utc INTEGER NOT NULL,
  window_h INTEGER NOT NULL DEFAULT 0,
  cls TEXT NOT NULL, type TEXT NOT NULL, tail TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL, price INTEGER NOT NULL,
  may_cancel INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX legs_status_dep ON legs(status, dep_utc);
CREATE INDEX legs_operator ON legs(operator_id);
CREATE TABLE bookings(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  pax INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL, contact_email TEXT NOT NULL,
  subtotal INTEGER NOT NULL, fee INTEGER NOT NULL, total INTEGER NOT NULL, retail INTEGER NOT NULL,
  pay_mode TEXT NOT NULL,
  pay_status TEXT NOT NULL DEFAULT 'none',
  stripe_session TEXT, stripe_pi TEXT, checkout_url TEXT,
  message TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX bookings_user ON bookings(user_id);
CREATE INDEX bookings_status ON bookings(status, expires_at);
CREATE TABLE booking_legs(
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  leg_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  op_status TEXT NOT NULL DEFAULT 'pending',
  op_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(booking_id, leg_id)
);
CREATE INDEX booking_legs_op ON booking_legs(operator_id);
CREATE TABLE alerts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  o TEXT NOT NULL, d TEXT NOT NULL, radius INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE alert_hits(
  alert_id TEXT NOT NULL, leg_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(alert_id, leg_id)
);
CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, ref TEXT, detail TEXT
);
`,
];

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  const ver = raw.prepare("PRAGMA user_version").get().user_version;
  for (let i = ver; i < MIGRATIONS.length; i++) {
    raw.exec("BEGIN");
    try { raw.exec(MIGRATIONS[i]); raw.exec(`PRAGMA user_version=${i + 1}`); raw.exec("COMMIT"); }
    catch (err) { raw.exec("ROLLBACK"); throw err; }
  }
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const clean = p => p.map(v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  let depth = 0;
  return {
    all: (sql, ...p) => st(sql).all(...clean(p)),
    get: (sql, ...p) => st(sql).get(...clean(p)),
    run: (sql, ...p) => st(sql).run(...clean(p)),
    /** Synchronous transaction. Never await inside fn. */
    tx(fn) {
      if (depth) return fn();
      raw.exec("BEGIN IMMEDIATE"); depth++;
      try { const r = fn(); raw.exec("COMMIT"); return r; }
      catch (err) { raw.exec("ROLLBACK"); throw err; }
      finally { depth--; }
    },
    audit(actor, action, ref, detail) {
      st("INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)").run(Date.now(), actor ?? null, action, ref ?? null, detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail));
    },
    close: () => raw.close(),
  };
}

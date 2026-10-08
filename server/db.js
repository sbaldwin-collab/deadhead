// One async database interface, two backends:
//   makeD1Db(env.DB)        Cloudflare D1 (Workers)
//   makeNodeDb(file)        node:sqlite (Node 22+), lazily imported so Workers never load it
// Interface: all(sql,...p) -> rows · get(sql,...p) -> row|null · run(sql,...p) -> {changes}
//            batch([[sql,...p], ...]) -> [{changes}]  (atomic: all or nothing)

// Ordered migrations. Never edit a shipped one; append a new entry. Statements end with ";\n".
const MIGRATIONS = [
`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL);
CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE resets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE operators(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), company TEXT NOT NULL, cert TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, base TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE legs(id TEXT PRIMARY KEY, operator_id TEXT NOT NULL REFERENCES operators(id), o TEXT NOT NULL, d TEXT NOT NULL, dep_local TEXT NOT NULL, dep_utc INTEGER NOT NULL, window_h INTEGER NOT NULL DEFAULT 0, cls TEXT NOT NULL, type TEXT NOT NULL, tail TEXT NOT NULL DEFAULT '', seats INTEGER NOT NULL, price INTEGER NOT NULL, may_cancel INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', hold_ref TEXT, alerted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX legs_status_dep ON legs(status, dep_utc);
CREATE INDEX legs_operator ON legs(operator_id);
CREATE INDEX legs_hold ON legs(hold_ref);
CREATE TABLE bookings(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, pax INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', contact_name TEXT NOT NULL, contact_phone TEXT NOT NULL, contact_email TEXT NOT NULL, subtotal INTEGER NOT NULL, fee INTEGER NOT NULL, total INTEGER NOT NULL, retail INTEGER NOT NULL, pay_mode TEXT NOT NULL, pay_status TEXT NOT NULL DEFAULT 'none', stripe_session TEXT, stripe_pi TEXT, checkout_url TEXT, message TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX bookings_user ON bookings(user_id);
CREATE INDEX bookings_status ON bookings(status, expires_at);
CREATE TABLE booking_legs(booking_id TEXT NOT NULL REFERENCES bookings(id), leg_id TEXT NOT NULL, operator_id TEXT NOT NULL, seq INTEGER NOT NULL, snapshot TEXT NOT NULL, op_status TEXT NOT NULL DEFAULT 'pending', op_note TEXT NOT NULL DEFAULT '', PRIMARY KEY(booking_id, leg_id));
CREATE INDEX booking_legs_op ON booking_legs(operator_id);
CREATE TABLE alerts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, o TEXT NOT NULL, d TEXT NOT NULL, radius INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE alert_hits(alert_id TEXT NOT NULL, leg_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(alert_id, leg_id));
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, ref TEXT, detail TEXT);
`,
];
const statements = sql => sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
const clean = p => p.map(v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

async function migrate(db) {
  await db.run("CREATE TABLE IF NOT EXISTS _migrations(version INTEGER NOT NULL)");
  const row = await db.get("SELECT MAX(version) v FROM _migrations");
  for (let i = row?.v || 0; i < MIGRATIONS.length; i++)
    await db.batch([...statements(MIGRATIONS[i]).map(s => [s]), ["INSERT INTO _migrations(version) VALUES(?)", i + 1]]);
}

/** Adds audit() and a one-time migration step to a raw backend. */
function wrap(raw) {
  let ready = null;
  const db = {
    ...raw,
    audit: (actor, action, ref, detail) => raw.run("INSERT INTO audit(at,actor,action,ref,detail) VALUES(?,?,?,?,?)", Date.now(), actor ?? null, action, ref ?? null,
      detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail)),
    ready: () => (ready ||= migrate(raw).catch(err => { ready = null; throw err; })),
  };
  return db;
}

export function makeD1Db(d1) {
  const prep = (sql, p) => d1.prepare(sql).bind(...clean(p));
  return wrap({
    all: async (sql, ...p) => (await prep(sql, p).all()).results || [],
    get: async (sql, ...p) => (await prep(sql, p).first()) ?? null,
    run: async (sql, ...p) => ({ changes: (await prep(sql, p).run()).meta?.changes ?? 0 }),
    batch: async list => (await d1.batch(list.map(([sql, ...p]) => prep(sql, p)))).map(r => ({ changes: r.meta?.changes ?? 0 })),
    close() {},
  });
}

export async function makeNodeDb(file) {
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") {
    const fs = await import("node:fs"), path = await import("node:path");
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const db = wrap({
    all: async (sql, ...p) => st(sql).all(...clean(p)),
    get: async (sql, ...p) => st(sql).get(...clean(p)) ?? null,
    run: async (sql, ...p) => ({ changes: Number(st(sql).run(...clean(p)).changes) }),
    async batch(list) {
      raw.exec("BEGIN IMMEDIATE");
      try { const out = list.map(([sql, ...p]) => ({ changes: Number(st(sql).run(...clean(p)).changes) })); raw.exec("COMMIT"); return out; }
      catch (err) { raw.exec("ROLLBACK"); throw err; }
    },
    close: () => raw.close(),
  });
  await db.ready();
  return db;
}

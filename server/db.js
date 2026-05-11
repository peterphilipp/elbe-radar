'use strict';
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path = require('path');
const fs   = require('fs');

const DATA_DIR    = process.env.DATA_DIR   || '/app/data';
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || '7', 10);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'elbe-radar.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ships (
    mmsi TEXT PRIMARY KEY, name TEXT, type TEXT,
    len INTEGER DEFAULT 0, wid INTEGER DEFAULT 0, drg INTEGER DEFAULT 0,
    cs TEXT, dest TEXT,
    lat REAL, lon REAL, sog INTEGER, cog INTEGER, heading INTEGER,
    seen INTEGER, eta_ts INTEGER, eta_dir TEXT, eta_dist REAL
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi TEXT NOT NULL, name TEXT, type TEXT, len INTEGER,
    lat REAL, lon REAL, sog INTEGER, cog INTEGER, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_ts   ON history(ts);
  CREATE INDEX IF NOT EXISTS idx_history_mmsi ON history(mmsi);
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL, ship_type TEXT, name_filter TEXT,
    min_len INTEGER DEFAULT 0, max_eta_min INTEGER DEFAULT 30,
    min_length_alert INTEGER DEFAULT 150, active INTEGER DEFAULT 1,
    created INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS alerted (
    key TEXT PRIMARY KEY, ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
  );
`);

// ── Passages table (statistics) ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS passages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi     TEXT NOT NULL,
    name     TEXT,
    type     TEXT,
    len      INTEGER DEFAULT 0,
    direction TEXT NOT NULL,         -- 'Hamburg' | 'Nordsee'
    lat      REAL, lon REAL,
    sog      INTEGER,
    ts       INTEGER NOT NULL,       -- Unix-ms
    date_de  TEXT NOT NULL           -- 'YYYY-MM-DD' (Europe/Berlin)
  );
  CREATE INDEX IF NOT EXISTS idx_passages_ts   ON passages(ts);
  CREATE INDEX IF NOT EXISTS idx_passages_date ON passages(date_de);
  CREATE INDEX IF NOT EXISTS idx_passages_mmsi ON passages(mmsi);
`);

// ── Migrations (safe – immer try/catch) ───────────────────────────────────────
for (const sql of [
  `ALTER TABLE alerts ADD COLUMN min_length_alert INTEGER DEFAULT 150`,
  `ALTER TABLE alerts ADD COLUMN user_id INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL`,
]) { try { db.exec(sql); } catch(e) {} }

// Password-Reset-Tokens
db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
`);

// ── Passages helpers ──────────────────────────────────────────────────────────
const insertPassage = db.prepare(`
  INSERT INTO passages (mmsi,name,type,len,direction,lat,lon,sog,ts,date_de)
  VALUES (@mmsi,@name,@type,@len,@direction,@lat,@lon,@sog,@ts,@date_de)
`);
const lastPassageTs = db.prepare(
  `SELECT MAX(ts) as ts FROM passages WHERE mmsi=? AND direction=?`
);
const PASSAGE_DEDUP_MS = 30 * 60 * 1000; // selbes Schiff / selbe Richtung = 30 min

function recordPassage(ship, direction) {
  const last = (lastPassageTs.get(ship.mmsi, direction)||{}).ts || 0;
  if (Date.now() - last < PASSAGE_DEDUP_MS) return;   // Duplikat vermeiden
  const now = Date.now();
  const date_de = new Date(now).toLocaleDateString('de-DE',
    { timeZone:'Europe/Berlin', year:'numeric', month:'2-digit', day:'2-digit' }
  ).split('.').reverse().join('-'); // → YYYY-MM-DD
  insertPassage.run({
    mmsi: ship.mmsi, name: ship.name||'', type: ship.type||'',
    len: ship.len||0, direction, lat: ship.lat||0, lon: ship.lon||0,
    sog: ship.sog||0, ts: now, date_de,
  });
}

// ── Prepared Statements ───────────────────────────────────────────────────────
const upsertShip = db.prepare(`
  INSERT INTO ships (mmsi,name,type,len,wid,drg,cs,dest,lat,lon,sog,cog,heading,seen,eta_ts,eta_dir,eta_dist)
  VALUES (@mmsi,@name,@type,@len,@wid,@drg,@cs,@dest,@lat,@lon,@sog,@cog,@heading,@seen,@eta_ts,@eta_dir,@eta_dist)
  ON CONFLICT(mmsi) DO UPDATE SET
    name=excluded.name, type=excluded.type,
    len=CASE WHEN excluded.len>0 THEN excluded.len ELSE ships.len END,
    wid=CASE WHEN excluded.wid>0 THEN excluded.wid ELSE ships.wid END,
    drg=CASE WHEN excluded.drg>0 THEN excluded.drg ELSE ships.drg END,
    cs=COALESCE(NULLIF(excluded.cs,''),ships.cs),
    dest=COALESCE(NULLIF(excluded.dest,''),ships.dest),
    lat=excluded.lat, lon=excluded.lon, sog=excluded.sog, cog=excluded.cog, heading=excluded.heading,
    seen=excluded.seen, eta_ts=excluded.eta_ts, eta_dir=excluded.eta_dir, eta_dist=excluded.eta_dist
`);
const insertHistory  = db.prepare(`INSERT INTO history (mmsi,name,type,len,lat,lon,sog,cog,ts) VALUES (@mmsi,@name,@type,@len,@lat,@lon,@sog,@cog,@ts)`);
const lastHistoryTs  = db.prepare(`SELECT MAX(ts) as ts FROM history WHERE mmsi=?`);
const getAlertedStmt = db.prepare(`SELECT ts FROM alerted WHERE key=?`);
const setAlertedStmt = db.prepare(`INSERT OR REPLACE INTO alerted (key,ts) VALUES (?,?)`);
const getSettStmt    = db.prepare(`SELECT value FROM settings WHERE key=?`);
const setSettStmt    = db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`);

// User statements
const findUserByName = db.prepare(`SELECT * FROM users WHERE username=? COLLATE NOCASE`);
const findUserById   = db.prepare(`SELECT id,username,is_admin,created_at FROM users WHERE id=?`);
const countUsers     = db.prepare(`SELECT COUNT(*) as n FROM users`);
const insertUserStmt = db.prepare(`INSERT INTO users (username,password_hash,is_admin) VALUES (?,?,?)`);
const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE token=? AND expires_at>?`);
const createSessStmt = db.prepare(`INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)`);
const deleteSessStmt = db.prepare(`DELETE FROM sessions WHERE token=?`);
const getUserSettStmt= db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key=?`);
const setUserSettStmt= db.prepare(`INSERT OR REPLACE INTO user_settings (user_id,key,value) VALUES (?,?,?)`);

const HISTORY_INTERVAL = 5 * 60 * 1000;

// ── Password helpers ──────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash)); } catch { return false; }
}
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function saveShip(ship) {
  const eta = ship.eta || {};
  upsertShip.run({
    mmsi:ship.mmsi, name:ship.name||'', type:ship.type||'Cargo',
    len:ship.len||0, wid:ship.wid||0, drg:ship.drg||0,
    cs:ship.cs||'', dest:ship.dest||'',
    lat:ship.lat||0, lon:ship.lon||0,
    sog:ship.sog||0, cog:ship.cog||0, heading:ship.heading||0,
    seen:ship.seen||Date.now(),
    eta_ts:  eta.eta ? new Date(eta.eta).getTime() : null,
    eta_dir: eta.direction||null, eta_dist: eta.distNm||null,
  });
  const lastTs = (lastHistoryTs.get(ship.mmsi)||{}).ts || 0;
  if ((ship.seen||Date.now()) - lastTs >= HISTORY_INTERVAL && ship.lat && ship.lon) {
    insertHistory.run({ mmsi:ship.mmsi, name:ship.name||'', type:ship.type||'', len:ship.len||0, lat:ship.lat, lon:ship.lon, sog:ship.sog||0, cog:ship.cog||0, ts:ship.seen||Date.now() });
  }
}

function cleanup() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000;
  const r1 = db.prepare(`DELETE FROM history WHERE ts < ?`).run(cutoff);
  const r2 = db.prepare(`DELETE FROM ships WHERE seen < ?`).run(Date.now() - 20*60*1000);
  db.prepare(`DELETE FROM alerted WHERE ts < ?`).run(Date.now() - 7*24*3600*1000);
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
  console.log(`[DB] Cleanup: ${r1.changes} History, ${r2.changes} Schiffe`);
}
setInterval(cleanup, 3600 * 1000);

module.exports = {
  saveShip,
  getActiveShips: (maxAgeMs=15*60*1000) =>
    db.prepare(`SELECT * FROM ships WHERE seen > ? ORDER BY seen DESC`).all(Date.now()-maxAgeMs),
  getHistory: (days=1) =>
    db.prepare(`SELECT * FROM history WHERE ts > ? ORDER BY ts DESC LIMIT 5000`).all(Date.now()-days*24*3600*1000),
  getTrack: (mmsi, hours=24) =>
    db.prepare(`SELECT lat,lon,sog,cog,ts FROM history WHERE mmsi=? AND ts > ? ORDER BY ts ASC`).all(mmsi, Date.now()-hours*3600*1000),

  // Alerts (per user)
  getAlertsForUser: uid => db.prepare(`SELECT * FROM alerts WHERE user_id=? AND active=1`).all(uid),
  getAllActiveAlerts: () => db.prepare(`SELECT * FROM alerts WHERE active=1`).all(),
  insertAlert: (uid, a) => db.prepare(`INSERT INTO alerts (user_id,name,ship_type,name_filter,min_len,max_eta_min,min_length_alert,active) VALUES (?,@name,@ship_type,@name_filter,@min_len,@max_eta_min,@min_length_alert,@active)`).run(uid, a),
  deleteAlert: id => db.prepare(`DELETE FROM alerts WHERE id=?`).run(id),
  toggleAlert: (id,v) => db.prepare(`UPDATE alerts SET active=? WHERE id=?`).run(v,id),
  getAlertOwner: id => db.prepare(`SELECT user_id FROM alerts WHERE id=?`).get(id),

  // Telegram dedup
  isAlerted:   (key, ms=6*3600*1000) => { const r=getAlertedStmt.get(key); return !!(r&&(Date.now()-r.ts)<ms); },
  markAlerted: key => setAlertedStmt.run(key, Date.now()),

  // Global settings
  getSetting:  key   => { const r=getSettStmt.get(key); return r?r.value:null; },
  setSetting:  (k,v) => setSettStmt.run(k, v),

  // Per-user settings
  getUserSetting:  (uid, key)   => { const r=getUserSettStmt.get(uid,key); return r?r.value:null; },
  setUserSetting:  (uid, key, v) => setUserSettStmt.run(uid, key, String(v)),
  getAllUserSettings: uid => db.prepare(`SELECT key,value FROM user_settings WHERE user_id=?`).all(uid),

  recordPassage,
  getPassages: (days=30) =>
    db.prepare(`SELECT * FROM passages WHERE ts > ? ORDER BY ts DESC LIMIT 2000`)
      .all(Date.now() - days*24*3600*1000),
  getPassageStats: (days=30) =>
    db.prepare(`
      SELECT date_de, direction, type, COUNT(*) as cnt
      FROM passages WHERE ts > ?
      GROUP BY date_de, direction, type
      ORDER BY date_de DESC
    `).all(Date.now() - days*24*3600*1000),

  // Auth
  countUsers:       () => countUsers.get().n,
  getUserByUsername: name  => findUserByName.get(name),
  getUserById:       id    => findUserById.get(id),
  getUserByEmail:    email => db.prepare(`SELECT * FROM users WHERE lower(email)=lower(?)`).get(email),
  createUser:        (username, password, isAdmin=0) => insertUserStmt.run(username, hashPassword(password), isAdmin),
  setUserEmail:      (id, email) => db.prepare(`UPDATE users SET email=? WHERE id=?`).run(email||null, id),
  verifyPassword,
  hashPassword,
  generateToken,
  getSession:    token   => getSessionStmt.get(token, Date.now()),
  createSession: (userId, token, expiresAt) => createSessStmt.run(token, userId, expiresAt),
  deleteSession: token   => deleteSessStmt.run(token),

  // Password-Reset-Tokens
  createResetToken: (userId) => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60 * 60 * 1000; // 1 Stunde
    db.prepare(`DELETE FROM password_reset_tokens WHERE user_id=?`).run(userId); // alte löschen
    db.prepare(`INSERT INTO password_reset_tokens (token,user_id,expires_at) VALUES (?,?,?)`).run(token, userId, expires);
    return token;
  },
  getResetToken: (token) => db.prepare(
    `SELECT * FROM password_reset_tokens WHERE token=? AND expires_at>? AND used=0`
  ).get(token, Date.now()),
  markResetTokenUsed: (token) => db.prepare(`UPDATE password_reset_tokens SET used=1 WHERE token=?`).run(token),
  resetPassword: (userId, newPassword) => db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(newPassword), userId),

  // Admin – Benutzerverwaltung
  getAllUsers:       () => db.prepare(`SELECT id, username, email, is_admin, created_at FROM users ORDER BY created_at ASC`).all(),
  deleteUser:        id => db.prepare(`DELETE FROM users WHERE id=?`).run(id),
  deleteUserSessions: id => db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(id),
  setUserAdmin:     (id, v) => db.prepare(`UPDATE users SET is_admin=? WHERE id=?`).run(v?1:0, id),
  resetUserPassword: (id, pw) => db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(pw), id),

  // DB-Stats
  getDbStats: () => ({
    history:  db.prepare(`SELECT COUNT(*) as cnt, MIN(ts) as min_ts, MAX(ts) as max_ts FROM history`).get(),
    ships:    db.prepare(`SELECT COUNT(*) as cnt FROM ships`).get().cnt,
    passages: db.prepare(`SELECT COUNT(*) as cnt FROM passages`).get().cnt,
    users:    db.prepare(`SELECT COUNT(*) as cnt FROM users`).get().cnt,
    sessions: db.prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE expires_at > ?`).get(Date.now()).cnt,
  }),

  db,
};

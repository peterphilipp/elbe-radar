'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR     = process.env.DATA_DIR || '/app/data';
const RETAIN_DAYS  = parseInt(process.env.RETAIN_DAYS || '7', 10);
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'elbe-radar.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ships (
    mmsi       TEXT PRIMARY KEY,
    name       TEXT,
    type       TEXT,
    len        INTEGER DEFAULT 0,
    wid        INTEGER DEFAULT 0,
    drg        INTEGER DEFAULT 0,
    cs         TEXT,
    dest       TEXT,
    lat        REAL,
    lon        REAL,
    sog        INTEGER,
    cog        INTEGER,
    heading    INTEGER,
    seen       INTEGER,
    eta_ts     INTEGER,
    eta_dir    TEXT,
    eta_dist   REAL
  );

  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mmsi       TEXT NOT NULL,
    name       TEXT,
    type       TEXT,
    len        INTEGER,
    lat        REAL,
    lon        REAL,
    sog        INTEGER,
    cog        INTEGER,
    ts         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_ts   ON history(ts);
  CREATE INDEX IF NOT EXISTS idx_history_mmsi ON history(mmsi);

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    ship_type  TEXT,
    name_filter TEXT,
    min_len    INTEGER DEFAULT 0,
    max_eta_min INTEGER DEFAULT 360,
    active     INTEGER DEFAULT 1,
    created    INTEGER DEFAULT (strftime('%s','now'))
  );
`);

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
    lat=excluded.lat, lon=excluded.lon,
    sog=excluded.sog, cog=excluded.cog, heading=excluded.heading,
    seen=excluded.seen,
    eta_ts=excluded.eta_ts, eta_dir=excluded.eta_dir, eta_dist=excluded.eta_dist
`);

const insertHistory = db.prepare(`
  INSERT INTO history (mmsi,name,type,len,lat,lon,sog,cog,ts)
  VALUES (@mmsi,@name,@type,@len,@lat,@lon,@sog,@cog,@ts)
`);

const lastHistoryTs = db.prepare(`
  SELECT MAX(ts) as ts FROM history WHERE mmsi=?
`);

const getActiveShips = db.prepare(`
  SELECT * FROM ships WHERE seen > ? ORDER BY seen DESC
`);

const getHistory = db.prepare(`
  SELECT * FROM history WHERE ts > ? ORDER BY ts DESC LIMIT 5000
`);

const getAlerts = db.prepare(`SELECT * FROM alerts WHERE active=1`);
const insertAlert = db.prepare(`
  INSERT INTO alerts (name,ship_type,name_filter,min_len,max_eta_min,active)
  VALUES (@name,@ship_type,@name_filter,@min_len,@max_eta_min,@active)
`);
const deleteAlert = db.prepare(`DELETE FROM alerts WHERE id=?`);
const toggleAlert = db.prepare(`UPDATE alerts SET active=? WHERE id=?`);

// ── History-Intervall: alle 30 Min pro Schiff ─────────────────────────────────
const HISTORY_INTERVAL = 30 * 60 * 1000;

function saveShip(ship) {
  const eta = ship.eta || {};
  upsertShip.run({
    mmsi: ship.mmsi, name: ship.name||'', type: ship.type||'Cargo',
    len: ship.len||0, wid: ship.wid||0, drg: ship.drg||0,
    cs: ship.cs||'', dest: ship.dest||'',
    lat: ship.lat||0, lon: ship.lon||0,
    sog: ship.sog||0, cog: ship.cog||0, heading: ship.heading||0,
    seen: ship.seen||Date.now(),
    eta_ts:   eta.eta   ? new Date(eta.eta).getTime() : null,
    eta_dir:  eta.direction || null,
    eta_dist: eta.distNm    || null,
  });

  // History alle 30 Min
  const lastTs = (lastHistoryTs.get(ship.mmsi) || {}).ts || 0;
  if ((ship.seen||Date.now()) - lastTs >= HISTORY_INTERVAL && ship.lat && ship.lon) {
    insertHistory.run({
      mmsi: ship.mmsi, name: ship.name||'', type: ship.type||'',
      len: ship.len||0, lat: ship.lat, lon: ship.lon,
      sog: ship.sog||0, cog: ship.cog||0, ts: ship.seen||Date.now(),
    });
  }
}

// ── Cleanup alte Daten ────────────────────────────────────────────────────────
function cleanup() {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600 * 1000;
  const r1 = db.prepare(`DELETE FROM history WHERE ts < ?`).run(cutoff);
  const r2 = db.prepare(`DELETE FROM ships WHERE seen < ?`).run(Date.now() - 20*60*1000);
  console.log(`[DB] Cleanup: ${r1.changes} History-Einträge, ${r2.changes} Schiffe entfernt`);
}
setInterval(cleanup, 3600 * 1000);

module.exports = {
  saveShip,
  getActiveShips: (maxAgeMs=15*60*1000) => getActiveShips.all(Date.now()-maxAgeMs),
  getHistory: (days=1) => getHistory.all(Date.now()-days*24*3600*1000),
  getAlerts: () => getAlerts.all(),
  insertAlert: a => insertAlert.run(a),
  deleteAlert: id => deleteAlert.run(id),
  toggleAlert: (id,v) => toggleAlert.run(v,id),
  db,
};

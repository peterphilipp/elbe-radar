'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const https        = require('https');
const WebSocket    = require('ws');
const path         = require('path');
const AISConnector = require('./aisConnector');
const db           = require('./db');
const { sendTestMessage, invalidateUserCache } = require('./telegramBot');

const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || '';
const REG_CODE   = process.env.REGISTRATION_CODE || '';
const SESSION_TTL= 30 * 24 * 3600 * 1000; // 30 Tage

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(express.json());

const BUILD_SHA  = process.env.BUILD_SHA  || 'dev';
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();

// ── Auth Middleware ───────────────────────────────────────────────────────────
function getTokenFromReq(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
}
function authMiddleware(req, res, next) {
  const token   = getTokenFromReq(req);
  const session = token ? db.getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'Nicht angemeldet' });
  req.userId = session.user_id;
  next();
}
// Optionaler alter API-Key-Schutz (backward compat)
function legacyAuth(req, res, next) {
  if (!API_SECRET) return next();
  const key = req.headers['x-api-key'] || req.query.apikey || '';
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── AIS ──────────────────────────────────────────────────────────────────────
const ais = new AISConnector(ships => broadcast(ships));
ais.start();

function broadcast(ships) {
  const payload = JSON.stringify({ type:'ships', data: db.getActiveShips(15*60*1000), ts: Date.now() });
  for (const c of wss.clients) if (c.readyState===WebSocket.OPEN) c.send(payload);
}

wss.on('connection', (ws, req) => {
  // WebSocket-Authentifizierung via Query-Parameter
  const url     = new URL(req.url, 'http://localhost');
  const token   = url.searchParams.get('token') || '';
  const session = token ? db.getSession(token) : null;
  if (!session) { ws.close(1008, 'Unauthorized'); return; }
  ws.userId = session.user_id;
  ws.send(JSON.stringify({ type:'ships', data: db.getActiveShips(15*60*1000), ts: Date.now() }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type==='setBox' && msg.box) ais.updateBox(msg.box);
    } catch(e) {}
  });
});

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, invite_code } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  if (username.length < 3)    return res.status(400).json({ error: 'Benutzername mindestens 3 Zeichen' });
  if (password.length < 6)    return res.status(400).json({ error: 'Passwort mindestens 6 Zeichen' });
  const userCount = db.countUsers();
  // Erster User = Admin, kein Code nötig. Danach: Code aus env oder leer = offen
  if (userCount > 0 && REG_CODE && invite_code !== REG_CODE) {
    return res.status(403).json({ error: 'Ungültiger Einladungscode' });
  }
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  try {
    db.createUser(username, password, userCount === 0 ? 1 : 0);
    const user  = db.getUserByUsername(username);
    const token = db.generateToken();
    db.createSession(user.id, token, Date.now() + SESSION_TTL);
    res.json({ token, username: user.username, isAdmin: user.is_admin===1 });
  } catch(e) {
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  const user = db.getUserByUsername(username);
  if (!user || !db.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  const token = db.generateToken();
  db.createSession(user.id, token, Date.now() + SESSION_TTL);
  res.json({ token, username: user.username, isAdmin: user.is_admin===1 });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.deleteSession(req.token || getTokenFromReq(req));
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, isAdmin: user.is_admin===1 });
});

app.get('/api/auth/hasUsers', (req, res) => {
  res.json({ hasUsers: db.countUsers() > 0, regCodeRequired: !!REG_CODE });
});

// ── USER SETTINGS ─────────────────────────────────────────────────────────────
app.get('/api/user/settings/:key', authMiddleware, (req, res) => {
  res.json({ value: db.getUserSetting(req.userId, req.params.key) });
});
app.post('/api/user/settings/:key', authMiddleware, (req, res) => {
  if (req.body.value === undefined) return res.status(400).json({ error: 'value required' });
  db.setUserSetting(req.userId, req.params.key, req.body.value);
  res.json({ ok: true });
});

// ── TELEGRAM (per User) ───────────────────────────────────────────────────────
app.get('/api/user/telegram', authMiddleware, (req, res) => {
  const raw = db.getUserSetting(req.userId, 'telegram');
  res.json(raw ? JSON.parse(raw) : { bot_token:'', chat_id:'' });
});
app.post('/api/user/telegram', authMiddleware, (req, res) => {
  const { bot_token, chat_id } = req.body;
  db.setUserSetting(req.userId, 'telegram', JSON.stringify({ bot_token:bot_token||'', chat_id:chat_id||'' }));
  invalidateUserCache(req.userId);
  res.json({ ok: true });
});
app.post('/api/user/telegram/test', authMiddleware, async (req, res) => {
  const result = await sendTestMessage(req.userId);
  res.json(result);
});

// ── ALERTS (per User, auth) ───────────────────────────────────────────────────
app.get('/api/alerts', authMiddleware, (req, res) => res.json(db.getAlertsForUser(req.userId)));
app.post('/api/alerts', authMiddleware, (req, res) => {
  const { name, ship_type, name_filter, min_length_alert, max_eta_min } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const info = db.insertAlert(req.userId, {
    name, ship_type:ship_type||null, name_filter:name_filter||null,
    min_len:0, max_eta_min:+max_eta_min||30,
    min_length_alert:+min_length_alert||150, active:1,
  });
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/alerts/:id', authMiddleware, (req, res) => {
  const owner = db.getAlertOwner(+req.params.id);
  if (!owner || owner.user_id !== req.userId) return res.status(403).json({error:'Forbidden'});
  db.deleteAlert(+req.params.id); res.json({ok:true});
});
app.patch('/api/alerts/:id', authMiddleware, (req, res) => {
  const owner = db.getAlertOwner(+req.params.id);
  if (!owner || owner.user_id !== req.userId) return res.status(403).json({error:'Forbidden'});
  db.toggleAlert(+req.params.id, req.body.active ? 1 : 0); res.json({ok:true});
});

// ── STATISTICS ────────────────────────────────────────────────────────────────
app.get('/api/stats/passages', authMiddleware, (req, res) => {
  const days = +(req.query.days||30);
  const { type, direction, min_len } = req.query;
  let sql = `SELECT * FROM passages WHERE ts > ?`;
  const params = [Date.now() - days*24*3600*1000];
  if (type)      { sql += ` AND type=?`;        params.push(type); }
  if (direction) { sql += ` AND direction=?`;   params.push(direction); }
  if (min_len)   { sql += ` AND len >= ?`;      params.push(+min_len); }
  sql += ` ORDER BY ts DESC LIMIT 2000`;
  res.json(db.db.prepare(sql).all(...params));
});
app.get('/api/stats/passages/summary', authMiddleware, (req, res) => {
  const days = +(req.query.days||30);
  const { type, direction, min_len } = req.query;
  let where = `WHERE ts > ?`;
  const params = [Date.now() - days*24*3600*1000];
  if (type)      { where += ` AND type=?`;      params.push(type); }
  if (direction) { where += ` AND direction=?`; params.push(direction); }
  if (min_len)   { where += ` AND len >= ?`;    params.push(+min_len); }
  const daily  = db.db.prepare(`SELECT date_de, direction, type, COUNT(*) as cnt FROM passages ${where} GROUP BY date_de, direction, type ORDER BY date_de DESC`).all(...params);
  const byName = db.db.prepare(`SELECT name, type, direction, COUNT(*) as cnt FROM passages ${where} GROUP BY name, direction ORDER BY cnt DESC LIMIT 50`).all(...params);
  res.json({ daily, byName });
});

// ── SHIP TYPE via API ─────────────────────────────────────────────────────────
// Liefert den aus AIS-Typcode + Name abgeleiteten Typ – gleiche Logik wie aisConnector
app.get('/api/ship/:mmsi/type', authMiddleware, (req, res) => {
  const ship = db.getActiveShips().find(s => s.mmsi === req.params.mmsi);
  if (!ship) return res.status(404).json({ error: 'not found' });
  res.json({ mmsi: ship.mmsi, name: ship.name, type: ship.type });
});

// ── SHIP PHOTO PROXY (umgeht CORS & Referer-Check) ────────────────────────────
// ── WEATHER & TIDE PROXY ──────────────────────────────────────────────────────
// Open-Meteo: kostenlos, kein Key, HTTPS
let weatherCache = null, weatherCacheTs = 0;
// Cache beim Start leer, damit neue Stationsnamen sofort ausprobiert werden
app.get('/api/weather', authMiddleware, async (req, res) => {
  if (weatherCache && Date.now() - weatherCacheTs < 10 * 60 * 1000) {
    return res.json(weatherCache);
  }
  try {
    // Wedel: 53.5765° N, 9.6922° E
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=53.5765&longitude=9.6922' +
      '&current=temperature_2m,windspeed_10m,winddirection_10m,weathercode,apparent_temperature' +
      '&hourly=windspeed_10m,winddirection_10m,precipitation_probability' +
      '&forecast_days=1&timezone=Europe%2FBerlin';
    const data = await new Promise((resolve, reject) => {
      const r = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.3' } }, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      r.on('error', reject); r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
    });
    // Pegelonline WSV – Station Wedel an der Elbe
    // Stationsname: WEDEL (ELBE) – Pegelonline shortname ist case-sensitive URL-encoded
    let tide = null;
    const pegelStations = [
      'WEDEL%20(ELBE)',   // vollständiger Name
      'WEDEL',            // Kurzname als Fallback
      'SCHULAU',          // Backup: Schulau liegt ebenfalls bei Wedel
    ];
    for (const station of pegelStations) {
      try {
        const tideRaw = await new Promise((resolve, reject) => {
          const url = `https://www.pegelonline.wsv.de/webservices/rest/v2/stations/${station}/W/measurements.json?start=PT6H`;
          const tr = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.4' } }, resp => {
            let d = ''; resp.on('data', c => d += c);
            resp.on('end', () => {
              try {
                const parsed = JSON.parse(d);
                resolve(parsed);
              } catch(e) { resolve(null); }
            });
          });
          tr.on('error', () => resolve(null));
          tr.setTimeout(6000, () => { tr.destroy(); resolve(null); });
        });
        if (Array.isArray(tideRaw) && tideRaw.length > 0) {
          tide = tideRaw;
          console.log(`[Pegel] Station ${station}: ${tideRaw.length} Messpunkte, letzter Wert: ${tideRaw[tideRaw.length-1]?.value} cm`);
          break;
        } else {
          console.log(`[Pegel] Station ${station}: keine Daten (${JSON.stringify(tideRaw)?.slice(0,80)})`);
        }
      } catch(e) {
        console.log(`[Pegel] Station ${station}: Fehler: ${e.message}`);
      }
    }
    weatherCache = { weather: data, tide, fetchedAt: Date.now() };
    weatherCacheTs = Date.now();
    res.json(weatherCache);
  } catch(e) {
    console.error('[Weather] Fehler:', e.message);
    res.status(502).json({ error: 'Wetterdaten nicht verfügbar', detail: e.message });
  }
});

// ── PLAYBACK API ──────────────────────────────────────────────────────────────
// GET /api/playback?ts=<unix_ms> – Alle Schiffe zum Zeitpunkt ts (±5 Min Fenster)
app.get('/api/playback', authMiddleware, (req, res) => {
  const ts = +(req.query.ts);
  if (!ts || isNaN(ts)) return res.status(400).json({ error: 'ts required' });
  const window_ms = 5 * 60 * 1000;
  // Für jede MMSI den Eintrag mit dem kleinsten Abstand zu ts nehmen
  const rows = db.db.prepare(`
    SELECT h.*, ABS(h.ts - ?) as diff
    FROM history h
    INNER JOIN (
      SELECT mmsi, MIN(ABS(ts - ?)) as min_diff
      FROM history
      WHERE ts BETWEEN ? AND ?
      GROUP BY mmsi
    ) best ON h.mmsi = best.mmsi AND ABS(h.ts - ?) = best.min_diff
    WHERE h.ts BETWEEN ? AND ?
    ORDER BY h.mmsi
  `).all(ts, ts, ts - window_ms, ts + window_ms, ts, ts - window_ms, ts + window_ms);
  res.json({ ts, count: rows.length, ships: rows });
});

// GET /api/playback/range – Zeitbereich der verfügbaren History
app.get('/api/playback/range', authMiddleware, (req, res) => {
  const range = db.db.prepare(`SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(DISTINCT mmsi) as ships FROM history`).get();
  res.json(range);
});

// ── SHIP PHOTO: IMO via Wikimedia ─────────────────────────────────────────────
// Cache in DB: ships.photo_url Spalte (Migration)
try { db.db.exec(`ALTER TABLE ships ADD COLUMN photo_url TEXT DEFAULT NULL`); } catch(e) {}
try { db.db.exec(`ALTER TABLE ships ADD COLUMN imo TEXT DEFAULT NULL`); } catch(e) {}
try { db.db.exec(`ALTER TABLE ships ADD COLUMN photo_checked INTEGER DEFAULT 0`); } catch(e) {}
// Schlechte Einträge zurücksetzen damit beim nächsten Klick Wikipedia versucht wird
try { db.db.exec(`UPDATE ships SET photo_checked=0, photo_url=NULL WHERE photo_checked=1 AND photo_url IS NULL`); } catch(e) {}

// Hilfsfunktion: prüft ob URL ein Bild liefert (ohne zu streamen)
function probeImage(url_or_opts) {
  return new Promise(resolve => {
    const req2 = https.get(url_or_opts, imgRes => {
      const ct = imgRes.headers['content-type'] || '';
      imgRes.resume();
      if (imgRes.statusCode === 200 && ct.startsWith('image/')) resolve(true);
      else resolve(false);
    });
    req2.on('error', () => resolve(false));
    req2.setTimeout(5000, () => { req2.destroy(); resolve(false); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.3' } }, resp => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    r.on('error', reject); r.setTimeout(6000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}



function tryPhotoSources(mmsi, sources, res) {
  if (!sources.length) return res.status(404).end();
  const [src, ...rest] = sources;
  const req2 = https.get(src, imgRes => {
    // Redirect folgen
    if (imgRes.statusCode === 301 || imgRes.statusCode === 302) {
      imgRes.resume();
      const loc = imgRes.headers['location'];
      if (loc && rest.length === 0) {
        // Follow redirect once
        https.get(loc, r2 => {
          if (r2.statusCode !== 200) { r2.resume(); return tryPhotoSources(mmsi, rest, res); }
          res.setHeader('Content-Type', r2.headers['content-type'] || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          r2.pipe(res);
        }).on('error', () => tryPhotoSources(mmsi, rest, res));
      } else {
        tryPhotoSources(mmsi, rest, res);
      }
      return;
    }
    if (imgRes.statusCode !== 200) { imgRes.resume(); return tryPhotoSources(mmsi, rest, res); }
    // Prüfen ob Content-Type wirklich ein Bild ist (MarineTraffic liefert manchmal HTML 200)
    const ct = imgRes.headers['content-type'] || '';
    if (!ct.startsWith('image/')) { imgRes.resume(); return tryPhotoSources(mmsi, rest, res); }
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  });
  req2.on('error', () => tryPhotoSources(mmsi, rest, res));
  req2.setTimeout(5000, () => { req2.destroy(); tryPhotoSources(mmsi, rest, res); });
}

// Hilfsfunktion: HTTPS-JSON abrufen
function fetchJsonHTTPS(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.4 (contact: admin)' } }, resp => {
      // Redirects folgen
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        resp.resume();
        return resolve(fetchJsonHTTPS(resp.headers.location));
      }
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    r.on('error', reject); r.setTimeout(7000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}

app.get('/api/ship/:mmsi/photo', (req, res) => {
  const mmsi = req.params.mmsi.replace(/\D/g, '');
  if (!mmsi) return res.status(400).end();
  const ua = 'Mozilla/5.0 (compatible; ElbeRadar/0.4)';

  // Harter Timeout: Photo-Anfrage darf max 4s dauern
  // Verhindert dass Browser-Verbindungspool durch langsame externe APIs blockiert wird
  let responded = false;
  const photoTimeout = setTimeout(() => {
    if (!responded && !res.headersSent) {
      responded = true;
      res.status(504).end();
    }
  }, 4000);
  const origEnd = res.end.bind(res);
  res.end = (...args) => { responded = true; clearTimeout(photoTimeout); return origEnd(...args); };

  // 1. Gecachte URL aus DB
  try {
    const row = db.db.prepare('SELECT photo_url, photo_checked, name FROM ships WHERE mmsi=?').get(mmsi);
    if (row && row.photo_checked && row.photo_url) return res.redirect(302, row.photo_url);
    if (row && row.photo_checked && !row.photo_url) return res.status(404).end();
  } catch(e) { /* DB nicht bereit */ }

  // Wrapper: nach tryPhotoSources 404 → Wikipedia/Commons asynchron
  const patchedRes = {
    get headersSent() { return res.headersSent; },
    setHeader: (k, v) => { if (!res.headersSent) res.setHeader(k, v); },
    status: (c) => ({
      end: () => {
        if (!res.headersSent) {
          // MarineTraffic hat nichts → Wikipedia/Commons versuchen
          fetchWikipediaPhoto(mmsi).then(url => {
            if (url) {
              try { db.db.prepare('UPDATE ships SET photo_checked=1, photo_url=? WHERE mmsi=?').run(url, mmsi); } catch(e){}
              if (!res.headersSent) res.redirect(302, url);
            } else {
              try { db.db.prepare('UPDATE ships SET photo_checked=1, photo_url=NULL WHERE mmsi=?').run(mmsi); } catch(e){}
              if (!res.headersSent) res.status(404).end();
            }
          }).catch(() => { if (!res.headersSent) res.status(404).end(); });
        }
      }
    }),
    pipe: (src) => {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      src.pipe(res);
      // Cache: kein URL aber erfolgreich gestreamt – mark checked without url
      setTimeout(() => { try { db.db.prepare('UPDATE ships SET photo_checked=1 WHERE mmsi=? AND photo_url IS NULL').run(mmsi); } catch(e){} }, 500);
    },
  };

  tryPhotoSources(mmsi, [
    { hostname: 'photos.marinetraffic.com', path: `/ais/showphoto.aspx?mmsi=${mmsi}&size=thumb800`, headers: { 'Referer': 'https://www.marinetraffic.com/', 'User-Agent': ua } },
    { hostname: 'photos.marinetraffic.com', path: `/ais/showphoto.aspx?mmsi=${mmsi}`,               headers: { 'Referer': 'https://www.marinetraffic.com/', 'User-Agent': ua } },
    { hostname: 'photos.vesseltracker.com', path: `/photos/vessels/thumb_${mmsi}.jpg`,              headers: { 'Referer': 'https://www.vesseltracker.com/', 'User-Agent': ua } },
  ], patchedRes);
});

async function fetchWikipediaPhoto(mmsi) {
  try {
    const row = db.db.prepare('SELECT name FROM ships WHERE mmsi=?').get(mmsi);
    if (!row || !row.name) return null;
    const nameClean = row.name.trim();

    // Versuch 1: Wikipedia REST API (beste Qualität, direkt Thumbnail)
    const slug = encodeURIComponent(nameClean.replace(/\s+/g, '_'));
    try {
      const wiki = await fetchJsonHTTPS(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
      const thumb = wiki?.thumbnail?.source || wiki?.originalimage?.source;
      if (thumb) return thumb.replace(/\/\d+px-/, '/600px-');
    } catch(e) { /* Kein Wikipedia-Artikel */ }

    // Versuch 2: Wikimedia Commons Dateisuche
    const q = encodeURIComponent(nameClean + ' ship');
    const commons = await fetchJsonHTTPS(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${q}&srnamespace=6&srlimit=5&format=json`
    );
    const hits = (commons?.query?.search || []).filter(r => /\.(jpg|jpeg|png)/i.test(r.title));
    if (hits.length > 0) {
      const title = hits[0].title.replace(/^File:/, '');
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}?width=600`;
    }
    return null;
  } catch(e) { return null; }
}

// ── AIS STATUS ────────────────────────────────────────────────────────────────
app.get('/api/ships',            authMiddleware, (req,res) => res.json(db.getActiveShips()));
app.get('/api/history',          authMiddleware, (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/ship/:mmsi/track', authMiddleware, (req,res) => res.json(db.getTrack(req.params.mmsi, +(req.query.hours||24))));
app.get('/api/status', authMiddleware, (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'0.4.2',
  retainDays: +(process.env.RETAIN_DAYS||7),
  buildSha: BUILD_SHA, buildTime: BUILD_TIME,
}));
app.get('/api/version', (req,res) => res.json({ sha: BUILD_SHA, time: BUILD_TIME, version:'0.4.2' }));

// Globale Settings (tile, refpoint) – per User via /api/user/settings
app.get('/api/settings/:key',  authMiddleware, (req,res) => res.json({ value: db.getUserSetting(req.userId, req.params.key) }));
app.post('/api/settings/:key', authMiddleware, (req,res) => {
  db.setUserSetting(req.userId, req.params.key, req.body.value||'');
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname,'..','public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      // SW muss immer frisch geladen werden
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.endsWith('.png') || filePath.endsWith('.ico')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'..','public','index.html')));

server.listen(PORT, () => {
  console.log(`[Server] Elbe Radar v0.4.2 · Port ${PORT}`);
  console.log(`[Server] AIS-Key:    ${process.env.AIS_API_KEY       ? 'gesetzt'           : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Reg-Code:   ${REG_CODE                      ? 'gesetzt'           : 'offen (jeder kann sich registrieren)'}`);
  console.log(`[Server] History:    ${process.env.RETAIN_DAYS||7} Tage · Intervall 5 min`);
  console.log(`[Server] Build:      ${BUILD_SHA} @ ${BUILD_TIME}`);
});

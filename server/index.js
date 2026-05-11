'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const https        = require('https');
const WebSocket    = require('ws');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
const AISConnector = require('./aisConnector');
const db           = require('./db');
const { sendTestMessage, invalidateUserCache } = require('./telegramBot');

const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || '';
const REG_CODE   = process.env.REGISTRATION_CODE || '';
const SESSION_TTL= 30 * 24 * 3600 * 1000; // 30 Tage
const APP_URL    = process.env.APP_URL    || `http://localhost:${PORT}`;

// ── Mailer ────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'localhost',
  port:   +(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS || '',
  } : undefined,
});
async function sendMail(to, subject, html) {
  if (!process.env.SMTP_HOST) {
    console.log(`[Mail] SMTP nicht konfiguriert – würde senden an ${to}: ${subject}`);
    return false;
  }
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@elberadar',
      to, subject, html,
    });
    console.log(`[Mail] Gesendet an ${to}: ${subject}`);
    return true;
  } catch(e) {
    console.error(`[Mail] Fehler: ${e.message}`);
    return false;
  }
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(express.json());

const BUILD_SHA  = process.env.BUILD_SHA  || 'dev';
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();

// ── Log-Buffer (letzten 500 Einträge) ────────────────────────────────────────
const LOG_BUFFER = [];
const MAX_LOGS   = 500;
function logPush(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  LOG_BUFFER.push({ ts: Date.now(), level, msg });
  if (LOG_BUFFER.length > MAX_LOGS) LOG_BUFFER.shift();
  process.stdout.write(`[${level.toUpperCase()}] ${msg}\n`);
}
console.log   = (...a) => logPush('info',  ...a);
console.error = (...a) => logPush('error', ...a);
console.warn  = (...a) => logPush('warn',  ...a);

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
function adminMiddleware(req, res, next) {
  const token   = getTokenFromReq(req);
  const session = token ? db.getSession(token) : null;
  if (!session) return res.status(401).json({ error: 'Nicht angemeldet' });
  const user = db.getUserById(session.user_id);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  req.userId = session.user_id;
  next();
}
// Optionaler Auth: setzt req.userId wenn Token gültig, sonst null (kein Fehler)
function optionalAuth(req, res, next) {
  const token   = getTokenFromReq(req);
  const session = token ? db.getSession(token) : null;
  req.userId    = session ? session.user_id : null;
  req.isAnon    = !session;
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
  // WebSocket-Authentifizierung via Query-Parameter; anonym erlaubt (eingeschränkt)
  const url     = new URL(req.url, 'http://localhost');
  const token   = url.searchParams.get('token') || '';
  const session = token ? db.getSession(token) : null;
  ws.userId = session ? session.user_id : null;
  ws.isAnon = !session;
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
  const { username, password, invite_code, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  if (username.length < 3)    return res.status(400).json({ error: 'Benutzername mindestens 3 Zeichen' });
  if (password.length < 6)    return res.status(400).json({ error: 'Passwort mindestens 6 Zeichen' });
  const userCount = db.countUsers();
  if (userCount > 0 && REG_CODE && invite_code !== REG_CODE) {
    return res.status(403).json({ error: 'Ungültiger Einladungscode' });
  }
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Benutzername bereits vergeben' });
  if (email && db.getUserByEmail(email)) return res.status(409).json({ error: 'E-Mail-Adresse bereits vergeben' });
  try {
    db.createUser(username, password, userCount === 0 ? 1 : 0);
    const user  = db.getUserByUsername(username);
    if (email) db.setUserEmail(user.id, email.trim().toLowerCase());
    const token = db.generateToken();
    db.createSession(user.id, token, Date.now() + SESSION_TTL);
    res.json({ token, username: user.username, isAdmin: user.is_admin===1 });
  } catch(e) {
    res.status(500).json({ error: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich' });
  const user = db.getUserByEmail(email.trim().toLowerCase());
  // Immer OK zurückgeben (verhindert User-Enumeration)
  if (!user) return res.json({ ok: true });
  const token = db.createResetToken(user.id);
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  const html = `
    <p>Hallo ${user.username},</p>
    <p>du hast eine Passwortrücksetzung für dein Elbe Radar Konto angefordert.</p>
    <p><a href="${resetUrl}" style="background:#1568c8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Passwort zurücksetzen</a></p>
    <p>Dieser Link ist 1 Stunde gültig.</p>
    <p>Falls du diese Anfrage nicht gestellt hast, ignoriere diese E-Mail.</p>
    <p style="color:#888;font-size:12px">Elbe Radar – ${APP_URL}</p>
  `;
  const sent = await sendMail(user.email, 'Elbe Radar – Passwort zurücksetzen', html);
  if (!sent && !process.env.SMTP_HOST) {
    // Dev-Modus: Token im Log, Link in Response
    console.log(`[PwReset] Token für ${user.username}: ${token}`);
    console.log(`[PwReset] Link: ${resetUrl}`);
    return res.json({ ok: true, devResetUrl: resetUrl }); // nur ohne SMTP konfiguration
  }
  res.json({ ok: true });
});

app.get('/api/auth/reset-password/:token', (req, res) => {
  const entry = db.getResetToken(req.params.token);
  if (!entry) return res.status(400).json({ error: 'Ungültiger oder abgelaufener Link' });
  const user = db.getUserById(entry.user_id);
  res.json({ valid: true, username: user?.username });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token und Passwort erforderlich' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwort mindestens 6 Zeichen' });
  const entry = db.getResetToken(token);
  if (!entry) return res.status(400).json({ error: 'Ungültiger oder abgelaufener Link' });
  db.resetPassword(entry.user_id, password);
  db.markResetTokenUsed(token);
  // Alle Sessions des Users löschen (Sicherheit)
  db.deleteUserSessions(entry.user_id);
  res.json({ ok: true });
});

// Email per User selbst ändern
app.post('/api/user/email', authMiddleware, (req, res) => {
  const { email } = req.body;
  if (email && db.getUserByEmail(email.trim().toLowerCase())?.id !== req.userId) {
    return res.status(409).json({ error: 'E-Mail bereits vergeben' });
  }
  db.setUserEmail(req.userId, email ? email.trim().toLowerCase() : null);
  res.json({ ok: true });
});
app.get('/api/user/email', authMiddleware, (req, res) => {
  const user = db.getUserById(req.userId);
  res.json({ email: user?.email || '' });
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
app.get('/api/weather', async (req, res) => {
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
    // Pegelonline WSV – Pegel Schulau (bei Wedel/Willkomm-Höft)
    // Korrekte API-Basis: rest-api/v2 (nicht rest/v2)
    let tide = null;
    let tideForecast = null;
    try {
      const tideRaw = await new Promise((resolve) => {
        const url = `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/SCHULAU/W/measurements.json?start=PT12H`;
        const tr = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.4' } }, resp => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => {
            console.log(`[Pegel] HTTP ${resp.statusCode}, Body-Anfang: ${d.slice(0,120)}`);
            try { resolve(JSON.parse(d)); } catch(e) {
              console.log(`[Pegel] JSON-Parse-Fehler: ${e.message}`);
              resolve(null);
            }
          });
        });
        tr.on('error', (e) => { console.log(`[Pegel] Netzwerkfehler: ${e.message}`); resolve(null); });
        tr.setTimeout(6000, () => { tr.destroy(); console.log('[Pegel] Timeout'); resolve(null); });
      });
      if (Array.isArray(tideRaw) && tideRaw.length > 0) {
        tide = tideRaw;
        console.log(`[Pegel] OK – ${tideRaw.length} Messpunkte, letzter Wert: ${tideRaw[tideRaw.length-1]?.value} cm`);
      } else {
        console.log(`[Pegel] Keine Daten – tideRaw: ${JSON.stringify(tideRaw)?.slice(0,120)}`);
      }

      // Gezeitenvorhersage (TRM) – nächste 6h, falls verfügbar
      try {
        const trmRaw = await new Promise((resolve) => {
          const u2 = `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/SCHULAU/TRM/measurements.json?start=P0D&end=PT6H`;
          const tr2 = https.get(u2, { headers: { 'User-Agent': 'ElbeRadar/0.5' } }, resp => {
            let d = ''; resp.on('data', c => d += c);
            resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
          });
          tr2.on('error', () => resolve(null));
          tr2.setTimeout(5000, () => { tr2.destroy(); resolve(null); });
        });
        if (Array.isArray(trmRaw) && trmRaw.length > 0) {
          tideForecast = trmRaw;
          console.log(`[Pegel] TRM Vorhersage: ${trmRaw.length} Punkte`);
        }
      } catch(e) { /* kein TRM für diese Station */ }
    } catch(e) {
      console.log(`[Pegel] Fehler: ${e.message}`);
    }
    weatherCache = { weather: data, tide, tideForecast, fetchedAt: Date.now() };
    weatherCacheTs = Date.now();
    res.json(weatherCache);
  } catch(e) {
    console.error('[Weather] Fehler:', e.message);
    res.status(502).json({ error: 'Wetterdaten nicht verfügbar', detail: e.message });
  }
});

// ── PEGEL DEBUG (kein Auth – nur zum Testen, danach entfernen) ────────────────
app.get('/api/pegel-debug', async (req, res) => {
  const url = `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/SCHULAU/W/measurements.json?start=PT12H`;
  try {
    const result = await new Promise((resolve) => {
      const tr = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.4' } }, resp => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => {
          let parsed = null; let parseErr = null;
          try { parsed = JSON.parse(d); } catch(e) { parseErr = e.message; }
          resolve({ status: resp.statusCode, rawSnippet: d.slice(0, 300), parsed, parseErr });
        });
      });
      tr.on('error', (e) => resolve({ networkError: e.message }));
      tr.setTimeout(8000, () => { tr.destroy(); resolve({ timeout: true }); });
    });
    res.json({ url, ...result, isArray: Array.isArray(result.parsed), length: Array.isArray(result.parsed) ? result.parsed.length : null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOG VIEWER ────────────────────────────────────────────────────────────────
app.get('/api/logs', adminMiddleware, (req, res) => {
  const since = +(req.query.since || 0);
  const logs  = since ? LOG_BUFFER.filter(l => l.ts > since) : LOG_BUFFER.slice(-200);
  res.json({ logs, total: LOG_BUFFER.length });
});

// ── ADMIN – BENUTZERVERWALTUNG ────────────────────────────────────────────────
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json(db.getAllUsers());
});
app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  const id = +req.params.id;
  if (id === req.userId) return res.status(400).json({ error: 'Eigenen Account nicht löschbar' });
  db.deleteUserSessions(id);
  db.deleteUser(id);
  res.json({ ok: true });
});
app.patch('/api/admin/users/:id/role', adminMiddleware, (req, res) => {
  const id = +req.params.id;
  if (id === req.userId) return res.status(400).json({ error: 'Eigene Rolle nicht änderbar' });
  db.setUserAdmin(id, req.body.is_admin ? 1 : 0);
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/reset-password', adminMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Mindestens 6 Zeichen' });
  db.resetUserPassword(+req.params.id, password);
  res.json({ ok: true });
});
app.post('/api/admin/users', adminMiddleware, (req, res) => {
  const { username, password, is_admin } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username + password erforderlich' });
  if (username.length < 3)   return res.status(400).json({ error: 'Username mind. 3 Zeichen' });
  if (password.length < 6)   return res.status(400).json({ error: 'Passwort mind. 6 Zeichen' });
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Username bereits vergeben' });
  db.createUser(username, password, is_admin ? 1 : 0);
  const user = db.getUserByUsername(username);
  res.json({ id: user.id, username: user.username, is_admin: user.is_admin });
});

// ── DB-STATS ──────────────────────────────────────────────────────────────────
app.get('/api/admin/db-stats', adminMiddleware, (req, res) => {
  const dbPath = path.join(process.env.DATA_DIR || '/app/data', 'elbe-radar.db');
  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(dbPath).size; } catch(e) {}
  const stats = db.getDbStats();
  res.json({ dbSizeBytes, ...stats });
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

// ── SHIP PHOTO PROXY ─────────────────────────────────────────────────────────
// Gibt sofort ein Bild zurück oder 404. Kein Blockieren, kein race condition.
app.get('/api/ship/:mmsi/photo', (req, res) => {
  const mmsi = req.params.mmsi.replace(/\D/g, '');
  if (!mmsi) return res.status(400).end();

  // 1. Gecachten Eintrag prüfen
  try {
    const row = db.db.prepare('SELECT photo_url, photo_checked FROM ships WHERE mmsi=?').get(mmsi);
    if (row && row.photo_checked && row.photo_url)  return res.redirect(302, row.photo_url);
    if (row && row.photo_checked && !row.photo_url) return res.status(404).end();
  } catch(e) { /* DB nicht bereit */ }

  // 2. MarineTraffic → VesselTracker → Wikipedia (async, in Hintergrund)
  //    Sofort mit 404 antworten wenn nichts gecacht → nächster Klick liefert Bild
  const ua = 'Mozilla/5.0 (compatible; ElbeRadar/0.4)';
  res.status(404).end(); // sofort antworten

  // Bild im Hintergrund suchen und cachen (für nächsten Klick)
  (async () => {
    const sources = [
      { hostname:'photos.marinetraffic.com', path:`/ais/showphoto.aspx?mmsi=${mmsi}&size=thumb800`, headers:{'Referer':'https://www.marinetraffic.com/','User-Agent':ua} },
      { hostname:'photos.marinetraffic.com', path:`/ais/showphoto.aspx?mmsi=${mmsi}`,               headers:{'Referer':'https://www.marinetraffic.com/','User-Agent':ua} },
      { hostname:'photos.vesseltracker.com', path:`/photos/vessels/thumb_${mmsi}.jpg`,              headers:{'Referer':'https://www.vesseltracker.com/','User-Agent':ua} },
    ];

    for (const src of sources) {
      const url = await probeAndGetImageUrl(src);
      if (url) {
        try { db.db.prepare('UPDATE ships SET photo_checked=1, photo_url=? WHERE mmsi=?').run(url, mmsi); } catch(e){}
        return;
      }
    }

    // Wikipedia REST API
    const url = await fetchWikipediaPhotoUrl(mmsi);
    try { db.db.prepare('UPDATE ships SET photo_checked=1, photo_url=? WHERE mmsi=?').run(url||null, mmsi); } catch(e){}
  })().catch(() => {
    try { db.db.prepare('UPDATE ships SET photo_checked=1, photo_url=NULL WHERE mmsi=?').run(mmsi); } catch(e){}
  });
});

// Gibt die endgültige Bild-URL zurück (folgt Redirects, prüft Content-Type)
function probeAndGetImageUrl(opts) {
  return new Promise(resolve => {
    const req = https.get(opts, resp => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        resp.resume();
        const loc = resp.headers.location;
        return resolve(loc ? probeAndGetImageUrl(loc) : null);
      }
      const ct = resp.headers['content-type'] || '';
      resp.resume();
      if (resp.statusCode === 200 && ct.startsWith('image/')) {
        // Bild-URL aus den Request-Optionen rekonstruieren
        const url = typeof opts === 'string' ? opts : `https://${opts.hostname}${opts.path}`;
        resolve(url);
      } else {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchWikipediaPhotoUrl(mmsi) {
  try {
    const row = db.db.prepare('SELECT name FROM ships WHERE mmsi=?').get(mmsi);
    if (!row || !row.name) return null;
    const slug = encodeURIComponent(row.name.trim().replace(/\s+/g, '_'));
    const wiki = await fetchJsonHTTPS(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
    const thumb = wiki?.thumbnail?.source || wiki?.originalimage?.source;
    if (thumb) return thumb.replace(/\/\d+px-/, '/600px-');
    // Commons fallback
    const q = encodeURIComponent(row.name.trim() + ' ship');
    const commons = await fetchJsonHTTPS(`https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${q}&srnamespace=6&srlimit=3&format=json`);
    const hits = (commons?.query?.search || []).filter(r => /\.(jpg|jpeg|png)/i.test(r.title));
    if (hits.length > 0) {
      const title = hits[0].title.replace(/^File:/, '');
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}?width=600`;
    }
    return null;
  } catch(e) { return null; }
}

function fetchJsonHTTPS(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.4' } }, resp => {
      if (resp.statusCode === 301 || resp.statusCode === 302) {
        resp.resume();
        return resolve(fetchJsonHTTPS(resp.headers.location));
      }
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    r.on('error', reject); r.setTimeout(6000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}


// ── AIS STATUS ────────────────────────────────────────────────────────────────
app.get('/api/ships',            authMiddleware, (req,res) => res.json(db.getActiveShips()));
app.get('/api/history',          authMiddleware, (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/ship/:mmsi/track', authMiddleware, (req,res) => res.json(db.getTrack(req.params.mmsi, +(req.query.hours||24))));
app.get('/api/status', authMiddleware, (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'0.5.5',
  retainDays: +(process.env.RETAIN_DAYS||7),
  buildSha: BUILD_SHA, buildTime: BUILD_TIME,
}));
app.get('/api/version', (req,res) => res.json({ sha: BUILD_SHA, time: BUILD_TIME, version:'0.5.5' }));

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
  console.log(`[Server] Elbe Radar v0.5.2 · Port ${PORT}`);
  console.log(`[Server] AIS-Key:    ${process.env.AIS_API_KEY       ? 'gesetzt'           : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Reg-Code:   ${REG_CODE                      ? 'gesetzt'           : 'offen (jeder kann sich registrieren)'}`);
  console.log(`[Server] History:    ${process.env.RETAIN_DAYS||7} Tage · Intervall 5 min`);
  console.log(`[Server] Build:      ${BUILD_SHA} @ ${BUILD_TIME}`);
});

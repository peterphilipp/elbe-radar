'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const https        = require('https');
const WebSocket    = require('ws');
const path         = require('path');
const fs           = require('fs');
const nodemailer   = require('nodemailer');
let webpush = null;
try { webpush = require('web-push'); } catch(e) { console.log('[Push] web-push nicht installiert'); }
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

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
let VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY  || '';
let VAPID_PRIV   = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJ = process.env.VAPID_SUBJECT     || 'mailto:admin@elberadar.local';
if (webpush) {
  if (!VAPID_PUBLIC || !VAPID_PRIV) {
    const k = webpush.generateVAPIDKeys();
    VAPID_PUBLIC = k.publicKey; VAPID_PRIV = k.privateKey;
    console.log('[Push] Neue VAPID-Keys generiert (nur diesen Run gültig!).');
    console.log('[Push] Für Persistenz in .env setzen:');
    console.log(`  VAPID_PUBLIC_KEY=${VAPID_PUBLIC}`);
    console.log(`  VAPID_PRIVATE_KEY=${VAPID_PRIV}`);
  }
  try {
    webpush.setVapidDetails(VAPID_SUBJ, VAPID_PUBLIC, VAPID_PRIV);
    console.log('[Push] VAPID konfiguriert');
  } catch(e) { console.error('[Push] VAPID-Fehler:', e.message); webpush = null; }
}

async function sendPushToUser(userId, payload) {
  if (!webpush) return 0;
  const subs = db.getUserPushSubscriptions(userId);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.removePushSubscription(s.endpoint);
      }
    }
  }
  return sent;
}

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
const SHIP_TTL_MS    = 60 * 60 * 1000; // 60 Minuten – Schiffe im Hafen senden seltener
const BROADCAST_RATE = 3 * 1000;       // max alle 3s broadcasten

let lastBroadcast = 0, broadcastPending = null;
function broadcast(ships) {
  const now = Date.now();
  if (now - lastBroadcast < BROADCAST_RATE) {
    if (broadcastPending) return;
    broadcastPending = setTimeout(() => {
      broadcastPending = null;
      broadcast(ships);
    }, BROADCAST_RATE - (now - lastBroadcast));
    return;
  }
  lastBroadcast = now;
  const cutoff = now - SHIP_TTL_MS;
  const active = [...ships.values()].filter(s => (s.seen || 0) >= cutoff);
  const payload = JSON.stringify({ type:'ships', data: active, ts: now });
  for (const c of wss.clients) if (c.readyState===WebSocket.OPEN) c.send(payload);
}

const ais = new AISConnector(ships => broadcast(ships));
ais.start();

// Alte Schiffe aus In-Memory-Map entfernen und Clients informieren
setInterval(() => {
  const cutoff = Date.now() - SHIP_TTL_MS;
  let removed = 0;
  for (const [mmsi, s] of ais.ships) {
    if ((s.seen || 0) < cutoff) { ais.ships.delete(mmsi); removed++; }
  }
  if (removed > 0) {
    console.log(`[AIS] ${removed} abgelaufene Schiffe (>30 Min) entfernt`);
    broadcast(ais.ships);
  }
}, 5 * 60 * 1000);

wss.on('connection', (ws, req) => {
  // WebSocket-Authentifizierung via Query-Parameter; anonym erlaubt (eingeschränkt)
  const url     = new URL(req.url, 'http://localhost');
  const token   = url.searchParams.get('token') || '';
  const session = token ? db.getSession(token) : null;
  ws.userId = session ? session.user_id : null;
  ws.isAnon = !session;
  const cutoff = Date.now() - SHIP_TTL_MS;
  const active = [...ais.ships.values()].filter(s => (s.seen || 0) >= cutoff);
  ws.send(JSON.stringify({ type:'ships', data: active, ts: Date.now() }));
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
  if (email) {
    const existing = db.getUserByEmail(email.trim().toLowerCase());
    // Nur ablehnen wenn die Email einem ANDEREN User gehört
    if (existing && existing.id !== req.userId) {
      return res.status(409).json({ error: 'E-Mail bereits vergeben' });
    }
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
// ── Synthetische Gezeitenvorhersage (Fallback wenn kein TRM verfügbar) ────────
function extrapolateTide(measurements, horizonSec = 10 * 3600) {
  if (!measurements || measurements.length < 60) return [];
  const pts = measurements.map(m => ({
    t: new Date(m.timestamp).getTime(), v: m.value,
  })).sort((a, b) => a.t - b.t);

  // M2-Hauptmondtide für Nordsee/Elbe – wissenschaftlicher Wert
  const M2_PERIOD_MS = 12.4206 * 3600 * 1000; // 12h 25min 14s
  const M2_HALF_MS   = M2_PERIOD_MS / 2;

  // Glättung mit 11-Punkte-Fenster (bei 1-min Daten = 11min)
  const smoothed = pts.map((p, i) => {
    const W = 11, s = Math.max(0, i - W), e = Math.min(pts.length - 1, i + W);
    const slice = pts.slice(s, e + 1);
    return { t: p.t, v: slice.reduce((a, x) => a + x.v, 0) / slice.length };
  });

  // Extrema mit großem Fenster ±90 Punkte (=1.5h bei 1min)
  // Mindestabstand zwischen Extrema: 4h (Halbperiode minus Toleranz)
  const WIN = 90;
  const MIN_GAP_MS = 4 * 3600 * 1000;
  const extrema = [];
  let lastT = -MIN_GAP_MS;
  for (let i = WIN; i < smoothed.length - WIN; i++) {
    if (smoothed[i].t - lastT < MIN_GAP_MS) continue;
    const win = smoothed.slice(i - WIN, i + WIN + 1).map(p => p.v);
    const v = smoothed[i].v;
    const isHW = v === Math.max(...win);
    const isNW = v === Math.min(...win);
    if (!isHW && !isNW) continue;
    if (extrema.length > 0 && extrema[extrema.length - 1].isHW === isHW) continue;
    // Exakteren Zeitpunkt im Original suchen (Mittelpunkt mehrerer gleich-extremer)
    const winStart = Math.max(0, i - WIN), winEnd = Math.min(pts.length - 1, i + WIN);
    let bestIdx = i, bestV = pts[i].v;
    for (let j = winStart; j <= winEnd; j++) {
      if (isHW && pts[j].v > bestV)  { bestV = pts[j].v; bestIdx = j; }
      if (isNW && pts[j].v < bestV || bestV === pts[i].v && pts[j].v < bestV) {
        if (isNW) { bestV = pts[j].v; bestIdx = j; }
      }
    }
    extrema.push({ t: pts[bestIdx].t, v: pts[bestIdx].v, isHW });
    lastT = smoothed[i].t;
  }

  // Periode aus erkannten Extrema, sonst M2-Fallback
  let periodMs = M2_PERIOD_MS;
  if (extrema.length >= 2) {
    const halfPeriods = [];
    for (let i = 1; i < extrema.length; i++) halfPeriods.push(extrema[i].t - extrema[i-1].t);
    const avgHalf = halfPeriods.reduce((a,b)=>a+b,0) / halfPeriods.length;
    // Plausibilität: 5h ≤ Halbperiode ≤ 7h (Elbe ≈ 6h 12min)
    if (avgHalf > 5*3600*1000 && avgHalf < 7*3600*1000) periodMs = avgHalf * 2;
  }

  // Bei 0 Extrema: globales Max/Min als Phase-Referenz
  if (extrema.length === 0) {
    const maxV = Math.max(...pts.map(p=>p.v));
    const minV = Math.min(...pts.map(p=>p.v));
    const maxPt = pts.reduce((a,b) => b.v > a.v ? b : a);
    const minPt = pts.reduce((a,b) => b.v < a.v ? b : a);
    // Nehme das jüngere Extremum als Referenz
    const ref = maxPt.t > minPt.t
      ? { t: maxPt.t, v: maxV, isHW: true }
      : { t: minPt.t, v: minV, isHW: false };
    extrema.push(ref);
    console.log(`[Tide] Kein Extremum, Fallback: ${ref.isHW?'HW':'NW'} ${new Date(ref.t).toLocaleTimeString('de-DE')}`);
  }

  // Amplitude aus den letzten 12h
  const last12h = pts.filter(p => p.t >= pts[pts.length-1].t - 12*3600*1000);
  const hw = Math.max(...last12h.map(p=>p.v));
  const nw = Math.min(...last12h.map(p=>p.v));
  const amp = (hw - nw) / 2;
  const mid = (hw + nw) / 2;

  // Wichtigste Stelle: Phase aus dem JÜNGSTEN Extremum
  const lastEx = extrema[extrema.length - 1];
  const phaseOffset = lastEx.isHW ? 0 : Math.PI;
  const nowTs = pts[pts.length - 1].t;

  // Extrapolation alle 10min
  const result = [];
  for (let dt = 10*60*1000; dt <= horizonSec*1000; dt += 10*60*1000) {
    const t   = nowTs + dt;
    const phi = ((t - lastEx.t) / periodMs) * 2 * Math.PI + phaseOffset;
    result.push({
      timestamp: new Date(t).toISOString(),
      value:     Math.round((mid + amp * Math.cos(phi)) * 10) / 10,
      synthetic: true,
    });
  }
  console.log(`[Tide] ${extrema.length} Extrema, Periode ${(periodMs/3600000).toFixed(2)}h, Phase=${lastEx.isHW?'HW':'NW'}@${new Date(lastEx.t).toLocaleTimeString('de-DE')}, Amp±${Math.round(amp)}cm, Mitte=${Math.round(mid)}cm`);
  return result;
}

// Open-Meteo: kostenlos, kein Key, HTTPS
let weatherCache = null, weatherCacheTs = 0;
// Cache beim Start leer, damit neue Stationsnamen sofort ausprobiert werden
app.get('/api/weather', async (req, res) => {
  if (weatherCache && Date.now() - weatherCacheTs < 10 * 60 * 1000 && !req.query.force) {
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

      // Fallback: Wenn kein TRM, synthetische Gezeitenvorhersage aus Messkurve extrapolieren
      // Findet letzte HW/NW in den Messdaten und extrapoliert Sinusoidalverlauf
      if (!tideForecast && tide && tide.length > 60) {
        try {
          tideForecast = extrapolateTide(tide, 9 * 3600); // 9h voraus
          if (tideForecast.length > 0)
            console.log(`[Pegel] Synthetischer Forecast: ${tideForecast.length} Punkte`);
        } catch(e) { console.log(`[Pegel] Extrapolation fehlgeschlagen: ${e.message}`); }
      }
    } catch(e) {
      console.log(`[Pegel] Fehler: ${e.message}`);
    }
    // Strömungsabschätzung aus Pegeländerung (steigend = Flut = landeinwärts)
    let current = null;
    if (tide && tide.length > 10) {
      const last = tide[tide.length - 1];
      const prev10 = tide[tide.length - 11]; // ~10 min zurück
      const dt_min = (new Date(last.timestamp).getTime() - new Date(prev10.timestamp).getTime()) / 60000;
      const dv     = last.value - prev10.value; // cm
      const rateCmPerH = dt_min > 0 ? (dv / dt_min) * 60 : 0;
      // Heuristik für Elbe: ~25 cm/h Pegeländerung ≈ 1.5 kn Stromgeschwindigkeit
      // Stromkenterung etwa bei Wendepunkt → bei sehr kleinem dv ist Strömung minimal
      const knots = Math.min(3.5, Math.abs(rateCmPerH) / 25 * 1.5);
      current = {
        rate_cm_h: Math.round(rateCmPerH),
        knots:     +knots.toFixed(1),
        direction: rateCmPerH > 1 ? 'flut' : rateCmPerH < -1 ? 'ebbe' : 'stau',
      };
    }
    weatherCache = { weather: data, tide, tideForecast, current, fetchedAt: Date.now() };
    weatherCacheTs = Date.now();
    res.json(weatherCache);
  } catch(e) {
    console.error('[Weather] Fehler:', e.message);
    res.status(502).json({ error: 'Wetterdaten nicht verfügbar', detail: e.message });
  }
});

// ── TIDE FORECAST (mehrtägige HW/NW-Vorhersage) ───────────────────────────────
app.get('/api/tide-forecast', async (req, res) => {
  try {
    // Pegelonline bietet für SCHULAU eine WV-Zeitreihe (Wasserstandsvorhersage)
    // mit echten Vorhersagedaten der WSV/BfG.
    const fetchUrl = (url, timeoutMs = 6000) => new Promise(resolve => {
      const tr = https.get(url, { headers: { 'User-Agent': 'ElbeRadar/0.7' } }, resp => {
        let d = ''; resp.on('data', c => d += c);
        resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
      });
      tr.on('error', () => resolve(null));
      tr.setTimeout(timeoutMs, () => { tr.destroy(); resolve(null); });
    });

    // 1) Echte Vorhersage (WV) versuchen - 72h ab jetzt
    let extremes = [];
    let source = 'extrapolation';
    const wvUrl = `https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/SCHULAU/WV/measurements.json?start=P0D&end=P3D`;
    const wvRaw = await fetchUrl(wvUrl);

    let forecastSeries = null;
    if (Array.isArray(wvRaw) && wvRaw.length > 20) {
      forecastSeries = wvRaw;
      source = 'pegelonline-wv';
      console.log(`[Tide] Echte WV-Vorhersage: ${wvRaw.length} Punkte`);
    } else {
      // 2) Fallback: Messdaten + extrapolieren
      const wRaw = await fetchUrl(`https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/SCHULAU/W/measurements.json?start=PT24H`);
      if (Array.isArray(wRaw) && wRaw.length >= 60) {
        forecastSeries = extrapolateTide(wRaw, 72 * 3600);
        source = 'extrapolation';
        console.log(`[Tide] Extrapoliert aus ${wRaw.length} Messpunkten`);
      }
    }

    if (!forecastSeries || forecastSeries.length < 5) {
      return res.json({ error: 'Keine Daten verfügbar', extremes: [], source: 'none' });
    }

    // Wendepunkte mit ordentlichem Mindestabstand (4h)
    const MIN_GAP_MS = 4 * 3600 * 1000;
    let lastExT = 0, lastIsHW = null;
    for (let i = 2; i < forecastSeries.length - 2; i++) {
      const t = new Date(forecastSeries[i].timestamp).getTime();
      if (t - lastExT < MIN_GAP_MS) continue;
      const v   = forecastSeries[i].value;
      const vp1 = forecastSeries[i-1].value, vp2 = forecastSeries[i-2].value;
      const vn1 = forecastSeries[i+1].value, vn2 = forecastSeries[i+2].value;
      const isHW = v > vp1 && v > vn1 && v >= vp2 && v >= vn2;
      const isNW = v < vp1 && v < vn1 && v <= vp2 && v <= vn2;
      if (!isHW && !isNW) continue;
      if (lastIsHW === isHW) continue; // muss alternieren
      extremes.push({ time: forecastSeries[i].timestamp, value: Math.round(v), isHW });
      lastExT = t; lastIsHW = isHW;
    }

    res.json({ extremes, source, generated: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC, enabled: !!webpush });
});
app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid' });
  db.addPushSubscription(req.userId, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.removePushSubscription(endpoint);
  res.json({ ok: true });
});
app.post('/api/push/test', authMiddleware, async (req, res) => {
  const sent = await sendPushToUser(req.userId, {
    title: '🚢 Elbe Radar – Test',
    body:  'Push funktioniert! 🎉',
    tag:   'elbr-test',
  });
  res.json({ ok: true, sent });
});

// ── WATCHLIST ─────────────────────────────────────────────────────────────────
app.get('/api/watchlist', authMiddleware, (req, res) => {
  res.json(db.getWatchlist(req.userId));
});
app.post('/api/watchlist/:mmsi', authMiddleware, (req, res) => {
  db.addToWatchlist(req.userId, req.params.mmsi, req.body?.name || '');
  res.json({ ok: true });
});
app.delete('/api/watchlist/:mmsi', authMiddleware, (req, res) => {
  db.removeFromWatchlist(req.userId, req.params.mmsi);
  res.json({ ok: true });
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
// ── PLAYBACK (NEU) ────────────────────────────────────────────────────────────

// GET /api/playback?ts=<unix_ms> – Snapshot aller Schiffe zum Zeitpunkt ts
// Für jede MMSI: der nächstgelegene History-Eintrag innerhalb ±3 Minuten
app.get('/api/playback', authMiddleware, (req, res) => {
  const ts = +(req.query.ts);
  if (!ts || isNaN(ts)) return res.status(400).json({ error: 'ts required' });
  const W = 3 * 60 * 1000; // ±3 Min Fenster
  // Einfache, zuverlässige Query: für jede MMSI den Eintrag mit der kleinsten Zeitdifferenz
  const rows = db.db.prepare(`
    SELECT *, ABS(ts - ?) as _diff FROM history
    WHERE ts BETWEEN ? AND ?
    ORDER BY mmsi, _diff ASC
  `).all(ts, ts - W, ts + W);
  // Deduplizierung: nur der erste (nächste) pro MMSI
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    if (!seen.has(r.mmsi)) { seen.add(r.mmsi); unique.push(r); }
  }
  res.json({ ts, count: unique.length, ships: unique });
});

// GET /api/playback/range – Zeitbereich der History
app.get('/api/playback/range', authMiddleware, (req, res) => {
  const range = db.db.prepare(`SELECT MIN(ts) as min_ts, MAX(ts) as max_ts, COUNT(DISTINCT mmsi) as ships FROM history`).get();
  res.json(range);
});

// GET /api/debug/ship/:mmsi – Alle History-Einträge für ein Schiff (letzte 24h)
// Für Debugging von Positions-Lücken
app.get('/api/debug/ship/:mmsi', adminMiddleware, (req, res) => {
  const mmsi = req.params.mmsi;
  const hours = +(req.query.hours || 24);
  const since = Date.now() - hours * 3600 * 1000;

  // 1) History für dieses Schiff
  const rows = db.db.prepare(`
    SELECT ts, lat, lon, sog, cog, name, type, len FROM history
    WHERE mmsi = ? AND ts > ? ORDER BY ts ASC
  `).all(mmsi, since);

  // 2) Wie viele History-Einträge gibt es überhaupt?
  const totalHistory = db.db.prepare(`SELECT COUNT(*) as n, COUNT(DISTINCT mmsi) as ships FROM history`).get();

  // 3) Gibt es das Schiff in der ships-Tabelle?
  const shipRow = db.db.prepare(`SELECT * FROM ships WHERE mmsi = ?`).get(mmsi);

  // 4) Neueste 5 History-Einträge egal welches Schiff (zeigt ob History überhaupt läuft)
  const recentHistory = db.db.prepare(`SELECT mmsi, name, ts FROM history ORDER BY ts DESC LIMIT 5`).all();

  // 5) Was hat die AIS-Memory-Map? (über ais-Modul nicht direkt erreichbar, zeige ships-Tabelle top 5)
  const recentShips = db.db.prepare(`SELECT mmsi, name, seen, lat, lon FROM ships ORDER BY seen DESC LIMIT 5`).all();

  // Lücken-Analyse
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].ts - rows[i-1].ts;
    if (gap > 3 * 60 * 1000) {
      gaps.push({ from: new Date(rows[i-1].ts).toISOString(), to: new Date(rows[i].ts).toISOString(), gap_min: Math.round(gap/60000) });
    }
  }

  res.json({
    query: { mmsi, hours },
    ship_in_ships_table: shipRow || null,
    history_for_ship: { total_points: rows.length, first: rows[0]||null, last: rows[rows.length-1]||null, gaps },
    db_totals: totalHistory,
    recent_history_any_ship: recentHistory.map(r => ({ ...r, ts_human: new Date(r.ts).toISOString() })),
    recent_ships_table: recentShips.map(r => ({ ...r, seen_human: new Date(r.seen).toISOString() })),
    points: rows
  });
});

// ── SQL DEBUG (Admin only) ─────────────────────────────────────────────────────
// POST /api/debug/sql  { sql: "SELECT ...", params: [] }
app.post('/api/debug/sql', adminMiddleware, (req, res) => {
  const { sql, params = [] } = req.body;
  if (!sql) return res.status(400).json({ error: 'sql required' });
  // Nur SELECT erlaubt – kein DDL/DML
  const normalized = sql.trim().toUpperCase();
  if (!/^SELECT\b/.test(normalized)) {
    return res.status(400).json({ error: 'Nur SELECT-Abfragen erlaubt' });
  }
  try {
    const stmt = db.db.prepare(sql);
    const rows = stmt.all(...params);
    res.json({ count: rows.length, rows });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});
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
// /api/ships – sofort verfügbar beim Seitenaufbau (statt auf WebSocket zu warten)
// Liefert die gleiche Daten wie der initiale WebSocket-Send
app.get('/api/ships', (req, res) => {
  const cutoff = Date.now() - SHIP_TTL_MS;
  const active = [...ais.ships.values()].filter(s => (s.seen || 0) >= cutoff);
  res.json(active);
});
app.get('/api/history',          authMiddleware, (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/ship/:mmsi/track', authMiddleware, (req,res) => res.json(db.getTrack(req.params.mmsi, +(req.query.hours||24))));
app.get('/api/status', authMiddleware, (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'0.8.1',
  retainDays: +(process.env.RETAIN_DAYS||7),
  buildSha: BUILD_SHA, buildTime: BUILD_TIME,
  ais: ais.getStatus(),
}));
app.get('/api/version', (req,res) => res.json({ sha: BUILD_SHA, time: BUILD_TIME, version:'0.8.1' }));

// Öffentlicher Healthcheck (für Docker/Podman HEALTHCHECK und externes Monitoring)
// Antwortet 200 wenn AIS verbunden UND in den letzten 5 Min Nachricht erhalten,
// sonst 503 mit Diagnose-Details
app.get('/api/health', (req, res) => {
  const aisStatus = ais.getStatus();
  const body = {
    status: aisStatus.healthy ? 'ok' : 'degraded',
    ais: {
      connected: aisStatus.connected,
      certError: aisStatus.certError,
      lastMessageAgo: aisStatus.secondsSinceLastMessage,
      reconnectAttempts: aisStatus.reconnectAttempts,
      totalMessages: aisStatus.totalMessages,
      lastError: aisStatus.lastErrorMessage,
    },
    uptime: Math.floor(process.uptime()),
    version: '0.8.1',
  };
  res.status(aisStatus.healthy ? 200 : 503).json(body);
});

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

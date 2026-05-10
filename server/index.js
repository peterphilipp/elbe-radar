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
// Photo-Quellen der Reihe nach ausprobieren
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

app.get('/api/ship/:mmsi/photo', (req, res) => {
  const mmsi = req.params.mmsi.replace(/\D/g, '');
  if (!mmsi) return res.status(400).end();
  const ua = 'Mozilla/5.0 (compatible; ElbeRadar/0.3)';
  tryPhotoSources(mmsi, [
    // Quelle 1: MarineTraffic Thumbnail
    { hostname:'photos.marinetraffic.com', path:`/ais/showphoto.aspx?mmsi=${mmsi}&size=thumb800`,
      headers:{ 'Referer':'https://www.marinetraffic.com/', 'User-Agent':ua } },
    // Quelle 2: MarineTraffic large
    { hostname:'photos.marinetraffic.com', path:`/ais/showphoto.aspx?mmsi=${mmsi}`,
      headers:{ 'Referer':'https://www.marinetraffic.com/', 'User-Agent':ua } },
    // Quelle 3: VesselFinder
    { hostname:'photos.vesseltracker.com', path:`/photos/vessels/thumb_${mmsi}.jpg`,
      headers:{ 'Referer':'https://www.vesseltracker.com/', 'User-Agent':ua } },
  ], res);
});

// ── AIS STATUS ────────────────────────────────────────────────────────────────
app.get('/api/ships',            authMiddleware, (req,res) => res.json(db.getActiveShips()));
app.get('/api/history',          authMiddleware, (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/ship/:mmsi/track', authMiddleware, (req,res) => res.json(db.getTrack(req.params.mmsi, +(req.query.hours||24))));
app.get('/api/status', authMiddleware, (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'0.3.7',
  retainDays: +(process.env.RETAIN_DAYS||7),
  buildSha: BUILD_SHA, buildTime: BUILD_TIME,
}));
app.get('/api/version', (req,res) => res.json({ sha: BUILD_SHA, time: BUILD_TIME, version:'0.3.7' }));

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
  console.log(`[Server] Elbe Radar v0.3.7 · Port ${PORT}`);
  console.log(`[Server] AIS-Key:    ${process.env.AIS_API_KEY       ? 'gesetzt'           : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Reg-Code:   ${REG_CODE                      ? 'gesetzt'           : 'offen (jeder kann sich registrieren)'}`);
  console.log(`[Server] History:    ${process.env.RETAIN_DAYS||7} Tage · Intervall 5 min`);
  console.log(`[Server] Build:      ${BUILD_SHA} @ ${BUILD_TIME}`);
});

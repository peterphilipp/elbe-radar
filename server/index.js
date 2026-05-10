'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const path         = require('path');
const AISConnector = require('./aisConnector');
const db           = require('./db');

const PORT       = process.env.PORT       || 3000;
const API_SECRET = process.env.API_SECRET || '';
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(express.json());

const BUILD_SHA  = process.env.BUILD_SHA  || 'dev';
const BUILD_TIME = process.env.BUILD_TIME || new Date().toISOString();

function requireAuth(req, res, next) {
  if (!API_SECRET) return next();
  const token = req.headers['x-api-key'] || req.query.apikey;
  if (token !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── AIS ──────────────────────────────────────────────────────────────────────
const ais = new AISConnector(ships => broadcast(ships));
ais.start();

function broadcast(ships) {
  const active  = db.getActiveShips(15 * 60 * 1000);
  const payload = JSON.stringify({ type:'ships', data: active, ts: Date.now() });
  for (const c of wss.clients) if (c.readyState===WebSocket.OPEN) c.send(payload);
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'ships', data: db.getActiveShips(15*60*1000), ts: Date.now() }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type==='setBox' && msg.box) ais.updateBox(msg.box);
    } catch(e) {}
  });
});

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/ships',            (req,res) => res.json(db.getActiveShips()));
app.get('/api/history',          (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/ship/:mmsi/track', (req,res) => res.json(db.getTrack(req.params.mmsi, +(req.query.hours||24))));
app.get('/api/status',           (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'0.2.5',
  retainDays: +(process.env.RETAIN_DAYS||7),
  buildSha: BUILD_SHA, buildTime: BUILD_TIME,
  authRequired: !!API_SECRET,
}));
app.get('/api/version', (req,res) => res.json({ sha: BUILD_SHA, time: BUILD_TIME, version:'0.2.5' }));

// ── Einstellungen (Kartenstil, etc.) ──────────────────────────────────────────
app.get('/api/settings/:key', (req,res) => {
  const value = db.getSetting(req.params.key);
  res.json({ key: req.params.key, value: value || null });
});
app.post('/api/settings/:key', (req,res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  db.setSetting(req.params.key, String(value));
  res.json({ ok: true });
});

// ── Alert CRUD ────────────────────────────────────────────────────────────────
app.get   ('/api/alerts',        (req,res) => res.json(db.getAlerts()));
app.post  ('/api/alerts', requireAuth, (req,res) => {
  const { name, ship_type, name_filter, min_length_alert, max_eta_min } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const info = db.insertAlert({
    name, ship_type:ship_type||null, name_filter:name_filter||null,
    min_len:0, max_eta_min:+max_eta_min||30,
    min_length_alert:+min_length_alert||150, active:1,
  });
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/alerts/:id', requireAuth, (req,res) => { db.deleteAlert(+req.params.id); res.json({ok:true}); });
app.patch ('/api/alerts/:id', requireAuth, (req,res) => {
  db.toggleAlert(+req.params.id, req.body.active ? 1 : 0);
  res.json({ok:true});
});

app.use(express.static(path.join(__dirname,'..','public')));
app.get('*',(req,res) => res.sendFile(path.join(__dirname,'..','public','index.html')));

server.listen(PORT, () => {
  console.log(`[Server] Elbe Radar v0.2.5 · Port ${PORT}`);
  console.log(`[Server] AIS-Key:    ${process.env.AIS_API_KEY       ? 'gesetzt'           : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Telegram:   ${process.env.TELEGRAM_BOT_TOKEN ? 'aktiv'            : 'nicht konfiguriert'}`);
  console.log(`[Server] Auth:       ${API_SECRET                     ? 'aktiv (API_SECRET)': 'deaktiviert'}`);
  console.log(`[Server] History:    ${process.env.RETAIN_DAYS||7} Tage · Intervall 5 min`);
  console.log(`[Server] Build:      ${BUILD_SHA} @ ${BUILD_TIME}`);
});

'use strict';
require('dotenv').config();
const express      = require('express');
const http         = require('http');
const WebSocket    = require('ws');
const path         = require('path');
const AISConnector = require('./aisConnector');
const db           = require('./db');

const PORT = process.env.PORT || 3000;
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.use(express.json());

// ── AIS ──────────────────────────────────────────────────────────────────────
const ais = new AISConnector(ships => broadcast(ships));
ais.start();

function broadcast(ships) {
  const active = db.getActiveShips(15 * 60 * 1000);
  const payload = JSON.stringify({ type:'ships', data: active, ts: Date.now() });
  for (const c of wss.clients) if (c.readyState===WebSocket.OPEN) c.send(payload);
}

wss.on('connection', ws => {
  // Initial-Push aus DB
  const active = db.getActiveShips(15 * 60 * 1000);
  ws.send(JSON.stringify({ type:'ships', data: active, ts: Date.now() }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type==='setBox' && msg.box) ais.updateBox(msg.box);
    } catch(e) {}
  });
});

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/ships',   (req,res) => res.json(db.getActiveShips()));
app.get('/api/history', (req,res) => res.json(db.getHistory(+(req.query.days||1))));
app.get('/api/status',  (req,res) => res.json({
  ships: db.getActiveShips().length, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version:'2.1.0',
  retainDays: process.env.RETAIN_DAYS||7,
}));

// ── Alert CRUD ────────────────────────────────────────────────────────────────
app.get   ('/api/alerts',      (req,res) => res.json(db.getAlerts()));
app.post  ('/api/alerts',      (req,res) => {
  const { name, ship_type, name_filter, min_len, max_eta_min } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  const info = db.insertAlert({
    name, ship_type:ship_type||null, name_filter:name_filter||null,
    min_len:+min_len||0, max_eta_min:+max_eta_min||360, active:1,
  });
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/alerts/:id',  (req,res) => { db.deleteAlert(+req.params.id); res.json({ok:true}); });
app.patch ('/api/alerts/:id',  (req,res) => {
  db.toggleAlert(+req.params.id, req.body.active ? 1 : 0);
  res.json({ok:true});
});

app.use(express.static(path.join(__dirname,'..','public')));
app.get('*',(req,res) => res.sendFile(path.join(__dirname,'..','public','index.html')));

server.listen(PORT, () => {
  console.log(`[Server] Elbe Radar v2.1 läuft auf Port ${PORT}`);
  console.log(`[Server] AIS-Key:  ${process.env.AIS_API_KEY  ? 'gesetzt' : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'aktiv' : 'nicht konfiguriert'}`);
  console.log(`[Server] History:  ${process.env.RETAIN_DAYS||7} Tage`);
});

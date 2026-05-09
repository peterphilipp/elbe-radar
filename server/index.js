'use strict';
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const AISConnector = require('./aisConnector');

const PORT = process.env.PORT || 3000;
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
let shipsCache = new Map();

const ais = new AISConnector(ships => { shipsCache = ships; broadcast(ships); });
ais.start();

function broadcast(ships) {
  const payload = JSON.stringify({ type: 'ships', data: [...ships.values()], ts: Date.now() });
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'ships', data: [...shipsCache.values()], ts: Date.now() }));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      // Browser sendet neue BoundingBox beim Karten-Move/Zoom
      if (msg.type === 'setBox' && msg.box) {
        ais.updateBox(msg.box);
      }
    } catch (e) {}
  });
});

app.get('/api/ships',  (req, res) => res.json([...shipsCache.values()]));
app.get('/api/status', (req, res) => res.json({
  ships: shipsCache.size, demo: !process.env.AIS_API_KEY,
  uptime: Math.floor(process.uptime()), version: '2.0.0',
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`[Server] Elbe Radar v2 läuft auf Port ${PORT}`);
  console.log(`[Server] AIS-Key: ${process.env.AIS_API_KEY ? 'gesetzt' : 'NICHT gesetzt (Demo)'}`);
  console.log(`[Server] Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'aktiv' : 'nicht konfiguriert'}`);
});

'use strict';
require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const AISConnector = require('./aisConnector');

const PORT = process.env.PORT || 3000;
const app  = express();
const server = http.createServer(app);

// WebSocket-Server für Browser-Clients
const wss = new WebSocket.Server({ server });

let shipsCache = new Map();

// AIS-Connector starten
const ais = new AISConnector((ships) => {
  shipsCache = ships;
  broadcast(ships);
});
ais.start();

// Alle Browser-Clients updaten
function broadcast(ships) {
  const payload = JSON.stringify({
    type: 'ships',
    data: [...ships.values()],
    ts:   Date.now(),
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Neuer Browser-Client: sofort aktuellen Stand schicken
wss.on('connection', (ws) => {
  console.log('[WS] Browser verbunden');
  ws.send(JSON.stringify({
    type: 'ships',
    data: [...shipsCache.values()],
    ts:   Date.now(),
  }));
  ws.on('close', () => console.log('[WS] Browser getrennt'));
});

// REST: Aktueller Schiffs-Snapshot
app.get('/api/ships', (req, res) => {
  res.json([...shipsCache.values()]);
});

// REST: Status
app.get('/api/status', (req, res) => {
  res.json({
    ships:   shipsCache.size,
    demo:    !process.env.AIS_API_KEY,
    uptime:  Math.floor(process.uptime()),
    version: '1.0.0',
  });
});

// Frontend ausliefern
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`[Server] Elbe Radar läuft auf Port ${PORT}`);
  console.log(`[Server] AIS-Key: ${process.env.AIS_API_KEY ? 'gesetzt' : 'NICHT gesetzt (Demo-Modus)'}`);
  console.log(`[Server] Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? 'aktiv' : 'nicht konfiguriert'}`);
});

'use strict';
const https  = require('https');
const { getAlerts } = require('./db');
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const alerted = new Map(); // mmsi+alertId → timestamp

function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', e => console.error('[Telegram] Fehler:', e.message));
  req.write(body); req.end();
}

function checkAlerts(ship, eta) {
  if (!eta) return;
  const alerts = getAlerts();
  for (const alert of alerts) {
    // Typ-Filter
    if (alert.ship_type && alert.ship_type !== ship.type) continue;
    // Namens-Filter
    if (alert.name_filter) {
      const needle = alert.name_filter.toLowerCase();
      if (!(ship.name||'').toLowerCase().includes(needle)) continue;
    }
    // Längen-Filter
    if (alert.min_len && (ship.len||0) < alert.min_len) continue;
    // ETA-Fenster
    const etaMs  = new Date(eta.eta).getTime();
    const etaMin = (etaMs - Date.now()) / 60000;
    if (etaMin < 0 || etaMin > alert.max_eta_min) continue;

    const key = `${ship.mmsi}:${alert.id}`;
    const last = alerted.get(key) || 0;
    if (Date.now() - last < 6 * 3600 * 1000) continue;
    alerted.set(key, Date.now());

    const etaStr = new Date(etaMs).toLocaleTimeString('de-DE',
      { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' });
    const emoji = ship.type==='Cruise' ? '🚢' : ship.type==='Container' ? '📦' : ship.type==='Tanker' ? '🛢' : '🚤';
    sendMessage(
      `${emoji} <b>${ship.name||'Unbekannt'}</b>
` +
      `🔔 Alert: <i>${alert.name}</i>
` +
      `🔹 Typ: ${ship.type}  ·  Länge: ${ship.len||'?'} m
` +
      `🔹 Richtung: ${eta.direction}  ·  ${(ship.sog/10).toFixed(1)} kn
` +
      `⏱ ETA Willkomm-Höft: <b>${etaStr} Uhr</b>  (${eta.distNm} sm)
` +
      `🔗 <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}">MarineTraffic</a>`
    );
    console.log(`[Telegram] Alert "${alert.name}": ${ship.name} ETA ${etaStr}`);
  }
}

module.exports = { checkAlerts, sendMessage };

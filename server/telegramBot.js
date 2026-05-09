'use strict';
const https = require('https');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const alerted = new Map(); // mmsi → timestamp, verhindert Doppel-Alerts

function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', e => console.error('Telegram Fehler:', e.message));
  req.write(body);
  req.end();
}

/**
 * Prüft ob ein Schiff einen Alert auslösen soll.
 * Sendet max. 1 Alert pro Schiff pro Passage (8h Cooldown).
 */
function checkAlert(ship, eta) {
  const minLen = parseInt(process.env.ALERT_MIN_LENGTH || '200', 10);
  if ((ship.len || 0) < minLen) return;
  if (!['Container', 'Cruise'].includes(ship.type)) return;
  if (!eta) return;

  const last = alerted.get(ship.mmsi) || 0;
  if (Date.now() - last < 8 * 3600 * 1000) return; // 8h Cooldown
  alerted.set(ship.mmsi, Date.now());

  const etaStr = eta.eta.toLocaleTimeString('de-DE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
  });
  const typeEmoji = ship.type === 'Cruise' ? '🚢' : '📦';
  const text =
    `${typeEmoji} <b>${ship.name || 'Unbekannt'}</b>
` +
    `🔹 Typ: ${ship.type}
` +
    `🔹 Länge: ${ship.len ? ship.len + ' m' : 'unbekannt'}
` +
    `🔹 Richtung: ${eta.direction}
` +
    `🔹 Geschwindigkeit: ${(ship.sog / 10).toFixed(1)} kn
` +
    `⏱ ETA Willkomm-Höft: <b>${etaStr} Uhr</b>
` +
    `📍 Distanz: ${eta.distNm} sm
` +
    `🔗 <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}">MarineTraffic</a>`;

  sendMessage(text);
  console.log(`[Telegram] Alert gesendet: ${ship.name} ETA ${etaStr}`);
}

module.exports = { checkAlert, sendMessage };

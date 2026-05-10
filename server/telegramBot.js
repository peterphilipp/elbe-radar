'use strict';
const https = require('https');
const { getAlerts, isAlerted, markAlerted } = require('./db');

function sendMessage(text) {
  const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', e => console.error('[Telegram]', e.message));
  req.write(body); req.end();
}

function checkAlerts(ship, eta) {
  if (!eta) return;
  let alerts;
  try { alerts = getAlerts(); } catch(e) { return; }
  for (const alert of alerts) {
    if (alert.ship_type   && alert.ship_type !== ship.type) continue;
    if (alert.name_filter && !(ship.name||'').toLowerCase().includes(alert.name_filter.toLowerCase())) continue;
    // Einziges Längenkriterium: min_length_alert
    const minLen = alert.min_length_alert || 150;
    if ((ship.len||0) < minLen) continue;
    const etaMs  = new Date(eta.eta).getTime();
    const etaMin = (etaMs - Date.now()) / 60000;
    if (etaMin < 0 || etaMin > alert.max_eta_min) continue;
    const key = `${ship.mmsi}:${alert.id}`;
    // Persistente Dedup-Prüfung (6 h Cooldown)
    if (isAlerted(key, 6*3600*1000)) continue;
    markAlerted(key);
    const etaStr = new Date(etaMs).toLocaleTimeString('de-DE',
      { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' });
    const emoji = {Cruise:'🚢',Container:'📦',Tanker:'🛢',Cargo:'🚤'}[ship.type]||'🚤';
    sendMessage(
      `${emoji} <b>${ship.name||'Unbekannt'}</b>\n` +
      `🔔 Alert: <i>${alert.name}</i>\n` +
      `🔹 ${ship.type} · ${ship.len||'?'} m · ${(ship.sog/10).toFixed(1)} kn\n` +
      `🔹 Richtung: ${eta.direction} · Distanz: ${eta.distNm} sm\n` +
      `⏱ ETA Willkomm-Höft: <b>${etaStr} Uhr</b>\n` +
      `🔗 <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}">MarineTraffic</a>`
    );
    console.log(`[Telegram] Alert "${alert.name}": ${ship.name} ETA ${etaStr}`);
  }
}
module.exports = { checkAlerts, sendMessage };

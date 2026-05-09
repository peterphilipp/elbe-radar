'use strict';
const https = require('https');
const { getAlerts } = require('./db');
const alerted = new Map();

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
    if (alert.min_len     && (ship.len||0) < alert.min_len) continue;
    // min_length_alert: Mindestlänge für Telegram-Benachrichtigung
    const minLenAlert = alert.min_length_alert || 150;
    if ((ship.len||0) < minLenAlert) continue;
    const etaMs  = new Date(eta.eta).getTime();
    const etaMin = (etaMs - Date.now()) / 60000;
    if (etaMin < 0 || etaMin > alert.max_eta_min) continue;
    const key = `${ship.mmsi}:${alert.id}`;
    if (Date.now() - (alerted.get(key)||0) < 6*3600*1000) continue;
    alerted.set(key, Date.now());
    const etaStr = new Date(etaMs).toLocaleTimeString('de-DE',
      { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' });
    const emoji = {Cruise:'🚢',Container:'📦',Tanker:'🛢',Cargo:'🚤'}[ship.type]||'🚤';
    sendMessage(
      `${emoji} <b>${ship.name||'Unbekannt'}</b>
` +
      `🔔 Alert: <i>${alert.name}</i>
` +
      `🔹 ${ship.type} · ${ship.len||'?'} m · ${(ship.sog/10).toFixed(1)} kn
` +
      `🔹 Richtung: ${eta.direction} · Distanz: ${eta.distNm} sm
` +
      `⏱ ETA Willkomm-Höft: <b>${etaStr} Uhr</b>
` +
      `🔗 <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${ship.mmsi}">MarineTraffic</a>`
    );
    console.log(`[Telegram] Alert "${alert.name}": ${ship.name} ETA ${etaStr}`);
  }
}
module.exports = { checkAlerts, sendMessage };

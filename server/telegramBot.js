'use strict';
const https = require('https');
const { getAllActiveAlerts, getUserSetting, isAlerted, markAlerted } = require('./db');
const { calcETA, DEFAULT_REF } = require('./etaCalculator');

// Cache für User-Konfigurationen (2 min TTL)
const userCfgCache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function getUserConfig(userId) {
  const now = Date.now();
  const cached = userCfgCache.get(userId);
  if (cached && now - cached.ts < CACHE_TTL) return cached.cfg;
  let refPoint = DEFAULT_REF, telegram = null;
  try {
    const rp = getUserSetting(userId, 'refpoint');
    if (rp) refPoint = JSON.parse(rp);
    const tg = getUserSetting(userId, 'telegram');
    if (tg) telegram = JSON.parse(tg);
  } catch {}
  const cfg = { refPoint, telegram };
  userCfgCache.set(userId, { cfg, ts: now });
  return cfg;
}
function invalidateUserCache(userId) { userCfgCache.delete(userId); }

function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) return Promise.resolve({ ok:false, error:'Keine Konfiguration' });
  return new Promise(resolve => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.ok ? {ok:true} : {ok:false, error:j.description||'Telegram-Fehler'});
        } catch { resolve({ok:false, error:'Antwort ungültig'}); }
      });
    });
    req.on('error', e => resolve({ok:false, error:e.message}));
    req.write(body); req.end();
  });
}

function checkAlerts(ship) {
  let allAlerts;
  try { allAlerts = getAllActiveAlerts(); } catch { return; }
  for (const alert of allAlerts) {
    if (!alert.user_id) continue;
    const cfg = getUserConfig(alert.user_id);
    if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_id) continue;
    if (alert.ship_type   && alert.ship_type !== ship.type) continue;
    if (alert.name_filter && !(ship.name||'').toLowerCase().includes(alert.name_filter.toLowerCase())) continue;
    // Längencheck nur wenn Schiffslänge bekannt (>0) – bei len=0 nicht herausfiltern
    const shipLen = ship.len || 0;
    const minLen  = alert.min_length_alert || 150;
    if (shipLen > 0 && shipLen < minLen) continue;
    const eta = calcETA(ship, cfg.refPoint);
    if (!eta) continue;
    const etaMs  = new Date(eta.eta).getTime();
    const etaMin = (etaMs - Date.now()) / 60000;
    if (etaMin < 0 || etaMin > alert.max_eta_min) continue;
    const key = `${ship.mmsi}:${alert.id}`;
    if (isAlerted(key, 6*3600*1000)) continue;
    markAlerted(key);
    const etaStr = new Date(etaMs).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Berlin' });
    const emoji  = {Cruise:'🚢',Container:'📦',Tanker:'🛢',Cargo:'🚤'}[ship.type]||'🚤';
    sendTelegramMessage(cfg.telegram.bot_token, cfg.telegram.chat_id,
      `${emoji} <b>${ship.name||'Unbekannt'}</b>\n` +
      `🔔 Alert: <i>${alert.name}</i>\n` +
      `🔹 ${ship.type} · ${ship.len||'?'} m · ${(ship.sog/10).toFixed(1)} kn\n` +
      `🔹 Richtung: ${eta.direction} · Distanz: ${eta.distNm} sm\n` +
      `⏱ ETA ${cfg.refPoint.name}: <b>${etaStr} Uhr</b>\n` +
      `🔗 <a href="https://www.marinetraffic.com/en/ais/home/centerx:${ship.lon.toFixed(3)}/centery:${ship.lat.toFixed(3)}/zoom:14">MarineTraffic</a>`
    );
    console.log(`[Telegram] Alert "${alert.name}" → User ${alert.user_id}: ${ship.name} ETA ${etaStr}`);
  }
}

async function sendTestMessage(userId) {
  const cfg = getUserConfig(userId);
  invalidateUserCache(userId);
  if (!cfg.telegram?.bot_token || !cfg.telegram?.chat_id) {
    return { ok:false, error:'Bot-Token und Chat-ID müssen konfiguriert sein' };
  }
  return sendTelegramMessage(
    cfg.telegram.bot_token, cfg.telegram.chat_id,
    `🔔 <b>Elbe Radar – Testnachricht</b>\n\n` +
    `✅ Deine Telegram-Benachrichtigungen funktionieren!\n\n` +
    `📍 Referenzpunkt: <b>${cfg.refPoint.name}</b>\n` +
    `(${cfg.refPoint.lat.toFixed(4)}°N, ${cfg.refPoint.lon.toFixed(4)}°E)`
  );
}

module.exports = { checkAlerts, sendTelegramMessage, sendTestMessage, invalidateUserCache };

'use strict';
const WebSocket = require('ws');
const { calcETA } = require('./etaCalculator');
const { checkAlert } = require('./telegramBot');

const BOX = { n: 53.620, s: 53.490, w: 9.100, e: 10.050 };

function shipType(code, name = '') {
  const n = (name || '').toLowerCase();
  if (/(aida|norwegian|costa|carnival|celebrity|mein schiff|tui cruis|princess|cunard|crystal|viking|queen|regent|silver|oceania|europa|columbus)/.test(n)) return 'Cruise';
  const c = +(code || 0);
  if (c >= 60 && c <= 69) return 'Cruise';
  if (c >= 70 && c <= 79) return 'Container';
  if (c >= 80 && c <= 89) return 'Tanker';
  return 'Cargo';
}

class AISConnector {
  constructor(onUpdate) {
    this.onUpdate = onUpdate; // Callback: (ships Map) => void
    this.ships = new Map();
    this.ws = null;
    this.reconnectTimer = null;
    this.apiKey = process.env.AIS_API_KEY || '';
  }

  start() {
    if (!this.apiKey) {
      console.warn('[AIS] Kein API-Key – Demo-Modus aktiv');
      this._startDemo();
      return;
    }
    this._connect();
  }

  _connect() {
    if (this.ws) try { this.ws.terminate(); } catch (e) {}
    console.log('[AIS] Verbinde mit aisstream.io …');
    this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    this.ws.on('open', () => {
      console.log('[AIS] Verbunden');
      this.ws.send(JSON.stringify({
        APIKey: this.apiKey,
        BoundingBoxes: [[[BOX.s, BOX.w], [BOX.n, BOX.e]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf8');
        const d = JSON.parse(raw);
        this._handleMsg(d);
      } catch (e) {
        console.error('[AIS] Parse-Fehler:', e.message);
      }
    });

    this.ws.on('error', e => console.error('[AIS] Fehler:', e.message));
    this.ws.on('close', (code) => {
      console.warn(`[AIS] Verbindung getrennt (${code}) – Reconnect in 15s`);
      this.reconnectTimer = setTimeout(() => this._connect(), 15000);
    });
  }

  _handleMsg(d) {
    const mtype = d.MessageType || '';
    const meta  = d.MetaData   || {};
    const msg   = d.Message    || {};
    const mmsi  = String(meta.MMSI || meta.UserID || '');
    if (!mmsi) return;

    const existing = this.ships.get(mmsi) || {};

    if (mtype === 'ShipStaticData') {
      const sd  = msg.ShipStaticData || msg;
      const dim = sd.Dimension || {};
      const name = (meta.ShipName || sd.Name || '').trim();
      const lat = parseFloat(meta.latitude ?? meta.Latitude ?? 0) || existing.lat;
      const lon = parseFloat(meta.longitude ?? meta.Longitude ?? 0) || existing.lon;
      this._upsert({ mmsi, lat, lon,
        name:  name || existing.name || '',
        type:  shipType(sd.Type, name) || existing.type || 'Cargo',
        dest:  (sd.Destination || '').trim() || existing.dest || '',
        cs:    sd.CallSign || existing.cs || '',
        len:   dim.A && dim.B ? +dim.A + +dim.B : existing.len || 0,
        wid:   dim.C && dim.D ? +dim.C + +dim.D : existing.wid || 0,
        drg:   sd.MaximumStaticDraught ? +sd.MaximumStaticDraught * 10 : existing.drg || 0,
      });
      return;
    }

    const lat = parseFloat(meta.latitude ?? meta.Latitude ?? 0);
    const lon = parseFloat(meta.longitude ?? meta.Longitude ?? 0);
    if (!lat || !lon) return;

    const pr  = msg.PositionReport || msg.StandardClassBPositionReport || msg;
    const sog = pr.Sog != null ? +pr.Sog * 10 : existing.sog;
    const cog = pr.Cog != null ? +pr.Cog      : existing.cog;
    const hdg = pr.TrueHeading != null && +pr.TrueHeading < 360 ? +pr.TrueHeading : existing.heading;
    const name2 = (meta.ShipName || '').trim();

    this._upsert({ mmsi, lat, lon,
      name:    name2 || existing.name || 'Unbekannt',
      type:    existing.type || shipType(null, name2) || 'Cargo',
      dest:    existing.dest || '',
      cs:      existing.cs  || '',
      len:     existing.len || 0,
      wid:     existing.wid || 0,
      drg:     existing.drg || 0,
      sog, cog, heading: hdg,
    });
  }

  _upsert(p) {
    const merged = { ...(this.ships.get(p.mmsi) || {}), ...p, seen: Date.now() };
    this.ships.set(p.mmsi, merged);

    // ETA berechnen & ggf. Telegram-Alert
    const eta = calcETA(merged);
    if (eta) {
      merged.eta = eta;
      checkAlert(merged, eta);
    }

    this._cleanup();
    this.onUpdate(this.ships);
  }

  _cleanup() {
    const cutoff = Date.now() - 20 * 60 * 1000; // 20 min
    for (const [mmsi, s] of this.ships) {
      if ((s.seen || 0) < cutoff) this.ships.delete(mmsi);
    }
  }

  // Demo-Modus: simulierte Schiffe wenn kein API-Key
  _startDemo() {
    const demo = [
      { mmsi:'211801001', name:'AIDA PRIMA',      lat:53.531, lon:9.560, sog:90,  cog:89,  type:'Cruise',    len:300, wid:37, drg:78,  dest:'HAMBURG'     },
      { mmsi:'636921002', name:'MSC HAMBURG',     lat:53.538, lon:9.820, sog:116, cog:271, type:'Container', len:366, wid:51, drg:148, dest:'ROTTERDAM'   },
      { mmsi:'352101003', name:'MAERSK ELSINORE', lat:53.533, lon:9.670, sog:107, cog:91,  type:'Container', len:399, wid:59, drg:155, dest:'HAMBURG'     },
      { mmsi:'538012004', name:'NORDIC RUTH',     lat:53.545, lon:9.880, sog:82,  cog:262, type:'Tanker',    len:253, wid:44, drg:109, dest:'BRUNSBÜTTEL' },
      { mmsi:'219091005', name:'ELBE PIONEER',    lat:53.527, lon:9.700, sog:66,  cog:93,  type:'Cargo',     len:155, wid:26, drg:68,  dest:'HAMBURG'     },
      { mmsi:'477888008', name:'COSCO UNIVERSE',  lat:53.543, lon:9.750, sog:104, cog:90,  type:'Container', len:400, wid:59, drg:160, dest:'HAMBURG'     },
    ];
    demo.forEach(s => this.ships.set(s.mmsi, { ...s, seen: Date.now() }));
    this.onUpdate(this.ships);
    setInterval(() => {
      for (const s of this.ships.values()) {
        const east = s.cog >= 30 && s.cog <= 200;
        s.lon += east ? 0.007 : -0.007;
        if (s.lon > 10.050) s.lon = 9.110;
        if (s.lon < 9.100)  s.lon = 10.040;
        s.seen = Date.now();
        const eta = calcETA(s);
        if (eta) { s.eta = eta; checkAlert(s, eta); }
      }
      this.onUpdate(this.ships);
    }, 3000);
    console.log('[AIS] Demo-Modus aktiv');
  }
}

module.exports = AISConnector;

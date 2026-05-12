'use strict';
const WebSocket      = require('ws');
const { calcETA, DEFAULT_REF } = require('./etaCalculator');
const { checkAlerts }= require('./telegramBot');
const { saveShip, getSetting, recordPassage } = require('./db');

function shipType(code, name='', len=0) {
  const n = (name||'').toLowerCase();
  const c = +(code||0);

  // AIS-Typcode hat Vorrang – am zuverlässigsten
  if (c>=60&&c<=69) return 'Cruise';
  if (c>=70&&c<=79) return 'Container';
  if (c>=80&&c<=89) return 'Tanker';

  // Namensbasierte Heuristik: nur wenn kein eindeutiger Code vorhanden
  // und Schiff groß genug (>= 100m) um echtes Kreuzfahrtschiff zu sein
  if (len >= 100 || len === 0) {
    // Exakte bekannte Reederei-Präfixe/Suffixe – kein Substring-Match auf kurze Wörter
    if (/\b(aida|mein schiff|tui cruises?)\b/.test(n)) return 'Cruise';
    // Bekannte Kreuzfahrtschiff-Namen, aber nur wenn Schiff lang genug
    if (len >= 150) {
      if (/(norwegian|costa |carnival|celebrity|cunard|crystal cruise|viking (star|sky|sea|ocean|orion|venus|jupiter|mars)|regent|silver(sea|shadow|spirit|whisper|wind|cloud|muse|nova|moon)|oceania|hanseatic (nature|inspiration|spirit)|columbus|columbus 2|aidanova|aida|queen [a-z]|europa [12]?)/.test(n)) return 'Cruise';
    }
  }

  return 'Cargo';
}

class AISConnector {
  constructor(onUpdate) {
    this.onUpdate    = onUpdate;
    this.ships       = new Map();
    this.ws          = null;
    this.apiKey      = process.env.AIS_API_KEY || '';
    this.currentBox  = { n:53.900, s:53.400, w:7.800, e:10.200 };
    // Referenzpunkt-Cache (30 s TTL – vermeidet DB-Reads bei jedem Schiff-Update)
    this._refCache   = null;
    this._refCacheTs = 0;
  }

  start() {
    // Beim Start sofort Schiffe aus DB laden – letzte 30 Min (passt zu SHIP_TTL_MS)
    try {
      const stored = db.getActiveShips(30 * 60 * 1000);
      for (const s of stored) this.ships.set(String(s.mmsi), s);
      if (stored.length > 0) {
        console.log(`[AIS] ${stored.length} Schiffe aus DB (letzte 30 Min) geladen`);
        this.onUpdate(this.ships);
      } else {
        console.log('[AIS] Keine aktuellen Schiffe in DB (< 30 Min)');
      }
    } catch(e) {
      console.error('[AIS] DB-Lade-Fehler:', e.message);
    }
    if (!this.apiKey) { this._startDemo(); return; }
    this._connect();
  }

  updateBox(box) {
    this.currentBox = box;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this._subscribe();
  }

  _getRefPoint() {
    if (Date.now() - this._refCacheTs < 30000 && this._refCache) return this._refCache;
    try {
      const v = getSetting('refpoint');
      this._refCache = v ? JSON.parse(v) : DEFAULT_REF;
    } catch { this._refCache = DEFAULT_REF; }
    this._refCacheTs = Date.now();
    return this._refCache;
  }

  _subscribe() {
    const b = this.currentBox;
    this.ws.send(JSON.stringify({
      APIKey: this.apiKey,
      BoundingBoxes: [[[b.s, b.w], [b.n, b.e]]],
      FilterMessageTypes: ['PositionReport','ShipStaticData','StandardClassBPositionReport'],
    }));
    console.log(`[AIS] BBox: N${b.n} S${b.s} W${b.w} E${b.e}`);
  }

  _connect() {
    if (this.ws) try { this.ws.terminate(); } catch(e) {}
    console.log('[AIS] Verbinde …');
    this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    this.ws.on('open',    () => { console.log('[AIS] Verbunden'); this._subscribe(); });
    this.ws.on('message', data => { try { this._handleMsg(JSON.parse(data.toString('utf8'))); } catch(e) {} });
    this.ws.on('error',   e  => console.error('[AIS] Fehler:', e.message));
    this.ws.on('close',   code => { console.warn(`[AIS] Getrennt (${code}) – Reconnect in 15s`); setTimeout(() => this._connect(), 15000); });
  }

  _handleMsg(d) {
    const mtype = d.MessageType||'', meta = d.MetaData||{}, msg = d.Message||{};
    const mmsi = String(meta.MMSI||meta.UserID||''); if (!mmsi) return;
    const ex = this.ships.get(mmsi) || {};
    if (mtype === 'ShipStaticData') {
      const sd = msg.ShipStaticData||msg, dim = sd.Dimension||{};
      const name = (meta.ShipName||sd.Name||'').trim();
      const len  = dim.A&&dim.B ? +dim.A + +dim.B : ex.len||0;
      this._upsert({ mmsi,
        lat:  parseFloat(meta.latitude||meta.Latitude||0)||ex.lat,
        lon:  parseFloat(meta.longitude||meta.Longitude||0)||ex.lon,
        name: name||ex.name||'', type: shipType(sd.Type, name, len)||ex.type||'Cargo',
        dest: (sd.Destination||'').trim()||ex.dest||'', cs: sd.CallSign||ex.cs||'',
        len,
        wid:  dim.C&&dim.D ? +dim.C + +dim.D : ex.wid||0,
        drg:  sd.MaximumStaticDraught ? +sd.MaximumStaticDraught*10 : ex.drg||0,
        sog: ex.sog, cog: ex.cog, heading: ex.heading,
      }); return;
    }
    const lat = parseFloat(meta.latitude||meta.Latitude||0);
    const lon = parseFloat(meta.longitude||meta.Longitude||0);
    if (!lat||!lon) return;
    const pr = msg.PositionReport||msg.StandardClassBPositionReport||msg;
    this._upsert({ mmsi, lat, lon,
      name:    (meta.ShipName||'').trim()||ex.name||'',
      type:    ex.type||shipType(null, meta.ShipName||'', ex.len||0)||'Cargo',
      dest:    ex.dest||'', cs: ex.cs||'',
      len:     ex.len||0, wid: ex.wid||0, drg: ex.drg||0,
      sog:     pr.Sog!=null ? +pr.Sog*10 : ex.sog,
      cog:     pr.Cog!=null ? +pr.Cog    : ex.cog,
      heading: pr.TrueHeading!=null&&+pr.TrueHeading<360 ? +pr.TrueHeading : ex.heading,
    });
  }

  _upsert(p) {
    const merged = { ...(this.ships.get(p.mmsi)||{}), ...p, seen: Date.now() };
    const eta = calcETA(merged, this._getRefPoint());
    if (eta) { merged.eta = eta; checkAlerts(merged, eta); recordPassage(merged, eta.direction); }
    this.ships.set(p.mmsi, merged);
    saveShip(merged);
    this.onUpdate(this.ships);
  }

  _startDemo() {
    const demo = [
      {mmsi:'211801001',name:'AIDA PRIMA',     lat:53.531,lon:9.560,sog:90, cog:89, type:'Cruise',    len:300,wid:37,drg:78 },
      {mmsi:'636921002',name:'MSC HAMBURG',    lat:53.538,lon:9.820,sog:116,cog:271,type:'Container', len:366,wid:51,drg:148},
      {mmsi:'352101003',name:'MAERSK ELSINORE',lat:53.533,lon:9.670,sog:107,cog:91, type:'Container', len:399,wid:59,drg:155},
      {mmsi:'538012004',name:'NORDIC RUTH',    lat:53.545,lon:9.880,sog:82, cog:262,type:'Tanker',    len:253,wid:44,drg:109},
      {mmsi:'219091005',name:'ELBE PIONEER',   lat:53.527,lon:9.700,sog:66, cog:93, type:'Cargo',     len:155,wid:26,drg:68 },
      {mmsi:'477888008',name:'COSCO UNIVERSE', lat:53.543,lon:9.750,sog:104,cog:90, type:'Container', len:400,wid:59,drg:160},
    ];
    demo.forEach(s => { s.seen=Date.now(); saveShip(s); this.ships.set(s.mmsi,s); });
    this.onUpdate(this.ships);
    setInterval(() => {
      for (const s of this.ships.values()) {
        const east = s.cog>=30&&s.cog<=200;
        s.lon += east ? 0.007 : -0.007;
        if (s.lon>10.050) s.lon=9.110;
        if (s.lon<9.100)  s.lon=10.040;
        s.seen = Date.now();
        const eta = calcETA(s, this._getRefPoint());
        if (eta) { s.eta=eta; checkAlerts(s,eta); }
        saveShip(s);
      }
      this.onUpdate(this.ships);
    }, 3000);
    console.log('[AIS] Demo-Modus aktiv');
  }
}
module.exports = AISConnector;

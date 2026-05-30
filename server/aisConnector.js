'use strict';
const WebSocket      = require('ws');
const { calcETA, DEFAULT_REF } = require('./etaCalculator');
const { checkAlerts }= require('./telegramBot');
const { saveShip, getSetting, recordPassage, getActiveShips } = require('./db');

// Bekannte Cruise-Reedereien und einzigartige Schiffsnamen (Wortgrenzen!)
// Diese Regex matcht NUR ganze Wörter – kein "norwegian" in "norwegianforest"
const CRUISE_BRANDS = /\b(aida|aidanova|aidabella|aidaprima|aidaperla|aidamar|aidasol|aidadiva|aidaluna|aidablu|aidastella|aidacara|aidamira|aidacosma|norwegian|costa|carnival|celebrity|cunard|crystal|regent|oceania|hanseatic|columbus|princess cruises|royal caribbean|holland america|msc cruises|mein schiff|tui cruises?|queen mary|queen elizabeth|queen victoria|queen anne|silver(?:sea|shadow|spirit|whisper|wind|cloud|muse|nova|moon|dawn|ray|origin)|viking (?:sky|sea|star|ocean|orion|venus|mars|jupiter|saturn|polaris|sun|aton|neptune)|europa ?[12]?|disney (?:magic|wonder|dream|fantasy|wish|treasure))\b/i;

function shipType(code, name='', len=0) {
  const n = (name||'').toLowerCase();
  const c = +(code||0);

  // AIS-Typcode hat absolut Vorrang – zuverlässigste Quelle
  if (c>=60&&c<=69) return 'Cruise';
  if (c>=70&&c<=79) return 'Container';
  if (c>=80&&c<=89) return 'Tanker';
  if (c===30||c===31||c===32) return 'Cargo'; // Fishing/Towing

  // Namensbasierte Cruise-Erkennung: greift bei bekannten Marken
  // auch wenn Länge unbekannt (len=0) – viele im Hafen liegende Schiffe haben len=0
  if (CRUISE_BRANDS.test(n)) {
    // Sicherheitsnetz gegen Falsch-Positive bei sehr kleinen Schiffen
    if (len > 0 && len < 80) return 'Cargo'; // <80m kann kein Kreuzfahrtschiff sein
    return 'Cruise';
  }

  return 'Cargo';
}

class AISConnector {
  constructor(onUpdate) {
    this.onUpdate    = onUpdate;
    this.ships       = new Map();
    // Status-Tracking für /api/health und UI
    this.status = {
      connected:        false,
      lastMessageAt:    null,   // Unix-ms der letzten AIS-Nachricht
      lastConnectAt:    null,   // Wann zuletzt verbunden
      lastErrorAt:      null,
      lastErrorMessage: null,
      lastErrorCode:    null,
      certError:        false,  // wahr wenn letzter Fehler ein TLS-Cert-Problem war
      reconnectAttempts: 0,
      totalMessages:    0,
    };
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
      const stored = getActiveShips(60 * 60 * 1000); // 60 Min – passt zu SHIP_TTL_MS
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
    // Mindest-Box: gesamte Elbe von Cuxhaven bis Hamburg immer abgedeckt
    // Client-Viewport kann die Box erweitern aber nicht verkleinern
    const MIN_BOX = { n:53.950, s:53.350, w:7.800, e:10.200 };
    this.currentBox = {
      n: Math.max(box.n, MIN_BOX.n),
      s: Math.min(box.s, MIN_BOX.s),
      w: Math.min(box.w, MIN_BOX.w),
      e: Math.max(box.e, MIN_BOX.e),
    };
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
    if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
    console.log('[AIS] Verbinde mit aisstream.io …');
    this.ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    this.ws.on('open', () => {
      this.status.connected = true;
      this.status.lastConnectAt = Date.now();
      this.status.certError = false;
      console.log('[AIS] Verbunden');
      this._subscribe();

      // Ping/Pong Keepalive – hält die Verbindung aktiv
      this._pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try { this.ws.ping(); } catch(e) {}
        }
      }, 25000); // alle 25s

      // Backoff erst zurücksetzen wenn Verbindung >60s stabil war
      this._stableTimer = setTimeout(() => {
        this._reconnectDelay = 15000;
        this.status.reconnectAttempts = 0;
      }, 60000);
    });
    this.ws.on('pong', () => {
      // Server antwortet auf Ping – Verbindung ist lebendig
      this.status.lastPongAt = Date.now();
    });
    this.ws.on('message', data => {
      this.status.lastMessageAt = Date.now();
      this.status.totalMessages++;
      try { this._handleMsg(JSON.parse(data.toString('utf8'))); } catch(e) {}
    });
    this.ws.on('error', e => {
      this.status.lastErrorAt      = Date.now();
      this.status.lastErrorMessage = e.message;
      this.status.lastErrorCode    = e.code || null;
      const certCodes = ['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'];
      const isCertErr = certCodes.includes(e.code) || /certificate|cert\s|TLS|SSL/i.test(e.message);
      if (isCertErr) {
        this.status.certError = true;
        console.error(`[AIS] TLS-Zertifikatfehler: ${e.message} (${e.code||'-'}). Setze NODE_OPTIONS="--use-openssl-ca" oder NODE_TLS_REJECT_UNAUTHORIZED=0.`);
      } else {
        console.error('[AIS] Verbindungsfehler:', e.message);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.status.connected = false;
      this.status.reconnectAttempts++;
      if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
      if (this._stableTimer)  { clearTimeout(this._stableTimer);   this._stableTimer  = null; }

      const uptime = this.status.lastConnectAt ? Math.floor((Date.now() - this.status.lastConnectAt) / 1000) : 0;
      const codeMap = {
        1000: 'Normale Trennung',
        1001: 'Server geht offline',
        1006: 'Server-Timeout oder Netzwerkfehler',
        1011: 'Server-Fehler',
        1012: 'Server-Neustart',
      };
      const explain = codeMap[code] || `Code ${code}`;
      const delay = this._reconnectDelay || 15000;

      // Wenn Verbindung <30s hielt → Backoff erhöhen (Rapid-Disconnect-Schutz)
      if (uptime < 30) {
        this._reconnectDelay = Math.min((delay || 15000) * 1.5, 120000);
        console.warn(`[AIS] Getrennt nach ${uptime}s: ${explain} – Backoff → ${this._reconnectDelay/1000}s`);
      } else {
        // Stabile Verbindung → normaler 15s Reconnect
        this._reconnectDelay = 15000;
        console.log(`[AIS] Getrennt nach ${uptime}s: ${explain} – Reconnect in 15s`);
      }
      setTimeout(() => this._connect(), this._reconnectDelay);
    });
  }

  /** Aktueller AIS-Verbindungs-Status für /api/health & UI */
  getStatus() {
    const now = Date.now();
    const secSinceMsg = this.status.lastMessageAt ? Math.floor((now - this.status.lastMessageAt)/1000) : null;
    return {
      ...this.status,
      secondsSinceLastMessage: secSinceMsg,
      // healthy = verbunden UND in den letzten 5 Min Nachricht erhalten
      healthy: this.status.connected && secSinceMsg !== null && secSinceMsg < 300,
    };
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
    // Type immer neu evaluieren, wenn ein Name verfügbar ist (auch wenn nur in DB)
    const updateName = (meta.ShipName||'').trim() || ex.name || '';
    const reEvalType = updateName ? shipType(null, updateName, ex.len||0) : null;
    this._upsert({ mmsi, lat, lon,
      name:    updateName,
      // Reevaluiere Type wenn Name+Länge da sind, sonst bestehenden Type behalten
      type:    (reEvalType==='Cruise') ? 'Cruise' : (ex.type || reEvalType || 'Cargo'),
      dest:    ex.dest||'', cs: ex.cs||'',
      len:     ex.len||0, wid: ex.wid||0, drg: ex.drg||0,
      sog:     pr.Sog!=null ? +pr.Sog*10 : ex.sog,
      cog:     pr.Cog!=null ? +pr.Cog    : ex.cog,
      heading: pr.TrueHeading!=null&&+pr.TrueHeading<360 ? +pr.TrueHeading : ex.heading,
    });
  }

  _upsert(p) {
    const isNew = !this.ships.has(p.mmsi);
    const merged = { ...(this.ships.get(p.mmsi)||{}), ...p, seen: Date.now() };
    const eta = calcETA(merged, this._getRefPoint());
    if (eta) { merged.eta = eta; checkAlerts(merged, eta); recordPassage(merged, eta.direction); }
    this.ships.set(p.mmsi, merged);
    saveShip(merged);
    this.onUpdate(this.ships);
    // Foto im Hintergrund prefetchen wenn neues Schiff (nicht bei jedem Positionsupdate)
    if (isNew && this._prefetchPhoto) this._prefetchPhoto(p.mmsi);
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

'use strict';
const DEFAULT_REF = { name:'Willkomm-Höft', lat:53.5688, lon:9.6981 };

// Haversine-Distanz in Seemeilen
function distNmHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a)) / 1.852;
}

// Peilung vom Schiff zum Referenzpunkt in Grad (0-360)
function bearingTo(lat1, lon1, lat2, lon2) {
  const toRad = x => x * Math.PI / 180;
  const dLon  = toRad(lon2 - lon1);
  const y     = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x     = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function calcETA(ship, refPoint) {
  const REF = refPoint || DEFAULT_REF;
  if (!ship.lat || !ship.lon || !ship.sog || ship.sog < 15) return null;
  const knots   = ship.sog / 10;
  const heading = ship.cog ?? 0;

  // Echte Distanz in Seemeilen
  const distNm = distNmHaversine(ship.lat, ship.lon, REF.lat, REF.lon);

  // Peilung vom Schiff zum Referenzpunkt
  const brgToRef = bearingTo(ship.lat, ship.lon, REF.lat, REF.lon);

  // Schiff muss tatsächlich in Richtung Referenzpunkt fahren
  // Toleranz ±60° (Elbe-Fahrrinne macht Kurven)
  const diff = angleDiff(heading, brgToRef);
  if (diff > 60) return null;

  // Plausibilität: Schiff zu weit weg oder zu langsam → kein ETA
  if (distNm > 30) return null; // > 30 sm = > ~3h bei 10 kn, zu weit für sinnvolle Vorhersage
  const hours = distNm / knots;
  if (hours < 0 || hours > 4) return null;

  // Richtung grob aus Kurs ableiten (Hamburg = E, Nordsee = W)
  const toHamburg = heading >= 60 && heading <= 180;

  return {
    eta:       new Date(Date.now() + hours * 3600 * 1000),
    distNm:    +distNm.toFixed(2),
    direction: toHamburg ? 'Hamburg' : 'Nordsee',
    refName:   REF.name,
  };
}
module.exports = { calcETA, DEFAULT_REF };

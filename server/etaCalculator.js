'use strict';
// Willkomm-Höft Koordinaten
const WILLKOMM_LON = 9.6981;
const WILLKOMM_LAT = 53.5688;

/**
 * Berechnet ETA eines Schiffs am Willkomm-Höft.
 * Gibt null zurück wenn das Schiff nicht auf Kurs ist oder zu weit weg.
 */
function calcETA(ship) {
  if (!ship.lon || !ship.sog || ship.sog < 15) return null; // < 1.5 kn

  const knots = ship.sog / 10;
  const heading = ship.cog ?? 0;
  const toHamburg = heading >= 30 && heading <= 200;
  const toNordsee = !toHamburg;

  // Nähert sich das Schiff dem Willkomm-Höft?
  const approachingFromWest = toHamburg && ship.lon < WILLKOMM_LON - 0.01;
  const approachingFromEast = toNordsee && ship.lon > WILLKOMM_LON + 0.01;
  if (!approachingFromWest && !approachingFromEast) return null;

  // Distanz in Seemeilen (nur Längengrad-Differenz entlang der Elbe)
  const distNm = Math.abs((WILLKOMM_LON - ship.lon) * 60 * Math.cos(WILLKOMM_LAT * Math.PI / 180));
  const hours = distNm / knots;
  if (hours < 0 || hours > 8) return null;

  return {
    eta: new Date(Date.now() + hours * 3600 * 1000),
    distNm: +distNm.toFixed(2),
    direction: toHamburg ? 'Hamburg' : 'Nordsee',
  };
}

module.exports = { calcETA };

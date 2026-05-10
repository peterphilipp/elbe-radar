'use strict';
const DEFAULT_REF = { name:'Willkomm-Höft', lat:53.5688, lon:9.6981 };

function calcETA(ship, refPoint) {
  const REF = refPoint || DEFAULT_REF;
  if (!ship.lon || !ship.sog || ship.sog < 15) return null;
  const knots   = ship.sog / 10;
  const heading = ship.cog ?? 0;
  const toHamburg  = heading >= 30 && heading <= 200;
  const approaching = (toHamburg  && ship.lon < REF.lon - 0.01) ||
                      (!toHamburg && ship.lon > REF.lon + 0.01);
  if (!approaching) return null;
  const distNm = Math.abs((REF.lon - ship.lon) * 60 * Math.cos(REF.lat * Math.PI / 180));
  const hours  = distNm / knots;
  if (hours < 0 || hours > 8) return null;
  return {
    eta:       new Date(Date.now() + hours * 3600 * 1000),
    distNm:    +distNm.toFixed(2),
    direction: toHamburg ? 'Hamburg' : 'Nordsee',
    refName:   REF.name,
  };
}
module.exports = { calcETA, DEFAULT_REF };

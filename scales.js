"use strict";
// Which trucks are running into a weigh station, and which of them is news.
//
// A scale is a fixed point and the fleet drives past dozens of them a day, so
// the hard part is not the distance — it is not saying the same thing forty
// times. Three rules do that work:
//
//   coming, not going   a truck a hundred miles past a scale is also a hundred
//                       miles from it. Direction decides, taken from the
//                       truck's own course when the ELD reports one and from
//                       the distance closing when it does not.
//   once per approach   the first time inside the ring is the message. Nothing
//                       more until the truck leaves the ring well behind.
//   moving              a parked truck is not approaching anything.
//
// Kept apart from the server so these rules can be driven through a whole
// approach — far, closing, inside, past, back again — in a test instead of in
// production.

const R_MI = 3958.8, rad = Math.PI / 180;

function haversineMi(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const angleGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const DEFAULTS = {
  radiusMi: 100,      // how far out the warning goes
  clearMi: 40,        // ... and how far past it the truck must get to re-arm
  aheadDeg: 70,       // a hundred miles out the road bends; this is not a laser
  minMph: 5,          // parked is not approaching
  closingMi: 2,       // without a course, this much closer counts as closing
};

// One truck against one scale. `prev` is what was recorded last tick for this
// pair, which is how a truck with no course reported still gets judged.
function look(truck, scale, prev, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const radius = scale.mi > 0 ? scale.mi : o.radiusMi;
  if (!truck || truck.lat == null || truck.lon == null) return { state: "unknown" };

  const mi = haversineMi(truck.lat, truck.lon, scale.lat, scale.lon);
  // The margin past the ring is proportional to the ring: a hundred-mile
  // warning should not re-arm the moment a truck wobbles, and a twenty-mile
  // one for a city scale should not stay armed forty miles away.
  const margin = Math.max(10, Math.min(o.clearMi, radius * 0.4));
  if (mi > radius + margin) return { state: "away", mi };        // out of the ring: forget it
  if (mi > radius) return { state: "edge", mi };                 // in the margin: neither alert nor forget

  const parked = truck.speed != null && truck.speed < o.minMph;
  const course = truck.bearing != null ? truck.bearing : (truck.course != null ? truck.course : null);
  const toScale = bearingDeg(truck.lat, truck.lon, scale.lat, scale.lon);
  const byCourse = course != null ? angleGap(course, toScale) <= o.aheadDeg : null;
  const closing = prev && prev.mi != null ? mi <= prev.mi - o.closingMi : null;
  // The course is the better signal when it is there; the distance closing is
  // the fallback, and either one on its own is enough.
  const coming = byCourse === true || closing === true;

  if (parked) return { state: "parked", mi };
  if (!coming) return { state: byCourse === false || closing === false ? "leaving" : "watch", mi };
  return { state: "coming", mi, gap: byCourse == null ? null : Math.round(angleGap(course, toScale)) };
}

// The whole fleet against the whole list. Returns what to say now and the
// state to keep, so the caller never has to reason about either.
//
// seen: { "unit|scaleId": { mi, alertedAt } } — carried between ticks.
function sweep(fleet, scales, seen, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const next = { ...(seen || {}) };
  const hits = [];                      // [{ scale, unit, driver, mi, ... }]

  for (const truck of fleet || []) {
    if (!truck || !truck.unit) continue;
    for (const scale of scales || []) {
      if (!scale || scale.lat == null || scale.lon == null) continue;
      const key = `${truck.unit}|${scale.id}`;
      const prev = next[key];
      const r = look(truck, scale, prev, o);

      if (r.state === "unknown") continue;
      if (r.state === "away") { delete next[key]; continue; }

      // Remember where it is even when nothing is said: that is what makes the
      // next tick able to tell closing from leaving.
      const entry = { mi: Math.round(r.mi * 10) / 10, alertedAt: prev ? prev.alertedAt : null };
      next[key] = entry;

      if (r.state === "coming" && !entry.alertedAt) {
        hits.push({
          scale, unit: truck.unit, driver: truck.driver || "",
          mi: entry.mi, location: truck.location || "", speed: truck.speed ?? null,
        });
      }
    }
  }
  return { hits, seen: next };
}

// Mark what was actually delivered. Done after the send, not before: a message
// Telegram refused must still be waiting at the next tick.
function markSent(seen, hits, at) {
  const stamp = at || new Date().toISOString();
  for (const h of hits || []) {
    const key = `${h.unit}|${h.scale.id}`;
    if (seen[key]) seen[key].alertedAt = stamp;
  }
  return seen;
}

// One message per scale, listing the trucks heading for it — the same shape the
// weather alerts use, because the reader is the same person.
function group(hits) {
  const by = new Map();
  for (const h of hits || []) {
    const g = by.get(h.scale.id) || { scale: h.scale, units: [] };
    g.units.push(h);
    by.set(h.scale.id, g);
  }
  for (const g of by.values()) g.units.sort((a, b) => a.mi - b.mi);
  return [...by.values()];
}

module.exports = { look, sweep, markSent, group, haversineMi, bearingDeg, angleGap, DEFAULTS };

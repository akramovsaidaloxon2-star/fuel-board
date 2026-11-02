"use strict";
// Which stations are actually on the way, once the board knows where the
// truck is going.
//
// Without a destination the board could only guess "ahead" from the truck's
// heading — a fifty-degree cone that is right on a straight interstate and
// wrong at the first junction. With the delivery ZIP it has the road itself:
// a line from the truck to the ZIP, and a station is on the way if it sits
// beside that line, at a point the tank can reach.
//
// Kept apart from the server so the geometry can be tested against known
// coordinates instead of against whatever the routing service returns today.

const R_MI = 3958.8, rad = Math.PI / 180;

function haversineMi(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The router hands back thousands of points for a long trip. Keeping one
// every half mile is plenty to say which side of a station a truck passes,
// and it keeps the per-station search cheap.
function buildRoute(coords, stepMi) {
  const step = stepMi || 0.5;
  const pts = [];
  let along = 0, prev = null;
  for (const c of coords || []) {
    const lon = +c[0], lat = +c[1];                    // GeoJSON order
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (prev) {
      const d = haversineMi(prev.lat, prev.lon, lat, lon);
      along += d;
      if (d < step && pts.length && along - pts[pts.length - 1].along < step) {
        prev = { lat, lon };
        continue;
      }
    }
    pts.push({ lat, lon, along });
    prev = { lat, lon };
  }
  // The end of the trip always counts, however close the last kept point.
  if (prev && pts.length && (pts[pts.length - 1].lat !== prev.lat || pts[pts.length - 1].lon !== prev.lon)) {
    pts.push({ lat: prev.lat, lon: prev.lon, along });
  }
  const box = pts.reduce((b, p) => ({
    minLat: Math.min(b.minLat, p.lat), maxLat: Math.max(b.maxLat, p.lat),
    minLon: Math.min(b.minLon, p.lon), maxLon: Math.max(b.maxLon, p.lon),
  }), { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });
  return { pts, miles: along, box };
}

// How far a point is from the route, and how far along the route the truck
// is when it passes it. Each segment is flattened around the point itself —
// at these distances the error is well under the corridor width.
function locate(route, lat, lon) {
  const pts = route && route.pts;
  if (!pts || pts.length < 2) return null;
  const kx = Math.cos(lat * rad) * 69.172, ky = 69.0;
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * ky;
    const bx = (b.lon - lon) * kx, by = (b.lat - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const off = Math.sqrt(px * px + py * py);
    if (!best || off < best.off) best = { off, along: a.along + t * (b.along - a.along) };
  }
  return best;
}

// The stations worth naming, given a route and the fuel on board.
//
// stations: [{ num, lat, lon, ppg, city, st }]
// here:     the assigned stop, same shape
// opts:     { range, corridorMi, minPpgGap }
//
// "before" is any cheaper pump the truck reaches ahead of the assigned stop;
// "after" is one past it but still inside the tank's range. Both are certain
// now — they are on the road to the delivery, not on a guessed heading.
function cheaperOnRoute(route, stations, here, opts) {
  const o = { corridorMi: 3, minPpgGap: 0.10, ...(opts || {}) };
  if (!route || !route.pts || route.pts.length < 2 || !here) return null;
  const at = locate(route, here.lat, here.lon);
  if (!at) return null;
  // Rough box first: most of the country is nowhere near the trip.
  const pad = o.corridorMi / 60 + 0.05;
  const b = route.box;
  let bestBefore = null, bestAfter = null;
  for (const s of stations || []) {
    if (!s || s.num === here.num || typeof s.ppg !== "number") continue;
    if (s.ppg > here.ppg - o.minPpgGap) continue;
    if (s.lat < b.minLat - pad || s.lat > b.maxLat + pad || s.lon < b.minLon - pad || s.lon > b.maxLon + pad) continue;
    const p = locate(route, s.lat, s.lon);
    if (!p || p.off > o.corridorMi) continue;              // not on this road
    if (o.range != null && p.along > o.range) continue;    // tank runs out first
    const cand = { ...s, along: Math.round(p.along), off: Math.round(p.off * 10) / 10,
      side: p.along < at.along ? "before" : "after" };
    if (cand.side === "before") { if (!bestBefore || s.ppg < bestBefore.ppg) bestBefore = cand; }
    else if (!bestAfter || s.ppg < bestAfter.ppg) bestAfter = cand;
  }
  return {
    here: { ...here, along: Math.round(at.along), off: Math.round(at.off * 10) / 10 },
    // A stop more than a few miles off the road to the delivery is itself
    // worth knowing: the truck is being sent out of its way to fuel.
    offRoute: at.off > o.corridorMi,
    before: bestBefore, after: bestAfter,
    routeMiles: Math.round(route.miles),
  };
}

const ZIP_RE = /^\d{5}$/;

module.exports = { buildRoute, locate, cheaperOnRoute, haversineMi, ZIP_RE };

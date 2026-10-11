"use strict";
// Which trucks are inside a weather warning right now.
//
// The alerts come from the National Weather Service, which publishes each one
// either as a polygon drawn around the affected ground or as a list of forecast
// zones. Both shapes end up here as rings of coordinates, and the question is
// the same: is this truck standing inside one.
//
// Kept apart from the server so the geometry can be tested against known
// points instead of against whatever the weather happens to be doing.

// Ray casting. A point on the boundary is not worth special handling: a truck
// exactly on the edge of a storm is inside it for any purpose this serves.
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];      // GeoJSON order: lon, lat
    const straddles = (yi > lat) !== (yj > lat);
    if (!straddles) continue;
    const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (lon < xCross) inside = !inside;
  }
  return inside;
}

// A GeoJSON geometry may be one polygon or several, and each polygon may carry
// holes after its outer ring. A truck in a hole is not in the alert.
function pointInGeometry(lat, lon, geom) {
  if (!geom) return false;
  const polys = geom.type === "MultiPolygon" ? geom.coordinates
    : geom.type === "Polygon" ? [geom.coordinates] : [];
  for (const poly of polys) {
    if (!poly || !poly.length) continue;
    if (!pointInRing(lat, lon, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(lat, lon, poly[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

// Rough box first: a point-in-polygon test over a few hundred alerts times a
// hundred trucks adds up, and nearly every pair is nowhere near each other.
function boundsOf(geom) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  const polys = geom && geom.type === "MultiPolygon" ? geom.coordinates
    : geom && geom.type === "Polygon" ? [geom.coordinates] : [];
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  return maxLat < minLat ? null : { minLat, maxLat, minLon, maxLon };
}

// The events worth waking somebody for. A heat advisory is not a road
// condition; ice, wind, flood and the rest are.
const ROAD_EVENTS = [
  "ice", "freezing", "winter", "blizzard", "snow", "wind", "tornado",
  "hurricane", "tropical", "flood", "dust", "fog", "storm",
];
function isRoadEvent(event) {
  const e = String(event || "").toLowerCase();
  return ROAD_EVENTS.some((w) => e.includes(w));
}

// Warnings mean it is happening or about to; watches and advisories are a
// maybe, and a fleet told about every maybe stops reading the messages.
function isSevere(props) {
  const sev = String((props && props.severity) || "").toLowerCase();
  if (sev === "extreme" || sev === "severe") return true;
  return /warning/i.test(String((props && props.event) || ""));
}

// alerts: NWS GeoJSON features, each with { id, properties, geometry }.
// zoneGeom: { zoneId: geometry } for the alerts that name zones instead of
// drawing a polygon — the server fetches and caches those separately.
// trucks: [{ unit, driver, lat, lon, location }]
function matchAlerts(alerts, trucks, zoneGeom) {
  const out = [];
  for (const a of alerts || []) {
    const p = (a && a.properties) || {};
    if (!isSevere(p) || !isRoadEvent(p.event)) continue;

    const shapes = [];
    if (a.geometry) shapes.push(a.geometry);
    else for (const z of p.affectedZones || []) {
      const id = String(z).split("/").pop();
      if (zoneGeom && zoneGeom[id]) shapes.push(zoneGeom[id]);
    }
    if (!shapes.length) continue;                      // nothing to test against

    const boxes = shapes.map((g) => ({ g, b: boundsOf(g) }));
    const hit = [];
    // One line per truck however many times the fleet feed mentions it: a
    // paging hiccup upstream must not turn one truck into a wall of names.
    const listed = new Set();
    for (const t of trucks || []) {
      if (!t || t.lat == null || t.lon == null) continue;
      if (listed.has(t.unit)) continue;
      for (const { g, b } of boxes) {
        if (b && (t.lat < b.minLat || t.lat > b.maxLat || t.lon < b.minLon || t.lon > b.maxLon)) continue;
        if (pointInGeometry(t.lat, t.lon, g)) { hit.push(t); listed.add(t.unit); break; }
      }
    }
    if (hit.length) {
      out.push({
        id: a.id || p.id || `${p.event}|${p.areaDesc}`,
        event: p.event || "Weather alert",
        headline: p.headline || "",
        area: p.areaDesc || "",
        severity: p.severity || "",
        ends: p.ends || p.expires || null,
        units: hit,
      });
    }
  }
  return out;
}

module.exports = { matchAlerts, pointInGeometry, pointInRing, boundsOf, isRoadEvent, isSevere };

// --- Radar picture for a message ---
// The National Weather Service publishes a looping radar image per region,
// free and without a key, and Telegram fetches a URL itself — so a message
// can carry the weather rather than only describe it. Regions are coarse
// boxes; a truck in Chicago gets the Great Lakes loop, not a national one
// where its storm is four pixels wide.
// Order matters: the boxes overlap where the mosaics do, and the first match
// wins, so the region a city actually belongs to is listed ahead of its
// neighbour. Chicago is Central Great Lakes, not Upper Mississippi Valley;
// Midland is South Plains, not Southern Rockies.
const RADAR_REGIONS = [
  { id: "ALASKA", minLat: 51, maxLat: 72, minLon: -170, maxLon: -130 },
  { id: "HAWAII", minLat: 18, maxLat: 23, minLon: -161, maxLon: -154 },
  { id: "PACNORTHWEST", minLat: 42, maxLat: 50, minLon: -125, maxLon: -116 },
  { id: "PACSOUTHWEST", minLat: 31, maxLat: 42, minLon: -125, maxLon: -114 },
  { id: "SOUTHROCKIES", minLat: 31, maxLat: 42, minLon: -115, maxLon: -103 },
  { id: "NORTHROCKIES", minLat: 41, maxLat: 50, minLon: -117, maxLon: -96 },
  { id: "SOUTHPLAINS", minLat: 25, maxLat: 41, minLon: -103, maxLon: -91 },
  { id: "CENTGRLAKES", minLat: 38, maxLat: 50, minLon: -92, maxLon: -78 },
  { id: "UPPERMISSVLY", minLat: 41, maxLat: 50, minLon: -98, maxLon: -87 },
  { id: "SOUTHMISSVLY", minLat: 28, maxLat: 40, minLon: -95, maxLon: -82 },
  { id: "NORTHEAST", minLat: 38, maxLat: 48, minLon: -82, maxLon: -66 },
  { id: "SOUTHEAST", minLat: 24, maxLat: 39, minLon: -86, maxLon: -74 },
];

function radarRegion(lat, lon) {
  if (lat == null || lon == null) return "CONUS";
  for (const r of RADAR_REGIONS) {
    if (lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon) return r.id;
  }
  return "CONUS";
}

function radarUrl(lat, lon) {
  return `https://radar.weather.gov/ridge/standard/${radarRegion(lat, lon)}_loop.gif`;
}

module.exports.radarRegion = radarRegion;
module.exports.radarUrl = radarUrl;

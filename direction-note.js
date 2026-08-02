"use strict";
// Turn a Google Maps link into the written route note dispatch sends drivers:
//
//   I 95 South > Exit 89 > I 495 South
//   I 495 South > Exit 65B > I 290 West
//
// The pieces that decide what the note says — pulling waypoints out of a link,
// and folding a routing engine's steps into those lines — are kept pure here so
// they can be tested without reaching the network.

// --- Waypoints out of a Google Maps URL -------------------------------------
// Maps links arrive in several shapes: /dir/ paths with places or coordinates,
// the ?api=1 form with origin/destination/waypoints, and /place/ links that
// only carry an @lat,lng. Short links redirect into one of these, so they are
// resolved before parsing.
const COORD_RE = /^(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/;

function asCoord(seg) {
  const m = COORD_RE.exec(String(seg || "").trim());
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  // Reject the @lat,lng,17z camera segment's zoom and anything off-globe.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function cleanSegment(seg) {
  let s = String(seg || "");
  try { s = decodeURIComponent(s); } catch { /* leave as-is if not valid escaping */ }
  return s.replace(/\+/g, " ").trim();
}

// A /dir/ path segment that describes the map view or Google's own state
// rather than a stop the driver passes through.
function isNoise(seg) {
  return !seg || seg.startsWith("@") || seg.startsWith("data=") || /^[a-z]+=/.test(seg) || seg === "dir" || seg === "maps";
}

function parseMapsPoints(url) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const last = out[out.length - 1];
    // Consecutive duplicates come from links that repeat the destination.
    if (last && JSON.stringify(last) === JSON.stringify(v)) return;
    out.push(v);
  };

  let u;
  try { u = new URL(String(url)); } catch { return out; }

  // ?api=1 form — explicit and unambiguous, so it wins when present.
  const q = u.searchParams;
  const origin = q.get("origin") || q.get("saddr");
  const dest = q.get("destination") || q.get("daddr");
  const via = q.get("waypoints") || q.get("waypoint");
  if (origin || dest) {
    for (const raw of [origin, ...(via ? via.split(/[|]/) : []), dest]) {
      if (!raw) continue;
      const seg = cleanSegment(raw);
      const c = asCoord(seg);
      push(c || { place: seg });
    }
    return out;
  }

  // /maps/dir/<stop>/<stop>/... — the shape you get from the Maps UI.
  const parts = u.pathname.split("/").filter(Boolean).map(cleanSegment);
  const dirAt = parts.indexOf("dir");
  if (dirAt >= 0) {
    for (const seg of parts.slice(dirAt + 1)) {
      if (isNoise(seg)) continue;
      const c = asCoord(seg);
      push(c || { place: seg });
    }
    if (out.length) return out;
  }

  // /maps/place/<name>/@lat,lng — a single pin, not a route.
  const placeAt = parts.indexOf("place");
  if (placeAt >= 0 && parts[placeAt + 1]) push({ place: parts[placeAt + 1] });
  const at = parts.find((p) => p.startsWith("@"));
  if (at) {
    const c = asCoord(at.slice(1).split(",").slice(0, 2).join(","));
    if (c && !out.length) push(c);
  }
  return out;
}

// A directions link built by the Maps UI often carries its stops only inside
// the data= blob, as !1d<lon>!2d<lat> pairs in travel order — the readable
// /dir/ path segments may be missing or reduced to a single place. Used as a
// fallback when the path yields fewer than two stops.
function parseDataWaypoints(url) {
  const out = [];
  for (const m of String(url || "").matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)) {
    const lon = +m[1], lat = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) out.push({ lat, lon });
  }
  return out;
}

// --- Route steps into written directions ------------------------------------
// A road's name comes from its ref ("I 95"). The compass half is the half that
// goes wrong: "I 81 South" is what the sign says, but the ramp joining it can
// curve through west, so the heading at the moment of the merge is no guide.
// In order of trust: the sign text the map data carries, then the direction the
// road actually runs over its whole length, and only then the turn heading.
function cardinal(bearing) {
  if (!Number.isFinite(bearing)) return "";
  const b = ((bearing % 360) + 360) % 360;
  if (b >= 315 || b < 45) return "North";
  if (b < 135) return "East";
  if (b < 225) return "South";
  return "West";
}

const CARD = { n: "North", s: "South", e: "East", w: "West" };
// Sign text reads "I 81 South, Wilkes-Barre" or "I-81 S; Harrisburg".
function cardinalFromSign(text) {
  const s = String(text || "");
  const word = s.match(/\b(north|south|east|west)\b/i);
  if (word) return CARD[word[1][0].toLowerCase()];
  const letter = s.match(/\b[A-Za-z]{1,3}[- ]?\d+[A-Za-z]?\s+([NSEW])\b/);
  return letter ? CARD[letter[1].toLowerCase()] : "";
}

function bearingBetween(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return NaN;
  const [lon1, lat1] = [+a[0], +a[1]], [lon2, lat2] = [+b[0], +b[1]];
  if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return NaN;
  const toR = Math.PI / 180;
  const p1 = lat1 * toR, p2 = lat2 * toR, dl = (lon2 - lon1) * toR;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Where this step's road actually goes: from where it starts to where the next
// manoeuvre picks up. A 125-mile run south reads as south however the on-ramp
// happened to be pointing.
function travelBearing(list, i) {
  const here = list[i] && list[i].maneuver && list[i].maneuver.location;
  const next = list[i + 1] && list[i + 1].maneuver && list[i + 1].maneuver.location;
  return bearingBetween(here, next);
}

// OSM refs can carry several designations at once ("I 95;US 1"); the first is
// the one signs lead with.
function roadRef(step) {
  const ref = String((step && step.ref) || "").split(";")[0].trim();
  if (ref) return ref;
  const name = String((step && step.name) || "").trim();
  return name;
}

// { ref, dir } rather than one string, so two labels can be compared by road
// without having to guess which trailing word was the compass half.
function roadLabel(step, list, i, signHint) {
  const ref = roadRef(step);
  if (!ref) return null;
  const dir = cardinalFromSign(signHint)
    || cardinalFromSign(step && step.destinations)
    || cardinal(travelBearing(list, i))
    || cardinal(step && step.maneuver && step.maneuver.bearing_after);
  return { ref, dir };
}

function labelText(label) {
  if (!label) return "";
  return label.dir ? `${label.ref} ${label.dir}` : label.ref;
}

// The exit number lives on the ramp step, but only sometimes: OSM tags it as
// `exits` on the maneuver, and on interchanges without a numbered exit there is
// nothing to show, in which case the line still names both roads.
function exitNumber(step) {
  const raw = step && (step.exits || (step.maneuver && step.maneuver.exit));
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  // "89" or "65B"; a bare small integer on a roundabout is a count, not a sign.
  return /^\d{1,3}[A-Za-z]?$/.test(s) ? s : "";
}

const RAMP_TYPES = new Set(["off ramp", "on ramp", "fork", "merge"]);

function directionLines(steps) {
  const lines = [];
  const list = Array.isArray(steps) ? steps : [];
  let current = null;

  for (let i = 0; i < list.length; i++) {
    const step = list[i];
    const label = roadLabel(step, list, i);
    const type = (step && step.maneuver && step.maneuver.type) || "";

    if (!current) { if (isRoad(label)) current = label; continue; }

    if (!RAMP_TYPES.has(type)) {
      // Staying on the same road still refreshes the compass half, so a run
      // that turns south later reads "I 81 South" and not the heading it had
      // when it was first joined.
      if (label && label.ref === current.ref) current = label;
      continue;
    }

    // The ramp itself is usually unnamed; the road being joined is the next
    // step carrying a ref of its own. The ramp's sign text names where it goes
    // ("I 81 South, Wilkes-Barre"), so it settles the direction of that road.
    const hint = step && step.destinations;
    let next = isRoad(label) ? label : null;
    for (let j = i + 1; j < list.length && !next; j++) {
      const cand = roadLabel(list[j], list, j, hint);
      if (isRoad(cand)) next = cand;
    }
    if (!next || next.ref === current.ref) continue;
    if (!next.dir) next = { ref: next.ref, dir: cardinalFromSign(hint) };

    const exit = exitNumber(step);
    lines.push(exit
      ? `${labelText(current)} > Exit ${exit} > ${labelText(next)}`
      : `${labelText(current)} > ${labelText(next)}`);
    current = next;
  }
  return lines;
}

function isRoad(label) {
  // Ramps and service roads come through as empty or as a street name with no
  // designation; a route note is only useful when it names a signed road.
  return !!label && /^[A-Za-z]{1,3}\s?-?\d/.test(String(label.ref || "").trim());
}

// --- The note itself --------------------------------------------------------
function formatMiles(mi) {
  return Number.isFinite(mi) ? (Math.round(mi * 100) / 100).toString() : "";
}

function buildNote({ lines, dhMiles, routeMiles, dispatchedMiles }) {
  const body = [];
  body.push("#DIRECTION", "", "After PU please follow the direction !!", "");
  if (lines && lines.length) body.push(...lines.map((l) => l), "");
  else body.push("(yo'nalish topilmadi — linkni tekshiring)", "");
  if (Number.isFinite(dhMiles)) body.push(`DH: ${formatMiles(dhMiles)}`);
  if (Number.isFinite(dispatchedMiles)) body.push(`Dispatched loaded miles: ${Math.round(dispatchedMiles)}`);
  if (Number.isFinite(routeMiles)) body.push(`Loaded miles with direction: ${Math.round(routeMiles)}`);
  return body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  parseMapsPoints,
  parseDataWaypoints,
  directionLines,
  buildNote,
  cardinal,
  cardinalFromSign,
  roadLabel,
  labelText,
  exitNumber,
  formatMiles,
};

"use strict";
// Who was driving when the toll was read.
//
// The toll report says a transponder went through an Illinois Tollway plaza at
// 14:32 and nothing else — no truck number. Motive, meanwhile, knows where
// every truck in the fleet was at 14:32. So the question is not "where did
// this transponder go" but "which of our trucks was standing in that place at
// that minute", which is a question the fleet's own history can answer.
//
// One crossing on its own is weak evidence: three trucks can be in Illinois at
// once. A whole report is strong evidence: a transponder lives in one truck
// for weeks, so the truck that fits every crossing — and not just one — is the
// truck the transponder is bolted into. That is why this works at the device
// level and treats each row as a vote rather than as an answer.

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Motive writes its locations as "7 mi NE of Gary, IN". The two letters on the
// end are the only state information available without a map of borders, and
// they are enough: a toll agency belongs to a state, and a truck either was in
// that state or it was not.
function stateOf(p) {
  const d = String((p && (p.state || p.description || p.location)) || "");
  if (/^[A-Z]{2}$/.test(d.trim())) return d.trim();
  const m = d.match(/,\s*([A-Za-z]{2})\b\s*(?:\d{5})?\s*$/) || d.match(/\b([A-Z]{2})\b\s*$/);
  return m ? m[1].toUpperCase() : "";
}

// Where a truck was at a given moment, read off its breadcrumb trail. Between
// two points it is interpolated; the gap to the nearer point is carried along,
// because a position stitched across a four-hour silence is not evidence of
// anything.
function posAt(points, atISO) {
  const t = Date.parse(atISO);
  if (!Number.isFinite(t) || !points || !points.length) return null;
  const pts = points
    .filter((p) => p && p.lat != null && p.lon != null && Number.isFinite(Date.parse(p.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!pts.length) return null;

  let before = null, after = null;
  for (const p of pts) {
    const pt = Date.parse(p.at);
    if (pt <= t) before = p;
    else { after = p; break; }
  }
  const gapMin = (p) => Math.abs(t - Date.parse(p.at)) / 60000;
  if (!before) return { lat: pts[0].lat, lon: pts[0].lon, gapMin: gapMin(pts[0]), from: pts[0], bracketed: false };
  if (!after) return { lat: before.lat, lon: before.lon, gapMin: gapMin(before), from: before, bracketed: false };

  const t0 = Date.parse(before.at), t1 = Date.parse(after.at);
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const near = gapMin(before) <= gapMin(after) ? before : after;
  return {
    lat: before.lat + (after.lat - before.lat) * f,
    lon: before.lon + (after.lon - before.lon) * f,
    gapMin: gapMin(near),
    spanMin: (t1 - t0) / 60000,
    from: near,
    bracketed: true,
  };
}

// How close counts as "at the plaza". A toll is read as the truck rolls
// through, but the trail is sampled every few minutes, so the position nearest
// the crossing can legitimately be a few miles up the road. Beyond about an
// hour's driving it is a different truck.
const NEAR_MI = 25;
const PLAUSIBLE_MI = 60;
// A position carried more than this far from a real reading says where the
// truck roughly was, not where it was.
const STALE_MIN = 120;

function plazaKey(agency, plaza) {
  return `${String(agency || "").trim().toUpperCase()}|${String(plaza || "").trim().toUpperCase()}`;
}

// Coordinates for the plaza named on the row, if any have been learned. Both
// the agency-qualified name and the bare name are tried: the same plaza name
// can appear under two agencies, but a hand-filled table usually has one.
function plazaPos(row, plazas) {
  if (!plazas) return null;
  const names = [row.exitPlaza, row.entryPlaza].filter(Boolean);
  for (const n of names) {
    const hit = plazas[plazaKey(row.agency, n)] || plazas[plazaKey("", n)] || plazas[String(n).trim().toUpperCase()];
    if (hit && hit.lat != null && hit.lon != null) return hit;
  }
  return null;
}

// One crossing, every truck considered. Returns the candidates in order of how
// well they fit, and says what the fit was based on so a dispatcher can judge
// it rather than take it on faith.
function matchRow(row, tracks, plazas) {
  const plaza = plazaPos(row, plazas);
  const want = new Set(row.states || []);
  const cands = [];
  let noData = 0;

  for (const unit of Object.keys(tracks || {})) {
    const tr = tracks[unit] || {};
    const p = posAt(tr.points, row.at);
    if (!p) { noData++; continue; }
    const st = stateOf(p.from);
    const inState = want.size ? want.has(st) : false;
    const mi = plaza ? haversineMi(p.lat, p.lon, plaza.lat, plaza.lon) : null;
    const stale = p.gapMin > STALE_MIN;

    // What makes a truck a candidate. With no plaza coordinates, being in the
    // agency's state is all there is to go on. With surveyed coordinates, the
    // distance decides and nothing else. With coordinates that were merely
    // geocoded from the plaza's name, the distance is a hint rather than a
    // fact — a name can land on a town centre twenty miles off the ramp — so
    // it narrows the field without being allowed to rule out a truck that was
    // demonstrably in the right state.
    const near = mi != null && mi <= NEAR_MI;
    const approx = !!(plaza && plaza.approx);
    let ok;
    if (!plaza) ok = inState;
    else if (approx) ok = (inState || near) && mi <= 200;
    else ok = mi <= PLAUSIBLE_MI;
    if (!ok) continue;

    cands.push({
      unit,
      driver: tr.driver || "",
      lat: Math.round(p.lat * 1e5) / 1e5,
      lon: Math.round(p.lon * 1e5) / 1e5,
      where: String((p.from && (p.from.description || p.from.location)) || ""),
      st,
      mi: mi == null ? null : Math.round(mi * 10) / 10,
      gapMin: Math.round(p.gapMin),
      inState,
      near,
      stale,
      // A number only for ranking, not for showing: near beats in-state,
      // in-state beats plausible, and a fresh reading beats a stale one.
      score: (near ? 100 : 0) + (inState ? 50 : 0) + (stale ? 0 : 20) +
        (mi == null ? 0 : Math.max(0, 30 - mi / 2)) + Math.max(0, 20 - p.gapMin / 10),
    });
  }

  cands.sort((a, b) => b.score - a.score || (a.mi == null ? 1e9 : a.mi) - (b.mi == null ? 1e9 : b.mi));
  const best = cands[0] || null;
  const runner = cands[1] || null;
  return {
    row: row.row,
    at: row.at,
    exact: row.exact,
    agency: row.agencyName || row.agency,
    plaza: row.exitPlaza || row.entryPlaza,
    plazaKnown: !!plaza,
    toll: row.toll,
    miles: row.miles,
    device: row.device,
    given: row.unit || "",
    candidates: cands.slice(0, 5),
    unit: best ? best.unit : "",
    driver: best ? best.driver : "",
    // One truck and no other is the only case worth calling decided.
    decided: !!(best && (!runner || best.score - runner.score >= 40)),
    noData,
  };
}

// The whole report, one answer per transponder.
//
// Each crossing votes. A truck that fits a crossing gains a vote; a truck that
// had a known position somewhere else loses one. A transponder stays in a
// truck, so after thirty crossings the right truck is not merely ahead — it is
// the only one that never contradicts the report.
function matchDevices(tolls, tracks, plazas, opts) {
  const o = opts || {};
  const minRows = o.minRows || 3;
  const byDevice = new Map();
  const rows = [];

  for (const t of tolls || []) {
    const m = matchRow(t, tracks, plazas);
    rows.push(m);
    const key = t.device || t.plate || "(nomsiz)";
    const d = byDevice.get(key) || {
      device: key, plate: t.plate || "", rows: 0, usable: 0,
      from: t.at, to: t.at, tally: new Map(), given: new Set(),
    };
    d.rows++;
    if (t.at < d.from) d.from = t.at;
    if (t.at > d.to) d.to = t.at;
    if (t.unit) d.given.add(t.unit);

    // A crossing nobody could be placed at teaches nothing either way.
    const anyPosition = Object.keys(tracks || {}).some((u) => posAt((tracks[u] || {}).points, t.at));
    if (!anyPosition) { byDevice.set(key, d); continue; }
    d.usable++;

    const fits = new Set(m.candidates.map((c) => c.unit));
    for (const unit of Object.keys(tracks || {})) {
      const p = posAt((tracks[unit] || {}).points, t.at);
      const e = d.tally.get(unit) || { unit, driver: (tracks[unit] || {}).driver || "", hit: 0, miss: 0, blind: 0, best: null };
      if (!p || p.gapMin > STALE_MIN) e.blind++;
      else if (fits.has(unit)) {
        e.hit++;
        const c = m.candidates.find((x) => x.unit === unit);
        if (c && (e.best == null || (c.mi != null && c.mi < e.best))) e.best = c.mi;
      } else e.miss++;
      d.tally.set(unit, e);
    }
    byDevice.set(key, d);
  }

  const devices = [...byDevice.values()].map((d) => {
    const units = [...d.tally.values()]
      .map((e) => ({
        ...e,
        // Out of the crossings where this truck's whereabouts were actually
        // known, how many put it at the toll.
        rate: e.hit + e.miss ? e.hit / (e.hit + e.miss) : 0,
      }))
      .filter((e) => e.hit > 0)
      .sort((a, b) => b.hit - a.hit || b.rate - a.rate);
    const top = units[0] || null;
    const next = units[1] || null;

    let verdict = "topilmadi", unit = "", driver = "";
    if (top && d.usable >= minRows) {
      const clear = !next || top.hit >= next.hit * 1.5 + 1;
      if (top.rate >= 0.9 && clear) verdict = "ishonchli";
      else if (top.rate >= 0.6 && clear) verdict = "ehtimol";
      else verdict = "aniq emas";
      if (verdict !== "aniq emas") { unit = top.unit; driver = top.driver; }
    } else if (top) verdict = "ma'lumot kam";

    return {
      device: d.device, plate: d.plate, rows: d.rows, usable: d.usable,
      from: d.from, to: d.to,
      given: [...d.given],
      unit, driver, verdict,
      hit: top ? top.hit : 0, miss: top ? top.miss : 0,
      rate: top ? Math.round(top.rate * 100) : 0,
      candidates: units.slice(0, 5).map((e) => ({
        unit: e.unit, driver: e.driver, hit: e.hit, miss: e.miss, blind: e.blind,
        rate: Math.round(e.rate * 100), bestMi: e.best,
      })),
    };
  }).sort((a, b) => b.rows - a.rows);

  return { rows, devices };
}

module.exports = {
  matchRow, matchDevices, posAt, stateOf, haversineMi, plazaKey,
  NEAR_MI, PLAUSIBLE_MI, STALE_MIN,
};

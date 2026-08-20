"use strict";
// Check a fuel-card report against what actually went into the tanks.
//
// The question every line has to answer is: how many gallons per percentage
// point of tank? For one truck that number is a constant — it is the tank. So
// the truck's own history is the measuring stick, and no tank capacity has to
// be known or configured:
//
//   20% -> 100% on 100 gal  =>  1.25 gal per point  (a ~125 gal tank)
//   35% -> 100% on 150 gal  =>  2.31 gal per point  (a ~231 gal tank)
//
// Same truck, so the second line is short about 69 gallons: they were paid for
// and never arrived in the tank.
//
// Nothing here decides that somebody stole fuel. A failed sensor, a second
// tank, or fuel put into a reefer all look wrong the same way. It marks the
// lines a person should look at, with the numbers that made them stand out.

const HOURS = 3600000;

// A card swipe and the tank's rise are minutes apart at best: the truck reports
// on its own schedule, and a fill takes a while. Anything inside this window is
// treated as the same event.
const MATCH_WINDOW_MS = 3 * HOURS;
// Two readings of the same tank never agree exactly — the gauge is coarse, the
// truck may be on a slope, and diesel volume moves with temperature. Only a
// gap wider than this is worth a person's time.
const TOLERANCE = 0.25;
// Below this the arithmetic is too shaky to accuse anyone: a 4-point rise on a
// coarse gauge can be off by half its own size.
const MIN_PCT_RISE = 8;
// One fill proves nothing about a truck; the baseline needs a few to be a
// baseline rather than an anecdote.
const MIN_SAMPLES = 2;

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const timeOf = (v) => (typeof v === "number" ? v : Date.parse(v));

// Gallons per percentage point, expressed as the tank capacity it implies —
// easier to sanity-check against a truck you know.
function impliedCapacity(gallons, pctRise) {
  if (!(gallons > 0) || !(pctRise > 0)) return null;
  return (gallons / pctRise) * 100;
}

// The fill whose rise lines up with this transaction in time. Location is used
// to break ties when two fills are equally close, not to reject a match: a
// station's coordinates and the truck's reported position rarely agree well
// enough to throw a line away on that alone.
function matchFill(txn, fills, usedIds) {
  const t = timeOf(txn.at);
  if (!Number.isFinite(t)) return null;
  let best = null, bestGap = Infinity;
  for (let i = 0; i < fills.length; i++) {
    if (usedIds.has(i)) continue;
    const f = fills[i];
    const start = timeOf(f.at), end = timeOf(f.endAt || f.at);
    if (!Number.isFinite(start)) continue;
    const gap = t < start ? start - t : (t > end ? t - end : 0);
    if (gap > MATCH_WINDOW_MS) continue;
    if (gap < bestGap) { best = { fill: f, index: i, gapMs: gap }; bestGap = gap; }
  }
  return best;
}

// One unit's transactions against one unit's fills.
function auditUnit(unit, txns, fills, opts) {
  const o = opts || {};
  const tolerance = o.tolerance == null ? TOLERANCE : o.tolerance;
  const nominalGal = o.nominalGal || null;
  const rows = [];
  const usedIds = new Set();

  const ordered = txns.slice().sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const list = (fills || []).slice().sort((a, b) => timeOf(a.at) - timeOf(b.at));

  // Pass one: pair each transaction with the tank rise it should have caused.
  const paired = ordered.map((txn) => {
    const m = matchFill(txn, list, usedIds);
    if (m) usedIds.add(m.index);
    const rise = m ? +(m.fill.to - m.fill.from).toFixed(1) : null;
    return {
      txn,
      fill: m ? m.fill : null,
      gapMin: m ? Math.round(m.gapMs / 60000) : null,
      rise,
      capacity: m ? impliedCapacity(txn.gallons, rise) : null,
    };
  });

  // The truck's own measuring stick: what its fills usually say the tank holds.
  // Only rises big enough to be measured get a vote.
  const samples = paired
    .filter((p) => p.capacity && p.rise >= MIN_PCT_RISE)
    .map((p) => p.capacity);
  const baseline = samples.length >= MIN_SAMPLES ? median(samples) : (nominalGal || null);
  const baselineFrom = samples.length >= MIN_SAMPLES ? "history" : (nominalGal ? "nominal" : "none");

  for (const p of paired) {
    const { txn, fill, rise, capacity } = p;
    const row = {
      unit,
      at: txn.at,
      gallons: txn.gallons,
      station: txn.station || "",
      rise,
      impliedGal: capacity == null ? null : Math.round(capacity),
      baselineGal: baseline == null ? null : Math.round(baseline),
      baselineFrom,
      gapMin: p.gapMin,
      lat: fill ? fill.lat : null,
      lon: fill ? fill.lon : null,
      verdict: "ok",
      reason: "",
      missingGal: null,
    };

    if (!fill) {
      // "The tank never moved" is the strongest accusation this makes, so it
      // is only allowed where a fill would actually have been recorded. With no
      // fills for the unit, or a purchase from before recording started, the
      // silence means nothing was watching — not that nothing happened.
      const tt = timeOf(txn.at);
      if (!list.length) {
        row.verdict = "unknown";
        row.reason = "bu unit uchun quyish yozuvlari yo'q — sensori yo'q yoki hali yozilmagan";
      } else if (o.historyFrom && Number.isFinite(tt) && tt < o.historyFrom) {
        row.verdict = "unknown";
        row.reason = "bu sana quyish tarixi boshlanishidan oldin — tekshirib bo'lmaydi";
      } else {
        row.verdict = "suspicious";
        row.reason = "bak ko'tarilmagan — bu vaqtda quyish qayd etilmagan";
        row.missingGal = Math.round(txn.gallons);
      }
      rows.push(row);
      continue;
    }
    if (rise < MIN_PCT_RISE) {
      row.verdict = "check";
      row.reason = `bak atigi ${rise}% ko'tarilgan — o'lchov ishonchsiz`;
      rows.push(row);
      continue;
    }
    if (baseline == null) {
      row.verdict = "unknown";
      row.reason = "taqqoslash uchun tarix yetarli emas (kamida 2 ta quyish kerak)";
      rows.push(row);
      continue;
    }

    const expected = (rise / 100) * baseline;
    const diff = txn.gallons - expected;
    const off = Math.abs(diff) / baseline;
    if (off > tolerance) {
      row.verdict = "suspicious";
      row.missingGal = Math.round(diff);
      row.reason = diff > 0
        ? `${Math.round(diff)} gal ortiqcha — bak ko'tarilishi ${Math.round(expected)} gal ni ko'rsatadi`
        : `${Math.round(-diff)} gal kam — bak ko'rsatganidan ozroq to'langan`;
    }
    rows.push(row);
  }

  // Fills nobody paid for on this card: not fraud on its own — cash, another
  // card, or a week boundary — but it belongs in the same picture.
  for (let i = 0; i < list.length; i++) {
    if (usedIds.has(i)) continue;
    const f = list[i];
    const rise = +(f.to - f.from).toFixed(1);
    if (rise < MIN_PCT_RISE) continue;
    rows.push({
      unit, at: f.at, gallons: null, station: "",
      rise, impliedGal: null,
      baselineGal: baseline == null ? null : Math.round(baseline),
      baselineFrom, gapMin: null, lat: f.lat, lon: f.lon,
      verdict: "unpaid",
      reason: `bak ${rise}% ko'tarilgan, lekin hisobotda bunday xarid yo'q`,
      missingGal: null,
    });
  }

  rows.sort((a, b) => timeOf(a.at) - timeOf(b.at));
  return rows;
}

// Card reports timestamp a purchase in the station's local time; the fills are
// recorded in UTC. Rather than ask which timezone a report is in — the answer
// changes as trucks cross the country — measure it: pair each purchase with its
// nearest fill, and the offset that keeps showing up is the report's.
function estimateOffsetMs(txns, events) {
  const deltas = [];
  const wide = 14 * HOURS;
  for (const t of txns || []) {
    const u = String(t.unit == null ? "" : t.unit).trim();
    const fills = (events || {})[u];
    if (!fills || !fills.length) continue;
    const tt = timeOf(t.at);
    if (!Number.isFinite(tt)) continue;
    let best = null, bestAbs = Infinity;
    for (const f of fills) {
      const ft = timeOf(f.at);
      if (!Number.isFinite(ft)) continue;
      const d = ft - tt;
      if (Math.abs(d) <= wide && Math.abs(d) < bestAbs) { best = d; bestAbs = Math.abs(d); }
    }
    if (best != null) deltas.push(best);
  }
  // Under about a dozen pairs the median is as likely to be noise as signal.
  if (deltas.length < 12) return { offsetMs: 0, samples: deltas.length, hours: 0 };
  const m = median(deltas);
  // Report timezones are whole hours; rounding keeps a few stray matches from
  // dragging the whole report sideways by a few minutes.
  const hours = Math.round(m / HOURS);
  return { offsetMs: hours * HOURS, samples: deltas.length, hours };
}

// txns: [{ unit, at, gallons, station? }] — one week of card lines.
// events: { unit: [ {at, endAt, from, to, lat, lon} ] } — recorded fills.
function auditReport(txns, events, opts) {
  const o = opts || {};
  const tz = o.offsetMs == null ? estimateOffsetMs(txns, events) : { offsetMs: o.offsetMs, samples: null, hours: o.offsetMs / HOURS };
  const byUnit = {};
  for (const t of txns || []) {
    const u = String(t.unit == null ? "" : t.unit).trim();
    if (!u || !(t.gallons > 0)) continue;
    // Shift the purchase onto the clock the fills were recorded on.
    const shifted = tz.offsetMs ? { ...t, at: new Date(timeOf(t.at) + tz.offsetMs).toISOString(), localAt: t.at } : t;
    (byUnit[u] = byUnit[u] || []).push(shifted);
  }
  // Nothing before the first fill ever recorded can be judged, whichever unit
  // it belongs to: that is simply where the record starts.
  let historyFrom = o.historyFrom;
  if (historyFrom == null) {
    for (const u of Object.keys(events || {})) {
      for (const f of events[u] || []) {
        const t = timeOf(f.at);
        if (Number.isFinite(t) && (historyFrom == null || t < historyFrom)) historyFrom = t;
      }
    }
  }
  const unitOpts = { ...o, historyFrom };
  const rows = [];
  for (const u of Object.keys(byUnit)) {
    rows.push(...auditUnit(u, byUnit[u], (events || {})[u] || [], unitOpts));
  }
  const counts = rows.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const missing = rows
    .filter((r) => r.verdict === "suspicious" && r.missingGal > 0)
    .reduce((a, r) => a + r.missingGal, 0);
  return {
    rows,
    summary: {
      lines: rows.length,
      suspicious: counts.suspicious || 0,
      check: counts.check || 0,
      unpaid: counts.unpaid || 0,
      unknown: counts.unknown || 0,
      ok: counts.ok || 0,
      missingGal: missing,
      tzHours: tz.hours,
      tzSamples: tz.samples,
    },
  };
}

module.exports = { auditReport, auditUnit, impliedCapacity, estimateOffsetMs, median, MATCH_WINDOW_MS, TOLERANCE };

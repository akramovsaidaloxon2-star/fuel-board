"use strict";
// Reading a fuel-card export: which columns mean what, and which rows are fuel.
//
// Kept apart from the page so it can be run against a real export in tests —
// the column names, the zero-padded unit numbers and the date format are the
// parts most likely to be wrong, and they are the parts a browser makes hardest
// to check.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReportParse = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Diesel only. DEF goes in its own tank and scale tickets are not fuel at
// all — counting either would flag every truck that bought them.
const FUEL_ITEMS = new Set(["ULSD", "DSL", "DIESEL", "LSD", "BIO", "B20"]);

const HEADERS = {
  unit: ["unit", "unit #", "unit no", "vehicle", "truck"],
  date: ["tran date", "transaction date", "date"],
  time: ["tran time", "transaction time", "time"],
  gallons: ["qty", "quantity", "gallons", "gal", "units"],
  item: ["item", "product", "fuel type", "type"],
  station: ["location name", "location", "merchant", "site name"],
  city: ["city"],
  state: ["state/ prov", "state/prov", "state", "st"],
  driver: ["driver name", "driver"],
  invoice: ["invoice", "invoice #", "ticket"],
};

function findColumns(headerRow) {
  const norm = headerRow.map((h) => String(h == null ? "" : h).trim().toLowerCase().replace(/\s+/g, " "));
  const col = {};
  for (const key of Object.keys(HEADERS)) {
    for (const want of HEADERS[key]) {
      const i = norm.indexOf(want);
      if (i >= 0) { col[key] = i; break; }
    }
  }
  return col;
}

// "0008" and "010" are the same trucks the board calls 8 and 10.
function normUnit(v) {
  const s = String(v == null ? "" : v).trim().replace(/^#/, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : s;
}

// "2026-08-15" + "08:51" in the station's local time; the server works out
// the offset from the fills themselves.
function toISO(date, time) {
  const d = String(date == null ? "" : date).trim();
  const t = String(time == null ? "" : time).trim() || "12:00";
  const md = d.match(/^(\d{4})-(\d{2})-(\d{2})/) || d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!md) return null;
  const [y, mo, da] = d.includes("/") ? [md[3], md[1], md[2]] : [md[1], md[2], md[3]];
  const mt = t.match(/^(\d{1,2}):(\d{2})/);
  const hh = mt ? mt[1] : "12", mm = mt ? mt[2] : "00";
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${mm}:00Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function parseSheet(rows) {
  if (!rows.length) return { txns: [], skipped: 0, reason: "fayl bo'sh" };
  // The header is not always the first row — some exports put a title above.
  let headerAt = 0, col = findColumns(rows[0]);
  for (let i = 0; i < Math.min(rows.length, 10) && (col.unit == null || col.gallons == null); i++) {
    const c = findColumns(rows[i]);
    if (c.unit != null && c.gallons != null) { col = c; headerAt = i; break; }
  }
  if (col.unit == null || col.gallons == null || col.date == null) {
    return { txns: [], skipped: 0, reason: "ustunlar topilmadi (Unit, Tran Date, Qty kerak)" };
  }

  const txns = [];
  let skipped = 0;
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const item = String(col.item != null ? r[col.item] : "ULSD").trim().toUpperCase();
    if (col.item != null && !FUEL_ITEMS.has(item)) { skipped++; continue; }
    const gallons = Number(r[col.gallons]);
    const unit = normUnit(r[col.unit]);
    const at = toISO(r[col.date], col.time != null ? r[col.time] : "");
    if (!unit || !at || !(gallons > 0)) { skipped++; continue; }
    txns.push({
      unit, at, gallons: Math.round(gallons * 10) / 10,
      station: String(col.station != null ? r[col.station] || "" : "").trim(),
      city: String(col.city != null ? r[col.city] || "" : "").trim(),
      st: String(col.state != null ? r[col.state] || "" : "").trim(),
      driver: String(col.driver != null ? r[col.driver] || "" : "").trim(),
      invoice: String(col.invoice != null ? r[col.invoice] || "" : "").trim(),
    });
  }
  return { txns, skipped, reason: "" };
}

  return { parseSheet, findColumns, normUnit, toISO, FUEL_ITEMS, HEADERS };
});

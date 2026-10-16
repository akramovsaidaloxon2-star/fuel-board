"use strict";
// Reading a toll report (PrePass / E-ZPass export) when the Truck ID column is
// empty.
//
// Every row still says where the transponder was and when: an agency, an exit
// plaza, an exit date and an exit time. That is enough to go looking for the
// truck in Motive's own location history — but only if the timestamp is
// honest, and a toll report writes its times in the plaza's local clock. An
// hour out is sixty miles out, so the state behind the agency code decides the
// time zone, and the zone turns the wall clock into a real instant.
//
// Kept apart from the page and from the server so the column names, the
// agency codes and the daylight-saving arithmetic can be run against a real
// export instead of being assumed.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TollParse = api;
})(typeof self !== "undefined" ? self : this, function () {

const HEADERS = {
  postDate: ["post date", "posting date", "posted"],
  invoiceDate: ["invoice date", "inv date"],
  source: ["source"],
  readType: ["read type", "read"],
  // The transponder itself. When Truck ID is blank this is the only thing
  // tying a pile of crossings together, and it is what the answer gets
  // written against.
  device: ["pp device id", "device id", "transponder", "transponder id", "tag", "tag id"],
  plate: ["toll device id or plate", "toll device id", "plate", "license plate", "lic plate"],
  unit: ["truck id", "truck", "unit", "unit #", "unit no", "vehicle", "vehicle id", "asset id"],
  agency: ["agency", "toll agency", "authority"],
  entryPlaza: ["entry plaza", "entry", "entry point", "plaza in"],
  entryDate: ["entry date"],
  entryTime: ["entry time"],
  exitPlaza: ["exit plaza", "exit", "exit point", "plaza out", "plaza", "location"],
  exitDate: ["exit date", "trans date", "transaction date", "date"],
  exitTime: ["exit time", "trans time", "transaction time", "time"],
  cls: ["cl", "cls", "class", "veh class", "axles"],
  miles: ["mi", "miles", "distance"],
  toll: ["toll", "toll amt", "toll amount", "amount", "amt", "charge", "fare"],
};

// Which state's clock a plaza runs on, and which state to look for the truck
// in. A few agencies sit on a border and are listed with both sides; the
// matcher accepts either, and the first one is the one whose clock the report
// is written in.
const AGENCIES = {
  ILTOLL: { states: ["IL"], name: "Illinois Tollway" },
  ISTHA: { states: ["IL"], name: "Illinois Tollway" },
  "CHICAGO SKYWAY": { states: ["IL"], name: "Chicago Skyway" },
  CSKY: { states: ["IL"], name: "Chicago Skyway" },
  ITRCC: { states: ["IN"], name: "Indiana Toll Road" },
  INDOT: { states: ["IN"], name: "Indiana" },
  OTC: { states: ["OH"], name: "Ohio Turnpike" },
  OTIC: { states: ["OH"], name: "Ohio Turnpike" },
  PTC: { states: ["PA"], name: "Pennsylvania Turnpike" },
  PATP: { states: ["PA"], name: "Pennsylvania Turnpike" },
  NYSTA: { states: ["NY"], name: "New York Thruway" },
  MTA: { states: ["NY"], name: "MTA Bridges & Tunnels" },
  PANYNJ: { states: ["NJ", "NY"], name: "Port Authority NY/NJ" },
  NJTA: { states: ["NJ"], name: "New Jersey Turnpike" },
  SJTA: { states: ["NJ"], name: "Atlantic City Expressway" },
  DRPA: { states: ["NJ", "PA"], name: "Delaware River Port Authority" },
  DRJTBC: { states: ["NJ", "PA"], name: "Delaware River Joint Toll Bridge" },
  MDTA: { states: ["MD"], name: "Maryland Transportation Authority" },
  DELDOT: { states: ["DE"], name: "Delaware" },
  DRBA: { states: ["DE"], name: "Delaware River & Bay Authority" },
  MASSDOT: { states: ["MA"], name: "MassDOT" },
  NHDOT: { states: ["NH"], name: "New Hampshire" },
  MTAME: { states: ["ME"], name: "Maine Turnpike" },
  RITBA: { states: ["RI"], name: "Rhode Island Turnpike & Bridge" },
  VDOT: { states: ["VA"], name: "Virginia" },
  WVPA: { states: ["WV"], name: "West Virginia Parkways" },
  KTA: { states: ["KS"], name: "Kansas Turnpike" },
  OTA: { states: ["OK"], name: "Oklahoma Turnpike" },
  NTTA: { states: ["TX"], name: "North Texas Tollway" },
  HCTRA: { states: ["TX"], name: "Harris County Toll Road" },
  TXDOT: { states: ["TX"], name: "TxDOT" },
  CFX: { states: ["FL"], name: "Central Florida Expressway" },
  FTE: { states: ["FL"], name: "Florida Turnpike" },
  MDX: { states: ["FL"], name: "Miami-Dade Expressway" },
  "E-470": { states: ["CO"], name: "E-470" },
  E470: { states: ["CO"], name: "E-470" },
  CDOT: { states: ["CO"], name: "Colorado" },
  SRTA: { states: ["GA"], name: "Georgia Peach Pass" },
  NCTA: { states: ["NC"], name: "North Carolina Turnpike" },
  BATA: { states: ["CA"], name: "Bay Area Toll Authority" },
  OCTA: { states: ["CA"], name: "Orange County" },
  WSDOT: { states: ["WA"], name: "Washington" },
};

const STATE_TZ = {
  IL: "America/Chicago", IN: "America/Indiana/Indianapolis", OH: "America/New_York",
  PA: "America/New_York", NY: "America/New_York", NJ: "America/New_York",
  MD: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  MA: "America/New_York", NH: "America/New_York", ME: "America/New_York",
  RI: "America/New_York", CT: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York", NC: "America/New_York",
  SC: "America/New_York", GA: "America/New_York", FL: "America/New_York",
  MI: "America/New_York", KY: "America/New_York",
  TX: "America/Chicago", OK: "America/Chicago", KS: "America/Chicago",
  MO: "America/Chicago", IA: "America/Chicago", MN: "America/Chicago",
  WI: "America/Chicago", NE: "America/Chicago", SD: "America/Chicago",
  ND: "America/Chicago", AR: "America/Chicago", LA: "America/Chicago",
  MS: "America/Chicago", AL: "America/Chicago", TN: "America/Chicago",
  CO: "America/Denver", NM: "America/Denver", WY: "America/Denver",
  MT: "America/Denver", UT: "America/Denver", ID: "America/Denver",
  AZ: "America/Phoenix",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles",
  OR: "America/Los_Angeles", WA: "America/Los_Angeles",
};

function agencyInfo(agency) {
  const key = String(agency || "").trim().toUpperCase();
  if (AGENCIES[key]) return AGENCIES[key];
  // "IL TOLLWAY", "Ohio Turnpike Commission" — fall back to a loose match so a
  // spelled-out agency still lands in the right state.
  for (const k of Object.keys(AGENCIES)) if (key.includes(k)) return AGENCIES[k];
  for (const k of Object.keys(AGENCIES)) {
    const n = AGENCIES[k].name.toUpperCase();
    if (key.includes(n) || n.includes(key)) return AGENCIES[k];
  }
  return null;
}

// How far the named zone is from UTC at that instant, daylight saving and all.
// Asked of the platform rather than worked out from a table of rules, because
// the rules change and the platform's copy is the one that is kept current.
function tzOffsetMs(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUTC = Date.parse(
    `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`
  );
  return asUTC - ms;
}

// A wall clock reading plus a zone makes an instant. Twice around, because the
// offset depends on the instant we are still working out — one pass is wrong
// for the hour either side of a daylight-saving change.
function zonedToISO(wall, tz) {
  const base = Date.parse(wall + "Z");
  if (!Number.isFinite(base)) return null;
  if (!tz) return new Date(base).toISOString();
  let ms = base;
  for (let i = 0; i < 2; i++) ms = base - tzOffsetMs(ms, tz);
  return new Date(ms).toISOString();
}

// Dates arrive as 10/11/2026, 2026-10-11, or as an Excel serial number when
// the column was formatted as a date and the sheet was read raw.
function wallDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) {              // Excel serial, 1900 epoch
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

// "14:32", "2:32 PM", "14:32:07", or an Excel fraction of a day.
function wallTime(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^0?\.\d+$/.test(s)) {
    const mins = Math.round(Number(s) * 1440);
    return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}:00`;
  }
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?/);
  if (!m) return null;
  let hh = Number(m[1]);
  if (m[4]) {
    const pm = /[Pp]/.test(m[4]);
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  if (hh > 23) return null;
  return `${String(hh).padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
}

function money(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function findColumns(headerRow) {
  const norm = (headerRow || []).map((h) =>
    String(h == null ? "" : h).trim().toLowerCase().replace(/\s+/g, " ").replace(/[.#:]/g, "").trim());
  const col = {};
  const taken = new Set();
  for (const key of Object.keys(HEADERS)) {
    for (const want of HEADERS[key]) {
      const i = norm.indexOf(want.replace(/[.#:]/g, "").trim());
      if (i >= 0 && !taken.has(i)) { col[key] = i; taken.add(i); break; }
    }
  }
  return col;
}

// A toll row only has to say when and roughly where to be useful. Exit is
// preferred over entry: that is where the truck was when the charge was read,
// and on a ticket system the entry can be hours earlier.
function parseSheet(rows) {
  const empty = { tolls: [], skipped: 0, devices: [], reason: "" };
  if (!rows || !rows.length) return Object.assign({}, empty, { reason: "fayl bo'sh" });

  let headerAt = -1, col = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = findColumns(rows[i]);
    const hasWhen = c.exitDate != null || c.entryDate != null || c.postDate != null;
    const hasWhere = c.exitPlaza != null || c.entryPlaza != null || c.agency != null;
    if (hasWhen && hasWhere) { col = c; headerAt = i; break; }
  }
  if (!col) {
    return Object.assign({}, empty, {
      reason: "ustunlar topilmadi (Agency/Exit Plaza va Exit Date kerak)",
    });
  }

  const tolls = [];
  let skipped = 0;
  const devices = new Map();
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const cell = (k) => (col[k] == null ? "" : String(r[col[k]] == null ? "" : r[col[k]]).trim());

    const agency = cell("agency");
    const info = agencyInfo(agency);
    const states = info ? info.states : [];
    const tz = STATE_TZ[states[0]] || null;

    const exitDate = wallDate(col.exitDate != null ? r[col.exitDate] : null);
    const exitTime = wallTime(col.exitTime != null ? r[col.exitTime] : null);
    const entryDate = wallDate(col.entryDate != null ? r[col.entryDate] : null);
    const entryTime = wallTime(col.entryTime != null ? r[col.entryTime] : null);
    // A date with no time is still worth keeping: the day alone narrows the
    // fleet down, and the row is marked so the match can say how sure it is.
    const exitAt = exitDate ? zonedToISO(`${exitDate}T${exitTime || "12:00:00"}`, tz) : null;
    const entryAt = entryDate ? zonedToISO(`${entryDate}T${entryTime || "12:00:00"}`, tz) : null;
    const at = exitAt || entryAt;
    if (!at) { skipped++; continue; }

    // "N/A" is what a report that never had the truck assigned writes here,
    // and it is the whole reason this file exists. Treat it as empty.
    const rawUnit = cell("unit");
    const unit = /^(n\/?a|none|-+|unassigned|unknown)$/i.test(rawUnit) ? "" : rawUnit.replace(/^#/, "");

    const row = {
      row: i + 1,
      device: cell("device"),
      plate: cell("plate"),
      unit,
      agency,
      agencyName: info ? info.name : agency,
      states,
      tz,
      source: cell("source"),
      readType: cell("readType"),
      entryPlaza: cell("entryPlaza"),
      exitPlaza: cell("exitPlaza") || cell("entryPlaza"),
      entryAt,
      exitAt,
      at,
      // Whether the clock reading was a real one or filled in at noon.
      exact: !!(exitAt ? exitTime : entryTime),
      miles: money(col.miles != null ? r[col.miles] : null),
      toll: money(col.toll != null ? r[col.toll] : null),
      cls: cell("cls"),
      postDate: wallDate(col.postDate != null ? r[col.postDate] : null),
    };
    tolls.push(row);
    const key = row.device || row.plate || "(nomsiz)";
    const d = devices.get(key) || { device: key, plate: row.plate, rows: 0, assigned: new Set(), from: at, to: at };
    d.rows++;
    if (row.unit) d.assigned.add(row.unit);
    if (at < d.from) d.from = at;
    if (at > d.to) d.to = at;
    devices.set(key, d);
  }

  return {
    tolls,
    skipped,
    devices: [...devices.values()].map((d) => ({
      device: d.device, plate: d.plate, rows: d.rows,
      assigned: [...d.assigned], from: d.from, to: d.to,
    })),
    reason: "",
  };
}

  return {
    parseSheet, findColumns, agencyInfo, zonedToISO, tzOffsetMs,
    wallDate, wallTime, HEADERS, AGENCIES, STATE_TZ,
  };
});

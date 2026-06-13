const http = require("http");
const fs = require("fs");
const path = require("path");

// --- Load .env (no dependency) ---
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      // Real environment variables (e.g. from the cloud host) win over .env.
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* no .env file */ }
}
loadEnv();

const API_KEY = process.env.MOTIVE_API_KEY;
const PORT = process.env.PORT || 3000;
const MOTIVE_BASE = "https://api.gomotive.com";

// Optional login. Set AUTH_USER + AUTH_PASS to require a username/password.
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const AUTH_ON = !!(AUTH_USER && AUTH_PASS);

function checkAuth(req, res) {
  if (!AUTH_ON) return true; // no credentials configured -> open (local dev)
  const hdr = req.headers["authorization"] || "";
  const m = hdr.match(/^Basic\s+(.+)$/i);
  if (m) {
    const [u, p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    if (u === AUTH_USER && p === AUTH_PASS) return true;
  }
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Fuel board", charset="UTF-8"',
    "Content-Type": "text/plain",
  });
  res.end("Authentication required");
  return false;
}

if (!API_KEY) {
  console.error("⚠  MOTIVE_API_KEY is missing. Add it to .env");
}

// --- Durable storage via a private GitHub repo (survives restarts/deploys) ---
const GH_TOKEN = process.env.GH_TOKEN || "";
const GH_REPO = process.env.GH_REPO || ""; // e.g. "owner/fuel-board-data"
const GH_ON = !!(GH_TOKEN && GH_REPO);
const ghSha = {};
const ghHeaders = () => ({ Authorization: `Bearer ${GH_TOKEN}`, "User-Agent": "fuel-board", Accept: "application/vnd.github+json" });
async function ghLoad(file) {
  if (!GH_ON) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}`, { headers: ghHeaders() });
    if (r.status === 404) return undefined; // file not there yet
    if (!r.ok) { console.error("ghLoad", file, r.status); return null; }
    const j = await r.json();
    ghSha[file] = j.sha;
    return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  } catch (e) { console.error("ghLoad err", file, e.message); return null; }
}
const ghTimers = {};
function ghSave(file, obj) {
  if (!GH_ON) return;
  clearTimeout(ghTimers[file]);
  ghTimers[file] = setTimeout(async () => {
    try {
      const body = { message: `update ${file}`, content: Buffer.from(JSON.stringify(obj)).toString("base64") };
      if (ghSha[file]) body.sha = ghSha[file];
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}`, { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { console.error("ghSave", file, r.status, (await r.text()).slice(0, 140)); return; }
      ghSha[file] = (await r.json()).content.sha;
    } catch (e) { console.error("ghSave err", file, e.message); }
  }, 4000);
}

// --- Simple in-memory cache so we don't hammer the Motive API ---
let cache = { data: null, at: 0 };
const CACHE_MS = 45 * 1000;

// --- Persistent last-known fuel cache (mirrors the Motive dashboard) ---
// A truck only reports fuel while its engine is on. When parked, the GPS
// breadcrumb drops the fuel field, so we remember the last reading per unit.
const FUEL_STORE = path.join(__dirname, "fuel_cache.json");
let fuelHist = {}; // { [unit]: { fuel: number, at: ISOstring } }
try {
  fuelHist = JSON.parse(fs.readFileSync(FUEL_STORE, "utf8"));
} catch { fuelHist = {}; }
// On a fresh/ephemeral host (e.g. Render free tier wipes the disk on every
// restart) start from the committed seed so coverage isn't stuck at "live only".
if (!Object.keys(fuelHist).length) {
  try { fuelHist = JSON.parse(fs.readFileSync(path.join(__dirname, "fuel_seed.json"), "utf8")); }
  catch { fuelHist = {}; }
}

let saveTimer = null;
function saveFuelHist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(FUEL_STORE, JSON.stringify(fuelHist), () => {});
  }, 500);
}

// --- Fuel-level time series (built from live readings, going forward) ---
// Lets us later verify a fuel purchase actually raised the tank level.
const SERIES_STORE = path.join(__dirname, "fuel_series.json");
let fuelSeries = {};
try { fuelSeries = JSON.parse(fs.readFileSync(SERIES_STORE, "utf8")); } catch { fuelSeries = {}; }
let seriesTimer = null;
function saveFuelSeries() {
  clearTimeout(seriesTimer);
  seriesTimer = setTimeout(() => {
    fs.writeFile(SERIES_STORE, JSON.stringify(fuelSeries), () => {});
    ghSave("fuel_series.json", fuelSeries);
  }, 3000);
}
function recordFuelPoint(unit, fuel, atISO) {
  if (!unit || typeof fuel !== "number") return;
  const t = atISO ? new Date(atISO).getTime() : Date.now();
  if (!Number.isFinite(t)) return;
  const arr = (fuelSeries[unit] = fuelSeries[unit] || []);
  const last = arr[arr.length - 1];
  // skip near-duplicate readings (keeps the series compact, still catches jumps)
  if (last && Math.abs(last[0] - t) < 10 * 60000 && Math.abs(last[1] - fuel) < 0.5) return;
  arr.push([t, fuel]);
  arr.sort((a, b) => a[0] - b[0]);
  const cutoff = Date.now() - 90 * 864e5;
  while (arr.length && arr[0][0] < cutoff) arr.shift();
  if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  saveFuelSeries();
}

// --- Daily odometer snapshots (for accurate per-period miles, going forward) ---
const ODO_STORE = path.join(__dirname, "odo_daily.json");
let odoDaily = {}; // { unit: { "YYYY-MM-DD": odometerMiles } }
try { odoDaily = JSON.parse(fs.readFileSync(ODO_STORE, "utf8")); } catch { odoDaily = {}; }
let odoTimer = null;
function saveOdo() {
  clearTimeout(odoTimer);
  odoTimer = setTimeout(() => {
    fs.writeFile(ODO_STORE, JSON.stringify(odoDaily), () => {});
    ghSave("odo_daily.json", odoDaily);
  }, 5000);
}
function recordOdo(unit, odo, atISO) {
  if (!unit || typeof odo !== "number" || odo <= 0) return;
  const day = (atISO ? new Date(atISO) : new Date()).toISOString().slice(0, 10);
  if (!odoDaily[unit]) odoDaily[unit] = {};
  odoDaily[unit][day] = Math.round(odo); // latest reading of the day wins
  saveOdo();
}
// Accurate period miles = odometer(end) - odometer(just before start). Needs snapshots.
function getOdoMiles(unit, start, end) {
  const days = odoDaily[unit];
  if (!days) return null;
  const dates = Object.keys(days).sort();
  const endDate = dates.filter((d) => d <= end).pop();
  let startDate = dates.filter((d) => d < start).pop();
  if (!startDate) startDate = dates.filter((d) => d >= start && d <= end)[0]; // fallback: first day in range
  if (!endDate || !startDate || endDate <= startDate) return null;
  const m = days[endDate] - days[startDate];
  return m > 0 ? Math.round(m) : null;
}

// --- Helpers ---
function statusFromSpeed(speed, ageMin) {
  if (ageMin > 720) return "Off duty"; // no update for >12h
  if (speed == null) return "Parked";
  if (speed > 5) return "Driving";
  return "Idle";
}

function stateFromDesc(desc) {
  if (!desc) return "";
  const m = desc.match(/,\s*([A-Z]{2})\b/);
  return m ? m[1] : "";
}

async function fetchAllVehicleLocations() {
  const perPage = 100;
  let page = 1;
  let all = [];
  let total = Infinity;

  while (all.length < total) {
    const url = `${MOTIVE_BASE}/v1/vehicle_locations?per_page=${perPage}&page_no=${page}`;
    const res = await fetch(url, { headers: { "X-Api-Key": API_KEY } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Motive ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const vehicles = json.vehicles || [];
    all = all.concat(vehicles);
    total = json.pagination ? json.pagination.total : all.length;
    if (vehicles.length === 0) break;
    page++;
    if (page > 20) break; // safety
  }
  return all;
}

// --- Idle hours + wasted fuel per unit (last 24h), refreshed slowly ---
// Source: /v1/driver_utilization rollups, keyed by driver_company_id which
// matches the vehicle number ~99% of the time in this fleet.
let idleCache = { data: {}, at: 0 };
const IDLE_CACHE_MS = 20 * 60 * 1000;

async function fetchIdle() {
  if (Object.keys(idleCache.data).length && Date.now() - idleCache.at < IDLE_CACHE_MS) {
    return idleCache.data;
  }
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const byUnit = {};
  let page = 1, total = Infinity;
  while ((page - 1) * 100 < total) {
    const url = `${MOTIVE_BASE}/v1/driver_utilization?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100&page_no=${page}`;
    const res = await fetch(url, { headers: { "X-Api-Key": API_KEY } });
    if (!res.ok) break;
    const json = await res.json();
    const rolls = (json.driver_idle_rollups || []).map((x) => x.driver_idle_rollup);
    for (const r of rolls) {
      const d = r.driver;
      const unit = d && d.driver_company_id ? String(d.driver_company_id) : null;
      if (!unit) continue;
      if (!byUnit[unit]) byUnit[unit] = { idleHours: 0, idleGallons: 0 };
      byUnit[unit].idleHours += (r.idle_time || 0) / 3600;
      byUnit[unit].idleGallons += r.idle_fuel || 0;
    }
    total = json.pagination ? json.pagination.total : rolls.length;
    if (!rolls.length) break;
    page++;
    if (page > 10) break;
  }
  for (const u in byUnit) {
    byUnit[u].idleHours = Math.round(byUnit[u].idleHours * 10) / 10;
    byUnit[u].idleGallons = Math.round(byUnit[u].idleGallons * 10) / 10;
  }
  idleCache = { data: byUnit, at: Date.now() };
  return byUnit;
}

function ageMinFrom(iso) {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}

function mapFleet(raw) {
  const now = Date.now();
  let dirty = false;

  const fleet = raw.map((w) => {
    const v = w.vehicle || {};
    const loc = v.current_location || {};
    const d = v.current_driver;
    const unit = String(v.number || v.id).trim();
    const livePct = loc.fuel_primary_remaining_percentage;
    const ageMin = ageMinFrom(loc.located_at) ?? 99999;
    if (loc.odometer != null && ageMin < 1440) recordOdo(unit, loc.odometer, loc.located_at);

    // Live fuel? Remember it as the last-known reading for this unit.
    let fuel = null, fuelSource = "none", fuelAt = null;
    if (livePct != null) {
      fuel = Math.round(livePct * 10) / 10;
      fuelSource = "live";
      fuelAt = loc.located_at;
      const prev = fuelHist[unit];
      if (!prev || prev.fuel !== fuel || prev.at !== fuelAt) {
        fuelHist[unit] = { fuel, at: fuelAt };
        dirty = true;
      }
      recordFuelPoint(unit, fuel, fuelAt);
    } else if (fuelHist[unit]) {
      // Parked / engine off: fall back to the last value we ever saw.
      fuel = fuelHist[unit].fuel;
      fuelSource = "cached";
      fuelAt = fuelHist[unit].at;
    }

    return {
      unit,
      driver: d ? `${d.first_name || ""} ${d.last_name || ""}`.trim() : "Unassigned",
      phone: d && d.phone ? d.phone : "",
      vehicleInfo: [v.year, v.make, v.model].filter(Boolean).join(" "),
      location: loc.description || "Unknown",
      state: stateFromDesc(loc.description),
      lat: loc.lat ?? null,
      lon: loc.lon ?? null,
      bearing: loc.bearing ?? null,
      fuel,
      fuelSource,             // "live" | "cached" | "none"
      fuelAgeMin: ageMinFrom(fuelAt),
      speed: loc.speed ?? null,
      odometer: loc.odometer != null ? Math.round(loc.odometer) : null,
      mpg: (loc.odometer != null && loc.fuel != null && loc.fuel > 0)
        ? Math.round((loc.odometer / loc.fuel) * 10) / 10 : null,
      ecm: (loc.odometer != null || loc.engine_hours != null),
      hasLocation: !!loc.located_at,
      status: statusFromSpeed(loc.speed, ageMin),
      updated: ageMin,
      tankGal: 150,
    };
  });

  if (dirty) saveFuelHist();

  // Units with a fuel value (live or cached) sorted low -> full, then the rest.
  const withFuel = fleet.filter((x) => x.fuel != null).sort((a, b) => a.fuel - b.fuel);
  const without = fleet.filter((x) => x.fuel == null).sort((a, b) => a.unit.localeCompare(b.unit));
  const live = fleet.filter((x) => x.fuelSource === "live").length;
  const cached = fleet.filter((x) => x.fuelSource === "cached").length;
  return {
    fleet: withFuel.concat(without),
    counts: { total: fleet.length, withFuel: withFuel.length, live, cached, none: fleet.length - withFuel.length },
  };
}

async function getFuelData() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const raw = await fetchAllVehicleLocations();
  const mapped = mapFleet(raw);

  // Attach idle hours + wasted fuel (cached, non-fatal if it fails).
  const idle = await fetchIdle().catch(() => ({}));
  for (const row of mapped.fleet) {
    const id = idle[row.unit];
    row.idleHours = id ? id.idleHours : null;
    row.idleGallons = id ? id.idleGallons : null;
  }

  const payload = {
    ok: true,
    syncedAt: new Date().toISOString(),
    counts: mapped.counts,
    fleet: mapped.fleet,
  };
  cache = { data: payload, at: Date.now() };
  return payload;
}

// --- Static file serving ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";
  const filePath = path.join(__dirname, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  // Never serve secrets
  if (/\.env$/i.test(filePath) || /server\.js$/i.test(filePath)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "text/plain",
      "Cache-Control": "no-cache, must-revalidate",
    });
    res.end(data);
  });
}

// --- Motive webhook receiver ---
// Captures incoming webhook payloads (so we can inspect their shape) and, if a
// payload carries a vehicle number + fuel %, updates the last-known cache — this
// is how we'd get fuel for PARKED trucks that the pull API doesn't expose.
let webhookLog = [];
let webhookOther = []; // non-location events (engine on/off, faults...) kept longer
let webhookCount = 0;
const actionCounts = {};

function ingestWebhookFuel(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return;
  const unit = String(p.vehicle_number != null ? p.vehicle_number : (p.number != null ? p.number : "")).trim();
  let pct = null;
  if (typeof p.primary_fuel_level === "number") pct = p.primary_fuel_level;
  else if (typeof p.fuel_primary_remaining_percentage === "number") pct = p.fuel_primary_remaining_percentage;
  if (unit && pct != null) {
    const f = Math.round(pct * 10) / 10;
    fuelHist[unit] = { fuel: f, at: p.located_at || new Date().toISOString() };
    saveFuelHist();
    recordFuelPoint(unit, f, p.located_at);
  }
}

function captureWebhook(req, res) {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on("end", () => {
    webhookCount++;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    webhookLog.unshift({ at: new Date().toISOString(), headers: req.headers, body: parsed || body.slice(0, 3000) });
    if (webhookLog.length > 30) webhookLog.pop();
    const action = parsed && parsed.action;
    if (action) actionCounts[action] = (actionCounts[action] || 0) + 1;
    // Keep anything that isn't a routine location ping so we can inspect it.
    if (action && !/^vehicle_location_(received|updated)$/.test(action)) {
      webhookOther.unshift({ at: new Date().toISOString(), body: parsed });
      if (webhookOther.length > 25) webhookOther.pop();
    }
    try { ingestWebhookFuel(parsed); } catch {}
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
}

// --- Saved fuel reports (weekly/monthly), persisted by date ---
const REPORTS_STORE = path.join(__dirname, "reports_data.json");
let reports = [];
try { reports = JSON.parse(fs.readFileSync(REPORTS_STORE, "utf8")); } catch { reports = []; }
function saveReports() {
  fs.writeFile(REPORTS_STORE, JSON.stringify(reports), () => {});
  ghSave("reports_data.json", reports);
}

// --- Toll / route-compliance board (manually entered, persisted) ---
const TOLL_STORE = path.join(__dirname, "toll_data.json");
let tollRows = [];
try { tollRows = JSON.parse(fs.readFileSync(TOLL_STORE, "utf8")); } catch { tollRows = []; }
function saveToll() {
  fs.writeFile(TOLL_STORE, JSON.stringify(tollRows), () => {});
  ghSave("toll_data.json", tollRows);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 10e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
}

// --- Fuel transaction location check (was the truck at the fuel stop?) ---
let vehIdMap = null, vehIdMapAt = 0;
async function getVehicleIdMap() {
  if (vehIdMap && Date.now() - vehIdMapAt < 30 * 60 * 1000) return vehIdMap;
  const map = {};
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${MOTIVE_BASE}/v1/vehicle_locations?per_page=100&page_no=${page}`, { headers: { "X-Api-Key": API_KEY } });
    if (!res.ok) break;
    const j = await res.json();
    (j.vehicles || []).forEach((w) => { map[String(w.vehicle.number).trim()] = w.vehicle.id; });
    if (!j.pagination || page * 100 >= j.pagination.total) break;
  }
  vehIdMap = map; vehIdMapAt = Date.now();
  return map;
}
async function fetchUnitPeriods(id, startISO, endISO) {
  const periods = []; let page = 1, total = Infinity;
  while ((page - 1) * 100 < total && page <= 6) {
    const url = `${MOTIVE_BASE}/v1/driving_periods?vehicle_ids[]=${id}&start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}&per_page=100&page_no=${page}`;
    const res = await fetch(url, { headers: { "X-Api-Key": API_KEY } });
    if (!res.ok) break;
    const j = await res.json();
    const arr = j.driving_periods || [];
    arr.forEach((w) => { const p = w.driving_period; periods.push({ st: new Date(p.start_time).getTime(), en: new Date(p.end_time).getTime(), o: p.origin, d: p.destination }); });
    total = j.pagination ? j.pagination.total : arr.length;
    if (!arr.length) break; page++;
  }
  return periods;
}
function addrState(a) { const m = String(a || "").match(/,\s*([A-Z]{2})\s*\d{5}/); return m ? m[1] : null; }
function addrCity(a) { const m = String(a || "").match(/,\s*([^,]+),\s*[A-Z]{2}\s*\d{5}/); return m ? m[1].trim() : null; }
async function checkTransactions(periodStart, periodEnd, transactions) {
  const idMap = await getVehicleIdMap();
  const byUnit = {};
  transactions.forEach((t) => { (byUnit[t.unit] = byUnit[t.unit] || []).push(t); });
  const startISO = (periodStart || "2026-01-01") + "T00:00:00Z";
  const endISO = (periodEnd || periodStart || "2026-12-31") + "T23:59:59Z";
  const W = 4 * 3600 * 1000;
  const out = [];
  for (const unit of Object.keys(byUnit)) {
    let id = idMap[unit];
    if (!id && /^\d+$/.test(unit)) id = idMap[unit.padStart(4, "0")];
    let periods = [];
    if (id) { try { periods = await fetchUnitPeriods(id, startISO, endISO); } catch {} }
    for (const t of byUnit[unit]) {
      const T = new Date(t.date + "T" + (t.time || "00:00") + ":00Z").getTime();
      const states = new Set(), cities = [];
      const add = (a) => { const s = addrState(a); if (s) states.add(s); const c = addrCity(a); if (c) cities.push(c); };
      // periods overlapping a window around the fuel time (truck driving then)
      periods.filter((p) => p.en >= T - W && p.st <= T + W).forEach((p) => { add(p.o); add(p.d); });
      // truck fuels while stopped: take the destination of the last trip before T
      // and the origin of the first trip after T (that parked spot ~ the fuel stop).
      let prev = null, next = null;
      for (const p of periods) {
        if (p.en <= T && (!prev || p.en > prev.en)) prev = p;
        if (p.st >= T && (!next || p.st < next.st)) next = p;
      }
      if (prev) add(prev.d);
      if (next) add(next.o);
      const fuelSt = String(t.state || "").toUpperCase();
      let verdict = "unknown";
      if (!id) verdict = "no-motive";
      else if (!states.size) verdict = "no-data";
      else if (states.has(fuelSt)) verdict = "ok";
      else verdict = "mismatch";

      // Did the tank fuel level actually rise around the transaction? (strongest proof)
      const series = fuelSeries[unit] || (/^\d+$/.test(unit) ? fuelSeries[unit.padStart(4, "0")] : null) || [];
      const FW = 6 * 3600 * 1000;
      const before = series.filter((p) => p[0] <= T && p[0] >= T - FW).map((p) => p[1]);
      const after = series.filter((p) => p[0] >= T && p[0] <= T + FW).map((p) => p[1]);
      let fuelVerdict = "no-fuel-data", rise = null;
      if (before.length && after.length) {
        rise = +(Math.max(...after) - Math.min(...before)).toFixed(1);
        fuelVerdict = rise > 10 ? "rose" : "no-rise";
      }
      // Combined: fuel-level evidence wins when we have it.
      let combined = verdict;
      if (fuelVerdict === "rose") combined = "all-good";
      else if (fuelVerdict === "no-rise") combined = "fraud";

      out.push({ unit, date: t.date, time: t.time, fuelCity: t.city, fuelState: t.state, qty: t.qty,
        truckStates: [...states], truckCities: [...new Set(cities)].slice(0, 3),
        verdict, fuelVerdict, rise, combined });
    }
  }
  return out;
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  // Public health check for uptime pingers (keeps the free instance awake).
  if (req.url === "/health" || req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }
  // Motive posts webhook events here (public — Motive can't send our login).
  if (req.url === "/webhook" && req.method === "POST") {
    captureWebhook(req, res);
    return;
  }
  // Protected: inspect what Motive has been sending.
  if (req.url === "/webhook/debug") {
    if (!checkAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: webhookCount, actionCounts, other: webhookOther, recent: webhookLog }, null, 2));
    return;
  }
  if (!checkAuth(req, res)) return;
  if (req.url === "/api/fuel" || req.url.startsWith("/api/fuel?")) {
    try {
      const data = await getFuelData();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // --- Reports API ---
  const reportMatch = req.url.match(/^\/api\/reports\/([\w-]+)$/);
  if (req.url === "/api/reports" && req.method === "GET") {
    const list = reports.map((r) => ({
      id: r.id, type: r.type, periodStart: r.periodStart, periodEnd: r.periodEnd,
      createdAt: r.createdAt, unitCount: r.rows ? r.rows.length : 0, totals: r.totals || null,
    })).sort((a, b) => (b.periodStart || "").localeCompare(a.periodStart || ""));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }
  if (req.url === "/api/reports" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.rows)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "rows required" }));
      return;
    }
    const rec = {
      id: "r" + Date.now().toString(36),
      type: body.type === "monthly" ? "monthly" : "weekly",
      periodStart: body.periodStart || null,
      periodEnd: body.periodEnd || null,
      createdAt: new Date().toISOString(),
      rows: body.rows,
      unmatched: body.unmatched || [],
      totals: body.totals || null,
    };
    reports.push(rec);
    saveReports();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: rec.id }));
    return;
  }
  if (reportMatch && req.method === "GET") {
    const r = reports.find((x) => x.id === reportMatch[1]);
    res.writeHead(r ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r || { ok: false, error: "not found" }));
    return;
  }
  if (reportMatch && req.method === "DELETE") {
    const i = reports.findIndex((x) => x.id === reportMatch[1]);
    if (i >= 0) { reports.splice(i, 1); saveReports(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/api/toll" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tollRows));
    return;
  }
  if (req.url === "/api/toll" && req.method === "POST") {
    const body = await readBody(req);
    if (body && Array.isArray(body.rows)) { tollRows = body.rows; saveToll(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: tollRows.length }));
    return;
  }

  if (req.url.startsWith("/api/perf-auto")) {
    const q = new URL(req.url, "http://x").searchParams;
    const start = q.get("start"), end = q.get("end");
    if (!start || !end) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "start/end required" })); return; }
    const idleByUnit = {};
    try {
      let page = 1, total = Infinity;
      while ((page - 1) * 100 < total && page <= 10) {
        const r = await fetch(`${MOTIVE_BASE}/v1/vehicle_utilization?start_date=${encodeURIComponent(start + "T00:00:00Z")}&end_date=${encodeURIComponent(end + "T23:59:59Z")}&per_page=100&page_no=${page}`, { headers: { "X-Api-Key": API_KEY } });
        if (!r.ok) break;
        const j = await r.json();
        const rolls = j.vehicle_idle_rollups || [];
        rolls.forEach((w) => { const v = w.vehicle_idle_rollup; const num = String(v.vehicle.number).trim(); idleByUnit[num] = +(v.idle_fuel || 0).toFixed(2); });
        total = j.pagination ? j.pagination.total : 0;
        if (!rolls.length) break; page++;
      }
    } catch (e) { /* idle optional */ }
    const units = {};
    const all = new Set([...Object.keys(idleByUnit), ...Object.keys(odoDaily)]);
    all.forEach((u) => { units[u] = { miles: getOdoMiles(u, start, end), idle: idleByUnit[u] != null ? idleByUnit[u] : null }; });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, start, end, units }));
    return;
  }

  if (req.url === "/api/fuel-check" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || !Array.isArray(body.transactions)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "transactions required" }));
      return;
    }
    try {
      const results = await checkTransactions(body.periodStart, body.periodEnd, body.transactions);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  serveStatic(req, res);
});

// Load durable data from the private GitHub repo on startup (overrides the
// ephemeral local disk copy), so reports + fuel history survive any restart.
async function initDurable() {
  if (!GH_ON) return;
  const r = await ghLoad("reports_data.json");
  if (Array.isArray(r)) reports = r;
  const s = await ghLoad("fuel_series.json");
  if (s && typeof s === "object") fuelSeries = s;
  const o = await ghLoad("odo_daily.json");
  if (o && typeof o === "object") odoDaily = o;
  const tl = await ghLoad("toll_data.json");
  if (Array.isArray(tl)) tollRows = tl;
  console.log(`  Durable store:       GitHub ${GH_REPO} ✓ (reports: ${reports.length})`);
}

server.listen(PORT, () => {
  console.log(`\n  Fuel board running:  http://localhost:${PORT}`);
  console.log(`  API endpoint:        http://localhost:${PORT}/api/fuel`);
  console.log(`  Motive key:          ${API_KEY ? "loaded ✓" : "MISSING ✗"}`);
  console.log(`  Login:               ${AUTH_ON ? `on (user: ${AUTH_USER}) ✓` : "OFF — set AUTH_USER/AUTH_PASS for cloud"}`);
  console.log(`  Durable store:       ${GH_ON ? "configuring…" : "OFF — set GH_TOKEN/GH_REPO for permanence"}\n`);
  initDurable().catch((e) => console.error("initDurable", e.message));
});

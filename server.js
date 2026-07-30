const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

// Login with roles. Manager = full access; worker = Fuel board / Map / Idle only.
const AUTH_USER = process.env.AUTH_USER || "";       // legacy single login = manager
const AUTH_PASS = process.env.AUTH_PASS || "";
const MANAGER_USER = process.env.MANAGER_USER || "";
const MANAGER_PASS = process.env.MANAGER_PASS || "";
const WORKER_USER = process.env.WORKER_USER || "";
const WORKER_PASS = process.env.WORKER_PASS || "";
const AUTH_ON = !!(AUTH_USER && AUTH_PASS) || !!(MANAGER_USER && MANAGER_PASS) || !!(WORKER_USER && WORKER_PASS);

// Validate a username/password -> role (used by the login form).
function roleFor(u, p) {
  if (MANAGER_USER && u === MANAGER_USER && p === MANAGER_PASS) return "manager";
  if (AUTH_USER && u === AUTH_USER && p === AUTH_PASS) return "manager";
  if (WORKER_USER && u === WORKER_USER && p === WORKER_PASS) return "worker";
  return null;
}
// Signed session cookie (no DB needed).
const SESSION_SECRET = process.env.SESSION_SECRET || (MANAGER_PASS + WORKER_PASS + AUTH_PASS + "mvx-v1");
function sign(s) { return crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url"); }
function makeToken(role) { const p = role + "." + (Date.now() + 30 * 864e5); return p + "." + sign(p); }
function verifyToken(tok) {
  if (!tok) return null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  if (sign(role + "." + exp) !== sig) return null;
  if (Date.now() > +exp) return null;
  if (role !== "manager" && role !== "worker") return null;
  return role;
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionRole(req) {
  if (!AUTH_ON) return "manager"; // open (local dev) -> full
  return verifyToken(getCookie(req, "mvx_session"));
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
const ghTimers = {}, ghPending = {}, ghLastSave = {};
// High-frequency, webhook-driven files push to GitHub at most once per 5 min
// (cuts outbound bandwidth a lot). User-triggered files stay near-immediate.
const GH_MIN = { "fuel_series.json": 300000, "odo_daily.json": 300000 };
// PUT a JSON file to the durable repo. If GitHub rejects the write because our
// cached sha is stale/missing (409 conflict or 422), re-fetch the latest sha
// and retry once — otherwise a single conflict would freeze that file forever
// (so later edits/removals never persist and reappear after a restart).
async function ghPut(file, obj) {
  const content = Buffer.from(JSON.stringify(obj)).toString("base64");
  const doPut = async () => {
    const body = { message: `update ${file}`, content };
    if (ghSha[file]) body.sha = ghSha[file];
    return fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}`, { method: "PUT", headers: { ...ghHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };
  let r = await doPut();
  if (r.status === 409 || r.status === 422) {
    try {
      const g = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${file}`, { headers: ghHeaders() });
      if (g.ok) ghSha[file] = (await g.json()).sha;
      else if (g.status === 404) delete ghSha[file]; // file gone — create fresh
    } catch {}
    r = await doPut();
  }
  if (!r.ok) { console.error("ghSave", file, r.status, (await r.text()).slice(0, 140)); return; }
  ghSha[file] = (await r.json()).content.sha;
}
function ghSave(file, obj) {
  if (!GH_ON) return;
  ghPending[file] = obj;                       // always remember the latest object
  if (ghTimers[file]) return;                  // a flush is already scheduled
  const wait = Math.max((GH_MIN[file] || 4000) - (Date.now() - (ghLastSave[file] || 0)), 800);
  ghTimers[file] = setTimeout(() => {
    ghTimers[file] = null;
    ghLastSave[file] = Date.now();
    const data = ghPending[file]; delete ghPending[file];
    ghPut(file, data).catch((e) => console.error("ghSave err", file, e.message));
  }, wait);
}
// Flush any GH writes still waiting out their throttle window before the
// process exits (e.g. a Render redeploy), so a restart mid-window doesn't
// silently drop up to GH_MIN worth of fuel/odometer history.
async function flushPendingGhSaves() {
  if (!GH_ON) return;
  const files = Object.keys(ghPending);
  for (const file of files) {
    if (ghTimers[file]) { clearTimeout(ghTimers[file]); ghTimers[file] = null; }
    const data = ghPending[file]; delete ghPending[file];
    try { await ghPut(file, data); } catch (e) { console.error("ghSave flush err", file, e.message); }
  }
}
async function gracefulShutdown(signal) {
  console.log(`\n  ${signal} received — flushing pending saves...`);
  try { await flushPendingGhSaves(); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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
// NOTE: the static demo seed (fuel_seed.json, frozen at commit time) is applied
// later, in initDurable(), and only for units that still have no reading at all
// after the durable per-unit fuel_series.json has had a chance to backfill the
// real last-known value. Applying it wholesale here (as before) let a months-old
// demo reading permanently mask a fresher real one on every restart, since later
// code only fills in a unit's fuelHist entry when one isn't already present.

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
// --- Fuel-station directories (store number -> coords) per brand, built by scrapers ---
function loadStations(file) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8")); } catch { return {}; } }
const brandStations = {
  pilot: loadStations("stations.json"),
  loves: loadStations("loves.json"),
  ta: loadStations("ta.json"),
};
const BRAND_LABELS = { pilot: "Pilot", loves: "Love's", ta: "TA/Petro" };
const stations = brandStations.pilot; // legacy alias (Pilot price lookups, etc.)
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Road miles + ETA via the public OSRM demo server; falls back to straight-line.
async function roadDistance(lat1, lon1, lat2, lon2) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      if (j.routes && j.routes[0]) {
        return { miles: j.routes[0].distance / 1609.34, etaMin: Math.round(j.routes[0].duration / 60), source: "road" };
      }
    }
  } catch (e) { /* fall through */ }
  return { miles: haversineMiles(lat1, lon1, lat2, lon2), etaMin: null, source: "air" };
}

// --- Per-unit fuel-stop assignments (which Pilot station each truck is sent to) ---
const ASSIGN_STORE = path.join(__dirname, "assignments.json");
let assignments = {};
// Normalize to { unit: { brand, num } }; migrate legacy string values (= Pilot).
function migrateAssignments() {
  for (const u in assignments) {
    const v = assignments[u];
    if (typeof v === "string") assignments[u] = { brand: "pilot", num: normNum(v) };
    else if (v && v.num) assignments[u] = { brand: v.brand || "pilot", num: normNum(v.num) };
    else delete assignments[u];
  }
}
try { assignments = JSON.parse(fs.readFileSync(ASSIGN_STORE, "utf8")); } catch { assignments = {}; }
migrateAssignments();
let assignTimer = null;
function saveAssignments() {
  clearTimeout(assignTimer);
  assignTimer = setTimeout(() => {
    fs.writeFile(ASSIGN_STORE, JSON.stringify(assignments), () => {});
    ghSave("assignments.json", assignments);
  }, 800);
}
let fsBoardCache = { data: null, at: 0 };
const FSBOARD_MS = 50 * 1000; // ~50s so the 60s board poll always recomputes miles

// --- Per-unit notes (driver quirks: uses exits, no calls, etc.) — durable ---
const UNOTES_STORE = path.join(__dirname, "unit_notes.json");
let unitNotes = {};
try { unitNotes = JSON.parse(fs.readFileSync(UNOTES_STORE, "utf8")); } catch { unitNotes = {}; }
let unotesTimer = null;
function saveUnitNotes() {
  clearTimeout(unotesTimer);
  unotesTimer = setTimeout(() => {
    fs.writeFile(UNOTES_STORE, JSON.stringify(unitNotes), () => {});
    ghSave("unit_notes.json", unitNotes);
  }, 800);
}

// --- Per-unit gallon limit (max gallons per fill) — durable ---
const ULIMITS_STORE = path.join(__dirname, "unit_limits.json");
let unitLimits = {};
try { unitLimits = JSON.parse(fs.readFileSync(ULIMITS_STORE, "utf8")); } catch { unitLimits = {}; }
let ulimitsTimer = null;
function saveUnitLimits() {
  clearTimeout(ulimitsTimer);
  ulimitsTimer = setTimeout(() => {
    fs.writeFile(ULIMITS_STORE, JSON.stringify(unitLimits), () => {});
    ghSave("unit_limits.json", unitLimits);
  }, 800);
}

// Normalize a store number so "008", "8", "#8" all map to the same key.
function normNum(s) {
  s = String(s == null ? "" : s).trim().replace(/^#/, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : s;
}

// --- Daily Pilot fuel prices (uploaded from the "Better Of" price report) ---
const PRICE_STORE = path.join(__dirname, "prices.json");
let priceData = { date: null, updatedAt: null, prices: {} };
try { const p = JSON.parse(fs.readFileSync(PRICE_STORE, "utf8")); if (p && p.prices) priceData = p; } catch {}
function savePrices() {
  fs.writeFile(PRICE_STORE, JSON.stringify(priceData), () => {});
  ghSave("prices.json", priceData);
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

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 10e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
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
  // --- Auth (public login routes) ---
  // Serve the custom login page.
  if (req.url === "/login" || req.url.startsWith("/login?")) {
    fs.readFile(path.join(__dirname, "login.html"), (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }
  // Login-page background image (public — needed before the user is signed in).
  if (req.url === "/login-bg.jpg") {
    fs.readFile(path.join(__dirname, "login-bg.jpg"), (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    });
    return;
  }
  // Validate credentials -> set a signed HttpOnly session cookie.
  if (req.url === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const role = roleFor((body && body.user || "").trim(), (body && body.pass) || "");
    if (!role) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Login yoki parol noto'g'ri" }));
      return;
    }
    const tok = makeToken(role);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `mvx_session=${tok}; HttpOnly; Path=/; Max-Age=${30 * 864e2}; SameSite=Lax`,
    });
    res.end(JSON.stringify({ ok: true, role }));
    return;
  }
  // Clear the session cookie.
  if (req.url === "/api/logout") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "mvx_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Cookie session gate (everything below requires a valid session) ---
  const role = sessionRole(req);
  if (!role) {
    if (req.url.startsWith("/api/") || req.url === "/webhook/debug") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "auth required" }));
    } else {
      res.writeHead(302, { Location: "/login" });
      res.end();
    }
    return;
  }
  req._role = role;

  // Protected: inspect what Motive has been sending.
  if (req.url === "/webhook/debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: webhookCount, actionCounts, other: webhookOther, recent: webhookLog }, null, 2));
    return;
  }
  if (req.url === "/api/me") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ role: req._role || "manager" }));
    return;
  }
  // Per-unit note (driver quirks). Any signed-in user can read/set.
  if (req.url === "/api/unit-note" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    if (!unit) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "unit kerak" })); return; }
    const note = String(body.note == null ? "" : body.note).slice(0, 500).trim();
    if (note) unitNotes[unit] = note; else delete unitNotes[unit];
    saveUnitNotes();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Per-unit gallon limit (max gallons per fill). Any signed-in user can set.
  if (req.url === "/api/unit-limit" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    if (!unit) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "unit kerak" })); return; }
    const lim = parseFloat(body.limit);
    if (Number.isFinite(lim) && lim > 0) unitLimits[unit] = Math.round(lim * 10) / 10; else delete unitLimits[unit];
    saveUnitLimits();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/fuel" || req.url.startsWith("/api/fuel?")) {
    try {
      const data = await getFuelData();
      for (const r of data.fleet) { r.assignedStop = assignments[r.unit] || null; r.note = unitNotes[r.unit] || ""; r.gallonLimit = unitLimits[r.unit] != null ? unitLimits[r.unit] : null; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // --- Daily Pilot price: upload (parsed in-browser) + read ---
  if (req.url === "/api/fuel-price" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(priceData));
    return;
  }
  if (req.url === "/api/fuel-price" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || typeof body.prices !== "object" || Array.isArray(body.prices)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "prices object kerak" }));
      return;
    }
    const norm = {};
    for (const k in body.prices) norm[normNum(k)] = body.prices[k];
    priceData = { date: body.date || null, updatedAt: new Date().toISOString(), prices: norm };
    savePrices();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: Object.keys(norm).length, date: priceData.date }));
    return;
  }

  // --- Fuel stop: assign a Pilot station to a unit + per-unit miles-left board ---
  // Assign / change a unit's fuel stop.
  if (req.url === "/api/fuel-stop/assign" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    const brand = (body && body.brand) || "pilot";
    const dir = brandStations[brand];
    const num = normNum(body && body.station);
    if (!unit || !num || !dir) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unit, brand va station kerak" }));
      return;
    }
    if (!dir[num]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `${BRAND_LABELS[brand] || brand} #${num} topilmadi (bazada ${Object.keys(dir).length} ta)` }));
      return;
    }
    assignments[unit] = { brand, num };
    saveAssignments();
    fsBoardCache = { data: null, at: 0 };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, unit, brand, station: { num, ...dir[num] } }));
    return;
  }
  // Clear a unit's fuel stop (e.g. once it has fueled).
  if (req.url === "/api/fuel-stop/clear" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    if (assignments[unit]) { delete assignments[unit]; saveAssignments(); fsBoardCache = { data: null, at: 0 }; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Miles-left to each assigned station (cached ~5 min so OSRM isn't hammered).
  if (req.url.startsWith("/api/fuel-stop/board")) {
    if (fsBoardCache.data && Date.now() - fsBoardCache.at < FSBOARD_MS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(fsBoardCache.data));
      return;
    }
    let data;
    try { data = await getFuelData(); } catch (e) { data = { fleet: [] }; }
    const out = {};
    for (const unit of Object.keys(assignments)) {
      const a = assignments[unit];
      const stn = (brandStations[a.brand] || {})[a.num];
      if (!stn) continue;
      const base = { brand: a.brand, brandLabel: BRAND_LABELS[a.brand] || a.brand, station: a.num, name: stn.brand, city: stn.city, st: stn.st };
      const truck = data.fleet.find((x) => x.unit === unit);
      if (!truck || truck.lat == null || truck.lon == null) {
        out[unit] = { ...base, miles: null, error: "no-location" };
        continue;
      }
      const dist = await roadDistance(truck.lat, truck.lon, stn.lat, stn.lon);
      out[unit] = { ...base, addr: stn.addr, lat: stn.lat, lon: stn.lon, miles: Math.round(dist.miles * 10) / 10, etaMin: dist.etaMin, source: dist.source };
    }
    fsBoardCache = { data: out, at: Date.now() };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  serveStatic(req, res);
});

// Load durable data from the private GitHub repo on startup (overrides the
// ephemeral local disk copy), so fuel history survives any restart.
async function initDurable() {
  let seeded = 0;
  if (GH_ON) {
    const s = await ghLoad("fuel_series.json");
    if (s && typeof s === "object") {
      fuelSeries = s;
      // Seed the last-known fuel cache from the durable series, so parked trucks
      // still show their most recent reading after a restart/deploy (not "No data yet").
      for (const u in fuelSeries) {
        const arr = fuelSeries[u];
        if (Array.isArray(arr) && arr.length && !fuelHist[u]) {
          const last = arr[arr.length - 1];
          if (last && typeof last[1] === "number") { fuelHist[u] = { fuel: last[1], at: new Date(last[0]).toISOString() }; seeded++; }
        }
      }
    }
    const o = await ghLoad("odo_daily.json");
    if (o && typeof o === "object") odoDaily = o;
    const as = await ghLoad("assignments.json");
    if (as && typeof as === "object" && !Array.isArray(as)) { assignments = as; migrateAssignments(); }
    const pr = await ghLoad("prices.json");
    if (pr && pr.prices) priceData = pr;
    const un = await ghLoad("unit_notes.json");
    if (un && typeof un === "object" && !Array.isArray(un)) unitNotes = un;
    const ul = await ghLoad("unit_limits.json");
    if (ul && typeof ul === "object" && !Array.isArray(ul)) unitLimits = ul;
    console.log(`  Durable store:       GitHub ${GH_REPO} ✓`);
  }
  // Any unit that still has no reading at all at this point (brand new / never
  // tracked, or GH off) falls back to the static demo seed rather than showing
  // "No data yet" -- but only fills gaps, so it can never mask a fresher real
  // reading pulled from the durable series above.
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "fuel_seed.json"), "utf8"));
    for (const u in seed) { if (!fuelHist[u]) { fuelHist[u] = seed[u]; seeded++; } }
  } catch {}
  if (seeded) { saveFuelHist(); cache.at = 0; } // invalidate fuel cache so the seeded values show
  if (seeded) console.log(`  Last-known seeded:   ${seeded} units (durable series + demo seed gaps)`);
}

server.listen(PORT, () => {
  console.log(`\n  Fuel board running:  http://localhost:${PORT}`);
  console.log(`  API endpoint:        http://localhost:${PORT}/api/fuel`);
  console.log(`  Motive key:          ${API_KEY ? "loaded ✓" : "MISSING ✗"}`);
  console.log(`  Login:               ${AUTH_ON ? `on (user: ${AUTH_USER}) ✓` : "OFF — set AUTH_USER/AUTH_PASS for cloud"}`);
  console.log(`  Stations:            Pilot ${Object.keys(brandStations.pilot).length} · Love's ${Object.keys(brandStations.loves).length} · TA/Petro ${Object.keys(brandStations.ta).length}`);
  console.log(`  Durable store:       ${GH_ON ? "configuring…" : "OFF — set GH_TOKEN/GH_REPO for permanence"}\n`);
  initDurable().catch((e) => console.error("initDurable", e.message));
});

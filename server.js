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
const MOTIVE_BASE = process.env.MOTIVE_BASE || "https://api.gomotive.com";

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

// --- Toll reminder points: an arbitrary spot (picked in Google Maps) per unit ---
// The board warns dispatch while the truck is still TOLL_REMIND_MI out, so the
// driver can be reminded about the directed route before he reaches the toll.
const TOLLPT_STORE = path.join(__dirname, "toll_points.json");
let tollPoints = {}; // { unit: [ { id, label, lat, lon, url, at } ] }
const MAX_POINTS = 8; // per unit — a directed route rarely needs more
const newPointId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// The first version of this feature stored a single point per unit. Fold those
// into the list shape and drop anything without usable coordinates.
function migrateTollPoints() {
  for (const u in tollPoints) {
    const v = tollPoints[u];
    const list = Array.isArray(v) ? v : [v];
    const clean = list
      .filter((p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon))
      .map((p) => ({ ...p, id: p.id || newPointId(), lat: +p.lat, lon: +p.lon }))
      .slice(0, MAX_POINTS);
    if (clean.length) tollPoints[u] = clean; else delete tollPoints[u];
  }
}
try { tollPoints = JSON.parse(fs.readFileSync(TOLLPT_STORE, "utf8")); } catch { tollPoints = {}; }
migrateTollPoints();
function saveTollPoints() {
  fs.writeFile(TOLLPT_STORE, JSON.stringify(tollPoints), () => {});
  ghSave("toll_points.json", tollPoints);
}
let tpBoardCache = { data: null, at: 0 };
const TOLL_REMIND_MI = 20; // how far out the reminder fires (road miles)
const ROUTE_NEAR_MI = 60;  // beyond this, straight-line miles are good enough

// --- Telegram: the reminder has to reach dispatch with no board open ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const TG_API = process.env.TELEGRAM_API || "https://api.telegram.org";
const TG_ON = !!(TG_TOKEN && TG_CHAT);
// Telegram sends happen server-side, so when a message never arrives there is
// nothing in the browser to inspect and the host logs are the only witness.
// Mirror the outcome of every send — plus a boot-time getMe — into the durable
// repo, where it can be read without shell access to the host. The token is
// never recorded; only whether it is set and its length, which is what catches
// a truncated or whitespace-padded value.
const tgDiag = {
  bootAt: new Date().toISOString(),
  on: TG_ON,
  tokenSet: !!TG_TOKEN,
  tokenLen: TG_TOKEN.length,
  chatSet: !!TG_CHAT,
  chatId: TG_CHAT,
  getMe: null,
  lastSend: null,
};
function tgDiagSave() { ghSave("telegram_diag.json", tgDiag); }
function tgNote(result) { tgDiag.lastSend = { at: new Date().toISOString(), ...result }; tgDiagSave(); }
async function tgSend(text) {
  if (!TG_ON) { tgNote({ ok: false, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID sozlanmagan" }); return false; }
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      console.error("telegram", r.status, body);
      tgNote({ ok: false, status: r.status, error: body });
      return false;
    }
    tgNote({ ok: true });
    return true;
  } catch (e) { console.error("telegram err", e.message); tgNote({ ok: false, error: e.message }); return false; }
}
// Ask Telegram who we are at boot: it separates a bad token (Unauthorized)
// from a bad chat id, which otherwise look identical from the board.
async function tgBootCheck() {
  if (!TG_ON) { tgDiagSave(); return; }
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/getMe`, { signal: AbortSignal.timeout(12000) });
    const body = await r.json().catch(() => null);
    tgDiag.getMe = r.ok && body && body.ok
      ? { ok: true, username: body.result && body.result.username }
      : { ok: false, status: r.status, error: (body && body.description) || `HTTP ${r.status}` };
  } catch (e) { tgDiag.getMe = { ok: false, error: e.message }; }
  tgDiagSave();
}

// Place name -> coordinates via OpenStreetMap's Nominatim (free, no API key).
// Cached per phrase: dispatch types the same handful of exits all week, and
// Nominatim's usage policy asks callers not to repeat identical lookups.
const GEOCODE_URL = process.env.GEOCODE_URL || "https://nominatim.openstreetmap.org/search";
const geoCache = new Map();
async function geocodePlace(text) {
  const q = String(text || "").trim();
  if (q.length < 3) return null;
  const key = q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  try {
    const url = `${GEOCODE_URL}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": "movex-fuel-board/1.0 (fleet dispatch board)", Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || hit.lat == null || hit.lon == null) { geoCache.set(key, null); return null; }
    const lat = +hit.lat, lon = +hit.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Nominatim's display_name is a long postal address; the first two parts
    // ("Breezewood, Bedford County") read better in a table cell.
    const label = String(hit.display_name || q).split(",").slice(0, 2).join(",").trim() || q;
    const out = { lat, lon, label: label.slice(0, 60) };
    geoCache.set(key, out);
    return out;
  } catch { return null; }
}

// Turn whatever dispatch typed into one coordinate: a place name, a Google Maps
// share link, a full desktop URL, a directions link, or bare coordinates. Only
// the place-name path needs the geocoder — links carry the coords themselves.
async function resolveMapPoint(input) {
  let u = String(input || "").trim();
  if (!u) return null;
  // Typed straight in: "34.05, -118.24"
  const raw = u.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (raw) {
    const lat = +raw[1], lon = +raw[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, label: `${lat}, ${lon}` };
    return null;
  }
  // Not a URL -> treat it as a place name ("Breezewood, PA", "I-80 Exit 161").
  if (!/^https?:\/\//i.test(u)) return geocodePlace(u);
  // Short share links (maps.app.goo.gl/…) only carry the coords after redirect.
  if (/goo\.gl/.test(u)) {
    try { const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10000) }); u = r.url || u; } catch {}
  }
  const pick = (lat, lon) => (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null);
  let pt = null;
  // 1) Pinned place: !3d<lat>!4d<lon> — the exact marker, most precise.
  let m = [...u.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)].pop();
  if (m) pt = pick(+m[1], +m[2]);
  // 2) ?q= / ?query= / ?destination= carrying "lat,lon".
  if (!pt) {
    m = u.match(/[?&](?:q|query|destination|center)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
    if (m) pt = pick(+m[1], +m[2]);
  }
  // 3) Directions waypoints: !1d<lon>!2d<lat> — take the last stop (the target).
  if (!pt) {
    m = [...u.matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)].pop();
    if (m) pt = pick(+m[2], +m[1]);
  }
  // 4) Map centre: /@<lat>,<lon>,<zoom>z — a rougher fallback (the view, not a pin).
  if (!pt) {
    m = u.match(/\/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) pt = pick(+m[1], +m[2]);
  }
  if (!pt) return null;
  // Name it from the /place/<name>/ segment when Google put one there.
  let label = "";
  const pm = u.match(/\/maps\/place\/([^/@?]+)/);
  if (pm) label = decodeURIComponent(pm[1].replace(/\+/g, " ")).trim();
  if (!label) label = `${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}`;
  return { ...pt, label: label.slice(0, 60) };
}

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

  // --- Toll reminder point: pin a spot from Google Maps, watch the miles left ---
  if (req.url === "/api/toll-point/assign" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    const link = (body && (body.link || body.point) || "").trim();
    if (!unit || !link) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unit va joy (nomi, linki yoki koordinatasi) kerak" }));
      return;
    }
    const pt = await resolveMapPoint(link);
    if (!pt) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Joy topilmadi. Shahar yoki manzil yozing (masalan: Breezewood, PA), yoki Google Maps linkini tashlang, yoki 41.2033,-77.1945 ko'rinishida koordinata bering." }));
      return;
    }
    const list = tollPoints[unit] || (tollPoints[unit] = []);
    if (list.length >= MAX_POINTS) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `Unit ${unit} da allaqachon ${MAX_POINTS} ta nuqta bor — avval bittasini o'chiring.` }));
      return;
    }
    const point = { id: newPointId(), label: (body.label || "").trim() || pt.label, lat: pt.lat, lon: pt.lon, url: link, at: new Date().toISOString() };
    list.push(point);
    saveTollPoints();
    tpBoardCache = { data: null, at: 0 };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, unit, point, count: list.length }));
    return;
  }
  // Drop one point by id, or every point on the unit when no id is given.
  if (req.url === "/api/toll-point/clear" && req.method === "POST") {
    const body = await readBody(req);
    const unit = (body && body.unit || "").trim();
    const id = (body && body.id || "").trim();
    const list = tollPoints[unit];
    if (list) {
      if (id) {
        tollPoints[unit] = list.filter((p) => p.id !== id);
        if (!tollPoints[unit].length) delete tollPoints[unit];
      } else {
        delete tollPoints[unit];
      }
      saveTollPoints();
      tpBoardCache = { data: null, at: 0 };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, left: (tollPoints[unit] || []).length }));
    return;
  }
  // Road miles from each truck to its toll point (same ~50s cache as the stop board).
  if (req.url.startsWith("/api/toll-point/board")) {
    if (tpBoardCache.data && Date.now() - tpBoardCache.at < FSBOARD_MS) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tpBoardCache.data));
      return;
    }
    let data;
    try { data = await getFuelData(); } catch (e) { data = { fleet: [] }; }
    const points = {};
    for (const unit of Object.keys(tollPoints)) {
      const truck = data.fleet.find((x) => x.unit === unit);
      const out = [];
      for (const p of tollPoints[unit]) {
        const base = { id: p.id, label: p.label, lat: p.lat, lon: p.lon, url: p.url, remindedAt: p.remindedAt || null };
        if (!truck || truck.lat == null || truck.lon == null) {
          out.push({ ...base, miles: null, error: "no-location" });
          continue;
        }
        // Straight-line first: with several points per unit, routing every one
        // of them each poll would hammer OSRM. Only the last stretch needs road
        // accuracy — anything further out is fine as a rough "still far" number.
        const air = haversineMiles(truck.lat, truck.lon, p.lat, p.lon);
        if (air > ROUTE_NEAR_MI) {
          out.push({ ...base, miles: Math.round(air), etaMin: null, source: "air" });
          continue;
        }
        const dist = await roadDistance(truck.lat, truck.lon, p.lat, p.lon);
        out.push({ ...base, miles: Math.round(dist.miles * 10) / 10, etaMin: dist.etaMin, source: dist.source });
      }
      // Nearest first, so the point the driver hits next sits on top.
      out.sort((a, b) => (a.miles == null) - (b.miles == null) || a.miles - b.miles);
      points[unit] = out;
    }
    const out = { remindMi: TOLL_REMIND_MI, points };
    tpBoardCache = { data: out, at: Date.now() };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  // --- Telegram setup helpers (never return the token itself) ---
  if (req.url === "/api/telegram/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, on: TG_ON, tokenSet: !!TG_TOKEN, chatSet: !!TG_CHAT, diag: tgDiag }));
    return;
  }
  // Finding a chat id is the fiddly part of the setup: write to the bot once,
  // then open this and copy the id it lists into TELEGRAM_CHAT_ID.
  if (req.url === "/api/telegram/chats") {
    if (!TG_TOKEN) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "TELEGRAM_BOT_TOKEN sozlanmagan" }));
      return;
    }
    try {
      const r = await fetch(`${TG_API}/bot${TG_TOKEN}/getUpdates`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const seen = new Map();
      for (const u of (j.result || [])) {
        const c = (u.message || u.channel_post || {}).chat;
        if (c && !seen.has(c.id)) seen.set(c.id, { id: c.id, type: c.type, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "" });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !!j.ok, chats: [...seen.values()], hint: "Botga bitta xabar yozing, keyin shu sahifani yangilang." }));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  // GET too, so the setup can be finished from the browser's address bar.
  if (req.url === "/api/telegram/test") {
    const sent = await tgSend("✅ MOVEX fuel board — Telegram ulanishi ishlayapti. Toll eslatmalari shu yerga keladi.");
    res.writeHead(sent ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: sent, error: sent ? undefined : (TG_ON ? "Telegram javob bermadi (log'ni qarang)" : "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID sozlanmagan") }));
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
    const tp = await ghLoad("toll_points.json");
    if (tp && typeof tp === "object" && !Array.isArray(tp)) { tollPoints = tp; migrateTollPoints(); }
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

// Watch the toll points server-side, so the reminder goes out even when nobody
// has the board open. The browser keeps its own toast; this drives Telegram.
// Each point remembers when it fired (durable), so a restart neither repeats a
// reminder nor loses one, and it re-arms only after the truck pulls well clear.
const TOLL_WATCH_MS = Math.max(+process.env.TOLL_WATCH_MS || 60000, 5000);
async function runTollWatch() {
  const units = Object.keys(tollPoints);
  if (!units.length) return;               // nothing pinned -> no Motive call
  let data;
  try { data = await getFuelData(); } catch { return; }
  let changed = false;
  for (const unit of units) {
    const truck = data.fleet.find((x) => x.unit === unit);
    if (!truck || truck.lat == null || truck.lon == null) continue;
    for (const p of tollPoints[unit] || []) {
      const air = haversineMiles(truck.lat, truck.lon, p.lat, p.lon);
      if (air > ROUTE_NEAR_MI) {
        if (p.remindedAt) { delete p.remindedAt; changed = true; }  // long gone
        continue;
      }
      const d = await roadDistance(truck.lat, truck.lon, p.lat, p.lon);
      const miles = Math.round(d.miles * 10) / 10;
      if (miles <= TOLL_REMIND_MI && !p.remindedAt) {
        const driver = truck.driver && truck.driver !== "Unassigned" ? ` (${truck.driver})` : "";
        const text = `📍 Toll eslatma\nUnit ${unit}${driver} → ${p.label}\nQolgan masofa: ${miles} mi${d.etaMin ? ` · ~${d.etaMin} daq` : ""}\n\nDriverga yo'nalishni eslating.`;
        // Mark it done only once Telegram has actually accepted the message —
        // otherwise a failed send would bury the reminder for good, since the
        // point never fires twice on one approach. A failure just retries next
        // tick. With Telegram off the board is the only channel, so mark it.
        const delivered = TG_ON ? await tgSend(text) : true;
        if (delivered) { p.remindedAt = new Date().toISOString(); changed = true; }
      } else if (miles > TOLL_REMIND_MI + 10 && p.remindedAt) {
        delete p.remindedAt;
        changed = true;
      }
    }
  }
  if (changed) { saveTollPoints(); tpBoardCache = { data: null, at: 0 }; } // so the ✓ shows up promptly
}

server.listen(PORT, () => {
  console.log(`\n  Fuel board running:  http://localhost:${PORT}`);
  console.log(`  API endpoint:        http://localhost:${PORT}/api/fuel`);
  console.log(`  Motive key:          ${API_KEY ? "loaded ✓" : "MISSING ✗"}`);
  console.log(`  Login:               ${AUTH_ON ? `on (user: ${AUTH_USER}) ✓` : "OFF — set AUTH_USER/AUTH_PASS for cloud"}`);
  console.log(`  Stations:            Pilot ${Object.keys(brandStations.pilot).length} · Love's ${Object.keys(brandStations.loves).length} · TA/Petro ${Object.keys(brandStations.ta).length}`);
  console.log(`  Durable store:       ${GH_ON ? "configuring…" : "OFF — set GH_TOKEN/GH_REPO for permanence"}`);
  console.log(`  Toll reminder:       ${TG_ON ? `Telegram ✓ (chat ${TG_CHAT})` : "board only — set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID for Telegram"}\n`);
  initDurable().catch((e) => console.error("initDurable", e.message));
  // After initDurable, so the diag write lands once the repo shas are known.
  setTimeout(() => tgBootCheck().catch((e) => console.error("tgBootCheck", e.message)), 8000);
  setInterval(() => runTollWatch().catch((e) => console.error("tollWatch", e.message)), TOLL_WATCH_MS);
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dirs = require("./direction-note.js");
const audit = require("./fuel-audit.js");

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

// One seat: the manager, with the whole board behind it. The worker and ops
// seats were removed — everything they gated is now the manager's.
// AUTH_USER/AUTH_PASS stays as the original name for that same login, so a
// deployment configured under either pair keeps working.
const AUTH_USER = process.env.AUTH_USER || "";       // legacy single login = manager
const AUTH_PASS = process.env.AUTH_PASS || "";
const MANAGER_USER = process.env.MANAGER_USER || "";
const MANAGER_PASS = process.env.MANAGER_PASS || "";
const AUTH_ON = !!(AUTH_USER && AUTH_PASS) || !!(MANAGER_USER && MANAGER_PASS);

// Validate a username/password -> role (used by the login form).
function roleFor(u, p) {
  if (MANAGER_USER && u === MANAGER_USER && p === MANAGER_PASS) return "manager";
  if (AUTH_USER && u === AUTH_USER && p === AUTH_PASS) return "manager";
  return null;
}
// Signed session cookie (no DB needed). The retired seats' passwords stay in
// the secret's recipe: dropping them would change the signing key and log
// everyone out on deploy for no benefit.
const SESSION_SECRET = process.env.SESSION_SECRET || (MANAGER_PASS + (process.env.WORKER_PASS || "") + AUTH_PASS + "mvx-v1");
function sign(s) { return crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url"); }
function makeToken(role) { const p = role + "." + (Date.now() + 30 * 864e5); return p + "." + sign(p); }
function verifyToken(tok) {
  if (!tok) return null;
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  if (sign(role + "." + exp) !== sig) return null;
  if (Date.now() > +exp) return null;
  // Cookies issued to the retired seats stop verifying here, so those sessions
  // land back on the login page instead of holding access that no longer exists.
  if (role !== "manager") return null;
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
// A fuel-card line can only be checked against what actually went into the
// tank, and that is knowable for a moment only: the level jumps, at a place, at
// a time. Locations are not otherwise kept, so a fill nobody recorded while it
// was happening can never be verified afterwards — hence recording it now,
// before there is anything to compare it against.
// Measured against the lowest reading of the last couple of hours, not against
// the previous one. A moving truck's gauge swings several points either way as
// fuel slides around the tank — unit 5478 read 36 -> 39.2 -> 34.8 -> 39.2 in
// five minutes, sitting still in terms of fuel. A rise from the recent floor
// ignores that swing and still catches a fill delivered over several readings.
const FILL_MIN_PCT = 10;             // a 150 gal tank: ~15 gallons
const FILL_FLOOR_MS = 2 * 3600000;   // how far back to look for that floor
const FILL_MERGE_MS = 45 * 60000;    // one fill arrives as several rising reads
const EVENTS_STORE = path.join(__dirname, "fuel_events.json");
let fuelEvents = {};
try { fuelEvents = JSON.parse(fs.readFileSync(EVENTS_STORE, "utf8")); } catch { fuelEvents = {}; }
let eventsTimer = null;
function saveFuelEvents() {
  clearTimeout(eventsTimer);
  eventsTimer = setTimeout(() => {
    fs.writeFile(EVENTS_STORE, JSON.stringify(fuelEvents), () => {});
    ghSave("fuel_events.json", fuelEvents);
  }, 3000);
}
// Events recorded before the threshold was raised are tank slosh, not fills.
// Dropping them on load keeps the noise out of every baseline computed later.
function pruneFuelEvents() {
  let dropped = 0;
  for (const u of Object.keys(fuelEvents)) {
    const keep = (fuelEvents[u] || []).filter((e) => (e.to - e.from) >= FILL_MIN_PCT);
    dropped += (fuelEvents[u] || []).length - keep.length;
    if (keep.length) fuelEvents[u] = keep; else delete fuelEvents[u];
  }
  if (dropped) { console.log(`  Fuel events:         ${dropped} ta chayqalish yozuvi tozalandi`); saveFuelEvents(); }
  return dropped;
}

function recordFill(unit, t, from, to, loc) {
  const arr = (fuelEvents[unit] = fuelEvents[unit] || []);
  const last = arr[arr.length - 1];
  const lat = loc && loc.lat != null ? +loc.lat : null;
  const lon = loc && loc.lon != null ? +loc.lon : null;
  if (last && to > last.to && t - new Date(last.endAt).getTime() <= FILL_MERGE_MS) {
    last.to = to;                                  // still climbing — same fill
    last.endAt = new Date(t).toISOString();
    last.pct = Math.round((last.to - last.from) * 10) / 10;
    if (last.lat == null && lat != null) { last.lat = lat; last.lon = lon; }
    saveFuelEvents();
    return;
  }
  arr.push({
    at: new Date(t).toISOString(),
    endAt: new Date(t).toISOString(),
    from, to,
    pct: Math.round((to - from) * 10) / 10,
    lat, lon,
  });
  const cutoff = Date.now() - 180 * 864e5;
  while (arr.length && new Date(arr[0].at).getTime() < cutoff) arr.shift();
  saveFuelEvents();
}

function recordFuelPoint(unit, fuel, atISO, loc) {
  if (!unit || typeof fuel !== "number") return;
  const t = atISO ? new Date(atISO).getTime() : Date.now();
  if (!Number.isFinite(t)) return;
  const arr = (fuelSeries[unit] = fuelSeries[unit] || []);
  const last = arr[arr.length - 1];
  // Checked before the near-duplicate skip below, though a fill is far too big
  // a jump to be caught by it.
  let floor = null;
  // The floor is only looked for since the last fill ended. Otherwise the
  // readings from before that fill stay in the window, and the next reading —
  // a truck simply driving away on a full tank — reads as a second fill.
  const done = fuelEvents[unit] || [];
  const prev = done[done.length - 1];
  const since = Math.max(t - FILL_FLOOR_MS, prev ? new Date(prev.endAt).getTime() : 0);
  for (let i = arr.length - 1; i >= 0 && arr[i][0] >= since; i--) {
    if (floor == null || arr[i][1] < floor) floor = arr[i][1];
  }
  if (floor != null && fuel - floor >= FILL_MIN_PCT) recordFill(unit, t, floor, fuel, loc);
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
  // Which build is actually serving. Without it, "the page still looks old" is
  // a guess between a deploy that hasn't finished and a browser holding a stale
  // copy; Render puts the deployed commit in the environment.
  commit: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7),
  on: TG_ON,
  tokenSet: !!TG_TOKEN,
  tokenLen: TG_TOKEN.length,
  chatSet: !!TG_CHAT,
  chatId: TG_CHAT,
  getMe: null,
  lastSend: null,
};
function tgDiagSave() { ghSave("telegram_diag.json", tgDiag); }
// Messages are sent as HTML so the unit and driver can be bolded. Anything
// interpolated in — driver names, point labels typed by dispatch — has to be
// escaped, or a stray "&" or "<" makes Telegram reject the whole message.
function tgEsc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function tgNote(result) { tgDiag.lastSend = { at: new Date().toISOString(), ...result }; tgDiagSave(); }
async function tgSend(text) {
  if (!TG_ON) { tgNote({ ok: false, error: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID sozlanmagan" }); return false; }
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
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


// --- Units the audit should leave alone ---
// A truck with a dead gauge, two tanks, or a reefer drawing off the same card
// fails the arithmetic every single week. Without a way to set those aside the
// list fills up with the same known-explained rows and stops being read.
const IGNORE_STORE = path.join(__dirname, "audit_ignore.json");
let auditIgnore = [];
try { auditIgnore = JSON.parse(fs.readFileSync(IGNORE_STORE, "utf8")); } catch { auditIgnore = []; }
if (!Array.isArray(auditIgnore)) auditIgnore = [];
function saveAuditIgnore() {
  fs.writeFile(IGNORE_STORE, JSON.stringify(auditIgnore), () => {});
  ghSave("audit_ignore.json", auditIgnore);
}
const normUnitId = (v) => {
  const s = String(v == null ? "" : v).trim().replace(/^#/, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : s;
};

// Which fleet unit a card line belongs to. The export writes the number the way
// whoever set the card up typed it, so "0010" and "010" both turn up — and in a
// real week they were two different trucks. An exact match wins; a padded form
// is accepted only when exactly one fleet unit could have produced it, and
// anything still ambiguous is left as written rather than guessed onto a truck.
function resolveUnit(raw, known) {
  const s = String(raw == null ? "" : raw).trim().replace(/^#/, "");
  if (!s || known.has(s)) return s;
  const n = normUnitId(s);
  if (known.has(n)) return n;
  const cands = [];
  for (const k of known) if (normUnitId(k) === n) cands.push(k);
  return cands.length === 1 ? cands[0] : s;
}

// --- Station coordinates, learned once and kept ---
// The audit asks whether the truck was anywhere near the station it was charged
// at. That needs the station's position, and the report only gives a city and a
// state. Geocoding 400 lines a week would be both slow and rude to a free
// service, so each city is looked up once and remembered — by the second week
// almost everything is already known.
const STATION_STORE = path.join(__dirname, "station_geo.json");
let stationGeo = {};
try { stationGeo = JSON.parse(fs.readFileSync(STATION_STORE, "utf8")); } catch { stationGeo = {}; }
function saveStationGeo() {
  fs.writeFile(STATION_STORE, JSON.stringify(stationGeo), () => {});
  ghSave("station_geo.json", stationGeo);
}
// A city centre is not the truck stop — those sit out by the interstate, and in
// a large metro that is a long way from downtown. The distance only has to
// catch a card used in another state, so it is deliberately generous.
const STATION_FAR_MI = 60;
const GEOCODE_BUDGET = 60;      // new lookups per upload; the rest wait a week

async function stationPoint(city, st, budget) {
  const key = `${String(city || "").trim().toUpperCase()}|${String(st || "").trim().toUpperCase()}`;
  if (key === "|") return null;
  if (Object.prototype.hasOwnProperty.call(stationGeo, key)) return stationGeo[key];
  if (budget.left <= 0 || budget.misses >= 3) return undefined;   // not looked up, not "no such place"
  budget.left--;
  const hit = await geocodePlace(`${city}, ${st}`);
  if (!hit) {
    // A geocoder that is down answers every lookup the same way, and each answer
    // costs the full timeout. Three in a row and the rest of the upload waits
    // for another day rather than making the operator sit through sixty of them.
    budget.misses++;
    if (budget.misses >= 3) return undefined;
  } else {
    budget.misses = 0;
  }
  stationGeo[key] = hit ? { lat: hit.lat, lon: hit.lon } : null;
  budget.dirty = true;
  return stationGeo[key];
}

// Adds the "was the truck there?" question to rows that already have an answer
// about the gallons.
async function checkLocations(rows) {
  const budget = { left: GEOCODE_BUDGET, dirty: false, misses: 0 };
  let checked = 0, far = 0, pending = 0;
  for (const r of rows) {
    if (r.lat == null || !r.city) continue;
    const pt = await stationPoint(r.city, r.st, budget);
    if (pt === undefined) { pending++; continue; }
    if (!pt) continue;                            // city could not be placed
    const mi = Math.round(haversineMiles(r.lat, r.lon, pt.lat, pt.lon));
    r.stationMi = mi;
    checked++;
    if (mi > STATION_FAR_MI) {
      far++;
      const note = `truck quyish paytida ${r.city}, ${r.st} dan ${mi} mil narida edi`;
      // A gallons verdict is the stronger finding; the distance is added to it
      // rather than replacing it.
      if (r.verdict === "ok" || r.verdict === "unknown" || r.verdict === "check") {
        r.verdict = "suspicious";
        r.reason = r.reason ? `${r.reason}; ${note}` : note;
      } else {
        r.reason = `${r.reason}; ${note}`;
      }
    }
  }
  if (budget.dirty) saveStationGeo();
  return { checked, far, pending };
}

// --- Written route note ("#DIRECTION") from a Google Maps link ---
// Dispatch writes these by hand today: which interstates the driver takes and
// which numbered exit joins the next one. The routing engine already knows the
// road-by-road path, so the note can be drafted from the link and then read
// over — see the caveat below about what it does not know.
const OSRM_BASE = process.env.OSRM_API || "https://router.project-osrm.org";
async function directionRoute(coords) {
  const via = coords.map((c) => `${c.lon},${c.lat}`).join(";");
  const r = await fetch(`${OSRM_BASE}/route/v1/driving/${via}?overview=false&steps=true`, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`marshrut xizmati javob bermadi (${r.status})`);
  const j = await r.json();
  const route = j.routes && j.routes[0];
  if (!route) throw new Error("bu bekatlar orasida yo'l topilmadi");
  const steps = [];
  for (const leg of route.legs || []) for (const s of leg.steps || []) steps.push(s);
  return { miles: route.distance / 1609.34, steps };
}
async function buildDirectionNote({ url, text, unit, dispatchedMiles }) {
  const dispatchedNum = Number(dispatchedMiles);
  const dispatched = Number.isFinite(dispatchedNum) && dispatchedNum > 0 ? dispatchedNum : undefined;
  // Google's own directions, pasted from the Details panel. Nothing is routed:
  // the roads, exits and compass halves are the ones the driver will read, so
  // this is preferred over anything computed here.
  const pasted = String(text || "").trim();
  if (pasted) {
    const g = dirs.parseGoogleText(pasted);
    if (!g.lines.length) return { ok: false, error: "matndan yo'nalish topilmadi — Google'dagi \"Details\" ro'yxatini to'liq nusxalang" };
    return {
      ok: true,
      note: dirs.buildNote({ lines: g.lines, routeMiles: g.miles == null ? undefined : g.miles, dispatchedMiles: dispatched }),
      lines: g.lines,
      stops: null,
      miles: g.miles,
      dh: null,
      source: "google",
    };
  }
  const link = String(url || "").trim();
  if (!link) return { ok: false, error: "link yoki matn kiritilmagan" };
  // Short share links carry nothing until they redirect.
  let expanded = link;
  if (/goo\.gl/.test(link)) {
    try {
      const r = await fetch(link, { redirect: "follow", signal: AbortSignal.timeout(12000) });
      expanded = r.url || link;
    } catch { /* fall through and try to parse the short form */ }
  }
  let points = dirs.parseMapsPoints(expanded);
  if (points.length < 2) {
    const wp = dirs.parseDataWaypoints(expanded);
    if (wp.length >= 2) points = wp;
  }
  if (points.length < 2) return { ok: false, error: "linkdan kamida ikkita bekat topilmadi — Maps'da yo'nalish linkini oching va uni tashlang" };
  const coords = [];
  for (const p of points) {
    if (p.lat != null) { coords.push({ lat: p.lat, lon: p.lon }); continue; }
    const g = await geocodePlace(p.place);
    if (g) coords.push({ lat: g.lat, lon: g.lon });
  }
  if (coords.length < 2) return { ok: false, error: "manzillarni koordinataga o'girib bo'lmadi" };
  let route;
  try { route = await directionRoute(coords); } catch (e) { return { ok: false, error: e.message }; }
  // DH is the empty run the truck is sitting on right now, so it is measured
  // from where the unit actually is to the first stop — not from the link.
  let dhMiles;
  if (unit) {
    try {
      const data = await getFuelData();
      const truck = (data.fleet || []).find((x) => String(x.unit) === String(unit));
      if (truck && truck.lat != null && truck.lon != null) {
        dhMiles = (await roadDistance(truck.lat, truck.lon, coords[0].lat, coords[0].lon)).miles;
      }
    } catch { /* DH is optional — the note is still worth sending without it */ }
  }
  const lines = dirs.directionLines(route.steps);
  return {
    ok: true,
    note: dirs.buildNote({ lines, dhMiles, routeMiles: route.miles, dispatchedMiles: dispatched }),
    lines,
    stops: coords.length,
    miles: Math.round(route.miles),
    dh: Number.isFinite(dhMiles) ? Math.round(dhMiles * 100) / 100 : null,
    source: "route",
  };
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
      recordFuelPoint(unit, fuel, fuelAt, loc);
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
      // The board's own files must never be stale after a deploy. The vendored
      // library is a different matter: it is nearly a megabyte and only changes
      // when it is deliberately replaced.
      "Cache-Control": url.startsWith("/vendor/")
        ? "public, max-age=604800"
        : "no-cache, must-revalidate",
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
    recordFuelPoint(unit, f, p.located_at, p);
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

// --- Toll directions: nag until dispatch confirms -----------------------------
// The toll points above remind by PLACE (truck is 20 miles out). This reminds by
// ANSWER: a direction handed to a driver stays PENDING until somebody confirms
// it, and keeps coming back every REMIND_EVERY_MIN minutes until they do. The
// two cover different failure modes, so both run.
//
// Directions arrive from the dispatch Google Sheet (read-only -- we never write
// back to it) or are typed in by hand. Only the operations seat can see them.
const DIR_STORE = path.join(__dirname, "directions_data.json");
let directions = [];
try { directions = JSON.parse(fs.readFileSync(DIR_STORE, "utf8")); } catch { directions = []; }
function saveDirections() {
  fs.writeFile(DIR_STORE, JSON.stringify(directions), () => {});
  ghSave("directions_data.json", directions);
}

const REMIND_EVERY_MIN = Math.max(1, +process.env.REMIND_EVERY_MIN || 30);

// --- Google Sheet intake (read-only) ---
// Accepts a "Publish to web -> CSV" link or a normal /edit link, which we
// rewrite to the CSV export endpoint (that form needs link-sharing turned on).
const SHEET_URL_RAW = (process.env.TOLL_SHEET_CSV || "").trim();
const SHEET_POLL_MIN = Math.max(1, +process.env.SHEET_POLL_MIN || 3);
function sheetCsvUrl(u) {
  if (!u) return "";
  if (/output=csv|\/export\?|\/pub\?/.test(u)) return u;            // already a CSV feed
  const m = u.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return u;
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
const SHEET_CSV = sheetCsvUrl(SHEET_URL_RAW);
const SHEET_ON = !!SHEET_CSV;

// Minimal RFC4180 CSV reader (quoted cells may hold commas and newlines).
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Header aliases -- dispatchers name these columns differently in every sheet,
// so match loosely instead of demanding one exact layout.
const DIR_ALIASES = {
  driver: ["driver", "driver name", "drivers", "name"],
  unit: ["unit", "unit no", "unit number", "truck", "truck no", "truck number"],
  loadId: ["load id", "loadid", "load", "load no", "load number", "trip", "trip id", "order", "order id"],
  route: ["from to", "route", "lane"],
  pu: ["pu", "pickup", "pu location", "pickup location", "pu address", "origin", "pu city"],
  puTime: ["pu time", "pu date", "pickup time", "pickup date", "pu appt", "pu appointment", "appointment"],
  sentAt: ["date", "sent", "sent at", "given", "given at", "direction date", "time", "timestamp"],
  direction: ["direction", "toll direction", "given direction", "instruction", "instructions", "comment", "note", "notes"],
  status: ["status", "confirmed", "confirm", "driver confirmed"],
};
const normHead = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function mapHeaders(headRow) {
  const map = {};
  headRow.forEach((h, i) => {
    const n = normHead(h);
    if (!n) return;
    for (const field in DIR_ALIASES) {
      if (map[field] != null) continue;
      if (DIR_ALIASES[field].some((a) => a === n)) { map[field] = i; return; }
    }
  });
  return map;
}
// A sheet row counts as CONFIRMED only when it says so outright.
function statusFromSheet(v) {
  const s = String(v || "").toLowerCase().trim();
  if (!s) return null;
  if (/^(confirmed|confirm|yes|ok|done|true|ha|tasdiq)/.test(s)) return "confirmed";
  if (/^(cancel|cancelled|canceled|skip|skipped|bekor)/.test(s)) return "cancelled";
  return "pending";
}
// Stable identity for a sheet row, so re-reading the sheet never duplicates a
// direction nor resets one dispatch has already confirmed here.
function dirKey(d) {
  const id = String(d.loadId || "").trim().toLowerCase();
  if (id) return "load:" + id;
  const s = [d.driver, d.unit, d.route, d.sentAt].map((x) => String(x || "").trim().toLowerCase()).join("|");
  return "row:" + crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

let sheetState = { at: 0, ok: null, error: "", rows: 0, added: 0, url: SHEET_ON };
async function syncSheet() {
  if (!SHEET_ON) { sheetState = { ...sheetState, ok: null, error: "TOLL_SHEET_CSV sozlanmagan" }; return sheetState; }
  try {
    const r = await fetch(SHEET_CSV, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status + " — sheet ochiq (share/publish) ekanini tekshiring");
    const text = await r.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error("CSV emas, HTML qaytdi — sheet ochiq emas");
    const grid = parseCsv(text).filter((row) => row.some((c) => String(c).trim()));
    if (!grid.length) throw new Error("Sheet bo'sh");
    const map = mapHeaders(grid[0]);
    if (map.driver == null && map.loadId == null && map.unit == null) {
      throw new Error("Ustun sarlavhalari topilmadi (Driver / Unit / Load ID kerak)");
    }
    const cell = (row, f) => (map[f] == null ? "" : String(row[map[f]] == null ? "" : row[map[f]]).trim());
    const byKey = new Map(directions.map((d) => [d.key, d]));
    let added = 0, seen = 0;
    for (let i = 1; i < grid.length; i++) {
      const row = grid[i];
      const rec = {
        driver: cell(row, "driver"), unit: cell(row, "unit"), loadId: cell(row, "loadId"),
        route: cell(row, "route"), pu: cell(row, "pu"), puTime: cell(row, "puTime"),
        direction: cell(row, "direction"), sentAt: cell(row, "sentAt"),
      };
      if (!rec.driver && !rec.unit && !rec.loadId) continue;   // spacer / junk row
      seen++;
      const key = dirKey(rec);
      const sheetStatus = statusFromSheet(cell(row, "status"));
      const cur = byKey.get(key);
      if (cur) {
        // Refresh the descriptive fields, but never clobber a local confirmation.
        Object.assign(cur, rec, { key });
        if (sheetStatus === "confirmed" && cur.status === "pending") {
          cur.status = "confirmed"; cur.confirmedAt = new Date().toISOString(); cur.confirmedBy = "sheet";
        } else if (sheetStatus === "cancelled" && cur.status === "pending") {
          cur.status = "cancelled";
        }
        continue;
      }
      const d = {
        id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        key, ...rec,
        source: "sheet",
        status: sheetStatus === "confirmed" ? "confirmed" : sheetStatus === "cancelled" ? "cancelled" : "pending",
        addedAt: new Date().toISOString(),
        confirmedAt: sheetStatus === "confirmed" ? new Date().toISOString() : null,
        confirmedBy: sheetStatus === "confirmed" ? "sheet" : null,
        lastRemindAt: 0, remindCount: 0, note: "",
      };
      directions.push(d); byKey.set(key, d); added++;
    }
    if (added || seen) saveDirections();
    sheetState = { at: Date.now(), ok: true, error: "", rows: seen, added, url: true };
    if (added) console.log(`  Sheet sync: +${added} yangi direction (jami ${directions.length})`);
    return sheetState;
  } catch (e) {
    sheetState = { at: Date.now(), ok: false, error: String(e.message || e), rows: 0, added: 0, url: true };
    console.error("syncSheet", sheetState.error);
    return sheetState;
  }
}

// --- Reminder engine ---
// The first announcement fires on the next tick after intake -- "a direction was
// sent" is itself what arms the reminder -- then repeats until confirmed.
const waitMin = (d) => Math.max(0, Math.round((Date.now() - new Date(d.addedAt || Date.now()).getTime()) / 60000));
function dirTgText(d, first) {
  const head = first ? "🛣️ <b>Yangi toll direction</b>" : `⏰ <b>Hali tasdiqlanmagan</b> (${(d.remindCount || 0) + 1}-eslatma)`;
  const rows = [
    ["Driver", d.driver], ["Unit", d.unit], ["Load", d.loadId],
    ["Route", d.route], ["PU", d.pu], ["PU vaqti", d.puTime], ["Direction", d.direction],
  ].filter(([, v]) => String(v || "").trim()).map(([k, v]) => `${k}: <b>${tgEsc(v)}</b>`);
  return `${head}\n${rows.join("\n")}\n\n⌛ ${waitMin(d)} daqiqadan beri kutmoqda — driver confirm qilsin.`;
}
async function runDirectionReminders() {
  const now = Date.now();
  const due = [];
  for (const d of directions) {
    if (d.status !== "pending") continue;
    const first = !d.lastRemindAt;
    if (!first && now - d.lastRemindAt < REMIND_EVERY_MIN * 60000) continue;
    due.push([d, first]);
  }
  if (!due.length) return;
  let changed = false;
  for (const [d, first] of due) {
    // Like the toll points: only count it as reminded once Telegram accepted the
    // message, so a failed send retries next tick instead of being swallowed.
    const delivered = TG_ON ? await tgSend(dirTgText(d, first)) : true;
    if (!delivered) continue;
    d.lastRemindAt = now;
    d.remindCount = (d.remindCount || 0) + 1;
    changed = true;
  }
  if (changed) saveDirections();
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

  // --- Toll directions: part of the manager's board, same as every other view. ---
  if (/^\/api\/directions\b/.test(req.url)) {
    const dirMatch = req.url.match(/^\/api\/directions\/([\w-]+)$/);
    const dirJson = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    // Lightweight poll for the banner/badge: just the pending ones + config state.
    if (req.url === "/api/directions/alerts" && req.method === "GET") {
      const pending = directions.filter((d) => d.status === "pending")
        .map((d) => ({ id: d.id, driver: d.driver, unit: d.unit, loadId: d.loadId, route: d.route, pu: d.pu, puTime: d.puTime, waitMin: waitMin(d), remindCount: d.remindCount || 0 }))
        .sort((a, b) => b.waitMin - a.waitMin);
      dirJson(200, { pending, count: pending.length, everyMin: REMIND_EVERY_MIN, telegram: TG_ON, sheet: sheetState });
      return;
    }
    if (req.url === "/api/directions/sync" && req.method === "POST") {
      const st = await syncSheet();
      dirJson(200, { ...st, ok: st.ok === true });
      return;
    }
    if (req.url === "/api/directions" && req.method === "GET") {
      const list = directions.slice().sort((a, b) => {
        if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
        return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
      }).map((d) => ({ ...d, waitMin: waitMin(d) }));
      dirJson(200, { rows: list, everyMin: REMIND_EVERY_MIN, telegram: TG_ON, sheet: sheetState });
      return;
    }
    // Manual entry, for directions given outside the sheet.
    if (req.url === "/api/directions" && req.method === "POST") {
      const b = await readBody(req);
      if (!b || (!String(b.driver || "").trim() && !String(b.unit || "").trim() && !String(b.loadId || "").trim())) {
        dirJson(400, { ok: false, error: "Driver, Unit yoki Load ID dan kamida bittasi kerak" });
        return;
      }
      const rec = {
        driver: String(b.driver || "").trim(), unit: String(b.unit || "").trim(), loadId: String(b.loadId || "").trim(),
        route: String(b.route || "").trim(), pu: String(b.pu || "").trim(), puTime: String(b.puTime || "").trim(),
        direction: String(b.direction || "").trim(), sentAt: String(b.sentAt || "").trim(),
      };
      const key = dirKey(rec);
      if (directions.some((d) => d.key === key)) { dirJson(409, { ok: false, error: "Bu direction allaqachon bor" }); return; }
      const d = {
        id: "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        key, ...rec, source: "manual", status: "pending",
        addedAt: new Date().toISOString(), confirmedAt: null, confirmedBy: null,
        lastRemindAt: 0, remindCount: 0, note: String(b.note || "").trim(),
      };
      directions.push(d);
      saveDirections();
      runDirectionReminders().catch(() => {});          // announce it right away
      dirJson(200, { ok: true, id: d.id });
      return;
    }
    // Confirm / cancel / re-open / annotate one direction.
    if (dirMatch && req.method === "PUT") {
      const b = await readBody(req) || {};
      const d = directions.find((x) => x.id === dirMatch[1]);
      if (!d) { dirJson(404, { ok: false, error: "not found" }); return; }
      if (b.status === "confirmed" || b.status === "cancelled" || b.status === "pending") {
        d.status = b.status;
        if (b.status === "confirmed") { d.confirmedAt = new Date().toISOString(); d.confirmedBy = "board"; }
        else { d.confirmedAt = null; d.confirmedBy = null; }
        if (b.status === "pending") { d.lastRemindAt = 0; d.remindCount = 0; }   // re-arm the nag
      }
      if (b.note != null) d.note = String(b.note).trim();
      saveDirections();
      dirJson(200, { ok: true });
      return;
    }
    if (dirMatch && req.method === "DELETE") {
      const i = directions.findIndex((x) => x.id === dirMatch[1]);
      if (i >= 0) { directions.splice(i, 1); saveDirections(); }
      dirJson(200, { ok: true });
      return;
    }
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
  if (req.url === "/api/audit-ignore") {
    if (req.method === "POST") {
      const body = (await readBody(req)) || {};
      const list = Array.isArray(body.units) ? body.units : [];
      auditIgnore = [...new Set(list.map(normUnitId).filter(Boolean))].sort();
      saveAuditIgnore();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, units: auditIgnore }));
    return;
  }

  if (req.url === "/api/fuel-audit" && req.method === "POST") {
    const body = (await readBody(req)) || {};
    const txns = Array.isArray(body.txns) ? body.txns : [];
    if (!txns.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "hisobotda yoqilg'i xaridlari topilmadi" }));
      return;
    }
    // Map every card line onto a unit the board actually knows before anything
    // is compared, so a padded number is not audited as a truck of its own.
    let known = new Set(Object.keys(fuelEvents));
    try {
      const data = await getFuelData();
      for (const t of data.fleet || []) if (t && t.unit) known.add(String(t.unit));
    } catch { /* fills alone still resolve most of them */ }
    const resolved = txns.map((t) => ({ ...t, unit: resolveUnit(t.unit, known) }));
    const skip = new Set(auditIgnore);
    const kept = resolved.filter((t) => !skip.has(t.unit) && !skip.has(normUnitId(t.unit)));
    const events = {};
    for (const u of Object.keys(fuelEvents)) if (!skip.has(normUnitId(u))) events[u] = fuelEvents[u];
    const out = audit.auditReport(kept, events);
    const loc = await checkLocations(out.rows);
    // How far back the fills go decides what can be judged at all, so it is
    // reported alongside: without it a page full of "unknown" looks broken
    // rather than simply early.
    let earliest = null, fills = 0;
    for (const u of Object.keys(fuelEvents)) {
      for (const f of fuelEvents[u]) {
        fills++;
        const t = Date.parse(f.at);
        if (Number.isFinite(t) && (earliest == null || t < earliest)) earliest = t;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      rows: out.rows,
      summary: {
        ...out.summary,
        locChecked: loc.checked, locFar: loc.far, locPending: loc.pending,
        ignoredLines: resolved.length - kept.length, ignoredUnits: auditIgnore.length,
      },
      history: { fills, units: Object.keys(fuelEvents).length, since: earliest ? new Date(earliest).toISOString() : null },
    }));
    return;
  }

  if (req.url === "/api/direction" && req.method === "POST") {
    const out = await buildDirectionNote((await readBody(req)) || {});
    res.writeHead(out.ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  // GET too, so the setup can be finished from the browser's address bar.
  if (req.url === "/api/telegram/test") {
    const sent = await tgSend("✅ MOVEX fuel board — Telegram ulanishi ishlayapti. Toll eslatmalari shu yerga keladi.");
    res.writeHead(sent ? 200 : 400, { "Content-Type": "application/json" });
    // Hand back what Telegram actually said — "didn't work" is not something
    // the operator can act on, "chat not found" is.
    const why = (tgDiag.lastSend && tgDiag.lastSend.error) || "Telegram javob bermadi";
    res.end(JSON.stringify({ ok: sent, error: sent ? undefined : why }));
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
    const ai = await ghLoad("audit_ignore.json");
    if (Array.isArray(ai)) auditIgnore = ai;
    const sg = await ghLoad("station_geo.json");
    if (sg && typeof sg === "object" && !Array.isArray(sg)) stationGeo = sg;
    const fe = await ghLoad("fuel_events.json");
    if (fe && typeof fe === "object" && !Array.isArray(fe)) { fuelEvents = fe; pruneFuelEvents(); }
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
    const dr = await ghLoad("directions_data.json");
    if (Array.isArray(dr)) directions = dr;
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
        const driver = truck.driver && truck.driver !== "Unassigned" ? ` (${tgEsc(truck.driver)})` : "";
        const text = `📍 <b>Toll eslatma</b>\n<b>Unit ${tgEsc(unit)}${driver}</b> → ${tgEsc(p.label)}\nQolgan masofa: <b>${miles} mi</b>${d.etaMin ? ` · ~${d.etaMin} daq` : ""}\n\nDriverga yo'nalishni eslating.`;
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
  console.log(`  Login:               ${AUTH_ON ? `on (user: ${MANAGER_USER || AUTH_USER}) ✓` : "OFF — set MANAGER_USER/MANAGER_PASS for cloud"}`);
  console.log(`  Stations:            Pilot ${Object.keys(brandStations.pilot).length} · Love's ${Object.keys(brandStations.loves).length} · TA/Petro ${Object.keys(brandStations.ta).length}`);
  console.log(`  Durable store:       ${GH_ON ? "configuring…" : "OFF — set GH_TOKEN/GH_REPO for permanence"}`);
  console.log(`  Toll reminder:       ${TG_ON ? `Telegram ✓ (chat ${TG_CHAT})` : "board only — set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID for Telegram"}`);
  console.log(`  Toll directions:     ${SHEET_ON ? `sheet har ${SHEET_POLL_MIN} daq · eslatma har ${REMIND_EVERY_MIN} daq ✓` : "OFF — set TOLL_SHEET_CSV"}\n`);
  initDurable()
    .catch((e) => console.error("initDurable", e.message))
    .then(() => {
      // Poll only after initDurable, or a fresh sheet read could re-add rows
      // already confirmed in the durable repo.
      if (SHEET_ON) { syncSheet().catch(() => {}); setInterval(() => syncSheet().catch(() => {}), SHEET_POLL_MIN * 60000); }
      setInterval(() => runDirectionReminders().catch((e) => console.error("dirRemind", e.message)), 60000);
    });
  // After initDurable, so the diag write lands once the repo shas are known.
  setTimeout(() => tgBootCheck().catch((e) => console.error("tgBootCheck", e.message)), 8000);
  setInterval(() => runTollWatch().catch((e) => console.error("tollWatch", e.message)), TOLL_WATCH_MS);
});

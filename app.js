const $ = (sel) => document.querySelector(sel);
let fleet = [];
let live = false;
let ROLE = "manager";          // set from /api/me
let fsBoard = {};              // unit -> { station, miles, etaMin, ... } for assigned stops
let priceMap = {};             // normalized store# -> { your, retail, disc, sav, city, st }
let priceDate = null;          // effective date of the loaded Pilot price report
const BRANDS = { pilot: "Pilot", loves: "Love's", ta: "TA/Petro" };

const normNum = (s) => {
  s = String(s == null ? "" : s).trim().replace(/^#/, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n) : s;
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function fuelClass(p) {
  if (p == null) return "none";
  if (p < 25) return "critical";
  if (p < 50) return "low";
  if (p < 75) return "mid";
  return "full";
}

function formatUpdated(mins) {
  if (mins == null || mins >= 99999) return "—";
  if (mins < 60) return mins + " min ago";
  const h = Math.floor(mins / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function renderStats(rows) {
  const fueled = rows.filter(r => r.fuel != null);
  const total = rows.length;
  const critical = fueled.filter(r => r.fuel < 25).length;
  const low = fueled.filter(r => r.fuel >= 25 && r.fuel < 50).length;
  const mid = fueled.filter(r => r.fuel >= 50 && r.fuel < 75).length;
  const full = fueled.filter(r => r.fuel >= 75).length;
  const avg = fueled.length ? Math.round(fueled.reduce((a, r) => a + r.fuel, 0) / fueled.length) : 0;

  $("#stat-critical").textContent = critical;
  $("#stat-low").textContent = low;
  $("#stat-mid").textContent = mid;
  $("#stat-full").textContent = full;
  $("#stat-total").textContent = total;
  $("#stat-avg").textContent = avg + "%";
}

function statusClass(s) {
  return "status-" + s.split(" ")[0];
}

function render() {
  const q = $("#search").value.toLowerCase().trim();
  const lvl = $("#filter-level").value;
  const st = $("#filter-status").value;
  const order = $("#sort-order").value;
  const showNoFuel = $("#show-nofuel") ? $("#show-nofuel").checked : true;

  let rows = fleet.filter(r => {
    if (!showNoFuel && r.fuel == null) return false;
    if (lvl && fuelClass(r.fuel) !== lvl) return false;
    if (st && r.status !== st) return false;
    if (!q) return true;
    return [r.unit, r.driver, r.location].some(v => String(v).toLowerCase().includes(q));
  });

  // Sorting. Null fuel always sinks to the bottom for fuel-based sorts.
  const nullLast = (a, b, cmp) => {
    if (a.fuel == null && b.fuel == null) return 0;
    if (a.fuel == null) return 1;
    if (b.fuel == null) return -1;
    return cmp(a, b);
  };
  if (order === "asc") rows.sort((a, b) => nullLast(a, b, (x, y) => x.fuel - y.fuel));
  else if (order === "desc") rows.sort((a, b) => nullLast(a, b, (x, y) => y.fuel - x.fuel));
  else if (order === "updated") rows.sort((a, b) => a.updated - b.updated);

  renderStats(rows);

  const tbody = $("#rows");
  const empty = $("#empty");
  if (!rows.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  tbody.innerHTML = rows.map((r, i) => {
    const fc = fuelClass(r.fuel);
    const hasFuel = r.fuel != null;
    const gallons = hasFuel ? Math.round((r.fuel / 100) * r.tankGal) : null;
    const stale = r.updated > 60;
    const cached = r.fuelSource === "cached";
    const fuelTag = r.fuelSource === "live"
      ? `<span class="fuel-tag live">live</span>`
      : cached ? `<span class="fuel-tag">last known · ${formatUpdated(r.fuelAgeMin)}</span>` : "";
    const fuelCell = hasFuel
      ? `<span class="fuel-pct ${fc}">${r.fuel}%</span> ${fuelTag}<div class="driver-meta">${gallons} / ${r.tankGal} gal</div>`
      : `<span class="fuel-pct none">No data yet</span>`;
    // Only trust the range when the reading is fresh. A long-stale "last known"
    // value (e.g. truck refueled while parked) would show a misleadingly low range.
    const fuelFresh = r.fuelSource === "live" || (r.fuelAgeMin != null && r.fuelAgeMin <= 360);
    const rangeMi = (hasFuel && r.mpg != null && fuelFresh)
      ? Math.round((r.fuel / 100) * r.tankGal * r.mpg) : null;
    const rangeHtml = rangeMi != null
      ? `<div class="range-est">≈ ${rangeMi.toLocaleString()} mi left</div>`
      : (hasFuel && !fuelFresh ? `<div class="range-est" style="opacity:.7">range n/a · stale</div>` : "");
    const barCell = hasFuel
      ? `<div class="fuel-bar"><div class="fuel-fill ${fc}" style="width: ${r.fuel}%; opacity:${cached ? 0.5 : 1}"></div><span class="fuel-bar-label">${r.fuel}%</span></div>${rangeHtml}`
      : `<div class="fuel-bar"><span class="fuel-bar-label" style="color:var(--text-mute)">—</span></div>`;

    const mpgCell = r.mpg != null
      ? `<span class="mpg ${r.mpg < 6 ? "bad" : r.mpg >= 7.5 ? "good" : ""}">${r.mpg.toFixed(1)}</span>`
      : `<span style="color:var(--text-mute)">—</span>`;

    const idleH = r.idleHours;
    const idleCell = (idleH != null && idleH > 0)
      ? `<span class="idle ${idleH >= 5 ? "high" : idleH >= 2 ? "mid" : ""}">${idleH.toFixed(1)}h</span><div class="driver-meta">${r.idleGallons != null ? r.idleGallons.toFixed(1) + " gal" : ""}</div>`
      : `<span style="color:var(--text-mute)">—</span>`;

    let fsCell;
    if (r.assignedStop) {
      const a = r.assignedStop;                 // { brand, num }
      const label = BRANDS[a.brand] || a.brand;
      const info = fsBoard[r.unit];
      const miles = info && info.miles != null ? `${info.miles} mi`
        : (info && info.error ? "no GPS" : "…");
      const near = info && info.miles != null && info.miles <= 15;
      const tip = info ? esc(`${info.name || label} #${a.num} · ${info.city || ""}, ${info.st || ""}`) : `${label} #${a.num}`;
      const pr = a.brand === "pilot" ? priceMap[normNum(a.num)] : null;
      const priceHtml = pr && pr.your != null
        ? `<span class="fs-price" title="Retail $${(+pr.retail).toFixed(2)} · save $${(+pr.sav).toFixed(2)}/gal">$${(+pr.your).toFixed(2)}</span>` : "";
      fsCell = `<div class="fs-assigned ${near ? "near" : ""}">
          <span class="fs-pill brand-${a.brand}" title="${tip}">${label} #${esc(a.num)}</span>
          <span class="fs-mi">${miles}</span>${priceHtml}
          <button class="fs-clear" data-unit="${esc(r.unit)}" title="Tugatildi / tozalash">✕</button>
        </div>`;
    } else {
      fsCell = `<div class="fs-assign-form">
          <select class="fs-brand" data-unit="${esc(r.unit)}">
            <option value="pilot">Pilot</option>
            <option value="loves">Love's</option>
            <option value="ta">TA/Petro</option>
          </select>
          <input class="fs-inp" data-unit="${esc(r.unit)}" inputmode="numeric" placeholder="#" autocomplete="off">
        </div>`;
    }
    return `
      <tr>
        <td class="time-cell">${i + 1}</td>
        <td><span class="unit-pill">${r.unit}</span>${r.vehicleInfo ? `<div class="driver-meta">${r.vehicleInfo}</div>` : ""}</td>
        <td>
          <div class="driver-name">${r.driver}</div>
          <div class="driver-meta">${r.phone || ""}</div>
        </td>
        <td>
          <div class="location">${r.location}</div>
          <div class="location-meta">${r.state}</div>
        </td>
        <td>${fuelCell}</td>
        <td>${barCell}</td>
        <td>${mpgCell}</td>
        <td>${idleCell}</td>
        <td class="time-cell ${stale ? "stale" : ""}">${formatUpdated(r.updated)}</td>
        <td><span class="status-badge ${statusClass(r.status)}">${r.status}</span></td>
        <td class="col-fuelstop">${fsCell}</td>
        <td>
          ${r.phone ? `<button class="action-btn" data-unit="${r.unit}" data-act="call">Call</button>` : ""}
          <button class="action-btn" data-unit="${r.unit}" data-act="locate">Locate</button>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".action-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const unit = btn.dataset.unit;
      const act = btn.dataset.act;
      const r = fleet.find(x => x.unit === unit);
      if (act === "call") {
        window.location.href = "tel:" + r.phone.replace(/[^0-9+]/g, "");
      } else {
        const q = (r.lat != null && r.lon != null) ? `${r.lat},${r.lon}` : encodeURIComponent(r.location);
        window.open(`https://www.google.com/maps/search/?api=1&query=${q}`, "_blank");
      }
    });
  });

  tbody.querySelectorAll(".fs-inp").forEach(inp => {
    inp.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const form = inp.closest(".fs-assign-form");
      const brand = form ? form.querySelector(".fs-brand").value : "pilot";
      assignStop(inp.dataset.unit, brand, inp.value, inp);
    });
  });
  tbody.querySelectorAll(".fs-clear").forEach(b => {
    b.addEventListener("click", () => clearStop(b.dataset.unit));
  });
}

async function assignStop(unit, brand, station, inp) {
  station = normNum(station);
  if (!station) return;
  if (inp) inp.disabled = true;
  try {
    const r = await fetch("/api/fuel-stop/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit, brand, station }) });
    const j = await r.json();
    if (!j.ok) { alert(j.error || "Xato"); if (inp) { inp.disabled = false; inp.focus(); } return; }
    const row = fleet.find(x => x.unit === unit);
    if (row) row.assignedStop = { brand, num: station };
    render();
    loadFsBoard();
  } catch (e) { alert("Xato: " + e.message); if (inp) inp.disabled = false; }
}

async function clearStop(unit) {
  try {
    await fetch("/api/fuel-stop/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit }) });
    const row = fleet.find(x => x.unit === unit);
    if (row) row.assignedStop = null;
    delete fsBoard[unit];
    render();
  } catch (e) { alert("Xato: " + e.message); }
}

async function loadFsBoard() {
  try {
    const r = await fetch("/api/fuel-stop/board");
    if (r.ok) { fsBoard = await r.json(); render(); }
  } catch {}
}

async function loadFuelPrice() {
  try {
    const r = await fetch("/api/fuel-price");
    if (!r.ok) return;
    const j = await r.json();
    priceMap = j.prices || {};
    priceDate = j.date || null;
    updatePriceLabel(Object.keys(priceMap).length);
    render();
  } catch {}
}
function updatePriceLabel(count) {
  const el = $("#price-label");
  if (el) el.textContent = count ? `Narx: ${priceDate || "—"} · ${count} stansiya` : "Narx yuklanmagan";
}

// Parse the Pilot "Better Of" price report (.xls/.xlsx) in the browser.
function parsePriceWorkbook(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  let date = null;
  for (const r of rows) {
    const m = r.join(" ").match(/Effective Date:\s*([\d/]+)/i);
    if (m) { date = m[1]; break; }
  }
  const hi = rows.findIndex(r => String(r[0]).trim().toLowerCase() === "site");
  if (hi < 0) throw new Error("'Site' ustuni topilmadi — bu Pilot narx fayli emasmi?");
  const head = rows[hi].map(c => String(c).trim().toLowerCase());
  const col = (name) => head.findIndex(h => h.includes(name));
  const cCity = col("city"), cSt = head.indexOf("st"), cProd = col("prod"),
    cRetail = col("retail price"), cDisc = col("disc"), cYour = col("your price"), cSav = col("savings");
  if (cYour < 0) throw new Error("'Your Price' ustuni topilmadi");
  const prices = {};
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const site = String(r[0]).trim();
    if (!site) continue;
    if (cProd >= 0 && String(r[cProd]).trim().toUpperCase() !== "DSL") continue; // diesel only
    const your = parseFloat(r[cYour]);
    if (!isFinite(your)) continue;
    prices[site] = {
      your: +your.toFixed(4),
      retail: parseFloat(r[cRetail]) || null,
      disc: parseFloat(r[cDisc]) || null,
      sav: parseFloat(r[cSav]) || null,
      city: String(cCity >= 0 ? r[cCity] : "").trim(),
      st: String(cSt >= 0 ? r[cSt] : "").trim(),
    };
  }
  return { date, prices };
}

async function uploadPriceFile(file) {
  const btn = $("#price-upload-btn");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "O'qilmoqda…";
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const { date, prices } = parsePriceWorkbook(wb);
    const n = Object.keys(prices).length;
    if (!n) throw new Error("Narx topilmadi (DSL satrlari yo'q)");
    btn.textContent = "Saqlanmoqda…";
    const res = await fetch("/api/fuel-price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, prices }) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "Server xatosi");
    await loadFuelPrice();
    btn.textContent = `✓ ${j.count} ta narx · ${j.date || ""}`;
    setTimeout(() => (btn.textContent = old), 2500);
  } catch (e) {
    alert("Narx yuklashda xato: " + e.message);
    btn.textContent = old;
  }
  btn.disabled = false;
  $("#price-file").value = "";
}

function renderCoverage() {
  const live = fleet.filter(r => r.fuelSource === "live");
  const cached = fleet.filter(r => r.fuelSource === "cached");
  const none = fleet.filter(r => r.fuelSource === "none");
  const total = fleet.length || 1;
  const covered = live.length + cached.length;

  $("#cov-reporting").textContent = live.length;
  $("#cov-check").textContent = cached.length;
  $("#cov-offline").textContent = none.length;
  $("#cov-pct").textContent = Math.round((covered / total) * 100) + "%";

  const card = (r) => `
    <div class="cov-item">
      <span class="u">${r.unit}</span>
      <span class="m">${r.vehicleInfo || "—"}</span>
      <span class="a">${formatUpdated(r.updated)}${r.location && r.location !== "Unknown" ? " · " + r.location : ""}</span>
    </div>`;

  none.sort((a, b) => a.unit.localeCompare(b.unit));
  $("#cov-list-check").innerHTML = cached.map(card).join("") || `<p class="cov-note">None yet — values fill in as trucks drive.</p>`;
  $("#cov-list-offline").innerHTML = none.map(card).join("") || `<p class="cov-note">None 🎉 every unit has reported fuel at least once.</p>`;

  $("#copy-check").onclick = () => copyUnits(cached, "Last known (parked)");
  $("#copy-offline").onclick = () => copyUnits(none, "Never reported fuel");
}

function copyUnits(list, label) {
  const text = `${label} (${list.length}):\n` + list.map(r => `${r.unit}\t${r.vehicleInfo || ""}`).join("\n");
  navigator.clipboard.writeText(text).then(() => {
    alert(`Copied ${list.length} units to clipboard`);
  });
}

const DIESEL_PRICE = 4.50;
function renderIdle() {
  const idling = fleet.filter(r => r.idleHours != null && r.idleHours > 0);
  const totalGal = idling.reduce((a, r) => a + (r.idleGallons || 0), 0);
  const totalHrs = idling.reduce((a, r) => a + (r.idleHours || 0), 0);

  $("#idle-gal").textContent = totalGal.toFixed(1);
  $("#idle-hrs").textContent = totalHrs.toFixed(1);
  $("#idle-count").textContent = idling.length;
  $("#idle-cost").textContent = "$" + Math.round(totalGal * DIESEL_PRICE).toLocaleString();

  const rows = [...idling].sort((a, b) => (b.idleGallons || 0) - (a.idleGallons || 0));
  const tbody = $("#idle-rows");
  const empty = $("#idle-empty");
  if (!rows.length) { tbody.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");

  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="time-cell">${i + 1}</td>
      <td><span class="unit-pill">${r.unit}</span></td>
      <td>${r.driver}</td>
      <td class="idle ${r.idleHours >= 5 ? "high" : r.idleHours >= 2 ? "mid" : ""}">${r.idleHours.toFixed(1)}h</td>
      <td>${r.idleGallons.toFixed(1)} gal</td>
      <td>$${Math.round(r.idleGallons * DIESEL_PRICE)}</td>
    </tr>`).join("");

  $("#copy-idle").onclick = () => {
    const text = `Idle last 24h — ${rows.length} trucks, ${totalGal.toFixed(1)} gal, $${Math.round(totalGal * DIESEL_PRICE)} wasted:\n` +
      rows.map(r => `${r.unit}\t${r.idleHours.toFixed(1)}h\t${r.idleGallons.toFixed(1)} gal`).join("\n");
    navigator.clipboard.writeText(text).then(() => alert(`Copied ${rows.length} trucks`));
  };
}

let mapObj = null, markersLayer = null;
function fuelColorHex(p) {
  if (p == null) return "#6b7388";
  if (p < 25) return "#e24b4a";
  if (p < 50) return "#ef9f27";
  if (p < 75) return "#f5d547";
  return "#2bb673";
}
function truckIcon(r) {
  const color = fuelColorHex(r.fuel);
  const b = r.bearing != null ? r.bearing : 0;
  const moving = r.speed != null && r.speed > 0;
  const shape = moving
    ? `<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${b}deg)">
         <path d="M12 3 L18.5 20 L12 16 L5.5 20 Z" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="1.2"/></svg>`
    : `<svg viewBox="0 0 24 24" width="20" height="20">
         <circle cx="12" cy="12" r="8" fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="1.4"/></svg>`;
  return L.divIcon({ html: `<div class="truck-marker">${shape}</div>`, className: "truck-div", iconSize: [26, 26], iconAnchor: [13, 13] });
}

function renderMap() {
  if (!window.L) return;
  if (!mapObj) {
    mapObj = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
    // Clean Google-Maps-like road map (sharp retina tiles, interstate shields + labels)
    const road = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 20, detectRetina: true, subdomains: "abcd", attribution: "&copy; OpenStreetMap &copy; CARTO" });
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Esri, Maxar" });
    // Roads + place names overlay (so Satellite can also show interstates/labels)
    const roadsLabels = L.layerGroup([
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }),
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 }),
    ]);
    road.addTo(mapObj); // default: clean road map
    L.control.layers(
      { "Yo'l xaritasi": road, "Sun'iy yo'ldosh": sat },
      { "Yo'llar + nomlar": roadsLabels },
      { position: "topright", collapsed: false }
    ).addTo(mapObj);
    markersLayer = L.markerClusterGroup
      ? L.markerClusterGroup({ maxClusterRadius: 45, spiderfyOnMaxZoom: true })
      : L.layerGroup();
    mapObj.addLayer(markersLayer);

    const FsControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        const wrap = L.DomUtil.create("div", "leaflet-bar");
        const btn = L.DomUtil.create("a", "leaflet-fs-btn", wrap);
        btn.href = "#"; btn.title = "Fullscreen"; btn.innerHTML = "⛶";
        L.DomEvent.on(btn, "click", L.DomEvent.stop).on(btn, "click", () => {
          const el = document.getElementById("map");
          if (!document.fullscreenElement) { (el.requestFullscreen || el.webkitRequestFullscreen).call(el); }
          else { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
        });
        return wrap;
      },
    });
    mapObj.addControl(new FsControl());
    document.addEventListener("fullscreenchange", () => setTimeout(() => mapObj.invalidateSize(), 200));
  }
  setTimeout(() => mapObj.invalidateSize(), 60);

  markersLayer.clearLayers();
  const pts = fleet.filter((r) => r.lat != null && r.lon != null);
  pts.forEach((r) => {
    const m = L.marker([r.lat, r.lon], { icon: truckIcon(r) });
    m.bindTooltip(`${r.unit} · ${r.driver}`, { direction: "top", offset: [0, -12] });
    const fuelTxt = r.fuel != null
      ? r.fuel + "%" + (r.fuelSource === "cached" ? " (last known)" : "")
      : "No data";
    const idleTxt = (r.idleHours > 0) ? `<br>Idle 24h: ${r.idleHours}h / ${r.idleGallons} gal` : "";
    m.bindPopup(
      `<b>Unit ${r.unit}</b><br>${r.driver}<br>Fuel: <b>${fuelTxt}</b>` +
      `<br>${r.location}${r.mpg != null ? "<br>MPG: " + r.mpg : ""}${idleTxt}`
    );
    markersLayer.addLayer(m);
  });
  const cnt = document.getElementById("map-count");
  if (cnt) cnt.textContent = pts.length + " trucks shown";
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const view = tab.dataset.view;
      $("#view-board").classList.toggle("hidden", view !== "board");
      $("#view-coverage").classList.toggle("hidden", view !== "coverage");
      $("#view-idle").classList.toggle("hidden", view !== "idle");
      $("#view-map").classList.toggle("hidden", view !== "map");
      $("#view-reports").classList.toggle("hidden", view !== "reports");
      $("#view-ranking").classList.toggle("hidden", view !== "ranking");
      $("#view-toll").classList.toggle("hidden", view !== "toll");
      if (view === "coverage") renderCoverage();
      if (view === "idle") renderIdle();
      if (view === "map") renderMap();
      if (view === "reports" && window.initReports) window.initReports();
      if (view === "ranking" && window.initRanking) window.initRanking();
      if (view === "toll" && window.initToll) window.initToll();
    });
  });
}

function setSync(text, ok) {
  const el = $("#last-sync");
  el.textContent = text;
  const dot = document.querySelector(".live-dot");
  if (dot) dot.style.background = ok ? "#2bb673" : "#e24b4a";
}

async function loadData() {
  setSync("Syncing…", true);
  try {
    const res = await fetch("/api/fuel", { cache: "no-store" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "API error");
    fleet = json.fleet;
    live = true;
    const t = new Date(json.syncedAt);
    const c = json.counts;
    setSync(`${c.live} live · ${c.cached} last-known · ${c.withFuel}/${c.total} units · ${t.toLocaleTimeString()}`, true);
  } catch (e) {
    // Fallback to mock data (when opened as a plain file, no backend)
    fleet = (window.MOCK_FLEET || []).map(x => ({ ...x, vehicleInfo: "", lat: null, lon: null, ecm: true }));
    live = false;
    setSync("Demo data (backend offline)", false);
  }
  render();
  if (!$("#view-coverage").classList.contains("hidden")) renderCoverage();
  if (!$("#view-idle").classList.contains("hidden")) renderIdle();
  if (!$("#view-map").classList.contains("hidden")) renderMap();
  loadFsBoard();
}

$("#search").addEventListener("input", render);
$("#filter-level").addEventListener("change", render);
$("#filter-status").addEventListener("change", render);
$("#sort-order").addEventListener("change", render);
const noFuelToggle = $("#show-nofuel");
if (noFuelToggle) noFuelToggle.addEventListener("change", render);
function applyTheme(mode) {
  document.body.classList.toggle("light", mode === "light");
  const btn = $("#theme-toggle");
  if (btn) btn.textContent = mode === "light" ? "☀️" : "🌙";
  try { localStorage.setItem("fuelboard-theme", mode); } catch {}
}
$("#theme-toggle").addEventListener("click", () => {
  applyTheme(document.body.classList.contains("light") ? "dark" : "light");
});
applyTheme((() => { try { return localStorage.getItem("fuelboard-theme") || "dark"; } catch { return "dark"; } })());

$("#refresh").addEventListener("click", loadData);

const logoutBtn = $("#logout");
if (logoutBtn) logoutBtn.addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST" }); } catch {}
  window.location.href = "/login";
});

const priceBtn = $("#price-upload-btn");
if (priceBtn) priceBtn.addEventListener("click", () => $("#price-file").click());
const priceFileInput = $("#price-file");
if (priceFileInput) priceFileInput.addEventListener("change", (e) => { if (e.target.files[0]) uploadPriceFile(e.target.files[0]); });

// Role-based access: workers get everything EXCEPT the Toll board.
fetch("/api/me").then((r) => r.json()).then((j) => {
  ROLE = j.role || "manager";
  document.body.classList.toggle("role-worker", ROLE === "worker");
  if (ROLE === "worker") {
    const b = document.querySelector(`.tab[data-view="toll"]`);
    if (b) b.remove();
    const badge = document.querySelector(".subtitle");
    if (badge) badge.textContent = "Worker view";
  }
  loadFsBoard();
  loadFuelPrice();
}).catch(() => {});

setupTabs();
loadData();
setInterval(loadData, 60000);

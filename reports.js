(function () {
  const $ = (s) => document.querySelector(s);
  let fuelAgg = null, perfAgg = null, allTx = [];
  let period = { start: null, end: null };
  let computed = null;
  let wired = false;
  let sortCol = "unit", sortDir = 1;

  function fmt(n, d = 0) { return n == null ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

  // ---- Parsing ----
  async function parseFuel(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    const agg = {}; const tx = []; let minD = null, maxD = null;
    for (const r of rows) {
      const item = String(r.Item || "").toUpperCase();
      const unit = String(r.Unit == null ? "" : r.Unit).trim();
      const d = r["Tran Date"];
      const ds = d ? String(d).slice(0, 10) : null;
      if (ds) { if (!minD || ds < minD) minD = ds; if (!maxD || ds > maxD) maxD = ds; }
      if (item !== "ULSD" || !unit) continue;
      if (!agg[unit]) agg[unit] = { qty: 0, amt: 0 };
      agg[unit].qty += Number(r.Qty) || 0;
      agg[unit].amt += Number(r.Amt) || 0;
      tx.push({ unit, date: ds, time: r["Tran Time"], city: String(r.City || "").trim(), state: String(r["State/ Prov"] || "").trim(), qty: +(Number(r.Qty) || 0).toFixed(1), loc: r["Location Name"] });
    }
    fuelAgg = agg; allTx = tx; period = { start: minD, end: maxD };
    $("#fuel-name").textContent = file.name + " · " + Object.keys(agg).length + " unit";
    $("#drop-fuel").classList.add("ok");
    $("#rep-period").textContent = period.start ? period.start + " → " + period.end : "";
  }

  async function parsePerf(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const hdr = lines[0].split(",");
    const vi = hdr.findIndex((h) => /^Vehicle$/i.test(h.trim()));
    const di = hdr.findIndex((h) => /Total Distance/i.test(h));
    const ii = hdr.findIndex((h) => /Idled Fuel/i.test(h));
    const dri = hdr.findIndex((h) => /^Driver$/i.test(h.trim()));
    const agg = {};
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(","); const v = (c[vi] || "").trim(); if (!v) continue;
      const mi = parseFloat(c[di]) || 0;
      if (!agg[v]) agg[v] = { miles: 0, idle: 0, driver: "", _dm: -1 };
      agg[v].miles += mi;
      agg[v].idle += parseFloat(c[ii]) || 0;
      const drv = (c[dri] || "").trim();
      if (drv && mi > agg[v]._dm) { agg[v]._dm = mi; agg[v].driver = drv; } // primary driver = most miles
    }
    perfAgg = agg;
    $("#perf-name").textContent = file.name + " · " + Object.keys(agg).length + " unit";
    $("#drop-perf").classList.add("ok");
  }

  async function autoFetch(btn) {
    if (!period.start) { alert("Avval Fuel report (Excel) yuklang — davr o'shandan aniqlanadi."); return; }
    const old = btn.textContent; btn.textContent = "Motive'dan olinmoqda…"; btn.disabled = true;
    try {
      const res = await fetch(`/api/perf-auto?start=${period.start}&end=${period.end}`);
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "auto error");
      const agg = {};
      Object.keys(j.units).forEach((u) => { agg[u] = { miles: j.units[u].miles, idle: j.units[u].idle, driver: "" }; });
      perfAgg = agg;
      const withMiles = Object.values(agg).filter((x) => x.miles != null).length;
      $("#perf-name").textContent = `Motive (avto) · ${Object.keys(agg).length} unit · ${withMiles} ta miles bilan`;
      $("#drop-perf").classList.add("ok");
      if (!withMiles) warn("Motive idle keldi, lekin miles hali yo'q (odometer tarixi bugundan yig'ilmoqda — keyingi haftadan miles ham bo'ladi). Hozir miles uchun CSV yuklang.");
    } catch (e) { alert("Xato: " + e.message); }
    btn.textContent = old; btn.disabled = false;
  }

  // ---- Compute ----
  function lookupPerf(unit) {
    if (perfAgg[unit]) return perfAgg[unit];
    if (/^\d+$/.test(unit) && perfAgg[unit.padStart(4, "0")]) return perfAgg[unit.padStart(4, "0")];
    return null;
  }

  function generate() {
    if (!fuelAgg) { warn("Fuel report (Excel) yuklang."); return; }
    if (!perfAgg) { warn("Driver Fuel Performance (CSV) yuklang."); return; }
    const rows = [], unmatched = [];
    let tQty = 0, tAmt = 0, tIdle = 0, tMiles = 0;
    Object.keys(fuelAgg).sort().forEach((u) => {
      const f = fuelAgg[u], p = lookupPerf(u);
      const ppg = f.qty ? f.amt / f.qty : null;
      tQty += f.qty; tAmt += f.amt;
      let miles = null, mpg = null, cpm = null, idle = null;
      const pm = p && p.miles != null ? p.miles : null;
      const pi = p && p.idle != null ? p.idle : null;
      if (pm != null) {
        miles = +pm.toFixed(1); tMiles += pm;
        mpg = f.qty ? +(pm / f.qty).toFixed(2) : null;
        cpm = pm > 0 ? +(f.amt / pm).toFixed(2) : null;
      }
      if (pi != null) { idle = +pi.toFixed(2); tIdle += pi; }
      if (pm == null) unmatched.push(u);
      rows.push({ unit: u, driver: (p && p.driver) || "", qty: +f.qty.toFixed(2), amt: +f.amt.toFixed(2), ppg: ppg != null ? +ppg.toFixed(2) : null, miles, mpg, cpm, idleGal: idle });
    });
    computed = { rows, unmatched, totals: {
      qty: +tQty.toFixed(1), amt: +tAmt.toFixed(2), idle: +tIdle.toFixed(1), miles: +tMiles.toFixed(1),
      ppg: tQty ? +(tAmt / tQty).toFixed(2) : null, mpg: tQty ? +(tMiles / tQty).toFixed(2) : null, cpm: tMiles ? +(tAmt / tMiles).toFixed(2) : null,
    } };
    render();
  }

  // ---- Render ----
  function render() {
    const { rows, unmatched } = computed;
    // Always recompute company totals from the rows (works for old + new saved reports).
    const T = rows.reduce((a, r) => ({
      qty: a.qty + (r.qty || 0), amt: a.amt + (r.amt || 0),
      miles: a.miles + (r.miles || 0), idle: a.idle + (r.idleGal || 0),
    }), { qty: 0, amt: 0, miles: 0, idle: 0 });
    $("#rep-stats").style.display = "grid";
    $("#rep-units").textContent = rows.length;
    $("#rep-gal").textContent = fmt(T.qty, 0);
    $("#rep-cost").textContent = "$" + fmt(T.amt, 0);
    $("#rep-ppg").textContent = T.qty ? "$" + (T.amt / T.qty).toFixed(2) : "—";
    $("#rep-mpg").textContent = T.qty ? (T.miles / T.qty).toFixed(2) : "—";
    $("#rep-cpm").textContent = T.miles ? "$" + (T.amt / T.miles).toFixed(2) : "—";
    $("#rep-idle").textContent = fmt(T.idle, 0);

    // low MPG list (< 6)
    const low = rows.filter((r) => r.mpg != null && r.mpg < 6).sort((a, b) => a.mpg - b.mpg);
    const box = $("#rep-lowmpg");
    if (low.length) {
      box.classList.remove("hidden");
      $("#rep-lowmpg-title").textContent = `Eng past MPG (< 6) — ${low.length} ta`;
      $("#rep-lowmpg-list").innerHTML = low.map((r) => `
        <div class="cov-item">
          <span class="u">${r.unit}</span>
          <span class="m mpg bad">${r.mpg} MPG</span>
          <span class="a">${fmt(r.miles, 0)} mi · ${fmt(r.qty, 0)} gal</span>
          <button class="btn rep-check-btn" data-unit="${r.unit}" style="margin-top:6px">🔍 Check</button>
        </div>`).join("");
      $("#rep-lowmpg-list").querySelectorAll(".rep-check-btn").forEach((b) =>
        b.addEventListener("click", () => checkUnit(b.dataset.unit, b)));
      $("#rep-check-detail").innerHTML = "";
    } else box.classList.add("hidden");

    renderRows();
    $("#rep-table").style.display = "";
    $("#rep-save").disabled = false;
    $("#rep-export").disabled = false;
    if (unmatched.length) warn("Motive'da topilmagan (miles yo'q): " + unmatched.join(", "));
    else clearWarn();
  }

  function renderRows() {
    const rows = [...computed.rows].sort((a, b) => {
      let x = a[sortCol], y = b[sortCol];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      if (sortCol === "unit") return String(x).localeCompare(String(y)) * sortDir;
      return (x - y) * sortDir;
    });
    $("#rep-rows").innerHTML = rows.map((r) => `
      <tr>
        <td><span class="unit-pill">${r.unit}</span></td>
        <td>${fmt(r.qty, 1)}</td>
        <td>$${fmt(r.amt, 0)}</td>
        <td>${r.ppg ?? "—"}</td>
        <td>${r.miles != null ? fmt(r.miles, 0) : '<span style="color:var(--text-mute)">—</span>'}</td>
        <td class="${r.mpg != null && r.mpg < 6 ? "mpg bad" : (r.mpg >= 7.5 ? "mpg good" : "")}">${r.mpg ?? "—"}</td>
        <td>${r.cpm ?? "—"}</td>
        <td class="${r.idleGal >= 30 ? "idle high" : (r.idleGal >= 15 ? "idle mid" : "")}">${r.idleGal ?? "—"}</td>
      </tr>`).join("");
    document.querySelectorAll("#rep-table th").forEach((th) => {
      const a = th.querySelector(".arrow");
      if (a) a.textContent = th.dataset.col === sortCol ? (sortDir === 1 ? " ▲" : " ▼") : "";
    });
  }

  function warn(msg) { const w = $("#rep-warn"); w.textContent = "⚠️ " + msg; w.classList.remove("hidden"); }
  function clearWarn() { $("#rep-warn").classList.add("hidden"); }

  // ---- Transaction location check ----
  async function checkUnit(unit, btn) {
    const txs = allTx.filter((t) => t.unit === unit);
    if (!txs.length) { alert("Bu unit transaksiyalari yuklangan fuel report'da yo'q (saqlangan reportda transaksiya saqlanmaydi). Asl fayllarni qayta yuklang."); return; }
    const old = btn.textContent; btn.textContent = "…"; btn.disabled = true;
    try {
      const res = await fetch("/api/fuel-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ periodStart: period.start, periodEnd: period.end, transactions: txs }) });
      const j = await res.json();
      renderCheck(unit, j.results || []);
    } catch (e) { alert("Xato: " + e.message); }
    btn.textContent = old; btn.disabled = false;
  }

  function renderCheck(unit, results) {
    const verdictBadge = (r) => {
      const v = r.combined || r.verdict;
      if (v === "all-good") return '<span style="color:var(--full);font-weight:600">✅ ALL GOOD</span>';
      if (v === "fraud") return '<span style="color:var(--critical);font-weight:600">🚨 FRAUD</span>';
      if (v === "ok") return '<span style="color:var(--full)">✓ joy mos</span>';
      if (v === "mismatch") return '<span style="color:var(--critical);font-weight:600">⚠️ joy mos emas</span>';
      if (v === "no-data") return '<span style="color:var(--text-mute)">period yo\'q</span>';
      return '<span style="color:var(--text-mute)">Motive\'da yo\'q</span>';
    };
    const fuelCell = (r) => {
      if (r.fuelVerdict === "rose") return `<span style="color:var(--full)">+${r.rise}% ✓</span>`;
      if (r.fuelVerdict === "no-rise") return `<span style="color:var(--critical)">+${r.rise}% ⚠️ ko'tarilmadi</span>`;
      return '<span style="color:var(--text-mute)" title="fuel level tarixi hozircha yo\'q (kelajakda yig\'iladi)">—</span>';
    };
    const el = $("#rep-check-detail");
    el.innerHTML = `<h3 style="font-size:15px;margin:0 0 8px">Unit ${unit} — transaksiya tekshiruvi</h3>
      <table class="idle-table"><thead><tr><th>Sana</th><th>Vaqt</th><th>Fuel stop</th><th>Gal</th><th>Truck o'sha vaqtda</th><th>Fuel level</th><th>Verdikt</th></tr></thead><tbody>` +
      results.map((r) => `<tr>
        <td>${r.date || "—"}</td><td>${r.time || "—"}</td>
        <td>${r.fuelCity}, ${r.fuelState}</td><td>${r.qty}</td>
        <td>${(r.truckCities || []).join(", ") || "—"} ${r.truckStates && r.truckStates.length ? "[" + r.truckStates.join(",") + "]" : ""}</td>
        <td>${fuelCell(r)}</td>
        <td>${verdictBadge(r)}</td></tr>`).join("") + `</tbody></table>
      <p class="cov-note" style="margin-top:8px">💡 <strong>Fuel level</strong> — truck baki ko'tarilganmi (eng kuchli isbot). Hozircha tarix yig'ilmoqda — o'tgan davrlar uchun "—", <strong>kelajakdagi</strong> reportlarda to'liq ishlaydi.</p>`;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---- Save / history ----
  async function save() {
    if (!computed) return;
    $("#rep-save").disabled = true;
    const body = { type: $("#rep-type").value, periodStart: period.start, periodEnd: period.end, rows: computed.rows, unmatched: computed.unmatched, totals: computed.totals };
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (j.ok) { alert("Saqlandi ✓"); loadHistory(); } else { alert("Xato: " + (j.error || "")); $("#rep-save").disabled = false; }
  }

  async function loadHistory() {
    const res = await fetch("/api/reports");
    const list = await res.json();
    // dropdown
    const sel = $("#rep-history-select");
    sel.innerHTML = `<option value="">📁 Saqlangan reportni oching…</option>` +
      list.map((r) => `<option value="${r.id}">${r.periodStart} → ${r.periodEnd} (${r.type}, ${r.unitCount}u)</option>`).join("");
    // cards
    const el = $("#rep-history");
    if (!list.length) { el.innerHTML = '<p class="cov-note">Hali saqlangan report yo\'q.</p>'; return; }
    el.innerHTML = `<div class="cov-grid">` + list.map((r) => `
      <div class="cov-item rep-hist" data-id="${r.id}">
        <span class="u">${r.periodStart || "?"} → ${r.periodEnd || "?"}</span>
        <span class="m">${r.type} · ${r.unitCount} unit</span>
        <span class="a">${r.totals ? "$" + fmt(r.totals.amt, 0) + " · " + fmt(r.totals.qty, 0) + " gal" : ""}</span>
      </div>`).join("") + `</div>`;
    el.querySelectorAll(".rep-hist").forEach((it) => it.addEventListener("click", () => openSaved(it.dataset.id)));
  }

  async function openSaved(id) {
    if (!id) return;
    const res = await fetch("/api/reports/" + id);
    const r = await res.json();
    if (!r || !r.rows) return;
    computed = { rows: r.rows, unmatched: r.unmatched || [], totals: r.totals || {} };
    period = { start: r.periodStart, end: r.periodEnd };
    if (r.type) $("#rep-type").value = r.type;
    $("#rep-period").textContent = period.start ? period.start + " → " + period.end : "";
    render();
    $("#rep-stats").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Export ----
  function exportXlsx() {
    if (!computed) return;
    const data = computed.rows.map((r) => ({ Unit: r.unit, "Qty (gal)": r.qty, "Amt ($)": r.amt, PPG: r.ppg, Miles: r.miles, MPG: r.mpg, CPM: r.cpm, "Idle gal": r.idleGal }));
    const ws = XLSX.utils.json_to_sheet(data, { header: ["Unit", "Qty (gal)", "Amt ($)", "PPG", "Miles", "MPG", "CPM", "Idle gal"] });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `Fuel Report ${period.start || ""}_${period.end || ""}.xlsx`);
  }

  // ---- Ranking (full leaderboard) ----
  let rankRows = [], rankCol = "mpg", rankDir = -1, rankWired = false;

  function renderRankTable() {
    const rows = [...rankRows].sort((a, b) => {
      let x = a[rankCol], y = b[rankCol];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      return (x - y) * rankDir;
    });
    const tbody = $("#rank-rows");
    if (!rows.length) { tbody.innerHTML = ""; $("#rank-empty").classList.remove("hidden"); return; }
    $("#rank-empty").classList.add("hidden");
    const medal = (i) => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (i + 1);
    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td class="rank-pos">${medal(i)}</td>
        <td><span class="unit-pill">${r.unit}</span></td>
        <td>${r.driver || "—"}</td>
        <td class="${r.mpg != null && r.mpg < 6 ? "mpg bad" : (r.mpg >= 7.5 ? "mpg good" : "")}">${r.mpg ?? "—"}</td>
        <td class="${r.idleGal >= 30 ? "idle high" : (r.idleGal >= 15 ? "idle mid" : "")}">${r.idleGal ?? "—"}</td>
        <td>${r.cpm != null ? "$" + r.cpm : "—"}</td>
        <td>${r.miles != null ? fmt(r.miles, 0) : "—"}</td>
        <td>${fmt(r.qty, 0)}</td>
        <td>$${fmt(r.amt, 0)}</td>
      </tr>`).join("");
    document.querySelectorAll("#rank-table th[data-rcol]").forEach((th) =>
      th.classList.toggle("active", th.dataset.rcol === rankCol));
  }

  async function loadRankReport(id) {
    if (!id) { rankRows = []; renderRankTable(); return; }
    const r = await (await fetch("/api/reports/" + id)).json();
    rankRows = r.rows || [];
    $("#rank-period").textContent = (r.periodStart || "?") + " → " + (r.periodEnd || "?") + " · " + rankRows.length + " unit";
    renderRankTable();
  }

  window.initRanking = async function () {
    const sel = $("#rank-report");
    if (!rankWired) {
      rankWired = true;
      sel.addEventListener("change", () => loadRankReport(sel.value));
      $("#rank-by").addEventListener("change", (e) => { const [c, d] = e.target.value.split("|"); rankCol = c; rankDir = +d; renderRankTable(); });
      document.querySelectorAll("#rank-table th[data-rcol]").forEach((th) => th.addEventListener("click", () => {
        const c = th.dataset.rcol;
        if (rankCol === c) rankDir = -rankDir; else { rankCol = c; rankDir = -1; }
        renderRankTable();
      }));
    }
    const list = await (await fetch("/api/reports")).json();
    sel.innerHTML = list.map((r) => `<option value="${r.id}">${r.periodStart} → ${r.periodEnd} (${r.type})</option>`).join("");
    if (!list.length) { rankRows = []; renderRankTable(); $("#rank-period").textContent = ""; return; }
    let pick = list[0].id;
    if (period.start) { const m = list.find((r) => r.periodStart === period.start && r.periodEnd === period.end); if (m) pick = m.id; }
    sel.value = pick;
    await loadRankReport(pick);
  };

  // ---- Wiring ----
  function setupDrop(dropId, inputId, handler) {
    const drop = $(dropId), input = $(inputId);
    input.addEventListener("change", () => { if (input.files[0]) handler(input.files[0]); });
    ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) handler(f); });
  }

  window.initReports = function () {
    if (wired) { loadHistory(); return; }
    wired = true;
    setupDrop("#drop-fuel", "#file-fuel", parseFuel);
    setupDrop("#drop-perf", "#file-perf", parsePerf);
    $("#rep-generate").addEventListener("click", generate);
    $("#rep-auto").addEventListener("click", (e) => autoFetch(e.currentTarget));
    $("#rep-save").addEventListener("click", save);
    $("#rep-export").addEventListener("click", exportXlsx);
    $("#rep-history-select").addEventListener("change", (e) => openSaved(e.target.value));
    document.querySelectorAll("#rep-table th").forEach((th) => th.addEventListener("click", () => {
      const col = th.dataset.col; if (!col) return;
      if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = col === "unit" ? 1 : -1; }
      if (computed) renderRows();
    }));
    loadHistory();
  };
})();

(function () {
  const $ = (s) => document.querySelector(s);
  let fuelAgg = null, perfAgg = null, allTx = [];
  let period = { start: null, end: null };
  let computed = null;
  let reviews = {};              // unit -> { status:"good"|"bad", note }
  let currentReportId = null;    // set when a saved report is open (enables persist)
  let wired = false;
  let sortCol = "unit", sortDir = 1;

  function fmt(n, d = 0) { return n == null ? "—" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }

  // Canonical unit number: strip a leading BOM/# and any leading zeros so that
  // "0007", "007", "#7" and "7" all match the same truck across the fuel report,
  // the performance CSV and Motive. Non-numeric ids (e.g. "TRK7") are left as-is.
  function normUnit(s) {
    s = String(s == null ? "" : s).replace(/^\uFEFF/, "").trim().replace(/^#/, "");
    return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
  }

  // ---- Parsing ----
  async function parseFuel(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    const agg = {}; const tx = []; let minD = null, maxD = null;
    for (const r of rows) {
      const item = String(r.Item || "").toUpperCase();
      const unit = normUnit(r.Unit);
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
    let text = await file.text();
    text = text.replace(/^\uFEFF/, ""); // strip UTF-8 BOM (Excel/Motive exports add it)
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) { warn("Performance CSV bo'sh."); return; }
    const cell = (x) => String(x == null ? "" : x).replace(/^\uFEFF/, "").trim().replace(/^"|"$/g, "").trim();
    const hdr = lines[0].split(",").map(cell);
    // Tolerant header detection: "Vehicle" / "Vehicle Number" / "Unit" / "Truck".
    let vi = hdr.findIndex((h) => /^vehicle\b/i.test(h));
    if (vi < 0) vi = hdr.findIndex((h) => /\b(unit|truck)\b/i.test(h));
    const di = hdr.findIndex((h) => /total distance|distance|miles/i.test(h));
    const ii = hdr.findIndex((h) => /idled?\s*fuel/i.test(h));
    const dri = hdr.findIndex((h) => /^driver\b/i.test(h));
    if (vi < 0) { warn("Performance CSV'da 'Vehicle' ustuni topilmadi. Ustunlar: " + hdr.join(" | ")); return; }
    const agg = {};
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(",").map(cell);
      const v = normUnit(c[vi]); if (!v) continue;
      const mi = di >= 0 ? parseFloat(c[di]) || 0 : 0;
      if (!agg[v]) agg[v] = { miles: 0, idle: 0, driver: "", _dm: -1 };
      agg[v].miles += mi;
      agg[v].idle += ii >= 0 ? parseFloat(c[ii]) || 0 : 0;
      const drv = dri >= 0 ? cell(c[dri]) : "";
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
      Object.keys(j.units).forEach((u) => { agg[normUnit(u)] = { miles: j.units[u].miles, idle: j.units[u].idle, driver: "" }; });
      perfAgg = agg;
      const withMiles = Object.values(agg).filter((x) => x.miles != null).length;
      $("#perf-name").textContent = `Motive (avto) · ${Object.keys(agg).length} unit · ${withMiles} ta miles bilan`;
      $("#drop-perf").classList.add("ok");
      if (!withMiles) warn("Motive idle keldi, lekin miles hali yo'q (odometer tarixi bugundan yig'ilmoqda — keyingi haftadan miles ham bo'ladi). Hozir miles uchun CSV yuklang.");
    } catch (e) { alert("Xato: " + e.message); }
    btn.textContent = old; btn.disabled = false;
  }

  // ---- Compute ----
  let usedPerf = new Set();   // Motive units matched to a fuel-card unit
  function lookupPerf(unit) {
    // Both sides are normUnit-canonical now; track which Motive unit we consumed
    // so generate() can still surface unmatched Motive ("orphan") units.
    const n = normUnit(unit);
    if (perfAgg[n]) { usedPerf.add(n); return perfAgg[n]; }
    if (perfAgg[unit]) { usedPerf.add(unit); return perfAgg[unit]; }
    return null;
  }

  function generate() {
    if (!fuelAgg) { warn("Fuel report (Excel) yuklang."); return; }
    if (!perfAgg) { warn("Driver Fuel Performance (CSV) yuklang."); return; }
    const rows = [], unmatched = [];
    usedPerf = new Set();
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
    const perfOrphans = Object.keys(perfAgg)
      .filter((k) => !usedPerf.has(k) && perfAgg[k] && perfAgg[k].miles != null)
      .map((k) => ({ unit: k, miles: +perfAgg[k].miles, idle: perfAgg[k].idle != null ? +perfAgg[k].idle : null }));
    computed = { rows, unmatched, perfOrphans, totals: {
      qty: +tQty.toFixed(1), amt: +tAmt.toFixed(2), idle: +tIdle.toFixed(1), miles: +tMiles.toFixed(1),
      ppg: tQty ? +(tAmt / tQty).toFixed(2) : null, mpg: tQty ? +(tMiles / tQty).toFixed(2) : null, cpm: tMiles ? +(tAmt / tMiles).toFixed(2) : null,
    } };
    reviews = {};            // fresh report — no reviews yet
    currentReportId = null;  // not saved yet; reviews persist on Save
    $("#rep-update").style.display = "none";  // edit/delete only for saved reports
    $("#rep-delete").style.display = "none";
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
      const doneCount = low.filter((r) => reviews[r.unit] && reviews[r.unit].status).length;
      $("#rep-lowmpg-title").textContent = `Eng past MPG (< 6) — ${low.length} ta · ${doneCount}/${low.length} tekshirildi`;
      $("#rep-lowmpg-list").innerHTML = low.map((r) => {
        const rv = reviews[r.unit] || {};
        return `
        <div class="cov-item lowmpg-item rev-${rv.status || "none"}" data-unit="${r.unit}">
          <span class="u">${r.unit}</span>
          <span class="m mpg bad">${r.mpg} MPG</span>
          <span class="a">${fmt(r.miles, 0)} mi · ${fmt(r.qty, 0)} gal</span>
          <div class="rev-btns">
            <button class="rev-btn good ${rv.status === "good" ? "on" : ""}" data-unit="${r.unit}" data-st="good">✓ All good</button>
            <button class="rev-btn bad ${rv.status === "bad" ? "on" : ""}" data-unit="${r.unit}" data-st="bad">⚠️ Yomon</button>
          </div>
          <input class="rev-note" data-unit="${r.unit}" placeholder="izoh…" value="${(rv.note || "").replace(/"/g, "&quot;")}">
          <button class="btn rep-check-btn" data-unit="${r.unit}">🔍 Check</button>
        </div>`; }).join("");
      $("#rep-lowmpg-list").querySelectorAll(".rep-check-btn").forEach((b) =>
        b.addEventListener("click", () => checkUnit(b.dataset.unit, b)));
      $("#rep-lowmpg-list").querySelectorAll(".rev-btn").forEach((b) =>
        b.addEventListener("click", () => toggleReview(b.dataset.unit, b.dataset.st)));
      $("#rep-lowmpg-list").querySelectorAll(".rev-note").forEach((n) =>
        n.addEventListener("change", () => setReviewNote(n.dataset.unit, n.value)));
      $("#rep-check-detail").innerHTML = "";
    } else box.classList.add("hidden");

    renderRows();
    renderUnmatched();
    $("#rep-table").style.display = "";
    $("#rep-save").disabled = false;
    $("#rep-export").disabled = false;
    clearWarn();
  }

  function renderUnmatched() {
    const um = (computed && computed.unmatched) || [];
    const orphans = (computed && computed.perfOrphans) || [];
    const el = $("#rep-unmatched");
    if (!el) return;
    if (!um.length && !orphans.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.remove("hidden");
    el.innerHTML = `
      <h3>⚠️ Match kelmadi — qo'lda to'g'rilang</h3>
      ${um.length ? `<div class="um-row"><span class="um-lbl">Fuel-kartada bor, Motive miles yo'q:</span> ${um.map((u) => `<span class="um-pill">${esc(u)}</span>`).join("")}</div>` : ""}
      ${orphans.length ? `<div class="um-row"><span class="um-lbl">Motive'da bor (miles), fuel-karta mos kelmadi:</span> ${orphans.map((o) => `<span class="um-pill orphan">${esc(o.unit)} · ${fmt(o.miles, 0)} mi${o.idle != null ? " · " + fmt(o.idle, 0) + " idle gal" : ""}</span>`).join("")}</div>` : ""}
      <p class="cov-note">Bir xil truck bo'lsa (masalan <b>0007 = 007</b>): jadvalni tahrirlab, o'sha unit qatoriga Motive miles'ini qo'lda kiriting — MPG avtomatik hisoblanadi.</p>`;
  }

  const esc = (v) => String(v == null ? "" : v).replace(/"/g, "&quot;");
  function recalcRow(r) {
    r.ppg = (r.amt != null && r.qty) ? +(r.amt / r.qty).toFixed(3) : null;
    r.mpg = (r.miles != null && r.qty) ? +(r.miles / r.qty).toFixed(2) : null;
    r.cpm = (r.amt != null && r.miles) ? +(r.amt / r.miles).toFixed(3) : null;
  }
  function onEditInput(e) {
    const el = e.target, i = +el.dataset.i, f = el.dataset.f, r = computed.rows[i];
    if (!r) return;
    if (f === "unit") r.unit = el.value.trim();
    else r[f] = el.value === "" ? null : parseFloat(el.value);
    recalcRow(r);
    const setD = (k, v) => { const c = document.querySelector(`[data-d="${k}-${i}"]`); if (c) c.textContent = (v == null ? "—" : v); };
    setD("ppg", r.ppg); setD("mpg", r.mpg); setD("cpm", r.cpm);
  }
  function renderRows() {
    const editMode = !!currentReportId;
    const rows = [...computed.rows].sort((a, b) => {
      let x = a[sortCol], y = b[sortCol];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      if (sortCol === "unit") return String(x).localeCompare(String(y)) * sortDir;
      return (x - y) * sortDir;
    });
    $("#rep-rows").innerHTML = rows.map((r) => {
      const i = computed.rows.indexOf(r);
      if (editMode) {
        return `<tr>
          <td><input class="rep-edit" data-i="${i}" data-f="unit" value="${esc(r.unit)}" style="width:60px"></td>
          <td><input class="rep-edit" data-i="${i}" data-f="qty" type="number" value="${r.qty ?? ""}" style="width:72px"></td>
          <td><input class="rep-edit" data-i="${i}" data-f="amt" type="number" value="${r.amt ?? ""}" style="width:84px"></td>
          <td class="rep-d" data-d="ppg-${i}">${r.ppg ?? "—"}</td>
          <td><input class="rep-edit" data-i="${i}" data-f="miles" type="number" value="${r.miles ?? ""}" style="width:72px"></td>
          <td class="rep-d" data-d="mpg-${i}">${r.mpg ?? "—"}</td>
          <td class="rep-d" data-d="cpm-${i}">${r.cpm ?? "—"}</td>
          <td><input class="rep-edit" data-i="${i}" data-f="idleGal" type="number" value="${r.idleGal ?? ""}" style="width:60px"></td>
          <td><button class="rep-row-del" data-i="${i}" title="Qatorni o'chirish">✕</button></td>
        </tr>`;
      }
      return `<tr>
        <td><span class="unit-pill">${esc(r.unit)}</span></td>
        <td>${fmt(r.qty, 1)}</td>
        <td>$${fmt(r.amt, 0)}</td>
        <td>${r.ppg ?? "—"}</td>
        <td>${r.miles != null ? fmt(r.miles, 0) : '<span style="color:var(--text-mute)">—</span>'}</td>
        <td class="${r.mpg != null && r.mpg < 6 ? "mpg bad" : (r.mpg >= 7.5 ? "mpg good" : "")}">${r.mpg ?? "—"}</td>
        <td>${r.cpm ?? "—"}</td>
        <td class="${r.idleGal >= 30 ? "idle high" : (r.idleGal >= 15 ? "idle mid" : "")}">${r.idleGal ?? "—"}</td>
        <td></td>
      </tr>`;
    }).join("");
    if (editMode) {
      $("#rep-rows").querySelectorAll(".rep-edit").forEach((el) => el.addEventListener("input", onEditInput));
      $("#rep-rows").querySelectorAll(".rep-row-del").forEach((b) => b.addEventListener("click", () => { computed.rows.splice(+b.dataset.i, 1); render(); }));
    }
    document.querySelectorAll("#rep-table th").forEach((th) => {
      const a = th.querySelector(".arrow");
      if (a) a.textContent = th.dataset.col === sortCol ? (sortDir === 1 ? " ▲" : " ▼") : "";
    });
  }
  async function saveReportEdits(btn) {
    if (!currentReportId || !computed) return;
    const T = computed.rows.reduce((a, r) => ({ qty: a.qty + (r.qty || 0), amt: a.amt + (r.amt || 0), miles: a.miles + (r.miles || 0), idle: a.idle + (r.idleGal || 0) }), { qty: 0, amt: 0, miles: 0, idle: 0 });
    const totals = { qty: +T.qty.toFixed(1), amt: +T.amt.toFixed(2), miles: Math.round(T.miles), idleGal: +T.idle.toFixed(1), ppg: T.qty ? +(T.amt / T.qty).toFixed(3) : null, mpg: T.qty ? +(T.miles / T.qty).toFixed(2) : null, cpm: T.miles ? +(T.amt / T.miles).toFixed(3) : null };
    computed.totals = totals;
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Saqlanmoqda…";
    try {
      const res = await fetch("/api/reports/" + currentReportId, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: computed.rows, totals }) });
      const j = await res.json();
      btn.textContent = j.ok ? "✓ Saqlandi" : "Xato"; setTimeout(() => (btn.textContent = old), 1600);
      render(); loadHistory();
    } catch (e) { alert("Xato: " + e.message); btn.textContent = old; }
    btn.disabled = false;
  }
  async function deleteReport(id) {
    if (!id) return;
    if (!confirm("Shu reportni butunlay o'chirasizmi? (qaytarib bo'lmaydi)")) return;
    try {
      await fetch("/api/reports/" + id, { method: "DELETE" });
      if (currentReportId === id) {
        currentReportId = null; computed = null;
        $("#rep-table").style.display = "none"; $("#rep-stats").style.display = "none"; $("#rep-lowmpg").classList.add("hidden");
        $("#rep-update").style.display = "none"; $("#rep-delete").style.display = "none";
      }
      loadHistory();
    } catch (e) { alert("Xato: " + e.message); }
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

  // ---- Manual review (low-MPG checked list) ----
  function toggleReview(unit, status) {
    const rv = reviews[unit] || {};
    rv.status = rv.status === status ? null : status;
    if (!rv.status && !rv.note) delete reviews[unit]; else reviews[unit] = rv;
    persistReview(unit);
    const item = document.querySelector(`#rep-lowmpg-list .lowmpg-item[data-unit="${unit}"]`);
    if (item) {
      const cur = reviews[unit] && reviews[unit].status;
      item.className = `cov-item lowmpg-item rev-${cur || "none"}`;
      item.querySelectorAll(".rev-btn").forEach((b) => b.classList.toggle("on", b.dataset.st === cur));
    }
    updateReviewCount();
  }
  function setReviewNote(unit, note) {
    const rv = reviews[unit] || {};
    rv.note = note.trim();
    if (!rv.status && !rv.note) delete reviews[unit]; else reviews[unit] = rv;
    persistReview(unit);
  }
  function updateReviewCount() {
    const items = $("#rep-lowmpg-list").querySelectorAll(".lowmpg-item");
    const done = [...items].filter((it) => reviews[it.dataset.unit] && reviews[it.dataset.unit].status).length;
    $("#rep-lowmpg-title").textContent = `Eng past MPG (< 6) — ${items.length} ta · ${done}/${items.length} tekshirildi`;
  }
  async function persistReview(unit) {
    if (!currentReportId) return; // unsaved report -> stored together on Save
    const rv = reviews[unit] || {};
    try {
      await fetch(`/api/reports/${currentReportId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unit, status: rv.status || null, note: rv.note || "" }) });
    } catch {}
  }

  // ---- Save / history ----
  async function save() {
    if (!computed) return;
    $("#rep-save").disabled = true;
    const body = { type: $("#rep-type").value, periodStart: period.start, periodEnd: period.end, rows: computed.rows, unmatched: computed.unmatched, totals: computed.totals, reviews };
    const res = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (j.ok) { currentReportId = j.id; alert("Saqlandi ✓"); loadHistory(); } else { alert("Xato: " + (j.error || "")); $("#rep-save").disabled = false; }
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
        <button class="rep-card-del" data-id="${r.id}" title="Reportni o'chirish">✕</button>
        <span class="u">${r.periodStart || "?"} → ${r.periodEnd || "?"}</span>
        <span class="m">${r.type} · ${r.unitCount} unit</span>
        <span class="a">${r.totals ? "$" + fmt(r.totals.amt, 0) + " · " + fmt(r.totals.qty, 0) + " gal" : ""}</span>
      </div>`).join("") + `</div>`;
    el.querySelectorAll(".rep-hist").forEach((it) => it.addEventListener("click", () => openSaved(it.dataset.id)));
    el.querySelectorAll(".rep-card-del").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); deleteReport(b.dataset.id); }));
  }

  async function openSaved(id) {
    if (!id) return;
    const res = await fetch("/api/reports/" + id);
    const r = await res.json();
    if (!r || !r.rows) return;
    computed = { rows: r.rows, unmatched: r.unmatched || [], totals: r.totals || {} };
    reviews = r.reviews || {};
    currentReportId = id;
    period = { start: r.periodStart, end: r.periodEnd };
    if (r.type) $("#rep-type").value = r.type;
    $("#rep-period").textContent = period.start ? period.start + " → " + period.end : "";
    render();
    $("#rep-update").style.display = "";   // saved report -> editable
    $("#rep-delete").style.display = "";
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
    $("#rep-update").addEventListener("click", (e) => saveReportEdits(e.currentTarget));
    $("#rep-delete").addEventListener("click", () => deleteReport(currentReportId));
    $("#rep-history-select").addEventListener("change", (e) => openSaved(e.target.value));
    document.querySelectorAll("#rep-table th").forEach((th) => th.addEventListener("click", () => {
      const col = th.dataset.col; if (!col) return;
      if (sortCol === col) sortDir = -sortDir; else { sortCol = col; sortDir = col === "unit" ? 1 : -1; }
      if (computed) renderRows();
    }));
    loadHistory();
  };
})();

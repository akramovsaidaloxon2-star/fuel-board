(function () {
  const $ = (s) => document.querySelector(s);
  let rows = [], wired = false, ro = false, curLabel = "", curId = "";

  // Exact column headers from the Fastmover toll report (1:1).
  const HEADERS = ["Driver", "Unit", "Load ID", "Date", "From > To", "Toll calculator", "Given direction", "Estimated difference", "Status", "DH", "Dispatched mile", "Directed mile", "Extra mile", "Driven mile", "Total Driven Mile", "Driven toll", "Charge"];

  // Soft saving constants (from the bottom of the report's main toll sheet).
  const EXTRA_MILE_RATE = 1.5;    // Extra Miles ($) = Extra Miles × 1.5

  function blank() { return { driver: "", unit: "", loadId: "", date: "", route: "", tollCalc: null, givenDir: null, status: "", dh: null, dispatched: null, directed: null, driven: null, totalDriven: null, drivenToll: null, charge: null, note: "" }; }
  const money = (n) => (n == null || isNaN(n)) ? "" : "$" + Number(n).toFixed(2);
  const num = (n) => (n == null || isNaN(n)) ? "" : Number(n).toFixed(1);
  const esc = (v) => String(v == null ? "" : v).replace(/"/g, "&quot;");

  // Estimated difference per row. Like the report, a load only earns soft saving when it was
  // FOLLOWED — NOT FOLLOWED / SKIPPED loads count as $0. Returns null when not computable yet.
  function estOf(r) {
    if (r.status === "NOT FOLLOWED" || r.status === "SKIPPED") return 0;
    return (r.tollCalc != null && r.givenDir != null) ? (r.tollCalc - r.givenDir) : null;
  }

  function inp(i, f, type, w) { const v = rows[i][f] == null ? "" : rows[i][f]; return `<input data-i="${i}" data-f="${f}" type="${type}" value="${esc(v)}" style="width:${w}px" ${ro ? "disabled" : ""}>`; }

  // Date is shown/stored as DD.MM.YYYY (report format) but edited with a native date picker (no manual typing).
  function toISO(d) {
    if (!d) return "";
    const s = String(d).trim();
    const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);   // DD.MM.YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;                    // already ISO
    return "";
  }
  function fromISO(iso) { const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso || ""); }
  function dateInp(i, w) { return `<input data-i="${i}" data-f="date" type="date" value="${toISO(rows[i].date)}" style="width:${w}px" ${ro ? "disabled" : ""}>`; }
  function statusSel(i, v) {
    const cls = v === "FOLLOWED" ? "ok" : (v === "NOT FOLLOWED" || v === "SKIPPED") ? "no" : "";
    const opt = (o) => `<option value="${o}" ${v === o ? "selected" : ""}>${o || "—"}</option>`;
    return `<select data-i="${i}" data-f="status" class="toll-status ${cls}" ${ro ? "disabled" : ""}>${["", "FOLLOWED", "NOT FOLLOWED", "SKIPPED"].map(opt).join("")}</select>`;
  }
  // Per-row note (e.g. why a load was NOT FOLLOWED). 📝 turns amber when a note exists; hover shows it.
  function noteBtn(i, r) {
    const has = r.note && String(r.note).trim();
    const tip = has ? r.note : (ro ? "Note yo'q" : "Note (izoh) qoldirish");
    return `<button type="button" class="toll-note ${has ? "has" : ""}" data-note="${i}" title="${esc(tip)}">📝</button>`;
  }

  // Flat row in the exact report column order, with computed est-diff and extra.
  function rowArray(r) {
    const est = estOf(r);
    const extra = (r.directed != null && r.dispatched != null) ? (r.directed - r.dispatched) : "";
    return [r.driver, r.unit, r.loadId, r.date, r.route, r.tollCalc, r.givenDir, est, r.status, r.dh, r.dispatched, r.directed, extra, r.driven, r.totalDriven, r.drivenToll, r.charge].map((v) => (v == null ? "" : v));
  }
  function fileBase() { return "Toll " + (curLabel ? curLabel.replace(/[^\w .-]/g, "").trim() : new Date().toISOString().slice(0, 10)); }

  function totals() {
    let charge = 0, est = 0, foll = 0, notf = 0, skip = 0;
    rows.forEach((r) => {
      if (r.charge != null) charge += +r.charge || 0;
      { const e = estOf(r); if (e != null) est += e; }
      if (r.status === "FOLLOWED") foll++; else if (r.status === "NOT FOLLOWED") notf++; else if (r.status === "SKIPPED") skip++;
    });
    const ctx = curId && curId !== "__live" ? `✏️ "${curLabel}" reportni tahrirlayapsiz (💾 Saqlash shu reportni yangilaydi) · ` : "";
    $("#toll-totals").textContent = `${ctx}${rows.length} qator · ✓ ${foll} followed · ⚠️ ${notf} not followed · ⏭️ ${skip} skipped · Est.diff $${est.toFixed(0)} · Charge $${charge.toFixed(0)}`;
    renderFoot();
  }

  // --- TOTAL + soft saving footer (rendered at the bottom of the board, like the report) ---
  // Extra Miles ($) = total Extra mile × 1.5 ; Soft saving = total Estimated difference − Extra Miles ($).
  const fmt2 = (n) => (n == null || isNaN(n)) ? "0" : (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmoney = (n) => (n == null || isNaN(n)) ? "$0.00" : "$" + (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Per-column sums + the derived soft-saving figures, over the current rows.
  function softTotals() {
    const s = { tollCalc: 0, givenDir: 0, estDiff: 0, dh: 0, dispatched: 0, directed: 0, extraMiles: 0, driven: 0, totalDriven: 0, drivenToll: 0, charge: 0 };
    rows.forEach((r) => {
      if (r.tollCalc != null) s.tollCalc += +r.tollCalc || 0;
      if (r.givenDir != null) s.givenDir += +r.givenDir || 0;
      { const e = estOf(r); if (e != null) s.estDiff += e; }
      if (r.dh != null) s.dh += +r.dh || 0;
      if (r.dispatched != null) s.dispatched += +r.dispatched || 0;
      if (r.directed != null) s.directed += +r.directed || 0;
      if (r.directed != null && r.dispatched != null) s.extraMiles += (r.directed - r.dispatched);
      if (r.driven != null) s.driven += +r.driven || 0;
      if (r.totalDriven != null) s.totalDriven += +r.totalDriven || 0;
      if (r.drivenToll != null) s.drivenToll += +r.drivenToll || 0;
      if (r.charge != null) s.charge += +r.charge || 0;
    });
    s.extraDollars = s.extraMiles * EXTRA_MILE_RATE;       // Extra Miles ($)
    s.softSaving = s.estDiff - s.extraDollars;             // Expected soft saving
    s.softSavingUnfollowed = s.softSaving - s.charge;      // ... with unfollowed (minus charges)
    return s;
  }

  function renderFoot() {
    const foot = $("#toll-foot");
    if (!foot) return;
    if (!rows.length) { foot.innerHTML = ""; return; }
    const t = softTotals();
    foot.innerHTML = `
      <tr class="toll-total-row">
        <td>TOTAL</td><td></td><td></td><td></td><td></td>
        <td>${fmoney(t.tollCalc)}</td><td>${fmoney(t.givenDir)}</td><td>${fmoney(t.estDiff)}</td>
        <td></td>
        <td>${fmt2(t.dh)}</td><td>${fmt2(t.dispatched)}</td><td>${fmt2(t.directed)}</td><td>${fmt2(t.extraMiles)}</td>
        <td>${fmt2(t.driven)}</td><td>${fmt2(t.totalDriven)}</td><td>${fmoney(t.drivenToll)}</td><td>${fmoney(t.charge)}</td>
        <td></td>
      </tr>
      <tr class="toll-foot-x">
        <td colspan="12" class="r">Extra Miles ($) = Extra mile × 1.5</td>
        <td>${fmoney(t.extraDollars)}</td>
        <td colspan="5"></td>
      </tr>
      <tr class="toll-foot-soft">
        <td colspan="5" class="r">Expected soft saving:</td>
        <td colspan="2">${fmoney(t.softSaving)}</td>
        <td colspan="4" class="r">Expected soft saving with unfollowed:</td>
        <td colspan="2">${fmoney(t.softSavingUnfollowed)}</td>
        <td colspan="5"></td>
      </tr>`;
  }

  function render() {
    const tbody = $("#toll-rows");
    tbody.innerHTML = rows.map((r, i) => `<tr>
      <td>${inp(i, "driver", "text", 220)}</td>
      <td>${inp(i, "unit", "text", 64)}</td>
      <td>${inp(i, "loadId", "text", 120)}</td>
      <td>${dateInp(i, 120)}</td>
      <td>${inp(i, "route", "text", 110)}</td>
      <td>${inp(i, "tollCalc", "number", 64)}</td>
      <td>${inp(i, "givenDir", "number", 64)}</td>
      <td class="toll-auto" data-auto="ed-${i}">${estOf(r) != null ? money(estOf(r)) : ""}</td>
      <td><div class="toll-status-cell">${statusSel(i, r.status)}${noteBtn(i, r)}</div></td>
      <td>${inp(i, "dh", "number", 56)}</td>
      <td>${inp(i, "dispatched", "number", 76)}</td>
      <td>${inp(i, "directed", "number", 76)}</td>
      <td class="toll-auto" data-auto="ex-${i}">${r.directed != null && r.dispatched != null ? num(r.directed - r.dispatched) : ""}</td>
      <td>${inp(i, "driven", "number", 76)}</td>
      <td>${inp(i, "totalDriven", "number", 80)}</td>
      <td>${inp(i, "drivenToll", "number", 64)}</td>
      <td>${inp(i, "charge", "number", 64)}</td>
      <td>${ro ? "" : `<button class="btn toll-del" data-del="${i}" title="O'chirish">✕</button>`}</td>
    </tr>`).join("");
    if (!ro) {
      tbody.querySelectorAll("input").forEach((el) => el.addEventListener("input", onInput));
      tbody.querySelectorAll("select").forEach((el) => el.addEventListener("change", onInput));
      tbody.querySelectorAll(".toll-del").forEach((b) => b.addEventListener("click", () => { rows.splice(+b.dataset.del, 1); render(); }));
    }
    // Note button works in both edit and read-only (view) modes.
    tbody.querySelectorAll(".toll-note").forEach((b) => b.addEventListener("click", () => onNote(+b.dataset.note)));
    $("#toll-add").disabled = ro; $("#toll-save").disabled = ro;
    totals();
  }

  function onNote(i) {
    const r = rows[i];
    if (ro) { alert(r.note ? r.note : "Note yo'q"); return; }
    const v = prompt("Note (izoh) — masalan: nega NOT FOLLOWED bo'ldi:", r.note || "");
    if (v === null) return;            // Bekor qilindi
    r.note = v.trim();
    render();                          // 📝 holatini yangilash uchun
  }

  function onInput(e) {
    const el = e.target, i = +el.dataset.i, f = el.dataset.f;
    let v = el.value;
    if (el.type === "number") v = v === "" ? null : parseFloat(v);
    else if (el.type === "date") v = fromISO(v);   // store report format DD.MM.YYYY
    rows[i][f] = v;
    const r = rows[i];
    if (f === "tollCalc" || f === "givenDir" || f === "status") { const c = document.querySelector(`[data-auto="ed-${i}"]`); if (c) { const e = estOf(r); c.textContent = e != null ? money(e) : ""; } }
    if (f === "directed" || f === "dispatched") { const c = document.querySelector(`[data-auto="ex-${i}"]`); if (c) c.textContent = r.directed != null && r.dispatched != null ? num(r.directed - r.dispatched) : ""; }
    if (f === "status") el.className = "toll-status " + (v === "FOLLOWED" ? "ok" : (v === "NOT FOLLOWED" || v === "SKIPPED") ? "no" : "");
    totals();
  }

  async function save(btn) {
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Saqlanmoqda…";
    // On the Live board -> /api/toll. On an opened saved report -> update that report.
    const onSaved = curId && curId !== "__live";
    const url = onSaved ? "/api/toll-reports/" + curId : "/api/toll";
    const method = onSaved ? "PUT" : "POST";
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
      const j = await res.json();
      btn.textContent = j.ok ? "Saqlandi ✓" : "Xato"; setTimeout(() => (btn.textContent = old), 1500);
      if (j.ok && onSaved) loadHistory();
    } catch (e) { alert("Xato: " + e.message); btn.textContent = old; }
    btn.disabled = false;
  }

  // --- Excel / PDF export (exact report columns) ---
  const round2 = (n) => Math.round(n * 100) / 100;
  // Soft-saving block appended to the bottom of the board sheet, like the report.
  function softSummaryRows() {
    const t = softTotals();
    const total = new Array(HEADERS.length).fill("");
    total[0] = "TOTAL";
    total[5] = round2(t.tollCalc); total[6] = round2(t.givenDir); total[7] = round2(t.estDiff);
    total[9] = round2(t.dh); total[10] = round2(t.dispatched); total[11] = round2(t.directed); total[12] = round2(t.extraMiles);
    total[13] = round2(t.driven); total[14] = round2(t.totalDriven); total[15] = round2(t.drivenToll); total[16] = round2(t.charge);
    const xtra = new Array(HEADERS.length).fill("");
    xtra[11] = "Extra Miles ($) = Extra mile × 1.5"; xtra[12] = round2(t.extraDollars);
    return [
      [],
      total,
      xtra,
      ["Expected soft saving:", round2(t.softSaving)],
      ["Expected soft saving with unfollowed:", round2(t.softSavingUnfollowed)],
    ];
  }
  function exportExcel() {
    const aoa = [[...HEADERS, "Note"], ...rows.map((r) => [...rowArray(r), r.note || ""]), ...softSummaryRows()];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (curLabel || "Toll").slice(0, 28));
    XLSX.writeFile(wb, fileBase() + ".xlsx");
  }
  function exportPdf() {
    const JS = window.jspdf && window.jspdf.jsPDF;
    if (!JS) { alert("PDF kutubxonasi yuklanmadi — sahifani yangilang"); return; }
    const doc = new JS({ orientation: "landscape", unit: "pt", format: "a4" });
    doc.setFontSize(12);
    doc.text("MOVEX — Toll report" + (curLabel ? " · " + curLabel : ""), 30, 28);
    doc.autoTable({
      head: [[...HEADERS, "Note"]], body: rows.map((r) => [...rowArray(r), r.note || ""]), startY: 40,
      styles: { fontSize: 5.5, cellPadding: 2, overflow: "linebreak" },
      headStyles: { fillColor: [27, 58, 99], textColor: 255, fontSize: 6 },
      theme: "grid", margin: { left: 16, right: 16 },
    });
    const t = softTotals();
    let y = (doc.lastAutoTable ? doc.lastAutoTable.finalY : 60) + 20;
    doc.setFontSize(10);
    [
      ["Estimated difference (jami):", fmt2(t.estDiff)],
      ["Extra Miles (jami):", fmt2(t.extraMiles) + " mi"],
      ["Extra Miles ($) = ×1.5:", fmoney(t.extraDollars)],
      ["Expected soft saving:", fmoney(t.softSaving)],
      ["Expected soft saving with unfollowed:", fmoney(t.softSavingUnfollowed)],
    ].forEach(([k, v]) => { doc.text(k + "  " + v, 30, y); y += 15; });
    doc.save(fileBase() + ".pdf");
  }

  // --- Saved reports (weekly / monthly snapshots) ---
  async function loadHistory() {
    try {
      const list = await (await fetch("/api/toll-reports")).json();
      const sel = $("#toll-rep-sel");
      const cur = sel.value;
      sel.innerHTML = `<option value="__live">🔴 Live board</option>` +
        (Array.isArray(list) ? list : []).map((r) => `<option value="${r.id}">${r.type === "monthly" ? "📅" : "🗓️"} ${esc(r.label || r.id)} (${r.count})</option>`).join("");
      sel.value = cur || "__live";
    } catch {}
  }
  async function openSelected(id) {
    if (id === "__live" || !id) {
      ro = false; curId = "__live"; curLabel = "";
      try { rows = await (await fetch("/api/toll")).json(); } catch { rows = []; }
      if (!Array.isArray(rows)) rows = [];
      render(); return;
    }
    try {
      const r = await (await fetch("/api/toll-reports/" + id)).json();
      if (r && Array.isArray(r.rows)) { rows = r.rows; curId = id; curLabel = r.label || ""; ro = false; render(); }
    } catch (e) { alert("Xato: " + e.message); }
  }
  async function saveReport(btn) {
    if (ro) { alert("Saqlangan reportni emas, Live board'ni report qiling (avval 🔴 Live board'ga o'ting)."); return; }
    const type = $("#toll-rep-type").value;
    const label = $("#toll-rep-label").value.trim();
    if (!label) { alert("Report nomini kiriting (masalan: June 2026)"); $("#toll-rep-label").focus(); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Saqlanmoqda…";
    try {
      const res = await fetch("/api/toll-reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, label, rows }) });
      const j = await res.json();
      btn.textContent = j.ok ? "✓ Saqlandi" : "Xato";
      $("#toll-rep-label").value = "";
      await loadHistory();
      setTimeout(() => (btn.textContent = old), 1600);
    } catch (e) { alert("Xato: " + e.message); btn.textContent = old; }
    btn.disabled = false;
  }
  async function deleteSelected() {
    const id = $("#toll-rep-sel").value;
    if (!id || id === "__live") { alert("O'chirish uchun saqlangan reportni tanlang"); return; }
    if (!confirm("Shu saqlangan reportni o'chirasizmi?")) return;
    try { await fetch("/api/toll-reports/" + id, { method: "DELETE" }); } catch {}
    await loadHistory();
    openSelected("__live");
  }

  window.initToll = async function () {
    if (!wired) {
      wired = true;
      $("#toll-add").addEventListener("click", () => { rows.push(blank()); render(); $("#toll-table").scrollIntoView({ block: "end", behavior: "smooth" }); });
      $("#toll-save").addEventListener("click", (e) => save(e.currentTarget));
      $("#toll-xls").addEventListener("click", exportExcel);
      $("#toll-pdf").addEventListener("click", exportPdf);
      $("#toll-rep-save").addEventListener("click", (e) => saveReport(e.currentTarget));
      $("#toll-rep-del").addEventListener("click", deleteSelected);
      $("#toll-rep-sel").addEventListener("change", (e) => openSelected(e.target.value));
      const helpToggle = (force) => {
        const p = $("#toll-help-panel"), show = force != null ? force : p.classList.contains("hidden");
        p.classList.toggle("hidden", !show);
        $("#toll-help-btn").classList.toggle("active", show);
        if (show) p.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      $("#toll-help-btn").addEventListener("click", () => helpToggle());
      $("#toll-help-close").addEventListener("click", () => helpToggle(false));
    }
    curId = "__live"; ro = false; curLabel = "";
    try { rows = await (await fetch("/api/toll")).json(); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    render();
    loadHistory();
  };
})();

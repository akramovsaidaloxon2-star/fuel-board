(function () {
  const $ = (s) => document.querySelector(s);
  let rows = [], wired = false, ro = false, curLabel = "", curId = "";

  // Exact column headers from the Fastmover toll report (1:1).
  const HEADERS = ["Driver", "Unit", "Load ID", "Date", "From > To", "Toll calculator", "Given direction", "Estimated difference", "Status", "DH", "Dispatched mile", "Directed mile", "Extra mile", "Driven mile", "Total Driven Mile", "Driven toll", "Charge"];

  function blank() { return { driver: "", unit: "", loadId: "", date: "", route: "", tollCalc: null, givenDir: null, status: "", dh: null, dispatched: null, directed: null, driven: null, totalDriven: null, drivenToll: null, charge: null }; }
  const money = (n) => (n == null || isNaN(n)) ? "" : "$" + Number(n).toFixed(2);
  const num = (n) => (n == null || isNaN(n)) ? "" : Number(n).toFixed(1);
  const esc = (v) => String(v == null ? "" : v).replace(/"/g, "&quot;");

  function inp(i, f, type, w) { const v = rows[i][f] == null ? "" : rows[i][f]; return `<input data-i="${i}" data-f="${f}" type="${type}" value="${esc(v)}" style="width:${w}px" ${ro ? "disabled" : ""}>`; }
  function statusSel(i, v) {
    const cls = v === "FOLLOWED" ? "ok" : (v === "NOT FOLLOWED" || v === "SKIPPED") ? "no" : "";
    const opt = (o) => `<option value="${o}" ${v === o ? "selected" : ""}>${o || "—"}</option>`;
    return `<select data-i="${i}" data-f="status" class="toll-status ${cls}" ${ro ? "disabled" : ""}>${["", "FOLLOWED", "NOT FOLLOWED", "SKIPPED"].map(opt).join("")}</select>`;
  }

  // Flat row in the exact report column order, with computed est-diff and extra.
  function rowArray(r) {
    const est = (r.tollCalc != null && r.givenDir != null) ? (r.tollCalc - r.givenDir) : "";
    const extra = (r.directed != null && r.dispatched != null) ? (r.directed - r.dispatched) : "";
    return [r.driver, r.unit, r.loadId, r.date, r.route, r.tollCalc, r.givenDir, est, r.status, r.dh, r.dispatched, r.directed, extra, r.driven, r.totalDriven, r.drivenToll, r.charge].map((v) => (v == null ? "" : v));
  }
  function fileBase() { return "Toll " + (curLabel ? curLabel.replace(/[^\w .-]/g, "").trim() : new Date().toISOString().slice(0, 10)); }

  function totals() {
    let charge = 0, est = 0, foll = 0, notf = 0, skip = 0;
    rows.forEach((r) => {
      if (r.charge != null) charge += +r.charge || 0;
      if (r.tollCalc != null && r.givenDir != null) est += (r.tollCalc - r.givenDir);
      if (r.status === "FOLLOWED") foll++; else if (r.status === "NOT FOLLOWED") notf++; else if (r.status === "SKIPPED") skip++;
    });
    const ctx = curId && curId !== "__live" ? `📅 ${curLabel} (saqlangan) · ` : "";
    $("#toll-totals").textContent = `${ctx}${rows.length} qator · ✓ ${foll} followed · ⚠️ ${notf} not followed · ⏭️ ${skip} skipped · Est.diff $${est.toFixed(0)} · Charge $${charge.toFixed(0)}`;
  }

  function render() {
    const tbody = $("#toll-rows");
    tbody.innerHTML = rows.map((r, i) => `<tr>
      <td>${inp(i, "driver", "text", 220)}</td>
      <td>${inp(i, "unit", "text", 64)}</td>
      <td>${inp(i, "loadId", "text", 120)}</td>
      <td>${inp(i, "date", "text", 92)}</td>
      <td>${inp(i, "route", "text", 110)}</td>
      <td>${inp(i, "tollCalc", "number", 64)}</td>
      <td>${inp(i, "givenDir", "number", 64)}</td>
      <td class="toll-auto" data-auto="ed-${i}">${r.tollCalc != null && r.givenDir != null ? money(r.tollCalc - r.givenDir) : ""}</td>
      <td>${statusSel(i, r.status)}</td>
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
    $("#toll-add").disabled = ro; $("#toll-save").disabled = ro;
    totals();
  }

  function onInput(e) {
    const el = e.target, i = +el.dataset.i, f = el.dataset.f;
    let v = el.value;
    if (el.type === "number") v = v === "" ? null : parseFloat(v);
    rows[i][f] = v;
    const r = rows[i];
    if (f === "tollCalc" || f === "givenDir") { const c = document.querySelector(`[data-auto="ed-${i}"]`); if (c) c.textContent = r.tollCalc != null && r.givenDir != null ? money(r.tollCalc - r.givenDir) : ""; }
    if (f === "directed" || f === "dispatched") { const c = document.querySelector(`[data-auto="ex-${i}"]`); if (c) c.textContent = r.directed != null && r.dispatched != null ? num(r.directed - r.dispatched) : ""; }
    if (f === "status") el.className = "toll-status " + (v === "FOLLOWED" ? "ok" : (v === "NOT FOLLOWED" || v === "SKIPPED") ? "no" : "");
    totals();
  }

  async function save(btn) {
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Saqlanmoqda…";
    try {
      const res = await fetch("/api/toll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows }) });
      const j = await res.json();
      btn.textContent = j.ok ? "Saqlandi ✓" : "Xato"; setTimeout(() => (btn.textContent = old), 1500);
    } catch (e) { alert("Xato: " + e.message); btn.textContent = old; }
    btn.disabled = false;
  }

  // --- Excel / PDF export (exact report columns) ---
  function exportExcel() {
    const aoa = [HEADERS, ...rows.map(rowArray)];
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
      head: [HEADERS], body: rows.map(rowArray), startY: 40,
      styles: { fontSize: 5.5, cellPadding: 2, overflow: "linebreak" },
      headStyles: { fillColor: [27, 58, 99], textColor: 255, fontSize: 6 },
      theme: "grid", margin: { left: 16, right: 16 },
    });
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
      if (r && Array.isArray(r.rows)) { rows = r.rows; curId = id; curLabel = r.label || ""; ro = true; render(); }
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
    }
    curId = "__live"; ro = false; curLabel = "";
    try { rows = await (await fetch("/api/toll")).json(); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    render();
    loadHistory();
  };
})();

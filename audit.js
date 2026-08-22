// Weekly fuel-card report -> which lines don't match the tank.
//
// The file is read here in the browser (SheetJS is already loaded for the price
// report) and only the parsed purchases are sent up, so nothing but unit, time,
// gallons and station leaves the page.
//
// Columns are found by their headings rather than by position: the export puts
// them in a fixed order today, but a heading is a much safer thing to rely on
// than "column 15".
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let wired = false, last = { rows: [], summary: null, history: null };

  const { parseSheet } = (typeof ReportParse !== "undefined" ? ReportParse : {});

  const VERDICT = {
    suspicious: { cls: "bad", label: "⚠ Shubhali" },
    unpaid: { cls: "warn", label: "◆ Kvitansiyasiz" },
    check: { cls: "warn", label: "? Tekshiring" },
    unknown: { cls: "dim", label: "— Ma'lumot yo'q" },
    ok: { cls: "ok", label: "✓ To'g'ri" },
  };

  function render(rows, summary, history) {
    const tbody = $("#audit-rows");
    const show = $("#audit-only-bad").checked
      ? rows.filter((r) => r.verdict === "suspicious" || r.verdict === "unpaid")
      : rows;
    $("#audit-empty").classList.toggle("hidden", show.length > 0);
    tbody.innerHTML = show.map((r) => {
      const v = VERDICT[r.verdict] || VERDICT.unknown;
      const when = String(r.localAt || r.at).replace("T", " ").slice(0, 16);
      const map = r.lat != null ? `<a href="https://www.google.com/maps?q=${r.lat},${r.lon}" target="_blank" rel="noopener">📍</a>` : "";
      return `<tr class="audit-${v.cls}">
        <td><span class="audit-chip ${v.cls}">${v.label}</span></td>
        <td>${esc(r.unit)}</td>
        <td>${esc(when)}</td>
        <td class="num">${r.gallons == null ? "—" : r.gallons}</td>
        <td class="num">${r.rise == null ? "—" : "+" + r.rise + "%"}</td>
        <td class="num">${r.impliedGal == null ? "—" : r.impliedGal}</td>
        <td class="num">${r.baselineGal == null ? "—" : r.baselineGal}</td>
        <td class="num">${r.missingGal == null ? "" : r.missingGal}</td>
        <td class="num">${r.stationMi == null ? "—" : r.stationMi}</td>
        <td>${esc(r.station)} ${map}</td>
        <td class="audit-why">${esc(r.reason)}</td>
      </tr>`;
    }).join("");

    const s = summary;
    $("#audit-sum").innerHTML =
      `<b>${s.lines}</b> qator · <b class="bad">${s.suspicious}</b> shubhali · ` +
      `<b>${s.unpaid}</b> kvitansiyasiz · <b>${s.check}</b> tekshirish kerak · <b>${s.ok}</b> to'g'ri` +
      (s.missingGal ? ` · <b class="bad">${s.missingGal} gal</b> hisobga tushmagan` : "") +
      (s.tzHours ? ` · vaqt farqi ${s.tzHours > 0 ? "+" : ""}${s.tzHours} soat` : "") +
      (s.locChecked ? ` · joylashuv tekshirildi: ${s.locChecked}${s.locFar ? `, mos kelmadi ${s.locFar}` : ""}` : "") +
      (s.locPending ? ` · ${s.locPending} zapravka keyingi safar aniqlanadi` : "") +
      (s.ignoredLines ? ` · ${s.ignoredLines} qator chetlab o'tildi` : "");

    // A wall of "no data" is the expected answer until the fills pile up; say
    // so plainly instead of letting it read as a broken page.
    const note = $("#audit-note");
    if (s.unknown > s.lines / 2) {
      const since = history && history.since ? new Date(history.since).toLocaleDateString() : "—";
      note.textContent = `Ko'p qator tekshirilmadi: quyish tarixi ${since} dan boshlangan va hozircha ${history ? history.fills : 0} ta yozuv bor. ` +
        `Har bir unit uchun kamida 2 ta oldingi quyish kerak — bir haftadan keyin to'liq ishlaydi.`;
      note.classList.remove("hidden");
    } else note.classList.add("hidden");
  }


  // Exporting matters more than it looks: acting on a flagged line means taking
  // it to whoever handles the driver, and that cannot be a screenshot.
  function asRows() {
    const head = ["Xulosa", "Unit", "Driver", "Vaqt", "Gallon", "Bak %", "Bak taxmini", "Odatda", "Farq", "Masofa mi", "Zapravka", "Shahar", "Sabab"];
    const body = (last.rows || []).map((r) => [
      (VERDICT[r.verdict] || {}).label || r.verdict,
      r.unit, r.driver || "", String(r.localAt || r.at).replace("T", " ").slice(0, 16),
      r.gallons == null ? "" : r.gallons,
      r.rise == null ? "" : r.rise,
      r.impliedGal == null ? "" : r.impliedGal,
      r.baselineGal == null ? "" : r.baselineGal,
      r.missingGal == null ? "" : r.missingGal,
      r.stationMi == null ? "" : r.stationMi,
      r.station || "", [r.city, r.st].filter(Boolean).join(", "), r.reason || "",
    ]);
    return [head, ...body];
  }

  async function copyTable(btn) {
    const text = asRows().map((r) => r.join("\t")).join("\n");
    try { await navigator.clipboard.writeText(text); }
    catch { return; }
    const old = btn.textContent;
    btn.textContent = "✓ Olindi";
    setTimeout(() => (btn.textContent = old), 1500);
  }

  function downloadCsv() {
    const csv = asRows()
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    // Excel opens a CSV as ASCII unless the byte-order mark says otherwise, and
    // then every Uzbek word in it is mangled.
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `fuel-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function loadIgnore() {
    try {
      const j = await (await fetch("/api/audit-ignore")).json();
      $("#audit-ignore").value = (j.units || []).join(", ");
    } catch { /* the box just stays empty */ }
  }

  async function saveIgnore(btn) {
    const units = $("#audit-ignore").value.split(/[,\s]+/).filter(Boolean);
    btn.disabled = true;
    try {
      const j = await (await fetch("/api/audit-ignore", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ units }),
      })).json();
      $("#audit-ignore").value = (j.units || []).join(", ");
      $("#audit-ignore-state").textContent = `${(j.units || []).length} ta unit chetlab o'tiladi`;
      $("#audit-ignore-state").className = "dir-draft-state";
    } catch (e) {
      $("#audit-ignore-state").textContent = "saqlanmadi: " + e.message;
      $("#audit-ignore-state").className = "dir-draft-state bad";
    } finally { btn.disabled = false; }
  }

  async function handleFile(file) {
    const state = $("#audit-state");
    state.textContent = "O'qilmoqda…"; state.className = "dir-draft-state";
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
      const { txns, skipped, skippedByItem, reason } = parseSheet(rows);
      if (!txns.length) {
        state.textContent = reason || "yoqilg'i xaridlari topilmadi";
        state.className = "dir-draft-state bad";
        return;
      }
      state.textContent = `${txns.length} ta yoqilg'i xaridi o'qildi (${skipped} qator o'tkazib yuborildi: DEF, scale va h.k.) — tekshirilmoqda…`;
      const res = await fetch("/api/fuel-audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txns }),
      });
      const j = await res.json();
      if (!j.ok) { state.textContent = j.error || "tekshirib bo'lmadi"; state.className = "dir-draft-state bad"; return; }
      last = { rows: j.rows, summary: j.summary, history: j.history };
      $("#audit-result").hidden = false;
      $("#audit-copy").hidden = false;
      $("#audit-csv").hidden = false;
      render(j.rows, j.summary, j.history);
      // Spell out what was left out. "58 rows skipped" hides the one question
      // worth asking of an unfamiliar export: was any of it actually fuel?
      const breakdown = Object.entries(skippedByItem || {})
        .sort((x, y) => y[1] - x[1])
        .map(([code, n]) => `${code} ${n}`)
        .join(", ");
      state.textContent = `${file.name} · ${txns.length} xarid o'qildi` +
        (skipped ? ` · yoqilg'i deb hisoblanmadi: ${breakdown}` : "");
    } catch (e) {
      state.textContent = "Xato: " + e.message;
      state.className = "dir-draft-state bad";
    }
  }

  window.initAudit = function () {
    if (wired || !$("#audit-file")) return;
    wired = true;
    $("#audit-btn").addEventListener("click", () => $("#audit-file").click());
    $("#audit-file").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
    $("#audit-only-bad").addEventListener("change", () => {
      if (last.rows.length) render(last.rows, last.summary, last.history);
    });
    $("#audit-copy").addEventListener("click", (e) => copyTable(e.currentTarget));
    $("#audit-csv").addEventListener("click", downloadCsv);
    $("#audit-ignore-save").addEventListener("click", (e) => saveIgnore(e.currentTarget));
    loadIgnore();
  };
})();

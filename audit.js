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
        <td>${esc(r.station)} ${map}</td>
        <td class="audit-why">${esc(r.reason)}</td>
      </tr>`;
    }).join("");

    const s = summary;
    $("#audit-sum").innerHTML =
      `<b>${s.lines}</b> qator · <b class="bad">${s.suspicious}</b> shubhali · ` +
      `<b>${s.unpaid}</b> kvitansiyasiz · <b>${s.check}</b> tekshirish kerak · <b>${s.ok}</b> to'g'ri` +
      (s.missingGal ? ` · <b class="bad">${s.missingGal} gal</b> hisobga tushmagan` : "") +
      (s.tzHours ? ` · vaqt farqi ${s.tzHours > 0 ? "+" : ""}${s.tzHours} soat` : "");

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

  async function handleFile(file) {
    const state = $("#audit-state");
    state.textContent = "O'qilmoqda…"; state.className = "dir-draft-state";
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
      const { txns, skipped, reason } = parseSheet(rows);
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
      render(j.rows, j.summary, j.history);
      state.textContent = `${file.name} · ${txns.length} xarid · ${skipped} qator yoqilg'i emas`;
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
  };
})();

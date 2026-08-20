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

  // Diesel only. DEF goes in its own tank and scale tickets are not fuel at
  // all — counting either would flag every truck that bought them.
  const FUEL_ITEMS = new Set(["ULSD", "DSL", "DIESEL", "LSD", "BIO", "B20"]);

  const HEADERS = {
    unit: ["unit", "unit #", "unit no", "vehicle", "truck"],
    date: ["tran date", "transaction date", "date"],
    time: ["tran time", "transaction time", "time"],
    gallons: ["qty", "quantity", "gallons", "gal", "units"],
    item: ["item", "product", "fuel type", "type"],
    station: ["location name", "location", "merchant", "site name"],
    city: ["city"],
    state: ["state/ prov", "state/prov", "state", "st"],
    driver: ["driver name", "driver"],
    invoice: ["invoice", "invoice #", "ticket"],
  };

  function findColumns(headerRow) {
    const norm = headerRow.map((h) => String(h == null ? "" : h).trim().toLowerCase().replace(/\s+/g, " "));
    const col = {};
    for (const key of Object.keys(HEADERS)) {
      for (const want of HEADERS[key]) {
        const i = norm.indexOf(want);
        if (i >= 0) { col[key] = i; break; }
      }
    }
    return col;
  }

  // "0008" and "010" are the same trucks the board calls 8 and 10.
  function normUnit(v) {
    const s = String(v == null ? "" : v).trim().replace(/^#/, "");
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? String(n) : s;
  }

  // "2026-08-15" + "08:51" in the station's local time; the server works out
  // the offset from the fills themselves.
  function toISO(date, time) {
    const d = String(date == null ? "" : date).trim();
    const t = String(time == null ? "" : time).trim() || "12:00";
    const md = d.match(/^(\d{4})-(\d{2})-(\d{2})/) || d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!md) return null;
    const [y, mo, da] = d.includes("/") ? [md[3], md[1], md[2]] : [md[1], md[2], md[3]];
    const mt = t.match(/^(\d{1,2}):(\d{2})/);
    const hh = mt ? mt[1] : "12", mm = mt ? mt[2] : "00";
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${mm}:00Z`;
    return Number.isFinite(Date.parse(iso)) ? iso : null;
  }

  function parseSheet(rows) {
    if (!rows.length) return { txns: [], skipped: 0, reason: "fayl bo'sh" };
    // The header is not always the first row — some exports put a title above.
    let headerAt = 0, col = findColumns(rows[0]);
    for (let i = 0; i < Math.min(rows.length, 10) && (col.unit == null || col.gallons == null); i++) {
      const c = findColumns(rows[i]);
      if (c.unit != null && c.gallons != null) { col = c; headerAt = i; break; }
    }
    if (col.unit == null || col.gallons == null || col.date == null) {
      return { txns: [], skipped: 0, reason: "ustunlar topilmadi (Unit, Tran Date, Qty kerak)" };
    }

    const txns = [];
    let skipped = 0;
    for (let i = headerAt + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;
      const item = String(col.item != null ? r[col.item] : "ULSD").trim().toUpperCase();
      if (col.item != null && !FUEL_ITEMS.has(item)) { skipped++; continue; }
      const gallons = Number(r[col.gallons]);
      const unit = normUnit(r[col.unit]);
      const at = toISO(r[col.date], col.time != null ? r[col.time] : "");
      if (!unit || !at || !(gallons > 0)) { skipped++; continue; }
      txns.push({
        unit, at, gallons: Math.round(gallons * 10) / 10,
        station: String(col.station != null ? r[col.station] || "" : "").trim(),
        city: String(col.city != null ? r[col.city] || "" : "").trim(),
        st: String(col.state != null ? r[col.state] || "" : "").trim(),
        driver: String(col.driver != null ? r[col.driver] || "" : "").trim(),
        invoice: String(col.invoice != null ? r[col.invoice] || "" : "").trim(),
      });
    }
    return { txns, skipped, reason: "" };
  }

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

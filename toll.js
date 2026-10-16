// Toll report -> which unit was carrying the transponder.
//
// The file is read here in the browser, the same way the fuel-card report is,
// and only the parsed crossings are sent up: agency, plaza, time, toll. The
// server has the fleet's history and does the matching.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let wired = false, last = { rows: [], devices: [], summary: null };

  const { parseSheet } = (typeof TollParse !== "undefined" ? TollParse : {});

  const VERDICT = {
    hisobotdan: { cls: "ok", label: "✓ Hisobotning o'zidan" },
    ziddiyat: { cls: "bad", label: "⚠ Ziddiyat" },
    "bir nechta unit": { cls: "warn", label: "◆ Bir nechta unit" },
    ishonchli: { cls: "ok", label: "✓ Ishonchli" },
    ehtimol: { cls: "warn", label: "≈ Ehtimol" },
    "aniq emas": { cls: "warn", label: "? Aniq emas" },
    "ma'lumot kam": { cls: "dim", label: "— Ma'lumot kam" },
    topilmadi: { cls: "bad", label: "✗ Topilmadi" },
  };

  const when = (iso) => String(iso || "").replace("T", " ").slice(0, 16);

  function render() {
    const devs = last.devices || [];
    // The transponder is the answer, so it goes first and large: one line per
    // device saying whose truck it is and on what evidence.
    $("#toll-devices").innerHTML = devs.map((d) => {
      const v = VERDICT[d.verdict] || VERDICT.topilmadi;
      const rivals = (d.candidates || []).slice(1, 3)
        .map((c) => `${esc(c.unit)} (${c.hit}/${c.hit + c.miss})`).join(", ");
      return `<div class="toll-dev">
        <div class="toll-dev-id">
          <b>${esc(d.device)}</b>
          <span class="toll-dim">${d.rows} o'tish · ${when(d.from)} — ${when(d.to)}</span>
        </div>
        <div class="toll-dev-ans">
          <span class="audit-chip ${v.cls}">${v.label}</span>
          ${d.unit ? `<b class="toll-unit">Unit ${esc(d.unit)}</b> <span>${esc(d.driver || "")}</span>` : `<span class="toll-dim">unit aniqlanmadi</span>`}
          ${d.conflict ? `<span class="toll-dim">Motive tarixi <b>${esc(d.conflict)}</b> ni ko'rsatadi — transponder boshqa truckda bo'lishi mumkin</span>` : ""}
          <span class="toll-dim">${d.hit}/${d.usable} o'tishda mos (${d.rate}%)</span>
          ${rivals ? `<span class="toll-dim">boshqa nomzodlar: ${rivals}</span>` : ""}
          ${d.given && d.given.length ? `<span class="toll-dim">hisobotda yozilgan: ${d.given.map(esc).join(", ")}</span>` : ""}
        </div>
      </div>`;
    }).join("") || `<div class="empty">Qurilma topilmadi</div>`;

    const rows = $("#toll-only-bad").checked
      ? (last.rows || []).filter((r) => !r.decided)
      : (last.rows || []);
    $("#toll-empty").classList.toggle("hidden", rows.length > 0);
    $("#toll-rows").innerHTML = rows.map((r) => {
      const cands = (r.candidates || []).map((c) =>
        `${esc(c.unit)}${c.mi == null ? "" : ` ${c.mi}mi`}${c.st ? ` ${esc(c.st)}` : ""}`).join(" · ");
      return `<tr class="${r.decided ? "" : "audit-warn"}">
        <td>${esc(when(r.at))}${r.exact ? "" : ` <span class="toll-dim">(vaqt taxminiy)</span>`}</td>
        <td>${esc(r.agency)}</td>
        <td>${esc(r.plaza)}${r.plazaKnown ? "" : ` <span class="toll-dim">?</span>`}</td>
        <td class="num">${r.toll == null ? "—" : "$" + r.toll.toFixed(2)}</td>
        <td>${r.unit ? `<b>${esc(r.unit)}</b>` : "—"}</td>
        <td>${esc(r.driver || "")}</td>
        <td class="audit-why">${cands || "hech kim mos kelmadi"}</td>
      </tr>`;
    }).join("");

    const s = last.summary || {};
    $("#toll-sum").innerHTML =
      `<b>${s.tolls || 0}</b> o'tish · <b>${s.devices || 0}</b> transponder · ` +
      `<b class="ok">${s.named || 0}</b> si unitga biriktirildi · ` +
      `${s.trucks || 0} truck tarixi (<b>${s.points || 0}</b> nuqta)` +
      (s.plazasLearned ? ` · ${s.plazasLearned} yangi plaza joyi topildi` : "") +
      (s.plazasMissed ? ` · ${s.plazasMissed} plaza joyi topilmadi (shtat bo'yicha solishtirildi)` : "") +
      (s.plazasPending ? ` · ${s.plazasPending} plaza keyingi yuklashda aniqlanadi` : "") +
      (s.saved ? ` · ${s.saved} qurilma eslab qolindi` : "");

    // No trail means nothing to compare against, and the usual cause is the
    // API key rather than the report — say which, or the page looks broken.
    const note = $("#toll-note");
    if (!s.points) {
      note.textContent = "Motive joylashuv tarixi bo'sh keldi — API kalitida tarix ruxsati (vehicle location history) yo'q bo'lishi mumkin." +
        (s.trackErrors && s.trackErrors.length ? " Javob: " + s.trackErrors.join("; ") : "");
      note.classList.remove("hidden");
    } else note.classList.add("hidden");
  }

  function asRows() {
    const head = ["Vaqt", "Agentlik", "Plaza", "Toll", "Unit", "Driver", "Transponder", "Nomzodlar"];
    const body = (last.rows || []).map((r) => [
      when(r.at), r.agency, r.plaza, r.toll == null ? "" : r.toll,
      r.unit || "", r.driver || "", r.device || "",
      (r.candidates || []).map((c) => `${c.unit}${c.mi == null ? "" : ` ${c.mi}mi`}`).join(" | "),
    ]);
    return [head, ...body];
  }

  function downloadCsv() {
    const csv = asRows()
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `toll-match-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  async function handleFile(file) {
    const state = $("#toll-state");
    state.textContent = "O'qilmoqda…"; state.className = "dir-draft-state";
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
      const { tolls, skipped, devices, reason } = parseSheet(rows);
      if (!tolls.length) {
        state.textContent = reason || "toll qatorlari topilmadi";
        state.className = "dir-draft-state bad";
        return;
      }
      state.textContent = `${tolls.length} o'tish o'qildi · ${devices.length} transponder — Motive tarixi so'ralmoqda…`;
      const res = await fetch("/api/toll-match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tolls }),
      });
      const j = await res.json();
      if (!j.ok) { state.textContent = j.error || "aniqlab bo'lmadi"; state.className = "dir-draft-state bad"; return; }
      last = { rows: j.rows, devices: j.devices, summary: j.summary };
      $("#toll-result").hidden = false;
      $("#toll-csv").hidden = false;
      render();
      state.textContent = `${file.name} · ${tolls.length} o'tish` + (skipped ? ` · ${skipped} qator vaqtsiz` : "");
    } catch (e) {
      state.textContent = "Xato: " + e.message;
      state.className = "dir-draft-state bad";
    }
  }

  window.initToll = function () {
    if (wired || !$("#toll-file")) return;
    wired = true;
    $("#toll-btn").addEventListener("click", () => $("#toll-file").click());
    $("#toll-file").addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
    $("#toll-only-bad").addEventListener("change", () => { if (last.rows.length) render(); });
    $("#toll-csv").addEventListener("click", downloadCsv);
  };
})();

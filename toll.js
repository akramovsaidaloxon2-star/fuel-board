(function () {
  const $ = (s) => document.querySelector(s);
  let rows = [], wired = false;
  function blank() { return { driver: "", unit: "", loadId: "", date: "", route: "", tollCalc: null, givenDir: null, status: "", dh: null, dispatched: null, directed: null, driven: null, totalDriven: null, drivenToll: null, charge: null }; }
  const money = (n) => (n == null || isNaN(n)) ? "" : "$" + Number(n).toFixed(2);
  const num = (n) => (n == null || isNaN(n)) ? "" : Number(n).toFixed(1);
  const esc = (v) => String(v).replace(/"/g, "&quot;");

  function inp(i, f, type, w) { const v = rows[i][f] == null ? "" : rows[i][f]; return `<input data-i="${i}" data-f="${f}" type="${type}" value="${esc(v)}" style="width:${w}px">`; }
  function statusSel(i, v) {
    return `<select data-i="${i}" data-f="status" class="toll-status ${v === 'FOLLOWED' ? 'ok' : v === 'NOT FOLLOWED' ? 'no' : ''}">
      <option value="" ${!v ? "selected" : ""}>—</option>
      <option value="FOLLOWED" ${v === 'FOLLOWED' ? "selected" : ""}>FOLLOWED</option>
      <option value="NOT FOLLOWED" ${v === 'NOT FOLLOWED' ? "selected" : ""}>NOT FOLLOWED</option>
    </select>`;
  }

  function totals() {
    let charge = 0, est = 0, foll = 0, notf = 0;
    rows.forEach((r) => {
      if (r.charge != null) charge += +r.charge || 0;
      if (r.tollCalc != null && r.givenDir != null) est += (r.tollCalc - r.givenDir);
      if (r.status === "FOLLOWED") foll++; else if (r.status === "NOT FOLLOWED") notf++;
    });
    $("#toll-totals").textContent = `${rows.length} qator · ✓ ${foll} followed · ⚠️ ${notf} not followed · Est.diff $${est.toFixed(0)} · Charge $${charge.toFixed(0)}`;
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
      <td><button class="btn toll-del" data-del="${i}" title="O'chirish">✕</button></td>
    </tr>`).join("");
    tbody.querySelectorAll("input").forEach((el) => el.addEventListener("input", onInput));
    tbody.querySelectorAll("select").forEach((el) => el.addEventListener("change", onInput));
    tbody.querySelectorAll(".toll-del").forEach((b) => b.addEventListener("click", () => { rows.splice(+b.dataset.del, 1); render(); }));
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
    if (f === "status") el.className = "toll-status " + (v === "FOLLOWED" ? "ok" : v === "NOT FOLLOWED" ? "no" : "");
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

  window.initToll = async function () {
    if (!wired) {
      wired = true;
      $("#toll-add").addEventListener("click", () => { rows.push(blank()); render(); const t = $("#toll-table"); t.scrollIntoView({ block: "end", behavior: "smooth" }); });
      $("#toll-save").addEventListener("click", (e) => save(e.currentTarget));
    }
    try { rows = await (await fetch("/api/toll")).json(); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    render();
  };
})();

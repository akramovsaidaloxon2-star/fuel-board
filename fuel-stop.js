(function () {
  const $ = (s) => document.querySelector(s);
  let wired = false, unitsLoaded = false;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function loadUnits() {
    try {
      const j = await (await fetch("/api/fuel")).json();
      const units = (j.fleet || []).map((r) => r.unit).filter(Boolean);
      $("#fs-units").innerHTML = units.map((u) => `<option value="${esc(u)}">`).join("");
    } catch {}
  }
  async function loadCount() {
    try {
      const j = await (await fetch("/api/fuel-stop?list=1")).json();
      if (j.ok) $("#fs-count").textContent = j.count + " Pilot stansiya bazada";
    } catch {}
  }

  async function go() {
    const unit = $("#fs-unit").value.trim();
    const station = $("#fs-station").value.trim();
    const out = $("#fs-result");
    if (!unit || !station) { out.innerHTML = '<p class="fs-msg warn">Unit va Pilot raqamini kiriting.</p>'; return; }
    out.innerHTML = '<p class="fs-msg">Hisoblanmoqda…</p>';
    try {
      const r = await fetch(`/api/fuel-stop?unit=${encodeURIComponent(unit)}&station=${encodeURIComponent(station)}`);
      const j = await r.json();
      if (!j.ok) { out.innerHTML = `<p class="fs-msg warn">${esc(j.error)}</p>`; return; }
      render(j, out);
    } catch (e) { out.innerHTML = `<p class="fs-msg warn">Xato: ${esc(e.message)}</p>`; }
  }

  function render(j, out) {
    const eta = j.etaMin != null ? `${Math.floor(j.etaMin / 60)}s ${j.etaMin % 60}m` : "—";
    const src = j.source === "road" ? "yo‘l masofasi" : "to‘g‘ri chiziq (taxminiy)";
    const enough = j.enough === true ? '<span class="fs-badge ok">✅ Yetadi</span>'
      : j.enough === false ? '<span class="fs-badge no">⚠️ Yetmasligi mumkin</span>'
      : '<span class="fs-badge">—</span>';
    const s = j.station, t = j.truck;
    out.innerHTML = `
      <div class="fs-card">
        <div class="fs-miles"><span class="fs-big">${j.miles}</span> mil <span class="fs-src">(${src})</span> &nbsp;·&nbsp; ⏱ <b>${eta}</b></div>
        <div class="fs-grid">
          <div><span>Stansiya</span><b>${esc(s.brand)} #${esc(s.num)}</b><small>${esc(s.addr)}, ${esc(s.city)}, ${esc(s.st)}</small></div>
          <div><span>Truck</span><b>Unit ${esc(t.unit)}${t.driver ? " · " + esc(t.driver) : ""}</b><small>${esc(t.location)}</small></div>
          <div><span>Hozirgi yoqilg‘i</span><b>${t.fuel != null ? t.fuel + "%" : "—"}</b><small>${t.gallonsRemaining != null ? "~" + t.gallonsRemaining + " gal · " + t.tankGal + " gal bak" : ""}</small></div>
          <div><span>Yetib boradigan masofa</span><b>${t.rangeMiles != null ? t.rangeMiles + " mil" : "—"}</b><small>${t.mpg ? t.mpg + " MPG" : "MPG yo‘q"}</small></div>
          <div><span>Stansiyagacha kerak</span><b>${j.fuelNeeded != null ? j.fuelNeeded + " gal" : "—"}</b><small>${j.miles} mil ÷ MPG</small></div>
          <div><span>Yetadimi?</span>${enough}</div>
        </div>
        <a class="fs-link" href="https://www.google.com/maps/dir/${t.lat},${t.lon}/${s.lat},${s.lon}" target="_blank" rel="noopener">🗺️ Google Maps'da yo‘nalish</a>
      </div>`;
  }

  window.initFuelStop = function () {
    if (!wired) {
      wired = true;
      $("#fs-go").addEventListener("click", go);
      $("#fs-station").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      $("#fs-unit").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#fs-station").focus(); });
      loadCount();
    }
    if (!unitsLoaded) { unitsLoaded = true; loadUnits(); }
  };
})();

(function () {
  const $ = (s) => document.querySelector(s);
  let wired = false;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function check(btn) {
    const link = $("#rc-link").value.trim();
    const from = $("#rc-from").value.trim(), to = $("#rc-to").value.trim(), via = $("#rc-via").value.trim();
    let body;
    if (link) body = { link };
    else if (from && to) body = { from, to, via: via || undefined };
    else { $("#rc-result").innerHTML = '<p class="fs-msg warn">Google link, yoki From va To kiriting.</p>'; return; }
    const out = $("#rc-result"); out.innerHTML = '<p class="fs-msg">Tekshirilmoqda… (truck vs mashina yo‘li)</p>';
    btn.disabled = true;
    try {
      const r = await fetch("/api/route-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) { out.innerHTML = `<p class="fs-msg warn">${esc(j.error)}</p>`; btn.disabled = false; return; }
      render(j, out);
    } catch (e) { out.innerHTML = `<p class="fs-msg warn">Xato: ${esc(e.message)}</p>`; }
    btn.disabled = false;
  }

  function render(j, out) {
    const verdict = j.restricted === true ? `<div class="rc-verdict bad">⚠️ Truck cheklovi bor</div>`
      : j.restricted === false ? `<div class="rc-verdict ok">✅ Truck uchun ochiq</div>`
      : `<div class="rc-verdict">— aniqlanmadi</div>`;
    const explain = j.restricted === true
      ? `Truck yo'li mashina yo'lidan <b>${j.extraMiles} mil</b> uzun — demak to'g'ri yo'lda parkway / past ko'prik / truck-taqiq bor, truck aylanib o'tishga majbur.${j.warnings && j.warnings.length ? " (" + esc(j.warnings.join("; ")) + ")" : ""}`
      : j.restricted === false ? `Truck yo'li mashina yo'li bilan deyarli bir xil — sezilarli cheklov yo'q.`
      : `Yetarli ma'lumot yo'q (bir yo'l topilmadi).`;
    out.innerHTML = `
      <div class="rc-card">
        ${verdict}
        <div class="rc-grid">
          <div><span>Yo'nalish</span><b>${esc(j.from)}</b><small>→ ${esc(j.to)}</small></div>
          <div><span>Mashina yo'li</span><b>${j.carMiles != null ? j.carMiles + " mi" : "—"}</b></div>
          <div><span>Truck yo'li</span><b>${j.truckMiles != null ? j.truckMiles + " mi" : "—"}</b></div>
          <div><span>Farq</span><b>${j.extraMiles != null ? (j.extraMiles > 0 ? "+" : "") + j.extraMiles + " mi" : "—"}</b><small>truck aylanishi</small></div>
        </div>
        <p class="rc-note">${explain}</p>
        ${j.truckRouteUrl ? `<a class="rc-link" href="${j.truckRouteUrl}" target="_blank" rel="noopener">🗺️ Truck yo'lini Google Maps'da ochish (driverga yuborish)</a>` : ""}
        <p class="rc-note dim">⚠️ OSM ma'lumoti asosida — asosiy cheklovlarni tutadi, lekin 100% kafolat emas. Shubhali bo'lsa Truck Path bilan tasdiqlang.</p>
      </div>`;
  }

  window.initRouteCheck = function () {
    if (wired) return; wired = true;
    $("#rc-go").addEventListener("click", (e) => check(e.currentTarget));
    ["rc-link", "rc-to"].forEach((id) => $("#" + id).addEventListener("keydown", (e) => { if (e.key === "Enter") check($("#rc-go")); }));
  };
})();

// Toll directions — intake from the dispatch Google Sheet + "confirm or be nagged".
//
// The toll points on the Fuel board remind by PLACE (truck is 20 miles out).
// This reminds by ANSWER: a direction stays pending until somebody confirms it.
// Two pieces live here:
//   1. The Directions tab (list, confirm, manual add, sheet sync).
//   2. A global watcher that polls from EVERY tab, so an unconfirmed direction
//      shows a banner + tab badge + sound wherever the user happens to be.
// Telegram is handled server-side; the browser only has to be loud on screen.
//
// Everything here is inert unless the signed-in seat is "ops" — app.js strips
// the markup for other roles and the API answers 403.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let rows = [], cfg = { everyMin: 30, telegram: false, sheet: {} }, wired = false, showDone = false;
  let lastPendingIds = [], muted = localStorage.getItem("dirMuted") === "1", forbidden = false;

  // --- Alert sound: two short beeps via WebAudio, so there's no asset to ship ---
  let audioCtx = null;
  function beep() {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      [0, 0.28].forEach((delay) => {
        const t = audioCtx.currentTime + delay;
        const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(t); osc.stop(t + 0.24);
      });
    } catch { /* autoplay blocked until the user clicks once — banner still shows */ }
  }

  const waitTxt = (m) => (m < 60 ? m + " daq" : Math.floor(m / 60) + " soat " + (m % 60) + " daq");
  const nameOf = (d) => [d.driver, d.unit && "Unit " + d.unit, d.loadId && "Load " + d.loadId].filter(Boolean).join(" · ") || "(nomsiz)";

  // --- Global banner + tab badge (runs on every tab, not just Directions) ---
  function paintAlerts(pending) {
    const badge = $("#dir-badge"), banner = $("#dir-banner");
    const n = pending.length;
    if (badge) { badge.textContent = n; badge.classList.toggle("hidden", n === 0); }
    if (!banner) return;
    banner.classList.toggle("hidden", n === 0);
    if (!n) { document.title = "MOVEX · Fuel Board"; return; }
    const worst = pending[0];
    $("#dir-banner-title").textContent = `${n} ta direction hali tasdiqlanmagan`;
    $("#dir-banner-sub").textContent = `${nameOf(worst)} — ${waitTxt(worst.waitMin)} kutmoqda · har ${cfg.everyMin} daqiqada eslatiladi`;
    document.title = `(${n}) MOVEX · Fuel Board`;
  }

  async function pollAlerts() {
    if (forbidden) return;
    try {
      const res = await fetch("/api/directions/alerts");
      if (res.status === 403 || res.status === 401) { forbidden = true; return; }   // not the ops seat
      const j = await res.json();
      cfg.everyMin = j.everyMin || cfg.everyMin;
      cfg.telegram = !!j.telegram;
      cfg.sheet = j.sheet || {};
      const pending = j.pending || [];
      // Alert only for directions we haven't already seen pending — not every poll.
      const ids = pending.map((p) => p.id);
      const fresh = ids.filter((id) => !lastPendingIds.includes(id));
      if (fresh.length) { beep(); notify(pending, fresh.length); }
      lastPendingIds = ids;
      paintAlerts(pending);
    } catch { /* offline — try again next tick */ }
  }

  function notify(pending, n) {
    try {
      if (!window.Notification || Notification.permission !== "granted") return;
      new Notification(`${n} ta yangi toll direction`, { body: nameOf(pending[0]) + " — tasdiqlanishi kerak", tag: "movex-dir" });
    } catch {}
  }

  // --- The Directions tab ---
  function statusChip(d) {
    if (d.status === "confirmed") return `<span class="dir-chip ok">✓ Confirmed</span>`;
    if (d.status === "cancelled") return `<span class="dir-chip off">✕ Bekor</span>`;
    return `<span class="dir-chip pend">⏳ Kutilmoqda</span>`;
  }

  function render() {
    const tbody = $("#dir-rows");
    if (!tbody) return;
    const list = showDone ? rows : rows.filter((d) => d.status === "pending");
    $("#dir-empty").classList.toggle("hidden", list.length > 0);
    $("#dir-count").textContent = rows.filter((d) => d.status === "pending").length;

    tbody.innerHTML = list.map((d) => `<tr class="${d.status === "pending" ? "dir-pending" : ""}">
      <td>${statusChip(d)}</td>
      <td>${esc(d.driver)}</td>
      <td>${esc(d.unit)}</td>
      <td>${esc(d.loadId)}</td>
      <td>${esc(d.route)}</td>
      <td>${esc(d.pu)}</td>
      <td>${esc(d.puTime)}</td>
      <td class="dir-dir" title="${esc(d.direction)}">${esc(d.direction)}</td>
      <td>${d.status === "pending" ? waitTxt(d.waitMin || 0) : ""}</td>
      <td>${d.status === "pending" ? (d.remindCount || 0) + "×" : ""}</td>
      <td class="dir-acts">
        ${d.status === "pending"
          ? `<button class="btn sm ok" data-ok="${d.id}">✓ Confirm</button>
             <button class="btn sm" data-cancel="${d.id}" title="Bekor qilindi">✕</button>`
          : `<button class="btn sm" data-reopen="${d.id}" title="Qayta ochish (eslatma yana yoqiladi)">↺</button>`}
        <button class="btn sm" data-del="${d.id}" title="O'chirish">🗑</button>
      </td>
    </tr>`).join("");

    tbody.querySelectorAll("[data-ok]").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.ok, "confirmed")));
    tbody.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.cancel, "cancelled")));
    tbody.querySelectorAll("[data-reopen]").forEach((b) => b.addEventListener("click", () => setStatus(b.dataset.reopen, "pending")));
    tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => del(b.dataset.del)));

    const s = cfg.sheet || {};
    const sheetTxt = !s.url ? "Sheet ulanmagan"
      : s.ok === true ? `Sheet ✓ ${s.rows || 0} qator`
      : s.ok === false ? `Sheet ✗ ${s.error || "xato"}` : "Sheet…";
    $("#dir-state").textContent = `${sheetTxt} · Telegram ${cfg.telegram ? "✓" : "✗"} · har ${cfg.everyMin} daq eslatadi`;
    $("#dir-state").className = "dir-state" + (s.ok === false ? " bad" : "");
  }

  async function load() {
    try {
      const res = await fetch("/api/directions");
      if (res.status === 403 || res.status === 401) { forbidden = true; return; }
      const j = await res.json();
      rows = j.rows || [];
      cfg = { everyMin: j.everyMin || 30, telegram: !!j.telegram, sheet: j.sheet || {} };
      render();
    } catch {}
  }

  async function setStatus(id, status) {
    try {
      await fetch("/api/directions/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      await load(); pollAlerts();
    } catch (e) { alert("Xato: " + e.message); }
  }
  async function del(id) {
    if (!confirm("Shu directionni o'chirasizmi?")) return;
    try { await fetch("/api/directions/" + id, { method: "DELETE" }); await load(); pollAlerts(); } catch {}
  }

  async function sync(btn) {
    btn.disabled = true; const old = btn.textContent; btn.textContent = "Yangilanmoqda…";
    try {
      const j = await (await fetch("/api/directions/sync", { method: "POST" })).json();
      btn.textContent = j.ok ? (j.added ? `+${j.added} yangi` : "Yangilandi ✓") : "Xato";
      if (!j.ok && j.error) alert("Sheet xatosi: " + j.error);
      await load(); pollAlerts();
    } catch (e) { alert("Xato: " + e.message); }
    setTimeout(() => (btn.textContent = old), 1800);
    btn.disabled = false;
  }

  async function addManual(e) {
    e.preventDefault();
    const body = {
      driver: $("#dir-f-driver").value.trim(), unit: $("#dir-f-unit").value.trim(),
      loadId: $("#dir-f-load").value.trim(), route: $("#dir-f-route").value.trim(),
      pu: $("#dir-f-pu").value.trim(), puTime: $("#dir-f-putime").value.trim(),
      direction: $("#dir-f-dir").value.trim(),
    };
    try {
      const j = await (await fetch("/api/directions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!j.ok) { alert(j.error || "Qo'shilmadi"); return; }
      $("#dir-form").reset();
      $("#dir-form").classList.add("hidden");
      await load(); pollAlerts();
    } catch (e2) { alert("Xato: " + e2.message); }
  }

  // Draft the "#DIRECTION" note from a Google Maps link so it doesn't have to be
  // typed exit by exit. The result lands in the direction box for review — it is
  // a car route, so it knows nothing about bridge heights or truck bans.
  async function draftFromLink(btn) {
    const url = $("#dir-f-link").value.trim();
    if (!url) { alert("Avval Google Maps linkini qo'ying."); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Yozilmoqda…";
    try {
      const res = await fetch("/api/direction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, unit: $("#dir-f-unit").value.trim() }),
      });
      const j = await res.json();
      if (!j.ok) { alert(j.error || "Yo'nalish chiqmadi"); return; }
      $("#dir-f-dir").value = j.note;
      if (!$("#dir-f-route").value.trim() && j.miles) $("#dir-f-route").value = j.miles + " mi";
    } catch (e) { alert("Xato: " + e.message); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  function setMuted(v) {
    muted = v;
    localStorage.setItem("dirMuted", v ? "1" : "0");
    const b = $("#dir-banner-mute");
    if (b) { b.textContent = v ? "🔕" : "🔔"; b.title = v ? "Ovozni yoqish" : "Ovozni o'chirish"; }
  }

  window.initDirections = function () {
    if (!document.querySelector(".dir-panel")) return;
    if (!wired) {
      wired = true;
      $("#dir-sync").addEventListener("click", (e) => sync(e.currentTarget));
      $("#dir-new").addEventListener("click", () => { $("#dir-form").classList.toggle("hidden"); $("#dir-f-driver").focus(); });
      $("#dir-f-cancel").addEventListener("click", () => $("#dir-form").classList.add("hidden"));
      $("#dir-f-draft").addEventListener("click", (e) => draftFromLink(e.currentTarget));
      $("#dir-form").addEventListener("submit", addManual);
      $("#dir-show-done").addEventListener("change", (e) => { showDone = e.target.checked; render(); });
    }
    load();
  };

  // Start the watcher as soon as the page loads, whatever tab is open.
  document.addEventListener("DOMContentLoaded", () => {
    setMuted(muted);
    const go = $("#dir-banner-go"), mute = $("#dir-banner-mute");
    if (go) go.addEventListener("click", () => {
      const tab = document.querySelector('.tab[data-view="directions"]');
      if (tab) tab.click();
    });
    if (mute) mute.addEventListener("click", () => setMuted(!muted));
    pollAlerts();
    setInterval(pollAlerts, 60000);
  });
})();

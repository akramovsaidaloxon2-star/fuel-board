// Weigh stations: the list, and what the board is watching.
//
// Pasted in bulk because that is how the list arrives — a column out of a
// spreadsheet or a handful of Google Maps links, not one form at a time.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let wired = false, radius = 100;

  function render(points) {
    $("#scale-count").textContent = points.length
      ? `${points.length} ta scale · standart halqa ${radius} mi`
      : "Hali bitta ham scale qo'shilmagan";
    $("#scale-empty").classList.toggle("hidden", points.length > 0);
    $("#scale-rows").innerHTML = points.map((p) => `<tr>
      <td>${esc(p.label)}${p.note ? `<div class="toll-dim">${esc(p.note)}</div>` : ""}</td>
      <td class="num">${p.mi > 0 ? p.mi : radius} mi</td>
      <td class="num">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</td>
      <td>${p.watching ? `<span class="toll-dim">${p.watching} truck kuzatuvda</span>` : ""}</td>
      <td><a href="https://www.google.com/maps?q=${p.lat},${p.lon}" target="_blank" rel="noopener">📍 Map</a></td>
      <td><button class="btn scale-del" data-id="${esc(p.id)}">O'chirish</button></td>
    </tr>`).join("");
    for (const b of document.querySelectorAll(".scale-del")) {
      b.addEventListener("click", () => del(b.dataset.id, b));
    }
  }

  async function load() {
    try {
      const j = await (await fetch("/api/scales")).json();
      radius = j.radiusMi || 100;
      render(j.points || []);
    } catch (e) {
      $("#scale-state").textContent = "ro'yxat olinmadi: " + e.message;
      $("#scale-state").className = "dir-draft-state bad";
    }
  }

  async function add(btn) {
    const text = $("#scale-text").value.trim();
    if (!text) return;
    const state = $("#scale-state");
    btn.disabled = true;
    state.textContent = "joylar aniqlanmoqda…"; state.className = "dir-draft-state";
    try {
      const j = await (await fetch("/api/scales", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })).json();
      if (!j.ok) { state.textContent = j.error || "qo'shilmadi"; state.className = "dir-draft-state bad"; return; }
      const added = (j.added || []).length;
      // What failed matters more than what worked: a misspelled town silently
      // dropped is a scale nobody gets warned about.
      state.textContent = `${added} ta qo'shildi` + ((j.failed || []).length ? ` · bo'lmadi: ${j.failed.join("; ")}` : "");
      state.className = (j.failed || []).length ? "dir-draft-state bad" : "dir-draft-state";
      if (added) $("#scale-text").value = "";
      load();
    } catch (e) {
      state.textContent = "Xato: " + e.message;
      state.className = "dir-draft-state bad";
    } finally { btn.disabled = false; }
  }

  async function del(id, btn) {
    btn.disabled = true;
    try {
      await fetch("/api/scales/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      load();
    } finally { btn.disabled = false; }
  }

  window.initScales = function () {
    if (!$("#scale-text")) return;
    if (!wired) {
      wired = true;
      $("#scale-add").addEventListener("click", (e) => add(e.currentTarget));
    }
    load();
  };
})();

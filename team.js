// Who plans the fuel, and how well they plan it.
//
// Two halves of one question, so one page: the accounts, and what each
// account has actually done. A dispatcher list on its own answers nothing,
// and a quality report with everything recorded as "manager" answers less.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const when = (iso) => (iso ? String(iso).replace("T", " ").slice(0, 16) : "—");
  let wired = false, days = 30;

  async function loadUsers() {
    try {
      const j = await (await fetch("/api/users")).json();
      const list = j.users || [];
      $("#team-users").innerHTML = list.length ? list.map((u) => `<tr>
        <td><b>${esc(u.name)}</b></td>
        <td>${esc(u.role)}</td>
        <td>${esc(when(u.lastSeen))}</td>
        <td>${esc(u.by ? `${u.by} qo'shgan · ${when(u.at)}` : when(u.at))}</td>
        <td><button class="btn team-del" data-name="${esc(u.name)}">O'chirish</button></td>
      </tr>`).join("") : `<tr><td colspan="5" class="toll-dim">Hali hisob qo'shilmagan — pastdan qo'shing.</td></tr>`;
      for (const b of document.querySelectorAll(".team-del")) {
        b.addEventListener("click", () => delUser(b.dataset.name, b));
      }
      // Logins set on the hosting panel still work; showing them stops the
      // same name being created twice and failing.
      $("#team-env").textContent = (j.envUsers || []).length
        ? `Render orqali qo'yilganlari: ${j.envUsers.join(", ")}`
        : "";
    } catch (e) {
      $("#team-state").textContent = "ro'yxat olinmadi: " + e.message;
      $("#team-state").className = "dir-draft-state bad";
    }
  }

  async function addUser(btn) {
    const name = $("#team-name").value.trim();
    const pass = $("#team-pass").value;
    const st = $("#team-state");
    if (!name || !pass) { st.textContent = "nom va parol kerak"; st.className = "dir-draft-state bad"; return; }
    btn.disabled = true;
    try {
      const j = await (await fetch("/api/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pass }),
      })).json();
      if (!j.ok) { st.textContent = j.error || "qo'shilmadi"; st.className = "dir-draft-state bad"; return; }
      st.textContent = j.updated ? `${name} — paroli yangilandi` : `${name} qo'shildi`;
      st.className = "dir-draft-state";
      $("#team-name").value = ""; $("#team-pass").value = "";
      loadUsers();
    } catch (e) {
      st.textContent = "Xato: " + e.message; st.className = "dir-draft-state bad";
    } finally { btn.disabled = false; }
  }

  async function delUser(name, btn) {
    btn.disabled = true;
    try {
      await fetch("/api/users/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      loadUsers();
    } finally { btn.disabled = false; }
  }

  async function loadReport() {
    try {
      const j = await (await fetch(`/api/plan-report?days=${days}`)).json();
      const people = j.people || [];
      $("#team-sum").innerHTML = `oxirgi <b>${j.days}</b> kun · <b>${j.total}</b> fuel stop` +
        (people.length ? ` · <b>${people.length}</b> kishi` : "");
      $("#team-note").textContent = j.note || "";
      $("#team-note").classList.toggle("hidden", !j.note);
      $("#team-rows").innerHTML = people.map((p) => {
        const w = p.worst;
        return `<tr>
          <td><b>${esc(p.user)}</b></td>
          <td class="num">${p.stops}</td>
          <td class="num">${p.checked}</td>
          <td class="num">${p.cheaper}${p.missRate != null ? ` <span class="toll-dim">(${p.missRate}%)</span>` : ""}</td>
          <td class="num">${p.avgPpg == null ? "—" : "$" + p.avgPpg.toFixed(3)}</td>
          <td class="num">${p.save ? `<b class="bad">$${p.save}</b>` : "—"}</td>
          <td class="audit-why">${w ? `${esc(w.unit)} → #${esc(w.num)} $${w.ppg} · arzoni #${esc(w.better.num)} $${w.better.ppg} (${w.better.miles} mi) → $${Math.round(w.better.save)}` : ""}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="7" class="toll-dim">Yozuv yo'q</td></tr>`;

      $("#team-recent").innerHTML = (j.recent || []).map((p) => `<tr>
        <td>${esc(when(p.at))}</td>
        <td>${esc(p.by || "—")}</td>
        <td>${esc(p.unit)}</td>
        <td>${esc(p.driver || "")}</td>
        <td>#${esc(p.num)} ${esc([p.city, p.st].filter(Boolean).join(", "))}${p.zip ? ` <span class="toll-dim">→ 📮${esc(p.zip)}</span>` : ""}</td>
        <td class="num">${p.ppg == null ? "—" : "$" + p.ppg}</td>
        <td class="num">${p.fuel == null ? "—" : p.fuel + "%"}</td>
        <td class="audit-why">${p.better
          ? `<span class="bad">arzoni bor edi:</span> #${esc(p.better.num)} $${p.better.ppg} · ${p.better.miles} mi · ~$${Math.round(p.better.save)}`
          : (p.checked ? "✓ yo'lda arzoni yo'q edi" : "<span class=\"toll-dim\">tekshirilmagan</span>")}${
          p.trip && p.trip.offRoute ? ` <span class="bad">· yo'ldan ${p.trip.hereOff} mi chetda</span>` : ""}${
          p.basis === "heading" ? ` <span class="toll-dim">(taxmin)</span>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="8" class="toll-dim">Yozuv yo'q</td></tr>`;
    } catch (e) {
      $("#team-sum").textContent = "hisobot olinmadi: " + e.message;
    }
  }

  window.initTeam = function () {
    if (!$("#team-name")) return;
    if (!wired) {
      wired = true;
      $("#team-add").addEventListener("click", (e) => addUser(e.currentTarget));
      $("#team-days").addEventListener("change", (e) => { days = +e.target.value || 30; loadReport(); });
    }
    loadUsers();
    loadReport();
  };
})();

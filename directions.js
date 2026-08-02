// Write the "#DIRECTION" note from a Google Maps link.
//
// Dispatch types these by hand today — which interstate the driver takes and
// which numbered exit joins the next one. Paste the link, get the note, read it
// over, send it. A link is the whole input: no driver, unit or load id.
//
// What came before this: an intake from the dispatch Google Sheet with a
// confirm-or-be-nagged list. It was cut back to the drafting box on request;
// the server still answers /api/directions, nothing here calls it.
(function () {
  const $ = (s) => document.querySelector(s);
  let wired = false;

  async function draftFromLink(btn) {
    const url = $("#dir-link").value.trim();
    const out = $("#dir-draft-out"), state = $("#dir-draft-state"), copy = $("#dir-draft-copy");
    if (!url) { state.textContent = "Avval linkni qo'ying"; state.className = "dir-draft-state bad"; return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "Yozilmoqda…";
    state.textContent = ""; state.className = "dir-draft-state";
    try {
      const res = await fetch("/api/direction", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const j = await res.json();
      if (!j.ok) {
        state.textContent = j.error || "Yo'nalish chiqmadi";
        state.className = "dir-draft-state bad";
        return;
      }
      out.value = j.note;
      out.hidden = false; copy.hidden = false;
      state.textContent = `${j.lines.length} ta yo'nalish · ${j.miles} mi · ${j.stops} bekat`;
    } catch (e) {
      state.textContent = "Xato: " + e.message;
      state.className = "dir-draft-state bad";
    } finally { btn.disabled = false; btn.textContent = old; }
  }

  async function copyDraft(btn) {
    const text = $("#dir-draft-out").value;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { $("#dir-draft-out").select(); document.execCommand("copy"); }  // older/http contexts
    const old = btn.textContent;
    btn.textContent = "✓ Olindi";
    setTimeout(() => (btn.textContent = old), 1500);
  }

  window.initDirections = function () {
    if (wired || !$("#dir-link")) return;
    wired = true;
    $("#dir-draft-go").addEventListener("click", (e) => draftFromLink(e.currentTarget));
    $("#dir-draft-copy").addEventListener("click", (e) => copyDraft(e.currentTarget));
    // Enter in the link box drafts, rather than doing nothing.
    $("#dir-link").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); draftFromLink($("#dir-draft-go")); }
    });
  };
})();

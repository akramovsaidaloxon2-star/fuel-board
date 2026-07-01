(function () {
  const $ = (s) => document.querySelector(s);
  let points = [], wired = false;
  let gmap = null, gmarkers = [], gpolyline = null, autocomplete = null;

  function esc(v) { return String(v == null ? "" : v).replace(/"/g, "&quot;"); }

  function render() {
    const list = $("#route-points");
    if (!points.length) {
      list.innerHTML = "";
      $("#route-summary").className = "empty";
      $("#route-summary").textContent = "Hali nuqta yo'q";
      return;
    }
    list.innerHTML = points.map((p, i) => {
      const role = i === 0 ? "Start" : (i === points.length - 1 ? "Destination" : "Via");
      const label = esc(p.label || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
      return `<li>
        <span class="route-role">${role}</span>
        <span class="route-label">${label}</span>
        <button class="btn icon-btn" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="Yuqoriga">▲</button>
        <button class="btn icon-btn" data-act="down" data-i="${i}" ${i === points.length - 1 ? "disabled" : ""} title="Pastga">▼</button>
        <button class="btn icon-btn" data-act="del" data-i="${i}" title="O'chirish">✕</button>
      </li>`;
    }).join("");
    list.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = +btn.dataset.i;
        if (btn.dataset.act === "del") removePoint(i);
        else if (btn.dataset.act === "up") movePoint(i, -1);
        else if (btn.dataset.act === "down") movePoint(i, 1);
      });
    });
  }

  function syncMarkers() {
    gmarkers.forEach((m) => m.setMap(null));
    gmarkers = points.map((p, i) => new google.maps.Marker({
      position: { lat: p.lat, lng: p.lon },
      map: gmap,
      label: String(i + 1),
    }));
    if (points.length) {
      const bounds = new google.maps.LatLngBounds();
      points.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lon }));
      gmap.fitBounds(bounds, 60);
    }
  }

  function clearPolyline() {
    if (gpolyline) { gpolyline.setMap(null); gpolyline = null; }
  }

  function addPoint(lat, lon, label) {
    points.push({ lat, lon, label: label || null });
    render();
    syncMarkers();
    $("#route-copy-link").disabled = true;
    clearPolyline();
  }
  function removePoint(i) {
    points.splice(i, 1);
    render();
    syncMarkers();
    $("#route-copy-link").disabled = true;
    clearPolyline();
  }
  function movePoint(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= points.length) return;
    [points[i], points[j]] = [points[j], points[i]];
    render();
    syncMarkers();
  }

  function renderSummary(j) {
    const el = $("#route-summary");
    el.className = "";
    el.innerHTML = `<strong>${j.miles} mi</strong> · ~${Math.floor(j.etaMin / 60)}h ${j.etaMin % 60}m`;
  }
  function renderNotices(notices) {
    const el = $("#route-notices");
    if (!notices || !notices.length) {
      el.innerHTML = `<p class="cov-note">✅ Taqiqlangan yo'llar aniqlanmadi.</p>`;
      return;
    }
    el.innerHTML = `<p class="cov-note">⚠️ Aniqlangan cheklovlar:</p><ul>${notices.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  }

  async function computeRoute() {
    if (points.length < 2) { alert("Kamida 2 ta nuqta kerak (start va destination)."); return; }
    const btn = $("#route-compute");
    btn.disabled = true;
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Xatolik");
      clearPolyline();
      gpolyline = new google.maps.Polyline({
        path: j.polyline.map(([lat, lon]) => ({ lat, lng: lon })),
        strokeColor: "#e24b4a",
        strokeWeight: 4,
        map: gmap,
      });
      renderSummary(j);
      renderNotices(j.notices);
      $("#route-copy-link").disabled = false;
    } catch (e) {
      alert("Xato: " + e.message);
    }
    btn.disabled = false;
  }

  function buildGoogleMapsLink() {
    const o = points[0], d = points[points.length - 1];
    const via = points.slice(1, -1);
    let url = `https://www.google.com/maps/dir/?api=1&origin=${o.lat},${o.lon}&destination=${d.lat},${d.lon}`;
    if (via.length) url += `&waypoints=${via.map((p) => `${p.lat},${p.lon}`).join("|")}`;
    url += "&travelmode=driving";
    return url;
  }

  function initMap() {
    if (gmap || !window.google || !window.google.maps) return;
    gmap = new google.maps.Map($("#route-map"), {
      center: { lat: 40.7, lng: -74.0 },
      zoom: 7,
    });
    gmap.addListener("click", (e) => addPoint(e.latLng.lat(), e.latLng.lng(), null));
    autocomplete = new google.maps.places.Autocomplete($("#route-search"));
    autocomplete.addListener("place_changed", () => {
      const p = autocomplete.getPlace();
      if (p && p.geometry) {
        addPoint(p.geometry.location.lat(), p.geometry.location.lng(), p.formatted_address || p.name);
        $("#route-search").value = "";
      }
    });
  }

  window.initRoute = function () {
    if (!wired) {
      wired = true;
      $("#route-compute").addEventListener("click", computeRoute);
      $("#route-clear").addEventListener("click", () => {
        points = [];
        render();
        syncMarkers();
        clearPolyline();
        $("#route-notices").innerHTML = "";
        $("#route-copy-link").disabled = true;
      });
      $("#route-copy-link").addEventListener("click", () => {
        navigator.clipboard.writeText(buildGoogleMapsLink()).then(() => {
          const btn = $("#route-copy-link");
          const old = btn.textContent;
          btn.textContent = "✅ Nusxalandi";
          setTimeout(() => { btn.textContent = old; }, 1500);
        });
      });
    }
    if (!window.google || !window.google.maps) {
      $("#route-map").innerHTML = `<div class="empty">Google Maps yuklanmadi — index.html ichidagi API key sozlanganini tekshiring.</div>`;
      return;
    }
    initMap();
  };
})();

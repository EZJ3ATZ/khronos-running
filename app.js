// ============================================================
// KRONOS RUNNING — frontend (servidor como cérebro compartilhado)
// ============================================================

const TOKEN_KEY = "kronos_token";
let token = localStorage.getItem(TOKEN_KEY) || null;
let meUser = null;

// Estado de corrida
let map, routeLine, posMarker, watchId;
let path = [], distanceKm = 0, startTime = null, timerInt = null;
let simInt = null, simPos = null, simHeading = 0;
let runPrivate = false, lastPosTime = null, fraudSince = null, fraudKm = 0;

// Ghost runner
const GHOST_KEY = "kronos_ghost";
let ghostOn = false, ghostMarker = null, ghostInt = null, ghostPath = null;

// Antifraude: > 25 km/h por 15 s pausa e anula a contagem do trecho
const FRAUD_KMH = 25, FRAUD_HOLD_MS = 15000;

// Territórios
let territories = [], terrLayers = {}, currentZoneId = null;

// Criar zona
let creatingZone = false, zonePoints = [], zoneTempLayer = null, zoneMarkers = [];

// ---------- API (build de teste: backend roda LOCAL no aparelho) ----------
async function api(pathname, method = "GET", body = null) {
  // Sem servidor — tudo é resolvido pelo LocalAPI sobre localStorage.
  try {
    return await window.LocalAPI(method, pathname, body);
  } catch (e) {
    throw new Error(e.error || e.message || ("Erro local " + (e.status || "")));
  }
}

// ---------- Geo ----------
function haversine(a, b) {
  const R = 6371;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function toRad(d) { return (d * Math.PI) / 180; }
function pointInPoly(pt, poly) {
  const x = pt[1], y = pt[0];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function territoryAt(pt) { return territories.find((t) => pointInPoly(pt, t.polygon)) || null; }

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function fmtPace(sp) {
  if (!isFinite(sp) || sp <= 0) return "--:--";
  return `${Math.floor(sp / 60)}:${String(Math.floor(sp % 60)).padStart(2, "0")}`;
}

// Renderiza parciais por km como barras (o km mais rápido fica destacado).
function renderSplits(el, splits) {
  if (!el) return;
  if (!splits || !splits.length) { el.innerHTML = ""; return; }
  const max = Math.max(...splits);
  const min = Math.min(...splits);
  el.innerHTML = `<div class="splits-title">Parciais por km</div>` +
    splits.map((s, i) => {
      const w = max > 0 ? Math.round((s / max) * 100) : 0;
      const best = s === min && splits.length > 1 ? " best" : "";
      return `<div class="split-row">
        <span class="split-km">${i + 1}</span>
        <span class="split-bar"><span class="split-fill${best}" style="width:${w}%"></span></span>
        <span class="split-pace">${fmtPace(s)}</span>
      </div>`;
    }).join("");
}

// ---------- Mapa ----------
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([-19.9167, -43.9345], 15);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 20,
  }).addTo(map);
  routeLine = L.polyline([], { color: "#F97316", weight: 6, opacity: 0.9 }).addTo(map);
  map.on("click", onMapClick);
}

function terrStyle(t) {
  // Zona Quente: contorno dourado grosso, destaque acima de dono/sem dono
  if (t.hot) {
    const base = t.mine ? "#F97316" : (t.owner_id ? "#ef4444" : "#64748b");
    return { color: "#fbbf24", fillColor: base, fillOpacity: 0.3, weight: 4 };
  }
  if (t.mine) return { color: "#F97316", fillColor: "#F97316", fillOpacity: 0.25, weight: 2 };
  if (t.owner_id) return { color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.18, weight: 2 };
  return { color: "#64748b", fillColor: "#64748b", fillOpacity: 0.12, weight: 1, dashArray: "5,5" };
}

function renderTerritories() {
  Object.values(terrLayers).forEach((l) => map.removeLayer(l));
  terrLayers = {};
  for (const t of territories) {
    const layer = L.polygon(t.polygon, terrStyle(t)).addTo(map);
    const dono = t.mine ? "Você" : (t.owner_name || "sem dono");
    const hot = t.hot ? `<br><b style="color:#fbbf24">🔥 ZONA QUENTE — km em dobro!</b>` : "";
    let hist = "";
    if (t.owner_id && t.reign_days != null) {
      const d = t.reign_days;
      hist = `<br><small>👑 domina há ${d === 0 ? "menos de 1 dia" : d + " dia" + (d > 1 ? "s" : "")}</small>`;
    }
    if (t.flips > 1) hist += `<br><small>🔁 ${t.flips} trocas de dono</small>`;
    layer.bindPopup(`<b>${t.name}</b>${hot}<br>Dono: ${dono}<br>${t.owner_km.toFixed(2)} km` + hist +
      (token ? `<br><small>seu: ${t.my_km.toFixed(2)} km</small>` : ""));
    terrLayers[t.id] = layer;
  }
}

async function loadTerritories() {
  try {
    territories = await api("/territories");
    renderTerritories();
  } catch (e) { console.warn("territories", e.message); }
}

// ---------- Auth ----------
function showAuth() { document.getElementById("auth-screen").classList.remove("hidden-screen"); }
function hideAuth() { document.getElementById("auth-screen").classList.add("hidden-screen"); }

function setAuthMode(mode) {
  document.querySelectorAll(".auth-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("au-username").classList.toggle("hidden", mode !== "register");
  document.getElementById("au-submit").textContent = mode === "register" ? "CADASTRAR" : "ENTRAR";
  document.getElementById("au-submit").dataset.mode = mode;
  document.getElementById("auth-err").textContent = "";
}

async function submitAuth() {
  const mode = document.getElementById("au-submit").dataset.mode || "login";
  const email = document.getElementById("au-email").value.trim();
  const password = document.getElementById("au-password").value;
  const username = document.getElementById("au-username").value.trim();
  const errEl = document.getElementById("auth-err");
  errEl.textContent = "";
  try {
    const body = mode === "register" ? { username, email, password } : { email, password };
    const data = await api("/" + mode, "POST", body);
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    meUser = data.user;
    hideAuth();
    await afterLogin();
  } catch (e) { errEl.textContent = e.message; }
}

async function afterLogin() {
  await loadTerritories();
  await loadStats();
  loadSeason();
  loadHotZone();
  loadNotifBadge();
}

// ---------- Temporada ----------
let seasonInfo = null;
async function loadSeason() {
  try {
    seasonInfo = await api("/season");
    document.getElementById("season-num").textContent = seasonInfo.season;
    const d = seasonInfo.days_left;
    const left = d >= 1 ? `${d} dia${d > 1 ? "s" : ""}` : `${seasonInfo.hours_left}h`;
    document.getElementById("season-left").textContent = left;
    document.getElementById("season-bar").classList.remove("hidden");
  } catch {}
}

// ---------- Zona Quente da semana ----------
let hotZone = null;
async function loadHotZone() {
  try {
    const r = await api("/hot_zone");
    hotZone = r.hot;
    const bar = document.getElementById("hot-bar");
    if (!hotZone) { bar.classList.add("hidden"); return; }
    document.getElementById("hot-icon").textContent = hotZone.icon || "🔥";
    document.getElementById("hot-name").textContent = hotZone.name;
    const d = r.days_left;
    document.getElementById("hot-theme").textContent =
      `${hotZone.theme} · acaba em ${d} dia${d !== 1 ? "s" : ""}`;
    bar.classList.remove("hidden");
  } catch {}
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  token = null; meUser = null;
  switchTab("correr");
  showAuth();
}

// ---------- Stats / resumo ----------
async function loadStats() {
  try {
    meUser = await api("/me");
    document.getElementById("summary").textContent =
      `${meUser.username} · ${meUser.level} · ${meUser.week_km} km esta semana · ${meUser.territories} território(s)`;
  } catch (e) {
    document.getElementById("summary").textContent = "Pronto para correr.";
  }
}

// ---------- Corrida ----------
function startRun(simulate) {
  if (!token) { showAuth(); return; }
  if (!simulate && !navigator.geolocation) { alert("Sem GPS disponível."); return; }
  path = []; distanceKm = 0; startTime = Date.now(); currentZoneId = null;
  lastPosTime = null; fraudSince = null; fraudKm = 0;
  runPrivate = document.getElementById("opt-private").checked;
  routeLine.setLatLngs([]);
  document.getElementById("fraud-banner").classList.add("hidden");
  document.getElementById("panel-pre").classList.add("hidden");
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("btn-stop").classList.remove("hidden");
  document.getElementById("tabbar").classList.add("hidden");
  document.getElementById("btn-create-zone").classList.add("hidden");
  document.getElementById("btn-bell").classList.add("hidden");
  timerInt = setInterval(updateHud, 500);
  if (document.getElementById("opt-ghost").checked) startGhost();
  if (simulate) startSimulation();
  else watchId = navigator.geolocation.watchPosition(onPosition, (e) => console.warn(e),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}

// ---------- Ghost runner ----------
function startGhost() {
  const raw = localStorage.getItem(GHOST_KEY);
  if (!raw) return;
  try { ghostPath = JSON.parse(raw); } catch { return; }
  if (!ghostPath || ghostPath.length < 2) { ghostPath = null; return; }
  ghostOn = true;
  let i = 0;
  ghostMarker = L.circleMarker(ghostPath[0], {
    radius: 8, color: "#a78bfa", weight: 2, fillColor: "#a78bfa", fillOpacity: 0.8,
  }).addTo(map).bindTooltip("Ghost", { permanent: false });
  ghostInt = setInterval(() => {
    i++;
    if (i >= ghostPath.length) { clearInterval(ghostInt); ghostInt = null; return; }
    ghostMarker.setLatLng(ghostPath[i]);
  }, 1000);
}
function stopGhost() {
  if (ghostInt) { clearInterval(ghostInt); ghostInt = null; }
  if (ghostMarker) { map.removeLayer(ghostMarker); ghostMarker = null; }
  ghostOn = false;
}

function startSimulation() {
  const c = map.getCenter();
  simPos = [c.lat + 0.0035, c.lng];
  simHeading = Math.PI;
  let simAlt = 780;            // altitude inicial fake (m)
  let simSlope = 0.4;          // tendência de subida/descida
  onPosition({ coords: { latitude: simPos[0], longitude: simPos[1], altitude: simAlt } });
  simInt = setInterval(() => {
    const stepM = 4 + Math.random() * 1.5;
    simHeading += (Math.random() - 0.5) * 0.25;
    const dLat = (stepM * Math.cos(simHeading)) / 111320;
    const dLng = (stepM * Math.sin(simHeading)) / (111320 * Math.cos((simPos[0] * Math.PI) / 180));
    simPos = [simPos[0] + dLat, simPos[1] + dLng];
    simSlope += (Math.random() - 0.5) * 0.3;        // varia o terreno
    simSlope = Math.max(-1.2, Math.min(1.2, simSlope));
    simAlt += simSlope;                              // sobe/desce suave
    onPosition({ coords: { latitude: simPos[0], longitude: simPos[1], altitude: simAlt } });
  }, 1000);
}

function onPosition(pos) {
  const now = Date.now();
  const alt = (pos.coords && typeof pos.coords.altitude === "number") ? pos.coords.altitude : null;
  const p = [pos.coords.latitude, pos.coords.longitude, now, alt];
  if (path.length > 0) {
    const seg = haversine(path[path.length - 1], p);
    const dtH = lastPosTime ? (now - lastPosTime) / 3600000 : 0;
    const kmh = dtH > 0 ? seg / dtH : 0;
    if (kmh > FRAUD_KMH) {
      if (!fraudSince) fraudSince = now;
      fraudKm += seg; // acumula trecho suspeito, ainda não conta
      if (now - fraudSince >= FRAUD_HOLD_MS) showFraud(true);
    } else {
      if (fraudSince && now - fraudSince < FRAUD_HOLD_MS) {
        distanceKm += fraudKm; // velocidade voltou ao normal a tempo: valida o trecho
      }
      fraudSince = null; fraudKm = 0;
      distanceKm += seg;
      showFraud(false);
    }
  }
  lastPosTime = now;
  path.push(p);
  const ll = [p[0], p[1]];
  routeLine.addLatLng(ll);
  map.setView(ll, map.getZoom() < 15 ? 16 : map.getZoom());
  if (!posMarker) {
    posMarker = L.circleMarker(ll, { radius: 9, color: "#fff", weight: 3, fillColor: "#F97316", fillOpacity: 1 }).addTo(map);
  } else { posMarker.setLatLng(ll); }
  updateZoneBanner(ll);
}

function showFraud(on) {
  const b = document.getElementById("fraud-banner");
  if (on) {
    b.textContent = "⚠️ Velocidade de veículo detectada — km pausado. Volte a correr.";
    b.classList.remove("hidden");
  } else {
    b.classList.add("hidden");
  }
}

function updateZoneBanner(p) {
  const zone = territoryAt(p);
  const zoneId = zone ? zone.id : null;
  if (zoneId === currentZoneId) return;
  currentZoneId = zoneId;
  const banner = document.getElementById("zone-banner");
  if (zone && !zone.mine) {
    banner.textContent = `Você está em território rival! · ${zone.name}`;
    banner.classList.remove("hidden");
  } else if (zone && zone.mine) {
    banner.textContent = `Seu território · ${zone.name}`;
    banner.classList.remove("hidden");
  } else { banner.classList.add("hidden"); }
}

function updateHud() {
  const el = (Date.now() - startTime) / 1000;
  document.getElementById("hud-dist").textContent = distanceKm.toFixed(2);
  document.getElementById("hud-time").textContent = fmtTime(el);
  document.getElementById("hud-pace").textContent = distanceKm > 0.01 ? fmtPace(el / distanceKm) : "--:--";
}

function stopRun() {
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (simInt) { clearInterval(simInt); simInt = null; }
  stopGhost();
  clearInterval(timerInt);
  document.getElementById("zone-banner").classList.add("hidden");
  document.getElementById("fraud-banner").classList.add("hidden");
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  window._lastRun = {
    started_at: new Date(startTime).toISOString(),
    finished_at: new Date().toISOString(),
    duration_s: elapsed, path: path, private: runPrivate,
  };
  if (path.length >= 2) localStorage.setItem(GHOST_KEY, JSON.stringify(path));
  document.getElementById("hud").classList.add("hidden");
  document.getElementById("btn-stop").classList.add("hidden");
  document.getElementById("post-dist").textContent = distanceKm.toFixed(2);
  document.getElementById("post-time").textContent = fmtTime(elapsed);
  document.getElementById("post-pace").textContent = distanceKm > 0.01 ? fmtPace(elapsed / distanceKm) : "--:--";
  document.getElementById("post-territories").innerHTML = "";
  document.getElementById("panel-post").classList.remove("hidden");
}

async function saveRun() {
  const btn = document.getElementById("btn-save");
  btn.disabled = true;
  try {
    const r = await api("/runs", "POST", window._lastRun);
    document.getElementById("post-elev").textContent = Math.round(r.elev_gain_m || 0);
    document.getElementById("post-speed").textContent = (r.avg_kmh || 0).toFixed(1);
    document.getElementById("post-cal").textContent = r.calories || 0;
    renderSplits(document.getElementById("post-splits"), r.splits || []);
    let html = "";
    if (r.conquered && r.conquered.length) {
      html += r.conquered.map((t) => `<div class="terr-win">🏆 Conquistou <b>${t.name}</b>!</div>`).join("");
    }
    const gains = Object.keys(r.terr_gain || {});
    if (gains.length) {
      html += gains.map((id) => {
        const t = territories.find((x) => String(x.id) === id);
        return `<div class="terr-row"><span>${t ? t.name : "zona"}</span><span>+${r.terr_gain[id].toFixed(2)} km</span></div>`;
      }).join("");
    } else if (!html) {
      html = `<div class="terr-note">Nenhum território cruzado.</div>`;
    }
    document.getElementById("post-territories").innerHTML = html;
    await loadTerritories();
    if (r.conquered && r.conquered.length) {
      showConquest(r.conquered[0].name, r.conquered[0].hot);
    } else {
      setTimeout(resetToPre, 900);
    }
  } catch (e) {
    alert("Erro ao salvar: " + e.message);
  } finally { btn.disabled = false; }
}

// ---------- Conquista com peso (overlay + card compartilhável) ----------
function showConquest(zoneName, isHot) {
  document.getElementById("cq-zone").textContent = zoneName;
  document.getElementById("cq-user").textContent = (meUser && meUser.username) || "você";
  document.getElementById("cq-season").textContent = seasonInfo ? seasonInfo.season : "–";
  const hotEl = document.getElementById("cq-hot");
  if (hotEl) hotEl.classList.toggle("hidden", !isHot);
  const card = document.getElementById("conquest-card");
  card.classList.toggle("hot", !!isHot);
  const ov = document.getElementById("conquest-overlay");
  ov.classList.remove("hidden");
  // requestAnimationFrame garante a transição de entrada
  requestAnimationFrame(() => ov.classList.add("show"));
  if (navigator.vibrate) navigator.vibrate(isHot ? [80, 40, 80, 40, 160] : [60, 40, 120]);
}

function closeConquest() {
  const ov = document.getElementById("conquest-overlay");
  ov.classList.remove("show");
  setTimeout(() => { ov.classList.add("hidden"); resetToPre(); }, 250);
}

function conquestCanvas(zoneName, userName, season) {
  const W = 1080, H = 1080;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#1E3A5F");
  grad.addColorStop(1, "#0d1726");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  // moldura laranja
  ctx.strokeStyle = "#F97316"; ctx.lineWidth = 14;
  ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.font = "140px serif"; ctx.fillText("👑", W / 2, 300);
  ctx.fillStyle = "#F97316";
  ctx.font = "bold 56px sans-serif";
  ctx.fillText("TERRITÓRIO CONQUISTADO", W / 2, 430);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 92px sans-serif";
  wrapText(ctx, zoneName, W / 2, 580, W - 200, 100);
  ctx.fillStyle = "#9fb3c8";
  ctx.font = "42px sans-serif";
  ctx.fillText(`por ${userName} · Temporada ${season}`, W / 2, 760);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText("KHRONOS RUNNING", W / 2, 940);
  ctx.fillStyle = "#F97316";
  ctx.font = "34px sans-serif";
  ctx.fillText("de quem é a rua?", W / 2, 1000);
  return cv;
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(" ");
  let line = "", lines = [];
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lh));
}

async function shareConquest() {
  const zoneName = document.getElementById("cq-zone").textContent;
  const userName = document.getElementById("cq-user").textContent;
  const season = document.getElementById("cq-season").textContent;
  const msg = `🏆 Conquistei a ${zoneName} no KHRONOS RUNNING! Vem tomar de mim se for capaz. 👟`;
  const cv = conquestCanvas(zoneName, userName, season);
  cv.toBlob(async (blob) => {
    const file = new File([blob], "kronos-conquista.png", { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: msg, title: "KHRONOS RUNNING" });
        return;
      }
      if (navigator.share) { await navigator.share({ text: msg, title: "KHRONOS RUNNING" }); return; }
    } catch { /* usuário cancelou ou indisponível: cai no fallback */ }
    // Fallback: baixa a imagem e abre o WhatsApp com o texto
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kronos-conquista.png";
    a.click();
    window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
  }, "image/png");
}

function resetToPre() {
  document.getElementById("panel-post").classList.add("hidden");
  document.getElementById("panel-pre").classList.remove("hidden");
  document.getElementById("tabbar").classList.remove("hidden");
  document.getElementById("btn-create-zone").classList.remove("hidden");
  document.getElementById("btn-bell").classList.remove("hidden");
  if (posMarker) { map.removeLayer(posMarker); posMarker = null; }
  routeLine.setLatLngs([]);
  loadStats();
  loadSeason();
  loadHotZone();
}

// ---------- Criar zona ----------
function enterCreateZone() {
  if (!token) { showAuth(); return; }
  creatingZone = true; zonePoints = []; zoneMarkers = [];
  if (zoneTempLayer) { map.removeLayer(zoneTempLayer); zoneTempLayer = null; }
  document.getElementById("create-bar").classList.remove("hidden");
  document.getElementById("panel-pre").classList.add("hidden");
  document.getElementById("btn-create-zone").classList.add("hidden");
}
function exitCreateZone() {
  creatingZone = false;
  zoneMarkers.forEach((m) => map.removeLayer(m));
  zoneMarkers = [];
  if (zoneTempLayer) { map.removeLayer(zoneTempLayer); zoneTempLayer = null; }
  zonePoints = [];
  document.getElementById("create-bar").classList.add("hidden");
  document.getElementById("zone-name").value = "";
  document.getElementById("panel-pre").classList.remove("hidden");
  document.getElementById("btn-create-zone").classList.remove("hidden");
}
function onMapClick(e) {
  if (!creatingZone) return;
  const p = [e.latlng.lat, e.latlng.lng];
  zonePoints.push(p);
  const m = L.circleMarker(p, { radius: 6, color: "#fff", fillColor: "#F97316", fillOpacity: 1 }).addTo(map);
  zoneMarkers.push(m);
  if (zoneTempLayer) map.removeLayer(zoneTempLayer);
  zoneTempLayer = L.polygon(zonePoints, { color: "#F97316", fillOpacity: 0.2, dashArray: "5,5" }).addTo(map);
}
async function saveZone() {
  const name = document.getElementById("zone-name").value.trim();
  if (zonePoints.length < 3) { alert("Marque pelo menos 3 pontos no mapa."); return; }
  if (name.length < 2) { alert("Dê um nome à zona."); return; }
  try {
    await api("/territories", "POST", { name, polygon: zonePoints });
    exitCreateZone();
    await loadTerritories();
  } catch (e) { alert(e.message); }
}

// ---------- Ranking ----------
async function loadRanking() {
  const el = document.getElementById("rank-list");
  el.innerHTML = "carregando…";
  try {
    const rows = await api("/ranking");
    if (!rows.length) { el.innerHTML = `<div class="terr-note">Sem corridas esta semana.</div>`; return; }
    el.innerHTML = rows.map((r) =>
      `<div class="rank-row ${meUser && r.username === meUser.username ? "me" : ""}">
        <span class="rank-pos">${r.pos}</span>
        <span class="rank-name">${r.username}</span>
        <span class="rank-lvl">${r.level}</span>
        <span class="rank-km">${r.week_km} km</span>
      </div>`).join("");
  } catch (e) { el.innerHTML = e.message; }
}

// ---------- Perfil ----------
async function loadProfile() {
  if (!meUser) { try { meUser = await api("/me"); } catch { return; } }
  try {
    const p = await api("/profile/" + encodeURIComponent(meUser.username));
    document.getElementById("prof-initial").textContent = p.username[0].toUpperCase();
    document.getElementById("prof-name").textContent = p.username;
    document.getElementById("prof-level").textContent = p.level + " · " + p.week_km + " km/semana";
    document.getElementById("prof-totalkm").textContent = p.total_km;
    document.getElementById("prof-weekkm").textContent = p.week_km;
    document.getElementById("prof-runs").textContent = p.runs;
    document.getElementById("prof-terr").textContent = p.territories;
    const tl = document.getElementById("prof-territories");
    tl.innerHTML = (p.owned_territories && p.owned_territories.length)
      ? p.owned_territories.map((t) => `<div class="terr-row"><span>${t.name}</span><span>🏆</span></div>`).join("")
      : `<div class="terr-note">Você ainda não domina nenhum território. Vá correr!</div>`;
    const tr = document.getElementById("prof-trophies");
    if (tr) {
      tr.innerHTML = (p.trophies && p.trophies.length)
        ? p.trophies.map((t) => `<div class="terr-row"><span>🏆 Temporada ${t.season} · ${t.name}</span><span>${t.km} km</span></div>`).join("")
        : `<div class="terr-note">Nenhum troféu ainda. Termine uma temporada como dono de uma zona!</div>`;
    }
    // Recordes pessoais
    const rec = p.records || {};
    const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setTxt("prof-longest", (rec.longest_km != null ? rec.longest_km : 0));
    setTxt("prof-bestpace", rec.best_pace_s ? fmtPace(rec.best_pace_s) : "--:--");
    setTxt("prof-elev", Math.round(rec.total_elev_m || 0));
    setTxt("prof-cal", Math.round(rec.total_cal || 0));
    // Peso
    const wIn = document.getElementById("prof-weight");
    if (wIn && p.weight_kg) wIn.value = p.weight_kg;
    // Histórico
    loadRunHistory();
  } catch (e) { console.warn(e.message); }
}

async function loadRunHistory() {
  const el = document.getElementById("prof-runs-list");
  if (!el) return;
  try {
    const rows = await api("/runs");
    if (!rows.length) {
      el.innerHTML = `<div class="terr-note">Nenhuma corrida ainda. Bora correr!</div>`;
      return;
    }
    el.innerHTML = rows.map((r) => {
      const d = new Date(r.finished_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      return `<div class="run-row" data-run="${r.id}">
        <span class="run-date">${d}${r.private ? " 🔒" : ""}</span>
        <span class="run-km">${r.distance_km} km</span>
        <span class="run-pace">${fmtPace(r.pace_s)}/km</span>
        <span class="run-extra">⛰️ ${Math.round(r.elev_gain_m)}m · 🔥 ${r.calories}</span>
      </div>`;
    }).join("");
  } catch (e) { el.innerHTML = e.message; }
}

async function saveWeight() {
  const wIn = document.getElementById("prof-weight");
  const w = parseFloat(wIn.value);
  if (!w || w <= 0) { alert("Informe um peso válido."); return; }
  try {
    await api("/me/weight", "POST", { weight_kg: w });
    alert("Peso salvo! As próximas corridas vão calcular calorias com ele.");
  } catch (e) { alert(e.message); }
}

// ---------- Social (feed / follow / like) ----------
async function loadFeed() {
  const el = document.getElementById("feed-list");
  el.innerHTML = "carregando…";
  try {
    const rows = await api("/feed");
    if (!rows.length) {
      el.innerHTML = `<div class="terr-note">Seu feed está vazio. Siga corredores ou faça uma corrida pública.</div>`;
      return;
    }
    el.innerHTML = rows.map((r) => {
      const min = Math.round(r.duration_s / 60);
      return `<div class="feed-card">
        <div class="feed-top"><b>${r.username}</b><span>${new Date(r.finished_at).toLocaleDateString("pt-BR")}</span></div>
        <div class="feed-stats">${r.distance_km} km · ${min} min</div>
        <button class="like-btn ${r.liked ? "on" : ""}" data-run="${r.id}">❤ <span>${r.likes}</span></button>
      </div>`;
    }).join("");
    el.querySelectorAll(".like-btn").forEach((b) =>
      b.addEventListener("click", () => toggleLike(b.dataset.run)));
  } catch (e) { el.innerHTML = e.message; }
}

async function toggleLike(runId) {
  try { await api(`/runs/${runId}/like`, "POST"); loadFeed(); }
  catch (e) { alert(e.message); }
}

async function doFollow() {
  const name = document.getElementById("follow-name").value.trim().replace(/^@/, "");
  if (!name) return;
  try {
    const r = await api("/follow/" + encodeURIComponent(name), "POST");
    document.getElementById("follow-name").value = "";
    alert(r.following ? `Seguindo @${name}` : `Deixou de seguir @${name}`);
    loadFeed();
  } catch (e) { alert(e.message); }
}

// ---------- Desafios (missões / estádios / volta ao mundo / streak) ----------
function missionRow(m) {
  const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
  return `<div class="mission ${m.done ? "done" : ""}">
    <div class="mission-top"><span>${m.text}</span><span>${m.progress}/${m.target}${m.done ? " ✓" : ""}</span></div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
  </div>`;
}

async function loadDesafios() {
  try {
    if (!meUser) meUser = await api("/me");
    document.getElementById("streak-val").textContent = meUser.streak || 0;
    const m = await api("/missions");
    document.getElementById("missions-daily").innerHTML = m.daily.map(missionRow).join("");
    document.getElementById("missions-weekly").innerHTML = m.weekly.map(missionRow).join("");
    const c = await api("/challenges");
    document.getElementById("stadiums-list").innerHTML = c.stadiums.map((s) =>
      `<div class="badge ${s.earned ? "earned" : ""}" title="${s.city} · ${s.km} km">
        <div class="badge-ico">${s.earned ? "🏟️" : "🔒"}</div>
        <div class="badge-name">${s.name}</div>
      </div>`).join("");
    document.getElementById("countries-list").innerHTML = c.countries.map((co) =>
      `<div class="mission ${co.earned ? "done" : ""}">
        <div class="mission-top"><span>${co.flag} ${co.name}</span><span>${co.pct}%</span></div>
        <div class="bar"><div class="bar-fill" style="width:${co.pct}%"></div></div>
      </div>`).join("");
  } catch (e) { console.warn(e.message); }
}

// ---------- Grupos ----------
async function loadGroups() {
  const el = document.getElementById("group-list");
  document.getElementById("group-detail").classList.add("hidden");
  el.classList.remove("hidden");
  el.innerHTML = "carregando…";
  try {
    const rows = await api("/groups");
    if (!rows.length) { el.innerHTML = `<div class="terr-note">Nenhum grupo ainda. Crie o primeiro!</div>`; return; }
    el.innerHTML = rows.map((gr) =>
      `<div class="group-row">
        <span class="group-open" data-id="${gr.id}">${gr.name} <small>(${gr.members})</small></span>
        <button class="btn-mini ${gr.joined ? "on" : ""}" data-join="${gr.id}">${gr.joined ? "Sair" : "Entrar"}</button>
      </div>`).join("");
    el.querySelectorAll(".group-open").forEach((s) =>
      s.addEventListener("click", () => openGroup(s.dataset.id)));
    el.querySelectorAll("[data-join]").forEach((b) =>
      b.addEventListener("click", () => joinGroup(b.dataset.join)));
  } catch (e) { el.innerHTML = e.message; }
}

async function createGroup() {
  const name = document.getElementById("group-name").value.trim();
  if (name.length < 2) { alert("Dê um nome ao grupo."); return; }
  try {
    await api("/groups", "POST", { name });
    document.getElementById("group-name").value = "";
    loadGroups();
  } catch (e) { alert(e.message); }
}

async function joinGroup(id) {
  try { await api(`/groups/${id}/join`, "POST"); loadGroups(); }
  catch (e) { alert(e.message); }
}

async function openGroup(id) {
  try {
    const g = await api("/groups/" + id);
    document.getElementById("group-list").classList.add("hidden");
    document.getElementById("group-detail").classList.remove("hidden");
    document.getElementById("group-detail-name").textContent = g.name;
    const r = document.getElementById("group-detail-rank");
    r.innerHTML = g.ranking.length
      ? g.ranking.map((x) =>
        `<div class="rank-row ${meUser && x.username === meUser.username ? "me" : ""}">
          <span class="rank-pos">${x.pos}</span><span class="rank-name">${x.username}</span>
          <span class="rank-lvl">${x.level}</span><span class="rank-km">${x.week_km} km</span>
        </div>`).join("")
      : `<div class="terr-note">Sem membros correndo esta semana.</div>`;
  } catch (e) { alert(e.message); }
}

// ---------- Notificações ----------
async function loadNotifBadge() {
  if (!token) return;
  try {
    const rows = await api("/notifications");
    const unseen = rows.filter((n) => !n.seen).length;
    const badge = document.getElementById("bell-badge");
    badge.textContent = unseen;
    badge.classList.toggle("hidden", unseen === 0);
  } catch {}
}

async function openNotif() {
  const panel = document.getElementById("notif-panel");
  const list = document.getElementById("notif-list");
  panel.classList.remove("hidden");
  list.innerHTML = "carregando…";
  try {
    const rows = await api("/notifications");
    list.innerHTML = rows.length
      ? rows.map((n) =>
        `<div class="notif-item ${n.seen ? "" : "unseen"}">${n.text}
          <small>${new Date(n.created_at).toLocaleString("pt-BR")}</small></div>`).join("")
      : `<div class="terr-note">Nenhuma notificação.</div>`;
    await api("/notifications/seen", "POST");
    loadNotifBadge();
  } catch (e) { list.innerHTML = e.message; }
}

// ---------- Tabs ----------
function switchTab(name) {
  document.querySelectorAll(".tab-view").forEach((v) => v.classList.add("hidden"));
  document.getElementById("tab-" + name).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  if (name === "ranking") { loadRanking(); loadGroups(); }
  if (name === "social") loadFeed();
  if (name === "desafios") loadDesafios();
  if (name === "perfil") loadProfile();
}

// ---------- Boot ----------
window.addEventListener("load", async () => {
  initMap();
  navigator.geolocation?.getCurrentPosition((pos) =>
    map.setView([pos.coords.latitude, pos.coords.longitude], 16), () => {});

  await loadTerritories();
  loadHotZone();

  document.querySelectorAll(".auth-tab").forEach((b) =>
    b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  document.getElementById("au-submit").addEventListener("click", submitAuth);
  document.getElementById("btn-start").addEventListener("click", () => startRun(false));
  document.getElementById("btn-sim").addEventListener("click", () => startRun(true));
  document.getElementById("btn-stop").addEventListener("click", stopRun);
  document.getElementById("btn-save").addEventListener("click", saveRun);
  document.getElementById("btn-discard").addEventListener("click", resetToPre);
  document.getElementById("btn-logout").addEventListener("click", logout);
  document.getElementById("btn-weight-save").addEventListener("click", saveWeight);
  document.getElementById("btn-create-zone").addEventListener("click", enterCreateZone);
  document.getElementById("btn-zone-cancel").addEventListener("click", exitCreateZone);
  document.getElementById("btn-zone-save").addEventListener("click", saveZone);
  document.getElementById("btn-follow").addEventListener("click", doFollow);
  document.getElementById("btn-group-create").addEventListener("click", createGroup);
  document.getElementById("btn-group-back").addEventListener("click", loadGroups);
  document.getElementById("btn-bell").addEventListener("click", openNotif);
  document.getElementById("btn-cq-share").addEventListener("click", shareConquest);
  document.getElementById("btn-cq-close").addEventListener("click", closeConquest);
  document.getElementById("btn-notif-close").addEventListener("click", () =>
    document.getElementById("notif-panel").classList.add("hidden"));
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)));
  setAuthMode("login");

  if (token) { hideAuth(); await afterLogin(); }
  else { showAuth(); }
});

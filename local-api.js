// ============================================================
// KHRONOS RUNNING — BACKEND LOCAL (build de teste, salva no aparelho)
// Implementa window.LocalAPI(method, path, body) replicando o servidor Flask,
// mas 100% offline sobre localStorage. Single-player.
// ============================================================
(function () {
  "use strict";

  // ---------- Constantes (espelham o app.py) ----------
  var LEVELS = [
    ["Ferro", 0], ["Bronze", 5], ["Prata", 11], ["Ouro", 16],
    ["Platina", 22], ["Esmeralda", 36], ["Safira", 48],
    ["Rubi", 61], ["Diamante", 91], ["Diamante Negro", 110],
  ];
  var SEASON_DAYS = 14;
  var SEASON_EPOCH = Date.UTC(2026, 0, 5); // segunda-feira
  var HOT_MULTIPLIER = 2;
  var HOT_THEMES = [
    ["Fúria de Ares", "⚔️"], ["Bênção de Hermes", "🪽"], ["Olhar de Medusa", "🐍"],
    ["Trovão de Thor", "⚡"], ["Chama de Hefesto", "🔥"], ["Sopro de Khronos", "⏳"],
  ];

  // Missões / desafios (definições reais capturadas do servidor)
  var MISSIONS_DAILY = [
    { id: "d_3km", text: "Corra 3 km hoje", target: 3 },
    { id: "d_run", text: "Faça 1 corrida hoje", target: 1 },
  ];
  var MISSIONS_WEEKLY = [
    { id: "w_25km", text: "Acumule 25 km na semana", target: 25 },
    { id: "w_4run", text: "Complete 4 corridas na semana", target: 4 },
    { id: "w_2zone", text: "Conquiste 2 territórios", target: 2 },
  ];
  var STADIUMS = [
    { id: "maracana", name: "Maracanã", city: "Rio de Janeiro", km: 10 },
    { id: "mineirao", name: "Mineirão", city: "Belo Horizonte", km: 8 },
    { id: "morumbi", name: "Morumbi", city: "São Paulo", km: 9 },
    { id: "beira_rio", name: "Beira-Rio", city: "Porto Alegre", km: 8 },
    { id: "arena_corinthians", name: "Neo Química Arena", city: "São Paulo", km: 9 },
    { id: "camp_nou", name: "Camp Nou", city: "Barcelona", km: 12 },
    { id: "wembley", name: "Wembley", city: "Londres", km: 11 },
    { id: "bernabeu", name: "Santiago Bernabéu", city: "Madri", km: 11 },
  ];
  var COUNTRIES = [
    { id: "br", name: "Brasil", flag: "🇧🇷", km: 50 },
    { id: "ar", name: "Argentina", flag: "🇦🇷", km: 40 },
    { id: "pt", name: "Portugal", flag: "🇵🇹", km: 20 },
    { id: "fr", name: "França", flag: "🇫🇷", km: 45 },
    { id: "jp", name: "Japão", flag: "🇯🇵", km: 35 },
    { id: "us", name: "Estados Unidos", flag: "🇺🇸", km: 80 },
  ];

  // ---------- Zonas embutidas (18 pontos turísticos reais de BH) ----------
  var SEED_ZONES = SEED_ZONES_JSON();

  // ---------- localStorage ----------
  var K_USER = "kl_user", K_RUNS = "kl_runs", K_STATE = "kl_state";
  function load(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  // ---------- Geo ----------
  function toRad(d) { return (d * Math.PI) / 180; }
  function haversine(a, b) {
    var R = 6371;
    var dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function pointInPoly(pt, poly) {
    var x = pt[1], y = pt[0], inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][1], yi = poly[i][0], xj = poly[j][1], yj = poly[j][0];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function territoryAt(pt) {
    for (var i = 0; i < SEED_ZONES.length; i++) if (pointInPoly(pt, SEED_ZONES[i].polygon)) return SEED_ZONES[i];
    return null;
  }

  // ---------- Tempo / temporada ----------
  function currentSeason() { return Math.max(0, Math.floor((Date.now() - SEASON_EPOCH) / 86400000 / SEASON_DAYS)); }
  function seasonEnd() { var n = currentSeason(); return SEASON_EPOCH + (n + 1) * SEASON_DAYS * 86400000; }
  function isoWeekIndex(ts) {
    var d = new Date(ts || Date.now());
    var date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    var week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return date.getUTCFullYear() * 53 + week;
  }
  function nextMondayMidnight() {
    var now = new Date();
    var day = now.getDay() || 7;            // 1..7 (seg..dom)
    var add = (8 - day) % 7 || 7;           // dias até a próxima segunda
    var d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + add);
    return d.getTime();
  }
  function todayStart() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function weekStart() {
    var now = new Date(); var day = now.getDay() || 7;
    var d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (day - 1)); return d.getTime();
  }
  function levelFor(km) { var name = LEVELS[0][0]; for (var i = 0; i < LEVELS.length; i++) if (km >= LEVELS[i][1]) name = LEVELS[i][0]; return name; }

  // ---------- Estado de territórios (reseta por temporada) ----------
  function getState() {
    var st = load(K_STATE, null);
    var season = currentSeason();
    if (!st || st.season !== season) {
      st = { season: season, terr: {} }; // zonas voltam a ser disputáveis a cada temporada
      save(K_STATE, st);
    }
    return st;
  }

  // ---------- Zona quente da semana ----------
  function hotZone() {
    if (!SEED_ZONES.length) return null;
    var wk = isoWeekIndex();
    var t = SEED_ZONES[wk % SEED_ZONES.length];
    var th = HOT_THEMES[wk % HOT_THEMES.length];
    return { id: t.id, name: t.name, theme: th[0], icon: th[1] };
  }

  // ---------- Métricas (porta do compute_run_metrics) ----------
  function computeRunMetrics(path, distanceKm, durationS, weightKg) {
    var elev = 0, lastAlt = null, i;
    for (i = 0; i < path.length; i++) {
      var alt = path[i].length >= 4 ? path[i][3] : null;
      if (alt === null || alt === undefined) continue;
      if (lastAlt !== null && (alt - lastAlt) > 1.0) elev += alt - lastAlt;
      lastAlt = alt;
    }
    var splits = [];
    var haveTime = path.length >= 2 && path.every(function (p) { return p.length >= 3 && p[2]; });
    if (haveTime && distanceKm >= 1) {
      var cum = [0], times = [path[0][2]];
      for (i = 1; i < path.length; i++) { cum.push(cum[i - 1] + haversine(path[i - 1], path[i])); times.push(path[i][2]); }
      var timeAtKm = function (target) {
        for (var k = 1; k < cum.length; k++) {
          if (cum[k] >= target) {
            var seg = cum[k] - cum[k - 1];
            if (seg <= 0) return times[k];
            var frac = (target - cum[k - 1]) / seg;
            return times[k - 1] + (times[k] - times[k - 1]) * frac;
          }
        }
        return times[times.length - 1];
      };
      var prevT = times[0];
      for (var km = 1; km <= Math.floor(distanceKm); km++) { var t = timeAtKm(km); splits.push(Math.round((t - prevT) / 1000)); prevT = t; }
    }
    var avgKmh = durationS > 0 ? distanceKm / (durationS / 3600) : 0;
    var w = (weightKg && weightKg > 0) ? weightKg : 70;
    var calories = Math.round(1.036 * w * distanceKm);
    return { elev_gain_m: Math.round(elev * 10) / 10, splits: splits, avg_kmh: Math.round(avgKmh * 100) / 100, calories: calories };
  }

  // ---------- Agregados de corridas ----------
  function allRuns() { return load(K_RUNS, []); }
  function sumKm(runs) { return runs.reduce(function (s, r) { return s + r.distance_km; }, 0); }
  function runsInWeek() { var ws = weekStart(); return allRuns().filter(function (r) { return new Date(r.finished_at).getTime() >= ws; }); }
  function runsToday() { var ts = todayStart(); return allRuns().filter(function (r) { return new Date(r.finished_at).getTime() >= ts; }); }
  function ownedTerritories() {
    var st = getState(), out = [];
    for (var i = 0; i < SEED_ZONES.length; i++) { var z = SEED_ZONES[i]; var e = st.terr[z.id]; if (e && e.km > 0) out.push({ id: z.id, name: z.name }); }
    return out;
  }
  function computeStreak() {
    var runs = allRuns(); if (!runs.length) return 0;
    var days = {}; runs.forEach(function (r) { var d = new Date(r.finished_at); d.setHours(0, 0, 0, 0); days[d.getTime()] = true; });
    var streak = 0, cur = new Date(); cur.setHours(0, 0, 0, 0);
    // se não correu hoje, começa de ontem
    if (!days[cur.getTime()]) cur.setDate(cur.getDate() - 1);
    while (days[cur.getTime()]) { streak++; cur.setDate(cur.getDate() - 1); }
    return streak;
  }
  function records() {
    var runs = allRuns();
    var longest = 0, bestPace = 0, elev = 0, cal = 0;
    runs.forEach(function (r) {
      if (r.distance_km > longest) longest = r.distance_km;
      if (r.distance_km >= 1 && r.duration_s > 0) { var p = r.duration_s / r.distance_km; if (!bestPace || p < bestPace) bestPace = p; }
      elev += r.elev_gain_m || 0; cal += r.calories || 0;
    });
    return { longest_km: Math.round(longest * 100) / 100, best_pace_s: bestPace ? Math.round(bestPace) : 0, total_elev_m: Math.round(elev), total_cal: Math.round(cal) };
  }

  // ---------- Perfil (me / profile) ----------
  function user() { return load(K_USER, null); }
  function meObject() {
    var u = user(); if (!u) return null;
    var wk = sumKm(runsInWeek());
    return {
      id: u.id, username: u.username, bio: u.bio || "", city: u.city || "",
      level: levelFor(wk), week_km: Math.round(wk * 100) / 100, total_km: Math.round(sumKm(allRuns()) * 100) / 100,
      runs: allRuns().length, territories: ownedTerritories().length, streak: computeStreak(),
      records: records(), weight_kg: u.weight_kg || 0,
    };
  }

  // ---------- Dispatcher ----------
  function notFound(p) { var e = new Error("Endpoint local não implementado: " + p); e.status = 404; return e; }

  function handle(method, path, body) {
    method = (method || "GET").toUpperCase();
    var u = user();

    // -- Auth --
    if (path === "/register" && method === "POST") {
      var uname = (body && body.username || "").trim() || (body && body.email || "corredor").split("@")[0];
      var nu = { id: 1, username: uname, email: (body && body.email) || "", weight_kg: 0, bio: "", city: "" };
      save(K_USER, nu);
      return { token: "local", user: meObject() };
    }
    if (path === "/login" && method === "POST") {
      if (!u) { // primeira vez: cria a partir do e-mail
        var nm = (body && body.email || "corredor").split("@")[0];
        save(K_USER, { id: 1, username: nm, email: (body && body.email) || "", weight_kg: 0, bio: "", city: "" });
      }
      return { token: "local", user: meObject() };
    }
    if (path === "/me" && method === "GET") {
      if (!u) { var e = new Error("não autenticado"); e.status = 401; throw e; }
      return meObject();
    }

    // -- Territórios --
    if (path === "/territories" && method === "GET") {
      var st = getState(); var hz = hotZone(); var hotId = hz ? hz.id : null;
      var me = meObject();
      return SEED_ZONES.map(function (z) {
        var e = st.terr[z.id]; var km = e ? e.km : 0;
        var mine = km > 0;
        var reignDays = (mine && e.since) ? Math.floor((Date.now() - e.since) / 86400000) : 0;
        return {
          id: z.id, name: z.name, polygon: z.polygon,
          mine: mine, my_km: Math.round(km * 1000) / 1000,
          owner_id: mine ? me.id : 0, owner_name: mine ? me.username : null,
          owner_km: Math.round(km * 1000) / 1000,
          hot: z.id === hotId, flips: e ? (e.flips || 0) : 0, reign_days: reignDays,
        };
      });
    }
    if (path === "/territories" && method === "POST") {
      // criar zona local (vira mais uma zona embutida nesta sessão/aparelho)
      var poly = body && body.polygon || [];
      var name = (body && body.name || "Minha zona").trim();
      var nid = SEED_ZONES.reduce(function (m, z) { return Math.max(m, z.id); }, 0) + 1;
      SEED_ZONES.push({ id: nid, name: name, polygon: poly });
      save("kl_custom_zones", SEED_ZONES.filter(function (z) { return z.id > 18; }));
      return { id: nid, name: name };
    }

    // -- Temporada / zona quente --
    if (path === "/season" && method === "GET") {
      var end = seasonEnd(); var ms = end - Date.now();
      return { season: currentSeason(), ends_at: new Date(end).toISOString(), days_left: Math.floor(ms / 86400000), hours_left: Math.floor(ms / 3600000) };
    }
    if (path === "/hot_zone" && method === "GET") {
      var hz2 = hotZone(); var hend = nextMondayMidnight(); var hms = hend - Date.now();
      return { hot: hz2, multiplier: HOT_MULTIPLIER, ends_at: new Date(hend).toISOString(), days_left: Math.max(0, Math.ceil(hms / 86400000)) };
    }

    // -- Corridas --
    if (path === "/runs" && method === "GET") {
      return allRuns().slice().reverse().slice(0, 50).map(function (r) {
        var pace = r.distance_km >= 0.05 ? Math.round(r.duration_s / r.distance_km) : 0;
        return { id: r.id, finished_at: r.finished_at, distance_km: Math.round(r.distance_km * 100) / 100, duration_s: r.duration_s, pace_s: pace, elev_gain_m: Math.round(r.elev_gain_m || 0), avg_kmh: r.avg_kmh || 0, calories: r.calories || 0, private: !!r.private };
      });
    }
    if (/^\/runs\/\d+$/.test(path) && method === "GET") {
      var rid = parseInt(path.split("/")[2], 10);
      var run = allRuns().filter(function (r) { return r.id === rid; })[0];
      if (!run) throw notFound(path);
      var pace2 = run.distance_km >= 0.05 ? Math.round(run.duration_s / run.distance_km) : 0;
      return {
        id: run.id, distance_km: Math.round(run.distance_km * 100) / 100, duration_s: run.duration_s, finished_at: run.finished_at,
        pace_s: pace2, elev_gain_m: Math.round(run.elev_gain_m || 0), avg_kmh: run.avg_kmh || 0, calories: run.calories || 0,
        path: (run.path || []).map(function (p) { return [p[0], p[1]]; }), splits: run.splits || [],
      };
    }
    if (/^\/runs\/\d+\/like$/.test(path) && method === "POST") { return { liked: true, likes: 1 }; }
    if (path === "/runs" && method === "POST") {
      var pth = (body && body.path) || [];
      var priv = !!(body && body.private);
      var dur = parseInt((body && body.duration_s) || 0, 10);
      var dist = 0, i2;
      for (i2 = 1; i2 < pth.length; i2++) dist += haversine(pth[i2 - 1], pth[i2]);
      var uu = user(); var weight = uu ? (uu.weight_kg || 0) : 0;
      var m = computeRunMetrics(pth, dist, dur, weight);

      // km por território (só corrida pública disputa)
      var terrGain = {};
      if (!priv) {
        for (i2 = 1; i2 < pth.length; i2++) {
          var seg = haversine(pth[i2 - 1], pth[i2]);
          var z = territoryAt(pth[i2]);
          if (z) terrGain[z.id] = (terrGain[z.id] || 0) + seg;
        }
      }

      // aplica ganho + detecta conquistas (solo: toda zona nova vira sua)
      var st2 = getState(); var hz3 = hotZone(); var hotId2 = hz3 ? hz3.id : null;
      var conquered = [];
      Object.keys(terrGain).forEach(function (idStr) {
        var id = parseInt(idStr, 10);
        var eff = terrGain[id] * (id === hotId2 ? HOT_MULTIPLIER : 1);
        var e = st2.terr[id] || { km: 0, flips: 0, since: null };
        var wasMine = e.km > 0;
        e.km += eff;
        if (!wasMine && e.km > 0) { e.flips = (e.flips || 0) + 1; e.since = Date.now(); var zz = SEED_ZONES.filter(function (x) { return x.id === id; })[0]; conquered.push({ id: id, name: zz ? zz.name : "zona", hot: id === hotId2 }); }
        st2.terr[id] = e;
      });
      save(K_STATE, st2);

      // salva a corrida
      var runs = allRuns();
      var newId = runs.reduce(function (mx, r) { return Math.max(mx, r.id); }, 0) + 1;
      runs.push({
        id: newId, started_at: (body && body.started_at) || new Date().toISOString(),
        finished_at: (body && body.finished_at) || new Date().toISOString(),
        distance_km: Math.round(dist * 1000) / 1000, duration_s: dur, path: pth, private: priv,
        elev_gain_m: m.elev_gain_m, avg_kmh: m.avg_kmh, calories: m.calories, splits: m.splits,
      });
      save(K_RUNS, runs);

      var wk2 = sumKm(runsInWeek());
      var gainOut = {}; Object.keys(terrGain).forEach(function (k) { gainOut[k] = Math.round(terrGain[k] * 1000) / 1000; });
      return {
        distance_km: Math.round(dist * 1000) / 1000, terr_gain: gainOut, conquered: conquered,
        week_km: Math.round(wk2 * 100) / 100, level: levelFor(wk2), hot_zone_id: hotId2,
        elev_gain_m: m.elev_gain_m, avg_kmh: m.avg_kmh, calories: m.calories, splits: m.splits,
      };
    }

    // -- Perfil / peso --
    if (/^\/profile\//.test(path) && method === "GET") {
      var me2 = meObject(); if (!me2) throw notFound(path);
      me2.owned_territories = ownedTerritories();
      me2.trophies = []; // troféus de temporadas passadas: começa vazio no aparelho
      return me2;
    }
    if (path === "/me/weight" && method === "POST") {
      var uw = user(); if (!uw) throw notFound(path);
      var w = parseFloat(body && body.weight_kg); if (!w || w <= 0 || w > 400) { var ee = new Error("peso inválido"); ee.status = 400; throw ee; }
      uw.weight_kg = w; save(K_USER, uw); return { weight_kg: w };
    }

    // -- Ranking (solo: só você) --
    if (path === "/ranking" && method === "GET") {
      var me3 = meObject(); if (!me3) return [];
      return [{ pos: 1, username: me3.username, level: me3.level, week_km: me3.week_km }];
    }

    // -- Social (solo: suas corridas públicas) --
    if (path === "/feed" && method === "GET") {
      var me4 = meObject();
      return allRuns().filter(function (r) { return !r.private; }).slice().reverse().slice(0, 30).map(function (r) {
        return { id: r.id, username: me4 ? me4.username : "você", user_id: 1, distance_km: Math.round(r.distance_km * 100) / 100, duration_s: r.duration_s, finished_at: r.finished_at, likes: 0, liked: false, mine: true };
      });
    }
    if (/^\/follow\//.test(path) && method === "POST") { return { following: false }; } // sem servidor não dá pra seguir

    // -- Missões --
    if (path === "/missions" && method === "GET") {
      var kmToday = sumKm(runsToday()), nToday = runsToday().length;
      var kmWeek = sumKm(runsInWeek()), nWeek = runsInWeek().length, zones = ownedTerritories().length;
      var prog = { d_3km: kmToday, d_run: nToday, w_25km: Math.round(kmWeek * 100) / 100, w_4run: nWeek, w_2zone: zones };
      var build = function (defs) { return defs.map(function (d) { var p = prog[d.id] || 0; return { id: d.id, text: d.text, target: d.target, progress: Math.round(p * 100) / 100, done: p >= d.target }; }); };
      return { daily: build(MISSIONS_DAILY), weekly: build(MISSIONS_WEEKLY) };
    }
    // -- Desafios (estádios / volta ao mundo) --
    if (path === "/challenges" && method === "GET") {
      var total = sumKm(allRuns());
      return {
        total_km: Math.round(total * 100) / 100,
        stadiums: STADIUMS.map(function (s) { return { id: s.id, name: s.name, city: s.city, km: s.km, earned: total >= s.km }; }),
        countries: COUNTRIES.map(function (c) { return { id: c.id, name: c.name, flag: c.flag, km: c.km, pct: Math.min(100, Math.round(total / c.km * 100)), earned: total >= c.km }; }),
      };
    }

    // -- Grupos / notificações (precisam de servidor: vazios) --
    if (path === "/groups" && method === "GET") return [];
    if (path === "/groups" && method === "POST") { var eg = new Error("Grupos precisam de servidor (modo de teste é offline)."); eg.status = 400; throw eg; }
    if (/^\/groups\//.test(path)) { if (method === "POST") { var ej = new Error("Grupos precisam de servidor."); ej.status = 400; throw ej; } return { name: "—", members: [] }; }
    if (path === "/notifications" && method === "GET") return [];
    if (path === "/notifications/seen" && method === "POST") return {};

    throw notFound(path);
  }

  // Exposto pro app.js
  window.LocalAPI = function (method, path, body) {
    return new Promise(function (resolve, reject) {
      try { resolve(handle(method, path, body)); }
      catch (e) { reject(e); }
    });
  };

  // Carrega zonas customizadas salvas antes (se houver)
  try {
    var custom = load("kl_custom_zones", []);
    if (custom && custom.length) custom.forEach(function (z) { if (!SEED_ZONES.some(function (s) { return s.id === z.id; })) SEED_ZONES.push(z); });
  } catch (e) {}

  // ---------- Dados embutidos ----------
  function SEED_ZONES_JSON() {
    return [{"id":1,"name":"Praça Rui Barbosa","polygon":[[-19.91758344229249,-43.93587990332794],[-19.91758344229249,-43.93377789667206],[-19.915607157707512,-43.93377789667206],[-19.915607157707512,-43.93587990332794]]},{"id":2,"name":"Centro de Arte Contemporânea e Fotografia","polygon":[[-19.92063384229249,-43.93900562360354],[-19.92063384229249,-43.93690357639645],[-19.918657557707512,-43.93690357639645],[-19.918657557707512,-43.93900562360354]]},{"id":3,"name":"Praça Zamenhof","polygon":[[-19.91760384229249,-43.929887103463514],[-19.91760384229249,-43.92778509653648],[-19.915627557707513,-43.92778509653648],[-19.915627557707513,-43.929887103463514]]},{"id":4,"name":"Parque Municipal Américo Renné Giannetti","polygon":[[-19.924005242292488,-43.93539804601718],[-19.924005242292488,-43.93329595398283],[-19.92202895770751,-43.93329595398283],[-19.92202895770751,-43.93539804601718]]},{"id":5,"name":"Galería","polygon":[[-19.920199642292488,-43.94181082071725],[-19.920199642292488,-43.93970877928275],[-19.91822335770751,-43.93970877928275],[-19.91822335770751,-43.94181082071725]]},{"id":6,"name":"Monumento à Mãe Mineira","polygon":[[-19.924120142292487,-43.93294574678114],[-19.924120142292487,-43.930843653218865],[-19.92214385770751,-43.930843653218865],[-19.92214385770751,-43.93294574678114]]},{"id":7,"name":"Praça Mucuri","polygon":[[-19.919808342292487,-43.928237618116185],[-19.919808342292487,-43.92613558188381],[-19.91783205770751,-43.92613558188381],[-19.91783205770751,-43.928237618116185]]},{"id":8,"name":"Varanda Urbana","polygon":[[-19.923930142292487,-43.94010754551785],[-19.923930142292487,-43.93800545448215],[-19.92195385770751,-43.93800545448215],[-19.92195385770751,-43.94010754551785]]},{"id":9,"name":"Praça Alberto Mazoni","polygon":[[-19.909666842292488,-43.93756395072487],[-19.909666842292488,-43.935462049275124],[-19.90769055770751,-43.935462049275124],[-19.90769055770751,-43.93756395072487]]},{"id":10,"name":"Sala Juvenal Dias","polygon":[[-19.92642284229249,-43.93451526209262],[-19.92642284229249,-43.93241313790739],[-19.924446557707512,-43.93241313790739],[-19.924446557707512,-43.93451526209262]]},{"id":11,"name":"Praça 1° de Maio","polygon":[[-19.921841542292487,-43.94388413163201],[-19.921841542292487,-43.94178206836799],[-19.91986525770751,-43.94178206836799],[-19.91986525770751,-43.94388413163201]]},{"id":12,"name":"Praça Afonso Arinos","polygon":[[-19.926356742292487,-43.937981361653065],[-19.926356742292487,-43.935879238346935],[-19.92438045770751,-43.935879238346935],[-19.92438045770751,-43.937981361653065]]},{"id":13,"name":"Praça Coronel Guilherme Vaz de Melo","polygon":[[-19.911552342292488,-43.94306146325108],[-19.911552342292488,-43.94095953674893],[-19.90957605770751,-43.94095953674893],[-19.90957605770751,-43.94306146325108]]},{"id":14,"name":"Praça Hugo Werneck","polygon":[[-19.924967742292488,-43.92786055241688],[-19.924967742292488,-43.925758447583114],[-19.92299145770751,-43.925758447583114],[-19.92299145770751,-43.92786055241688]]},{"id":15,"name":"Praça Oswaldo de Mello Campos","polygon":[[-19.92762654229249,-43.9306112700973],[-19.92762654229249,-43.92850912990269],[-19.925650257707513,-43.92850912990269],[-19.925650257707513,-43.9306112700973]]},{"id":16,"name":"Teatro do UNI-BH","polygon":[[-19.90889594229249,-43.942591245603865],[-19.90889594229249,-43.940489354396135],[-19.906919657707512,-43.940489354396135],[-19.906919657707512,-43.942591245603865]]},{"id":17,"name":"Monumento Álvares Cabral","polygon":[[-19.92801804229249,-43.94090947270093],[-19.92801804229249,-43.93880732729907],[-19.926041757707512,-43.93880732729907],[-19.926041757707512,-43.94090947270093]]},{"id":18,"name":"Raul Soares","polygon":[[-19.923189542292487,-43.94628674059384],[-19.923189542292487,-43.944184659406154],[-19.92121325770751,-43.944184659406154],[-19.92121325770751,-43.94628674059384]]}];
  }
})();

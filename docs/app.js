/* Tráfico Zaragoza en directo – solo datos abiertos reales. */
(function () {
  "use strict";

  var ZGZ = "https://www.zaragoza.es/sede/servicio";
  var URLS = {
    cortes: ZGZ + "/via-publica/incidencia.json?rows=500&srsname=wgs84",
    tiempos: ZGZ + "/tiempos-recorrido.json?start=0&rows=-1&srsname=wgs84",
    tranvia: ZGZ + "/urbanismo-infraestructuras/transporte-urbano/parada-tranvia.json?rows=200&srsname=wgs84",
    postes: ZGZ + "/urbanismo-infraestructuras/transporte-urbano/poste-autobus.json?rows=-1&fl=id,title,geometry&srsname=wgs84",
    poste: function (id) { return ZGZ + "/urbanismo-infraestructuras/transporte-urbano/poste-autobus/" + encodeURIComponent(id) + ".json"; },
    dgtInc: "data/dgt_incidencias.json",
    dgtCam: "data/dgt_camaras.json",
    patrones: "data/patrones.json",
    estado: "data/estado.json"
  };
  var COLORS = { red: "#e5484d", orange: "#f5a524", green: "#30a46c", purple: "#8e4ec6", blue: "#0b6bcb", gray: "#8b8d98", dark: "#1c2024" };
  var DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

  // ---------------------------------------------------------------- utilidades
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fetchJSON(url, noCache) {
    var u = noCache ? url + (url.indexOf("?") < 0 ? "?" : "&") + "_=" + Date.now() : url;
    return fetch(u, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function fmtFecha(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d)) return s;
    return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
  }
  function hace(s) {
    var d = new Date(s); if (isNaN(d)) return "";
    var m = Math.round((Date.now() - d) / 60000);
    if (m < 1) return "ahora mismo"; if (m < 60) return "hace " + m + " min";
    var h = Math.round(m / 60); if (h < 48) return "hace " + h + " h";
    return "hace " + Math.round(h / 24) + " días";
  }
  var toastT;
  function toast(msg) { var t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 3500); }

  // ---------------------------------------------------------------- mapa
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([41.6488, -0.8891], 13);
  // Mapa base gratuito de OpenStreetMap (en modo oscuro se oscurece con CSS)
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: dark ? "tiles-dark" : "",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Datos: Ayto. Zaragoza, DGT'
  }).addTo(map);

  var layers = {
    tiempos: { name: "Tráfico urbano: tiempos de recorrido", emoji: "⏱️", color: COLORS.purple, group: L.layerGroup(), on: true, count: "–" },
    dgt: { name: "Incidencias DGT (Z-40, A-2, A-23…)", emoji: "⚠️", color: COLORS.red, group: L.layerGroup(), on: true, count: "–" },
    camaras: { name: "Cámaras DGT (imagen en directo)", emoji: "📷", color: COLORS.dark, group: L.layerGroup(), on: true, count: "–" },
    cortes: { name: "Cortes y obras en la ciudad", emoji: "🚧", color: COLORS.orange, group: L.layerGroup(), on: true, count: "–" },
    tranvia: { name: "Tranvía en directo", emoji: "🚋", color: COLORS.green, group: L.layerGroup(), on: true, count: "–" },
    bus: { name: "Autobús: paradas (acerca el mapa)", emoji: "🚌", color: COLORS.blue, group: L.layerGroup(), on: true, count: "–" }
  };
  var heat = null;

  function renderLayerList() {
    var html = "";
    Object.keys(layers).forEach(function (k) {
      var l = layers[k];
      html += '<label class="layer"><input type="checkbox" data-layer="' + k + '"' + (l.on ? " checked" : "") + '>' +
        '<span class="lemo">' + l.emoji + '</span><span class="name">' + esc(l.name) + '</span>' +
        '<span class="count">' + esc(l.count) + "</span></label>";
    });
    $("layerList").innerHTML = html;
    Array.prototype.forEach.call($("layerList").querySelectorAll("input"), function (i) {
      i.addEventListener("change", function () { setLayer(i.getAttribute("data-layer"), i.checked); });
    });
  }
  function setCount(k, n) { layers[k].count = n; renderLayerList(); }
  function setLayer(k, on) {
    var l = layers[k]; l.on = on;
    if (k === "bus") { updateBusVisibility(); return; }
    if (on) l.group.addTo(map); else map.removeLayer(l.group);
  }
  Object.keys(layers).forEach(function (k) { if (k !== "bus") layers[k].group.addTo(map); });

  // Icono con emoji dentro de una "burbuja" blanca con borde de color
  function emojiIcon(emoji, border, opts) {
    opts = opts || {};
    var h = opts.size || 30, w = opts.wide ? Math.round(h * 1.6) : h;
    var label = opts.label ? '<span class="emo-lbl" style="background:' + border + '">' + esc(opts.label) + "</span>" : "";
    return L.divIcon({ className: "", html: '<div class="emo' + (opts.cls ? " " + opts.cls : "") + '" style="width:' + w + "px;height:" + h + "px;font-size:" + Math.round(h * .55) + "px;border-color:" + border + '">' + emoji + label + "</div>",
      iconSize: [w, h], iconAnchor: [w / 2, h / 2], popupAnchor: [0, -h / 2], tooltipAnchor: [w / 2, 0] });
  }
  function divIcon(cls, html, size, bg) {
    return L.divIcon({ className: "", html: '<div class="' + cls + '" style="width:' + size + "px;height:" + size + "px;" + (bg ? "background:" + bg : "") + '">' + html + "</div>", iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }

  // ---------------------------------------------------------------- capa 1: tiempos de recorrido (paneles)
  function loadTiempos() {
    return fetchJSON(URLS.tiempos, true).then(function (d) {
      var g = layers.tiempos.group; g.clearLayers();
      var conDatos = 0;
      (d.result || []).forEach(function (r) {
        var c = r.geometry && r.geometry.coordinates; if (!c) return;
        var tmp = document.createElement("div"); tmp.innerHTML = r.description || "";
        var items = Array.prototype.map.call(tmp.querySelectorAll("li"), function (li) { return li.textContent.trim(); }).filter(Boolean);
        if (items.length) conDatos++;
        var body = items.length ? "<ul>" + items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>"
          : '<p class="muted">El panel no publica tiempos de recorrido en este momento.</p>';
        L.marker([c[1], c[0]], { icon: divIcon("panel-icon", "⏱", 22, items.length ? COLORS.purple : COLORS.gray) })
          .bindPopup("<h3>" + esc(r.title) + "</h3>" + body + '<p class="muted">Panel informativo del Ayuntamiento · en directo</p>')
          .addTo(g);
      });
      setCount("tiempos", conDatos + "/" + (d.result || []).length);
    }).catch(function () { setCount("tiempos", "sin conexión"); });
  }

  // ---------------------------------------------------------------- capa 2: incidencias DGT
  function colorDGT(i) {
    if (i.causa === "accident" || i.causa === "abnormalTraffic") return COLORS.red;
    if (i.causa === "roadMaintenance") return COLORS.orange;
    if (i.causa === "vehicleObstruction" || i.causa === "obstruction") return "#d6409f";
    return COLORS.purple;
  }
  function emojiDGT(i) {
    if (i.causa === "accident") return "🚗💥";
    if (i.causa === "abnormalTraffic" || /retenci|denso|lento|detenido/i.test(i.detalle || "") && i.causa !== "vehicleObstruction") return "🚗🚙";
    if (i.causa === "roadMaintenance") return /cortad/i.test(i.afeccion || "") ? "🚧" : "🚜";
    if (/cortad/i.test(i.afeccion || "") && i.causa !== "vehicleObstruction") return "🚧";
    return "⚠️";
  }
  function popupDGT(i) {
    return "<h3>" + emojiDGT(i) + " " + esc(i.carretera || "Carretera") + " · " + esc(i.tipo) + "</h3><table>" +
      (i.detalle ? "<tr><td>Detalle</td><td>" + esc(i.detalle) + "</td></tr>" : "") +
      (i.afeccion ? "<tr><td>Afección</td><td>" + esc(i.afeccion) + "</td></tr>" : "") +
      "<tr><td>Tramo</td><td>km " + esc(i.desde.km) + (i.hasta && i.hasta.km !== i.desde.km ? " → " + esc(i.hasta.km) : "") + "</td></tr>" +
      (i.desde.municipio ? "<tr><td>Municipio</td><td>" + esc(i.desde.municipio) + "</td></tr>" : "") +
      (i.sentido ? "<tr><td>Sentido</td><td>" + esc({ both: "Ambos", positive: "Creciente", negative: "Decreciente" }[i.sentido] || i.sentido) + "</td></tr>" : "") +
      (i.inicio ? "<tr><td>Desde</td><td>" + esc(fmtFecha(i.inicio)) + "</td></tr>" : "") +
      (i.fin ? "<tr><td>Hasta</td><td>" + esc(fmtFecha(i.fin)) + "</td></tr>" : "") +
      "</table>" + (i.comentario ? "<p>" + esc(i.comentario) + "</p>" : "") + '<p class="muted">Fuente: DGT (NAP)</p>';
  }
  var dgtMarkers = {};
  function loadDGT() {
    return fetchJSON(URLS.dgtInc, true).then(function (d) {
      var g = layers.dgt.group; g.clearLayers(); dgtMarkers = {};
      var inc = d.incidencias || [];
      inc.sort(function (a, b) { var p = function (x) { return x.causa === "accident" ? 0 : x.causa === "roadMaintenance" ? 2 : 1; }; return p(a) - p(b); });
      var html = "";
      inc.forEach(function (i) {
        var col = colorDGT(i);
        var a = [i.desde.lat, i.desde.lon], b = [i.hasta.lat, i.hasta.lon];
        var popup = popupDGT(i);
        if (a[0] !== b[0] || a[1] !== b[1]) L.polyline([a, b], { color: col, weight: 6, opacity: .8 }).bindPopup(popup).addTo(g);
        var em = emojiDGT(i);
        var m = L.marker(a, { icon: emojiIcon(em, col, { wide: em.length > 2 && em !== "⚠️", size: 32 }), zIndexOffset: 500 }).bindPopup(popup).addTo(g);
        dgtMarkers[i.id] = m;
        html += '<li data-id="' + esc(i.id) + '"><span class="tag" style="background:' + col + '">' + emojiDGT(i) + " " + esc(i.tipo) + "</span><b>" + esc(i.carretera) + " km " + esc(i.desde.km) + (i.desde.municipio ? " · " + esc(i.desde.municipio) : "") + "</b><small>" + esc([i.detalle, i.afeccion].filter(Boolean).join(" · ")) + "</small></li>";
      });
      $("dgtList").innerHTML = html || "<li><small>No hay incidencias activas ahora mismo en la zona.</small></li>";
      $("dgtMeta").textContent = inc.length + " activas · datos de la DGT descargados " + hace(d.descargado) + " (" + fmtFecha(d.descargado) + ")";
      setCount("dgt", inc.length);
      Array.prototype.forEach.call($("dgtList").querySelectorAll("li[data-id]"), function (li) {
        li.addEventListener("click", function () { var m = dgtMarkers[li.getAttribute("data-id")]; if (m) { map.setView(m.getLatLng(), 14); m.openPopup(); } });
      });
    }).catch(function () { $("dgtMeta").textContent = "Aún no hay datos de la DGT (el recolector no se ha ejecutado)."; setCount("dgt", "–"); });
  }

  // ---------------------------------------------------------------- capa 3: cámaras DGT
  var camTimer = null;
  function openCam(c) {
    $("camTitle").textContent = (c.carretera || "") + " km " + (c.km || "");
    $("camSub").textContent = c.destino ? "Sentido / ubicación: " + c.destino : "";
    var load = function () { $("camImg").src = c.url + "?t=" + Date.now(); };
    load(); clearInterval(camTimer); camTimer = setInterval(load, 60000);
    $("camDialog").showModal();
  }
  $("camDialog").addEventListener("close", function () { clearInterval(camTimer); $("camImg").removeAttribute("src"); });
  $("camImg").addEventListener("error", function () { if ($("camImg").getAttribute("src")) toast("La DGT no ha devuelto imagen para esta cámara ahora mismo."); });
  function loadCamaras() {
    return fetchJSON(URLS.dgtCam, true).then(function (d) {
      var g = layers.camaras.group; g.clearLayers();
      (d.camaras || []).forEach(function (c) {
        L.marker([c.lat, c.lon], { icon: divIcon("cam-icon", "📷", 22), title: (c.carretera || "") + " km " + c.km })
          .on("click", function () { openCam(c); }).addTo(g);
      });
      setCount("camaras", (d.camaras || []).length);
    }).catch(function () { setCount("camaras", "–"); });
  }

  // ---------------------------------------------------------------- capa 4: cortes del Ayuntamiento
  function colorCorte(tipo) {
    if (/corte/i.test(tipo || "")) return COLORS.red;
    if (/transporte/i.test(tipo || "")) return COLORS.blue;
    return COLORS.orange;
  }
  function emojiCorte(tipo, r) {
    if (/corte/i.test(tipo || "")) return "🚧";
    if (/obra|reforma|urbaniza|asfalt|pavimen|renovaci|instalaci|canaliza|red de|zanja|construcci/i.test((r.title || "") + " " + (r.motivo || ""))) return "🚜";
    return "🚗🚙";
  }
  var corteMarkers = {};
  function loadCortes() {
    return fetchJSON(URLS.cortes, true).then(function (d) {
      var g = layers.cortes.group; g.clearLayers(); corteMarkers = {};
      var res = d.result || []; var html = "";
      res.forEach(function (r) {
        var m = /Tipo:\s*([^<]+)/.exec(r.description || ""); var tipo = m ? m[1].trim() : "Afección";
        var col = colorCorte(tipo), em = emojiCorte(tipo, r);
        var popup = "<h3>" + em + " " + esc(r.title) + '</h3><p><span class="tag" style="background:' + col + '">' + esc(tipo) + "</span></p><table>" +
          (r.calle ? "<tr><td>Dirección</td><td>" + esc(r.calle) + "</td></tr>" : "") +
          (r.inicio ? "<tr><td>Inicio</td><td>" + esc(fmtFecha(r.inicio).slice(0, 10)) + "</td></tr>" : "") +
          (r.fin ? "<tr><td>Fin</td><td>" + esc(fmtFecha(r.fin).slice(0, 10)) + "</td></tr>" : "") +
          "</table>" + (r.tramo ? "<p><b>Tramo:</b> " + esc(r.tramo) + "</p>" : "") + (r.motivo ? "<p><b>Motivo:</b> " + esc(r.motivo) + "</p>" : "") +
          (r.observaciones ? "<p>" + esc(r.observaciones) + "</p>" : "") + '<p class="muted">Fuente: Ayuntamiento de Zaragoza · actualizado ' + esc(fmtFecha(r.lastUpdated)) + "</p>";
        if (r.line && r.line.coordinates) {
          var lines = r.line.type === "MultiLineString" ? r.line.coordinates : [r.line.coordinates];
          lines.forEach(function (ln) { L.polyline(ln.map(function (p) { return [p[1], p[0]]; }), { color: col, weight: 7, opacity: .85 }).bindPopup(popup).addTo(g); });
        }
        var c = r.geometry && r.geometry.coordinates;
        if (c) { corteMarkers[r.id] = L.marker([c[1], c[0]], { icon: emojiIcon(em, col, { wide: em.length > 2, size: 28 }), zIndexOffset: 300 }).bindPopup(popup).addTo(g); }
        html += '<li data-id="' + esc(r.id) + '"><span class="tag" style="background:' + col + '">' + em + " " + esc(tipo) + "</span><b>" + esc(r.title) + "</b><small>" + esc((r.tramo || r.calle || "").slice(0, 140)) + "</small></li>";
      });
      $("cortesList").innerHTML = html || "<li><small>No hay cortes publicados ahora mismo.</small></li>";
      $("cortesMeta").textContent = res.length + " activas · en directo del Ayuntamiento · consultado " + new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
      setCount("cortes", res.length);
      Array.prototype.forEach.call($("cortesList").querySelectorAll("li[data-id]"), function (li) {
        li.addEventListener("click", function () { var m = corteMarkers[li.getAttribute("data-id")]; if (m) { map.setView(m.getLatLng(), 16); m.openPopup(); } });
      });
    }).catch(function () { $("cortesMeta").textContent = "No se ha podido conectar con el Ayuntamiento. Se reintentará."; });
  }

  // ---------------------------------------------------------------- capa 5a: tranvía (paradas + posición estimada)
  function colorEspera(min) { if (min == null) return COLORS.gray; if (min <= 5) return COLORS.green; if (min <= 10) return COLORS.orange; return COLORS.red; }
  var tranviaMarkers = {}, tramVeh = L.layerGroup().addTo(layers.tranvia.group);
  function lerp(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
  function distM(a, b) { var dy = (a[0] - b[0]) * 111320, dx = (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180); return Math.sqrt(dx * dx + dy * dy); }
  /* Calcula dónde está cada vehículo a partir de los tiempos de llegada a las paradas, en orden de recorrido.
     Si el siguiente vehículo llega antes a la parada i que a la parada i-1, es que ya ha pasado la i-1:
     está entre ambas. Cuanto menos le falte, más cerca de la parada i. */
  function estimarVehiculos(seq, minPorMetro) {
    var out = [];
    for (var i = 0; i < seq.length; i++) {
      var s = seq[i]; if (s.eta == null) continue;
      if (s.eta === 0) { out.push({ pos: s.pos, junto: s, eta: 0, info: s.info, i: i, prog: i }); continue; }
      var p = seq[i - 1];
      if (!p || p.eta == null || p.corte) continue;
      if (s.eta < p.eta) {
        var tSeg = Math.max(1, distM(p.pos, s.pos) * minPorMetro);
        var f = Math.min(0.95, Math.max(0.05, 1 - s.eta / tSeg));
        out.push({ pos: lerp(p.pos, s.pos, f), junto: s, eta: s.eta, info: s.info, i: i, prog: i - 1 + f });
      }
    }
    return out;
  }
  /* Flota: mantiene los vehículos de cada sentido entre actualizaciones y los mueve suavemente.
     Cada vehículo avanza hacia su siguiente parada para llegar justo cuando dicen los tiempos de llegada;
     al llegar espera unos segundos y sigue hacia la siguiente. Cada nueva consulta corrige su posición. */
  function Flota(group) { this.group = group; this.dirs = {}; }
  Flota.prototype.clear = function () { this.group.clearLayers(); this.dirs = {}; };
  Flota.prototype.count = function () { var n = 0, d = this.dirs; Object.keys(d).forEach(function (k) { n += d[k].veh.length; }); return n; };
  Flota.prototype.update = function (key, seq, ests, minPorMetro, build) {
    var prev = this.dirs[key] ? this.dirs[key].veh.slice() : [], now = Date.now(), group = this.group, out = [];
    ests.sort(function (a, b) { return b.prog - a.prog; });
    ests.forEach(function (e) {
      var best = null, bd = 1e9;
      prev.forEach(function (o) { if (o.used) return; var d = e.prog - o.p; if (d > -0.8 && d < 2 && Math.abs(d) < bd) { bd = Math.abs(d); best = o; } });
      var b = build(e), v;
      if (best) { best.used = true; v = best; v.marker.setPopupContent(b.popup); v.marker.setTooltipContent(b.tip); }
      else { v = { pd: e.prog, marker: L.marker(e.pos, { icon: b.icon, zIndexOffset: 1000 }).bindPopup(b.popup).bindTooltip(b.tip).addTo(group) }; }
      v.p = Math.max(e.prog, best ? Math.min(best.p, e.i) : e.prog);
      v.i = e.i; v.arrive = now + e.eta * 60000;
      out.push(v);
    });
    prev.forEach(function (o) { if (!o.used) group.removeLayer(o.marker); });
    out.forEach(function (v) { v.used = false; });
    this.dirs[key] = { seq: seq, veh: out, mpm: minPorMetro };
  };
  Flota.prototype.tick = function (dt) {
    var now = Date.now(), dirs = this.dirs;
    Object.keys(dirs).forEach(function (k) {
      var D = dirs[k], seq = D.seq;
      D.veh.forEach(function (v) {
        if (now < v.arrive) {
          var rest = (v.arrive - now) / 1000;
          v.p += (v.i - v.p) * Math.min(1, dt / rest);
        } else if (now > v.arrive + 20000 && v.i + 1 < seq.length && !seq[v.i].corte) {
          var tSeg = Math.max(60, distM(seq[v.i].pos, seq[v.i + 1].pos) * D.mpm * 60);
          v.p = Math.min(v.i + 0.9, v.p + dt / tSeg);
        } else { v.p = Math.max(v.p, Math.min(v.i, v.p + dt / 10)); }
        v.pd += (v.p - v.pd) * Math.min(1, dt * 1.2);
        var kk = Math.floor(v.pd), f = v.pd - kk;
        var pos = kk >= seq.length - 1 ? seq[seq.length - 1].pos : (kk < 0 ? seq[0].pos : lerp(seq[kk].pos, seq[kk + 1].pos, f));
        v.marker.setLatLng(pos);
      });
    });
  };
  var flotas = [];
  setInterval(function () { flotas.forEach(function (f) { f.tick(0.25); }); }, 250);
  var tramFlota = new Flota(tramVeh); flotas.push(tramFlota);

  function loadTranvia() {
    return fetchJSON(URLS.tranvia, true).then(function (d) {
      var res = d.result || []; var activas = 0;
      var dirs = { 1: [], 2: [] };
      res.forEach(function (r) {
        var c = r.geometry && r.geometry.coordinates; if (!c) return;
        var dest = r.destinos || [];
        var mins = dest.map(function (x) { return x.minutos; }).filter(function (x) { return typeof x === "number"; });
        var min = mins.length ? Math.min.apply(null, mins) : null; if (min != null) activas++;
        var primero = dest.filter(function (x) { return x.minutos === min; })[0];
        var n = parseInt(r.id, 10); if (!isNaN(n) && dirs[n % 10]) dirs[n % 10].push({ id: n, title: r.title, pos: [c[1], c[0]], eta: min, info: primero });
        var popup = "<h3>🚉 Parada " + esc(r.title) + "</h3>" + (dest.length ? "<table>" + dest.map(function (x) {
          return "<tr><td>" + esc(x.linea) + "</td><td>" + esc(x.destino) + "</td><td><b>" + esc(x.minutos) + " min</b></td></tr>";
        }).join("") + "</table>" : '<p class="muted">Sin llegadas previstas ahora.</p>') +
          '<p class="muted">Tiempo real · actualizado ' + esc((r.lastUpdated || "").slice(11, 16)) + "</p>";
        var m = tranviaMarkers[r.id];
        var tip = r.title + (min != null ? " · próximo en " + min + " min" : "");
        if (m) { m.setIcon(emojiIcon("🚉", colorEspera(min), { size: 22, cls: "stop" })); m.setPopupContent(popup); m.setTooltipContent(tip); }
        else { tranviaMarkers[r.id] = L.marker([c[1], c[0]], { icon: emojiIcon("🚉", colorEspera(min), { size: 22, cls: "stop" }) }).bindPopup(popup).bindTooltip(tip).addTo(layers.tranvia.group); }
      });
      // Sentido 1 (id acabado en 1): hacia Mago de Oz, ids crecientes. Sentido 2: hacia Av. Academia, ids decrecientes.
      dirs[1].sort(function (a, b) { return a.id - b.id; });
      dirs[2].sort(function (a, b) { return b.id - a.id; });
      [1, 2].forEach(function (k) {
        tramFlota.update("d" + k, dirs[k], estimarVehiculos(dirs[k], 1 / 300), 1 / 300, function (v) {
          var destino = v.info ? v.info.destino : (k === 1 ? "MAGO DE OZ" : "AVENIDA ACADEMIA");
          var doble = /doble/i.test(destino || ""), dest = String(destino).replace(/ - Tranvia doble/i, "");
          return {
            icon: emojiIcon("🚋", COLORS.green, { size: 34, cls: "veh", label: k === 1 ? "↓" : "↑" }),
            tip: "Tranvía hacia " + dest,
            popup: "<h3>🚋 Tranvía L1" + (doble ? " (doble)" : "") + "</h3><p>Hacia <b>" + esc(dest) + "</b><br>" +
              (v.eta === 0 ? "En la parada <b>" + esc(v.junto.title) + "</b>" : "Llega a <b>" + esc(v.junto.title) + "</b> en " + v.eta + " min") +
              '</p><p class="muted">Posición estimada a partir de los tiempos de llegada en las paradas (no es GPS). Se corrige cada 30 s.</p>'
          };
        });
      });
      var total = tramFlota.count();
      setCount("tranvia", total + " en marcha · " + activas + " paradas");
    }).catch(function () { setCount("tranvia", "sin conexión"); });
  }

  // ---------------------------------------------------------------- capa 5b: autobús (postes; llegada al pulsar)
  var busLoaded = false, BUS_ZOOM = 15;
  function loadPostes() {
    return fetchJSON(URLS.postes).then(function (d) {
      var g = layers.bus.group; var res = d.result || [];
      res.forEach(function (r) {
        var c = r.geometry && r.geometry.coordinates; if (!c) return;
        L.marker([c[1], c[0]], { icon: emojiIcon("🚏", "#c7cbd1", { size: 20, cls: "stop" }) })
          .bindPopup("<h3>🚏 " + esc(r.title) + '</h3><p class="muted">Consultando llegadas…</p>')
          .on("popupopen", function (e) { busPopup(e.popup, r); })
          .addTo(g);
      });
      busLoaded = true; setCount("bus", res.length + " paradas"); updateBusVisibility();
    }).catch(function () { setCount("bus", "sin conexión"); });
  }
  function busPopup(popup, r) {
    fetchJSON(URLS.poste(r.id), true).then(function (d) {
      var dest = d.destinos || [];
      popup.setContent("<h3>🚌 " + esc(d.title || r.title) + "</h3>" + (dest.length ? "<table><tr><td><b>Línea</b></td><td><b>Destino</b></td><td><b>1.º</b></td><td><b>2.º</b></td></tr>" + dest.map(function (x) {
        return "<tr><td>" + esc(x.linea) + "</td><td>" + esc((x.destino || "").replace(/,$/, "")) + "</td><td>" + esc((x.primero || "").replace(" minutos.", " min").replace(".", "")) + "</td><td>" + esc((x.segundo || "").replace(" minutos.", " min").replace(".", "")) + "</td></tr>";
      }).join("") + "</table>" : '<p class="muted">Sin llegadas previstas ahora.</p>') + '<p class="muted">Tiempo real · ' + esc((d.lastUpdated || "").slice(11, 16)) + "</p>");
    }).catch(function () { popup.setContent("<h3>🚌 " + esc(r.title) + '</h3><p class="muted">No se ha podido consultar ahora.</p>'); });
  }
  function updateBusVisibility() {
    var show = layers.bus.on && busLoaded && map.getZoom() >= BUS_ZOOM;
    if (show && !map.hasLayer(layers.bus.group)) layers.bus.group.addTo(map);
    if (!show && map.hasLayer(layers.bus.group)) map.removeLayer(layers.bus.group);
  }
  map.on("zoomend", updateBusVisibility);

  // ---------------------------------------------------------------- capa 5c: autobuses en circulación de una línea (posición estimada)
  var busVeh = L.layerGroup().addTo(map), busRuta = L.layerGroup().addTo(busVeh), busFlota = new Flota(L.layerGroup().addTo(busVeh)), busLinea = null, busTimer = null, busCache = {};
  flotas.push(busFlota);
  function parseEta(t) {
    if (!t) return null;
    if (/en la parada/i.test(t)) return 0;
    var m = /(\d+)\s*min/i.exec(t); return m ? parseInt(m[1], 10) : null;
  }
  function normDest(d) { return String(d || "").replace(/[.,]+\s*$/, "").trim().toUpperCase(); }
  function pool(items, n, fn) {
    var i = 0, out = new Array(items.length);
    function next() { if (i >= items.length) return Promise.resolve(); var k = i++; return fn(items[k]).then(function (v) { out[k] = v; }, function () { out[k] = null; }).then(next); }
    var w = []; for (var j = 0; j < n; j++) w.push(next());
    return Promise.all(w).then(function () { return out; });
  }
  function loadLineas() {
    return fetchJSON(ZGZ + "/urbanismo-infraestructuras/transporte-urbano/linea-autobus.json").then(function (d) {
      var ids = (d.result || []).map(function (u) { return String(u).split("/").pop(); });
      ids.sort(function (a, b) { var na = parseInt(a, 10), nb = parseInt(b, 10); if (!isNaN(na) && !isNaN(nb)) return na - nb; if (!isNaN(na)) return -1; if (!isNaN(nb)) return 1; return a.localeCompare(b); });
      $("busLinea").innerHTML = '<option value="">— elige una línea —</option>' + ids.map(function (x) { return '<option value="' + esc(x) + '">Línea ' + esc(x) + "</option>"; }).join("");
    }).catch(function () { $("busEstado").textContent = "No se ha podido cargar la lista de líneas."; });
  }
  function paradasLinea(id) {
    if (busCache[id]) return Promise.resolve(busCache[id]);
    return fetchJSON(ZGZ + "/urbanismo-infraestructuras/transporte-urbano/linea-autobus/" + encodeURIComponent(id) + ".json?srsname=wgs84").then(function (d) {
      var paradas = [], trazado = [];
      (d.result || []).forEach(function (r) {
        var g = r.geometry || {};
        if (g.type === "Point" && r.about) paradas.push({ id: String(r.about).split("/").pop(), title: (r.title || "").replace(/^Parada\s+/, ""), pos: [g.coordinates[1], g.coordinates[0]] });
        else if (g.type === "MultiLineString") g.coordinates.forEach(function (ln) { trazado.push(ln.map(function (p) { return [p[1], p[0]]; })); });
        else if (g.type === "LineString") trazado.push(g.coordinates.map(function (p) { return [p[1], p[0]]; }));
      });
      busCache[id] = { paradas: paradas, trazado: trazado };
      return busCache[id];
    });
  }
  function cargarBuses() {
    var id = busLinea; if (!id) return;
    $("busEstado").textContent = "Consultando las paradas de la línea " + id + "…";
    paradasLinea(id).then(function (L1) {
      return pool(L1.paradas, 6, function (p) { return fetchJSON(URLS.poste(p.id), true); }).then(function (res) {
        if (busLinea !== id) return;
        var porDestino = {}, ok = 0;
        L1.paradas.forEach(function (p, k) {
          var r = res[k]; if (!r) return; ok++;
          (r.destinos || []).forEach(function (x) {
            if (String(x.linea) !== String(id)) return;
            var dn = normDest(x.destino); (porDestino[dn] = porDestino[dn] || []).push({ title: p.title, pos: p.pos, eta: parseEta(x.primero), info: x });
          });
        });
        busRuta.clearLayers();
        L1.trazado.forEach(function (ln) { L.polyline(ln, { color: COLORS.blue, weight: 4, opacity: .35, interactive: false }).addTo(busRuta); });
        var vistos = {};
        Object.keys(porDestino).forEach(function (dn) {
          var seq = porDestino[dn]; vistos[dn] = true;
          for (var i = 1; i < seq.length; i++) if (distM(seq[i - 1].pos, seq[i].pos) > 1500) seq[i - 1].corte = true;
          busFlota.update(dn, seq, estimarVehiculos(seq, 1 / 230), 1 / 230, function (v) {
            return {
              icon: emojiIcon("🚌", COLORS.blue, { size: 34, cls: "veh", label: id }),
              tip: "Línea " + id + " hacia " + dn,
              popup: "<h3>🚌 Línea " + esc(id) + "</h3><p>Hacia <b>" + esc(dn) + "</b><br>" +
                (v.eta === 0 ? "En la parada <b>" + esc(v.junto.title) + "</b>" : "Llega a <b>" + esc(v.junto.title) + "</b> en " + v.eta + " min") +
                '</p><p class="muted">Posición estimada a partir de los tiempos de llegada en las paradas (no es GPS).</p>'
            };
          });
        });
        Object.keys(busFlota.dirs).forEach(function (k) { if (!vistos[k]) busFlota.update(k, busFlota.dirs[k].seq, [], 1 / 230, null); });
        var total = busFlota.count();
        $("busEstado").textContent = "Línea " + id + ": " + total + " autobuses en circulación (estimado) · " + ok + " paradas consultadas · " + new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }) + ". Se actualiza cada minuto.";
      });
    }).catch(function () { $("busEstado").textContent = "No se ha podido consultar la línea " + id + " ahora."; });
  }
  $("busLinea").addEventListener("change", function () {
    busLinea = this.value || null; clearInterval(busTimer); busRuta.clearLayers(); busFlota.clear();
    if (!busLinea) { $("busEstado").textContent = ""; return; }
    cargarBuses(); busTimer = setInterval(cargarBuses, 60 * 1000);
    paradasLinea(busLinea).then(function (L1) { var pts = L1.paradas.map(function (p) { return p.pos; }); if (pts.length) map.fitBounds(pts, { padding: [30, 30] }); });
  });

  // ---------------------------------------------------------------- patrones (histórico)
  var puntoMarkers = [];
  function loadPatrones() {
    return fetchJSON(URLS.patrones, true).then(function (p) {
      var horas = p.fotos ? Math.round(p.fotos * 10 / 60) : 0;
      $("patMeta").textContent = "Histórico recogido desde " + fmtFecha(p.desde) + " · " + p.fotos + " fotos (≈" + horas + " h de datos, " + p.dias + " días) · " + p.incidencias_distintas + " incidencias distintas." +
        (p.dias < 7 ? " Los patrones serán fiables cuando haya varias semanas de datos." : "");
      // tabla día x hora
      var max = 0; p.media_activas.forEach(function (row) { row.forEach(function (v) { if (v != null && v > max) max = v; }); });
      var html = '<table class="grid"><tr><th></th>';
      for (var h = 0; h < 24; h++) html += "<th>" + (h % 3 === 0 ? h : "") + "</th>";
      html += "</tr>";
      p.media_activas.forEach(function (row, d) {
        html += "<tr><th>" + DIAS[d] + "</th>";
        row.forEach(function (v, h) {
          var a = v == null || !max ? 0 : 0.12 + 0.88 * v / max;
          html += '<td title="' + DIAS[d] + " " + h + ":00 · " + (v == null ? "sin datos" : v + " activas de media, " + p.nuevas[d][h] + " nuevas") + '" style="' + (v == null ? "" : "background:rgba(229,72,77," + a.toFixed(2) + ")") + '"></td>';
        });
        html += "</tr>";
      });
      $("grid").innerHTML = html + "</table>";
      // puntos recurrentes
      var lh = "";
      (p.puntos || []).slice(0, 15).forEach(function (pt, i) {
        var causas = Object.keys(pt.causas).map(function (k) { return k + " (" + pt.causas[k] + ")"; }).join(", ");
        lh += '<li data-i="' + i + '"><b>' + esc(pt.carretera) + " · " + pt.incidencias + (pt.incidencias === 1 ? " incidencia" : " incidencias") + "</b><small>" + pt.dias + (pt.dias === 1 ? " día" : " días") + " con incidencias · " + esc(causas) + "</small></li>";
      });
      $("puntosList").innerHTML = lh || "<li><small>Todavía no hay histórico suficiente.</small></li>";
      Array.prototype.forEach.call($("puntosList").querySelectorAll("li[data-i]"), function (li) {
        li.addEventListener("click", function () {
          var pt = p.puntos[+li.getAttribute("data-i")];
          puntoMarkers.forEach(function (m) { map.removeLayer(m); });
          var m = L.circle([pt.lat, pt.lon], { radius: 300, color: COLORS.red, weight: 2, fillOpacity: .15 }).addTo(map)
            .bindPopup("<h3>Punto recurrente</h3><p>" + esc(pt.carretera) + "<br>" + pt.incidencias + " incidencias distintas en " + pt.dias + " días</p>").openPopup();
          puntoMarkers = [m]; map.setView([pt.lat, pt.lon], 14);
        });
      });
      // mapa de calor
      if (heat) map.removeLayer(heat);
      var maxH = 1; (p.calor || []).forEach(function (c) { if (c[2] > maxH) maxH = c[2]; });
      heat = L.heatLayer((p.calor || []).map(function (c) { return [c[0], c[1], c[2] / maxH]; }), { radius: 25, blur: 20, maxZoom: 14 });
      if ($("heatToggle").checked) heat.addTo(map);
    }).catch(function () { $("patMeta").textContent = "Todavía no hay histórico."; });
  }
  $("heatToggle").addEventListener("change", function () { if (!heat) return; if (this.checked) heat.addTo(map); else map.removeLayer(heat); });

  function loadEstado() {
    return fetchJSON(URLS.estado, true).then(function (e) {
      var errs = Object.keys(e.errores || {});
      $("estadoMeta").textContent = "Última ejecución del recolector: " + fmtFecha(e.ultima_ejecucion) + " (" + hace(e.ultima_ejecucion) + ")" + (errs.length ? " · fuentes con error: " + errs.join(", ") : " · todas las fuentes respondieron.");
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- interfaz
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
    b.addEventListener("click", function () {
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b); });
      Array.prototype.forEach.call(document.querySelectorAll(".tabpane"), function (x) { x.classList.toggle("active", x.id === "tab-" + b.getAttribute("data-tab")); });
    });
  });
  $("togglePanel").addEventListener("click", function () { $("panel").classList.add("hidden"); $("showPanel").hidden = false; setTimeout(function () { map.invalidateSize(); }, 50); });
  $("showPanel").addEventListener("click", function () { $("panel").classList.remove("hidden"); $("showPanel").hidden = true; setTimeout(function () { map.invalidateSize(); }, 50); });

  renderLayerList();
  loadLineas();
  loadTiempos(); loadDGT(); loadCamaras(); loadCortes(); loadTranvia(); loadPostes(); loadPatrones(); loadEstado();
  setInterval(loadTranvia, 30 * 1000);
  setInterval(loadTiempos, 2 * 60 * 1000);
  setInterval(function () { loadDGT(); loadEstado(); }, 2 * 60 * 1000);
  setInterval(loadCortes, 5 * 60 * 1000);
  setInterval(loadPatrones, 15 * 60 * 1000);
})();

/* Service worker: permite instalar la web como app y abrirla aunque falle la conexión.
   Siempre intenta la red primero (para tener datos y versiones al día) y solo usa
   la copia guardada si no hay conexión. Los datos en directo no se guardan. */
var CACHE = "trafico-zgz-v2";
var BASE = ["./", "manifest.webmanifest", "icons/icon-192.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASE); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  var propio = u.origin === self.location.origin && u.pathname.indexOf("/data/") < 0;
  var libreria = u.hostname === "unpkg.com";
  if (!propio && !libreria) return; // datos en directo, mapa base, etc.: directos a la red
  e.respondWith(fetch(e.request).then(function (r) {
    if (r.ok) { var copia = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copia); }); }
    return r;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: false }).then(function (r) { return r || caches.match("./"); }); }));
});

// Offline support. All of the site's own files are cached on first visit, so
// the tools keep working with no connection. The deploy workflow replaces
// __BUILD__ with the commit id, which makes browsers fetch a fresh copy of
// everything after each update.

const VERSION = "__BUILD__";
const CACHE = `pdftools-${VERSION}`;

const CORE = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "images.js",
  "images-to-pdf.js",
  "zip.js",
  "worker.js",
  "fill-core.js",
  "fill-sign.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "vendor/qpdf/qpdf.js",
  "vendor/qpdf/qpdf.wasm",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/wasm/openjpeg.wasm",
  "vendor/pdfjs/wasm/jbig2.wasm",
  "vendor/pdfjs/wasm/qcms_bg.wasm",
  "vendor/heic-to/heic-to.js",
  "vendor/fonts/arimo.woff2",
  "vendor/fonts/dancing-script.woff2",
  "vendor/fonts/great-vibes.woff2",
  "vendor/fonts/homemade-apple.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pdftools-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first; anything else from this site (fonts, character maps) is cached
// the first time it's needed.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }),
  );
});

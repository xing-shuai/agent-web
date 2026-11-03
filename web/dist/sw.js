// Minimal service worker — exists only so the app is installable.
// Never caches anything: stale bundles have bitten us before.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally no respondWith — every request goes straight to network.
});

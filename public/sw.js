/*
 * Legacy PWA cleanup worker.
 *
 * ORGO no longer registers a service worker. This one-time replacement clears
 * the old app caches and unregisters itself for browsers that installed it.
 */
self.addEventListener('install', function (event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(keys
                    .filter(function (key) { return key.indexOf('orgo-app-') === 0; })
                    .map(function (key) { return caches.delete(key); }));
            })
            .then(function () { return self.registration.unregister(); })
            .then(function () { return self.clients.claim(); })
    );
});

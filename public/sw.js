const CACHE_VERSION = 'orgo-app-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGE_CACHE = `${CACHE_VERSION}-pages`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const ORGO_CACHES = [STATIC_CACHE, PAGE_CACHE, DATA_CACHE];

const APP_SHELL = [
    '/',
    '/offline.html',
    '/manifest.webmanifest',
    '/app-icon.svg',
    '/favicon.svg',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/icons/icon-maskable-512.png',
    '/css/style.css?v=20260702a',
    '/css/whyrise.css?v=20260702c',
    '/css/home.css?v=20260702e',
    '/css/app-shell.css?v=20260702a',
    '/js/nav.js?v=20260525b',
    '/js/auth.js?v=20260525b',
    '/js/visitor.js?v=20260621e',
    '/js/api.js?v=20260702b',
    '/js/search.js?v=20260630a',
    '/js/report-core.js?v=20260630a',
    '/js/home.js?v=20260702c',
    '/js/app-shell.js?v=20260702a'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            caches.keys().then((keys) => Promise.all(
                keys
                    .filter((key) => key.startsWith('orgo-app-') && !ORGO_CACHES.includes(key))
                    .map((key) => caches.delete(key))
            )),
            self.registration.navigationPreload
                ? self.registration.navigationPreload.enable()
                : Promise.resolve(),
            self.clients.claim()
        ])
    );
});

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request, cacheName, fallbackUrl) {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
    } catch (error) {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (fallbackUrl) {
            const fallback = await caches.match(fallbackUrl, { ignoreSearch: true });
            if (fallback) return fallback;
        }
        throw error;
    }
}

async function navigationResponse(event) {
    const request = event.request;
    const cache = await caches.open(PAGE_CACHE);
    try {
        const response = await event.preloadResponse || await fetch(request);
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
    } catch (error) {
        return await caches.match(request, { ignoreSearch: true })
            || await caches.match('/offline.html');
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
        .then((response) => {
            if (response && response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => null);
    return cached || await network || Response.error();
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(navigationResponse(event));
        return;
    }

    if (url.pathname.startsWith('/data/')) {
        event.respondWith(networkFirst(request, DATA_CACHE));
        return;
    }

    if (['style', 'script', 'image', 'font', 'manifest'].includes(request.destination)) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

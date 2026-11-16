/* sw.js — offline support that never goes stale.
 * Part of George's app-update kit (~/Developer/app-update-kit). Do not remove.
 *
 * Same-origin files are fetched network-first (revalidating past the browser's
 * HTTP cache), so a fresh launch always gets the newest deploy. The last good
 * copy of everything visited is kept so the app still opens offline; on a slow
 * connection the saved copy is used after a few seconds and refreshed behind
 * the scenes. Other sites (maps, fonts, APIs) are left to the browser.
 *
 * No version number to bump for content changes. Only bump LOGIC if the logic
 * in this file changes. Caches are named by this app's path, so apps sharing
 * the github.io domain never delete each other's offline copies.
 */
const LOGIC = 1;
// Per app (optional): files to save on install so the app works offline after
// its first launch, and the names of caches this app used before the kit.
const PRECACHE = [];
const LEGACY = [];
const SCOPE = new URL(self.registration.scope).pathname;
const PREFIX = `app:${SCOPE}:`;
const CACHE = `${PREFIX}${LOGIC}`;
const SLOW_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all([SCOPE, ...PRECACHE].map((path) =>
        cache.add(new Request(new URL(path, self.registration.scope).href, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => (k.startsWith(PREFIX) && k !== CACHE) || LEGACY.some((old) => k === old || k.startsWith(old)))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (req.headers.has('range')) return; // media seeking: let the browser handle it
  event.respondWith(networkFirst(event, req));
});

async function networkFirst(event, req) {
  const cache = await caches.open(CACHE);
  // A navigation Request can't be re-issued with options, so fetch its URL instead.
  const nav = req.mode === 'navigate';
  const network = (nav ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' }))
    .then(async (res) => {
      // Safari rejects redirected responses for navigations; hand back a clean copy.
      if (nav && res.redirected) res = new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
      if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        event.waitUntil(cache.put(req, copy).catch(() => {}));
      }
      return res;
    });
  const saved = cache.match(req)
    .then((hit) => hit || cache.match(req, { ignoreSearch: true })) // e.g. app.js?v=12 offline, saved as app.js
    .then((hit) => hit || (req.mode === 'navigate' ? cache.match(SCOPE) : undefined));
  // Prefer the network; fall back to the saved copy if offline or very slow.
  const slow = new Promise((resolve) => setTimeout(resolve, SLOW_MS, 'slow'));
  try {
    const first = await Promise.race([network, slow]);
    if (first !== 'slow') return first;
    const hit = await saved;
    if (hit) { event.waitUntil(network.catch(() => {})); return hit; }
    return await network;
  } catch (err) {
    const hit = await saved;
    if (hit) return hit;
    throw err;
  }
}

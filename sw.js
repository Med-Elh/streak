/**
 * Streak. service worker — what makes "Add to Home Screen" behave like an app.
 *
 * Network first for everything on this site, so a push to GitHub shows up on
 * the next open exactly as it does in the browser (the ?v= stamps from
 * bump-version.ps1 keep working unchanged). The cache is only a fallback for
 * when the phone is offline, so the app still opens instead of showing
 * Safari's "you're not connected" page.
 *
 * Supabase, the CDNs and Google Fonts are cross-origin and never touched:
 * data always comes live from the database, never from a stale copy.
 */

const CACHE = 'streak-shell-v1';
const SHELL = ['./', './index.html', './profiles.html', './habits.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // One missing file must not abort the whole install.
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});

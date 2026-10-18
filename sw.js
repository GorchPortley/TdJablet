// Service worker: keeps the app working with no network (a DJ booth rarely
// has good Wi-Fi). App files are cached on install; everything else from this
// site (e.g. the optional ffmpeg.wasm files) is cached the first time it is used.
// Bump VERSION when shipping changes.

const VERSION = 'tdjablet-v1';
const VENDOR = 'tdjablet-vendor'; // survives app updates
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/main.js',
  'js/App.js',
  'js/Deck.js',
  'js/shared/BeatGrid.js',
  'js/audio/AudioEngine.js',
  'js/audio/engine-processor.js',
  'js/audio/dsp/DeckCore.js',
  'js/audio/dsp/TimeStretch.js',
  'js/analysis/Analyzer.js',
  'js/analysis/analyzer-worker.js',
  'js/analysis/waveform.js',
  'js/analysis/bpm.js',
  'js/decode/decode.js',
  'js/decode/pcm.js',
  'js/decode/tags.js',
  'js/decode/ffmpeg.js',
  'js/library/Library.js',
  'js/library/LibraryStore.js',
  'js/rekordbox/pdb.js',
  'js/rekordbox/anlz.js',
  'js/rekordbox/xml.js',
  'js/rekordbox/import.js',
  'js/ui/dom.js',
  'js/ui/controls.js',
  'js/ui/Tape.js',
  'js/ui/Overview.js',
  'js/ui/PhaseMeter.js',
  'js/ui/DeckView.js',
  'js/ui/MixerView.js',
  'js/ui/Browser.js',
  'js/ui/Settings.js',
  'js/ui/SettingsView.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: answer from the cache at once, refresh it in the background.
// Big versioned files under vendor/ (ffmpeg.wasm) are cache-first and never re-downloaded.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(url.pathname.includes('/vendor/') ? VENDOR : VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit && url.pathname.includes('/vendor/')) return hit;
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    }),
  );
});

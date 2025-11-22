const CACHE_NAME = 'v-metrics-v1';
// キャッシュするファイルの一覧
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './vmetrics.js',
  './dexie.js',
  './html2canvas.min.js',
  './jspdf.umd.min.js',
  // アイコン画像がある場合はここに追加
  './V-Metrics.white.png',
  './V-Metrics.png',
  './logo.png',
  './volleyball.png'
];

// インストール時：ファイルをキャッシュする
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// 通信時：キャッシュがあればそれを使う（オフライン対応）
self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
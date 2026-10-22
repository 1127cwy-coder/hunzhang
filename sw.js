// ============================================================================
// 《混賬》(Messy Split) v7.1 - PWA Service Worker (sw.js)
// 功能：
// 1. 離線快取核心 HTML 與三大 JS 模組（db-crypto / export-backup / ocr-scanner）
// 2. 放行每日凌晨 2:12 跨日匯率 API 請求（確保聯網時永遠抓取當天最新匯率）
// 3. 自動快取本地 Tesseract.js OCR 資源，實現真正的離線掃單與秒開記帳
// ============================================================================

const CACHE_NAME = 'messy-split-pwa-v7.1';

// 1. 安裝時必須預先快取的核心靜態檔案清單
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './db-crypto.js',
  './export-backup.js',
  './ocr-scanner.js',
  './icon-192.png',
  './icon-512.png'
];

// ----------------------------------------------------------------------------
// 【階段一：Install 安裝階段】把主畫面、三大模組與桌面圖示存入手機本地快取
// ----------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  self.skipWaiting(); // 強制新版 Service Worker 立即接管
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW v7.1] 略過預快取項目:', url, err))
        )
      );
    })
  );
});

// ----------------------------------------------------------------------------
// 【階段二：Activate 啟動階段】自動清理 v7.0 等舊版本快取（絕不影響 IndexedDB 帳目與 Blob）
// ----------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('messy-split-') && name !== CACHE_NAME)
          .map((oldName) => {
            console.log('[SW v7.1] 自動清理舊版快取:', oldName);
            return caches.delete(oldName);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ----------------------------------------------------------------------------
// 【階段三：Fetch 請求攔截階段】
// ----------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // 1. 每日匯率 API 請求（open.er-api.com / exchangerate-api.com）與 Firebase 同步：
  //    直接走網路 (Network Only)，不快取舊回應；若斷網失敗則由前端自動沿用昨日匯率紀錄
  if (
    url.hostname.includes('er-api.com') ||
    url.hostname.includes('exchangerate-api.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com')
  ) {
    return;
  }

  // 2. HTML 導航請求：網路優先 (Network First)，斷網時退回本地快取的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return networkRes;
        })
        .catch(() => caches.match('./index.html') || caches.match('./'))
    );
    return;
  }

  // 3. 本地模組、圖示與 Tesseract.js CDN 資源：快取優先 + 背景更新 (Stale-While-Revalidate)
  event.respondWith(
    caches.match(req).then((cachedRes) => {
      const fetchPromise = fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => cachedRes);

      return cachedRes || fetchPromise;
    })
  );
});

// 支援前端主動觸發更新
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
// ============================================================================
// 《混賬》(Messy Split) v7.2 - PWA Service Worker (sw.js)
// 審計強化內容：
// 1. [資安/穩定] 嚴格限制僅攔截 http/https 協定，防止 OCR 之 blob:/data: 觸發 Cache API 報錯
// 2. [美術/PWA] 預快取清單納入獨立 maskable 圖示與 8 款動物頭像縮圖 (allSettled 容錯)
// 3. [效能] 新增 safeCachePut 與快取數量上限控管，防止 QuotaExceededError
// 4. [資安] 離線回應注入 X-Frame-Options、X-Content-Type-Options 等防護標頭
// ============================================================================

const CACHE_NAME = 'messy-split-pwa-v7.2-r2';
const MAX_CACHE_ENTRIES = 120;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './db-crypto.js',
  './export-backup.js',
  './ocr-scanner.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  // 8 款稀有動物頭像縮圖（簡短檔名）
  './fox.jpg',
  './bunny.jpg',
  './bear.jpg',
  './chick.jpg',
  './otter.jpg',
  './dog.jpg',
  './flamingo.jpg',
  './sloth.jpg',
  // 原始上傳檔名保底（若資料夾內僅存其中一種，allSettled 會自動略過不存在者）
  './IMG_2445_306587.jpeg',
  './IMG_2449_306587.jpeg',
  './IMG_2450_306587.jpeg',
  './IMG_2451_306587.jpeg',
  './IMG_2448_306587.jpeg',
  './IMG_2455_306587.jpeg',
  './IMG_2454_306587.jpeg',
  './IMG_2453_306587.jpeg'
];

// 匯率與外部即時 API 永遠走網路，斷網時由前端使用昨日匯率與 IndexedDB 兜底
const NETWORK_ONLY_HOSTS = [
  'open.er-api.com',
  'er-api.com',
  'exchangerate-api.com',
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebaseio.com',
  'identitytoolkit.googleapis.com'
];

// 允許被 Stale-While-Revalidate 快取的跨域 CDN（含 Tailwind CSS 與 Tesseract 語言包）
const CACHEABLE_CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'cdn.jsdelivr.net',
  'tessdata.projectnaptha.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'cdn.skypack.dev'
];

function isNetworkOnly(url) {
  const host = url.hostname;
  return NETWORK_ONLY_HOSTS.some(
    (h) => host === h || host.endsWith('.' + h) || host.includes(h)
  );
}

function isCacheableCdn(url) {
  const host = url.hostname;
  return CACHEABLE_CDN_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

/**
 * 安全寫入快取並控制快取總項目數，防止手機儲存空間不足 (QuotaExceededError)
 */
async function safeCachePut(cache, request, response) {
  try {
    await cache.put(request, response);
    const keys = await cache.keys();
    if (keys.length > MAX_CACHE_ENTRIES) {
      const overflow = keys.length - MAX_CACHE_ENTRIES;
      for (let i = 0; i < overflow; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      try {
        const keys = await cache.keys();
        const half = Math.ceil(keys.length / 2);
        for (let i = 0; i < half; i++) {
          await cache.delete(keys[i]);
        }
      } catch (_) {}
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        const results = await Promise.allSettled(
          PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.info('[SW v7.2] 略過選用預快取項目:', url, err.message);
              return null;
            })
          )
        );
        const okCount = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
        console.log(`[SW v7.2] 預快取完成 (${okCount}/${PRECACHE_ASSETS.length})`);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => {
        return Promise.all(
          names
            .filter((n) => n.startsWith('messy-split-') && n !== CACHE_NAME)
            .map((old) => {
              console.log('[SW v7.2] 清理舊版快取:', old);
              return caches.delete(old);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  // 0. 嚴格過濾非 http/https 協定 (防止 Tesseract 之 blob: 或 data: URL 觸發快取錯誤)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return;
  }

  // 1. 匯率與外部即時 API -> Network Only
  if (isNetworkOnly(url)) {
    return;
  }

  // 2. 導航請求：Network First + 正規化快取 key
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkRes = await fetch(req);
          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            const cache = await caches.open(CACHE_NAME);
            await safeCachePut(cache, './index.html', clone);
            await safeCachePut(cache, './', clone.clone());
          }
          return networkRes;
        } catch (e) {
          const cached =
            (await caches.match('./index.html')) || (await caches.match('./'));
          return (
            cached ||
            new Response(
              '<!DOCTYPE html><html lang="zh-HK"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>離線中 - 混賬</title></head><body style="font-family:sans-serif;padding:24px;text-align:center;background:#FAF6F0;color:#1E293B;"><h1>🛡️ 混賬離線模式</h1><p>目前無網路連線，請重新整理或檢查網路，你的本地帳目仍安全保存在裝置內。</p></body></html>',
              {
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'X-Content-Type-Options': 'nosniff',
                  'X-Frame-Options': 'DENY',
                  'Referrer-Policy': 'strict-origin-when-cross-origin'
                }
              }
            )
          );
        }
      })()
    );
    return;
  }

  // 3. 靜態資源與白名單 CDN：Stale-While-Revalidate
  const isSameOrigin = url.origin === self.location.origin;
  const isAllowedCdn = isCacheableCdn(url);

  if (!isSameOrigin && !isAllowedCdn) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedRes = await cache.match(req);

      const fetchAndCache = async () => {
        try {
          const networkRes = await fetch(req);
          // 同源資源要求 200 OK；白名單 CDN 額外允許 opaque (status 0) 以支援 Tailwind script 標籤快取
          const canCache =
            networkRes &&
            (networkRes.ok || (isAllowedCdn && networkRes.type === 'opaque'));

          if (canCache) {
            await safeCachePut(cache, req, networkRes.clone());
          }
          return networkRes;
        } catch (err) {
          return cachedRes;
        }
      };

      if (cachedRes) {
        fetchAndCache();
        return cachedRes;
      }
      return fetchAndCache();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
// ============================================================================
// 《混賬》(Messy Split) v7.4 - 純前端三層收據掃描引擎 (ocr-scanner.js)
// 強化內容：
// 1. [韓文動態字庫] 自動偵測當前群組幣別 (KRW)，按需動態載入 Tesseract 'kor' 韓文語言包，免改動主程式
// 2. [新幣別與全形正規化] 全面支援 EUR (€) 與 KRW (₩ / 원 / 합계) 空白容錯、韓文日期 (년/월/일) 與全形數字轉換
// 3. [效能與 iOS 相容] 內嵌 Blob Web Worker + Transferable ArrayBuffer 零拷貝二值化，延遲釋放 URL 防 iOS WebKit 失敗
// 4. [功能與法規] 支援 createImageBitmap EXIF 自動轉正，鎖定 Tesseract.js v5.1.1 並附帶 Apache License 2.0 授權標示
// ============================================================================

const OCRScanner = (() => {
  'use strict';

  const MAX_WIDTH = 1400;
  const MAX_HEIGHT = 3800;
  const PAD = 20;

  const TESSERACT_CDN_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const OPEN_SOURCE_NOTICE =
    'OCR Engine powered by Tesseract.js (Apache License 2.0, Copyright Naptha / Jerome Wu).';
  const OCR_DISCLAIMER =
    'OCR 辨識結果僅供輔助輸入參考，儲存前請自行核對單據金額。';

  // ==========================================================================
  // 背景像素二值化 Web Worker (Transferable Objects 零拷貝傳輸)
  // ==========================================================================
  let binarizationWorker = null;
  let workerJobId = 0;
  const pendingWorkerJobs = new Map();

  function getBinarizationWorker() {
    if (binarizationWorker) return binarizationWorker;
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;

    const workerCode = `
      self.onmessage = function(e) {
        var jobId = e.data.jobId;
        var buffer = e.data.buffer;
        var data = new Uint8ClampedArray(buffer);
        var totalPixels = data.length / 4;
        var luminanceSum = 0;
        var grays = new Uint8Array(totalPixels);

        for (var i = 0, p = 0; i < data.length; i += 4, p++) {
          var g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
          grays[p] = g;
          luminanceSum += g;
        }

        var avgLum = luminanceSum / (totalPixels || 1);
        var dynamicThreshold = Math.min(205, Math.max(125, avgLum * 0.88));
        var contrast = 1.45;
        var intercept = 128 * (1 - contrast);

        for (var j = 0, q = 0; j < data.length; j += 4, q++) {
          var val = grays[q] * contrast + intercept;
          if (val > dynamicThreshold) val = 255;
          else val = Math.max(0, Math.round(val * 0.65));
          data[j] = data[j + 1] = data[j + 2] = val;
        }

        self.postMessage({ jobId: jobId, buffer: buffer }, [buffer]);
      };
    `;

    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      binarizationWorker = new Worker(url);
      // 延遲釋放 Blob URL，避免 iOS WebKit 背景執行緒尚未完成讀取即被撤銷
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 3000);

      binarizationWorker.onmessage = (e) => {
        const { jobId, buffer } = e.data;
        const resolver = pendingWorkerJobs.get(jobId);
        if (resolver) {
          pendingWorkerJobs.delete(jobId);
          resolver.resolve(new Uint8ClampedArray(buffer));
        }
      };

      binarizationWorker.onerror = (err) => {
        for (const [, resolver] of pendingWorkerJobs.entries()) {
          resolver.reject(err);
        }
        pendingWorkerJobs.clear();
        try {
          binarizationWorker.terminate();
        } catch (_) {}
        binarizationWorker = null;
      };

      return binarizationWorker;
    } catch (_) {
      return null;
    }
  }

  function binarizeOnMainThread(data) {
    const totalPixels = data.length / 4;
    let luminanceSum = 0;
    const grays = new Uint8Array(totalPixels);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      grays[p] = g;
      luminanceSum += g;
    }

    const avgLum = luminanceSum / (totalPixels || 1);
    const dynamicThreshold = Math.min(205, Math.max(125, avgLum * 0.88));
    const contrast = 1.45;
    const intercept = 128 * (1 - contrast);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      let val = grays[p] * contrast + intercept;
      if (val > dynamicThreshold) val = 255;
      else val = Math.max(0, Math.round(val * 0.65));
      data[i] = data[i + 1] = data[i + 2] = val;
    }
  }

  async function applyAdaptiveBinarization(ocrCtx, width, height) {
    try {
      const imgData = ocrCtx.getImageData(0, 0, width, height);
      const worker = getBinarizationWorker();

      if (worker) {
        try {
          const jobId = ++workerJobId;
          const buffer = imgData.data.buffer;
          const processedArray = await new Promise((resolve, reject) => {
            pendingWorkerJobs.set(jobId, { resolve, reject });
            worker.postMessage({ jobId, buffer }, [buffer]);
          });
          const outImgData = new ImageData(processedArray, width, height);
          ocrCtx.putImageData(outImgData, 0, 0);
          return;
        } catch (_) {
          const fallbackImgData = ocrCtx.getImageData(0, 0, width, height);
          binarizeOnMainThread(fallbackImgData.data);
          ocrCtx.putImageData(fallbackImgData, 0, 0);
          return;
        }
      }

      binarizeOnMainThread(imgData.data);
      ocrCtx.putImageData(imgData, 0, 0);
    } catch (e) {
      console.warn('[OCR] getImageData 失敗，改用原圖', e);
    }
  }

  async function loadOrientedImageSource(fileOrBlob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => {
            try {
              bitmap.close();
            } catch (_) {}
          }
        };
      } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const tempUrl = URL.createObjectURL(fileOrBlob);
      img.onload = () => {
        resolve({
          source: img,
          width: img.width,
          height: img.height,
          cleanup: () => URL.revokeObjectURL(tempUrl)
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(tempUrl);
        reject(new Error('無法讀取收據圖片'));
      };
      img.src = tempUrl;
    });
  }

  // ==========================================================================
  // Layer 1：影像降採樣、EXIF 正向化與 Web Worker 高對比二值化
  // ==========================================================================
  async function preprocessReceiptImage(fileOrBlob, maxWidth = MAX_WIDTH) {
    const loaded = await loadOrientedImageSource(fileOrBlob);
    let { width, height } = loaded;

    try {
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      if (height > MAX_HEIGHT) {
        width = Math.round((width * MAX_HEIGHT) / height);
        height = MAX_HEIGHT;
      }

      const archiveCanvas = document.createElement('canvas');
      archiveCanvas.width = width;
      archiveCanvas.height = height;
      const archiveCtx = archiveCanvas.getContext('2d');
      if (!archiveCtx) throw new Error('Canvas 不支援');
      archiveCtx.drawImage(loaded.source, 0, 0, width, height);

      const ocrCanvas = document.createElement('canvas');
      ocrCanvas.width = width + PAD * 2;
      ocrCanvas.height = height + PAD * 2;
      const ocrCtx = ocrCanvas.getContext('2d');
      ocrCtx.fillStyle = '#FFFFFF';
      ocrCtx.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
      ocrCtx.drawImage(loaded.source, PAD, PAD, width, height);

      await applyAdaptiveBinarization(ocrCtx, ocrCanvas.width, ocrCanvas.height);

      const ocrDataUrl = ocrCanvas.toDataURL('image/jpeg', 0.88);

      return await new Promise((resolve) => {
        const tryToBlob = (type, quality, fallback) => {
          archiveCanvas.toBlob(
            (blob) => {
              if (blob) resolve({ processedBlob: blob, ocrDataUrl });
              else if (fallback) fallback();
              else resolve({ processedBlob: fileOrBlob, ocrDataUrl });
            },
            type,
            quality
          );
        };
        tryToBlob('image/webp', 0.78, () => tryToBlob('image/jpeg', 0.78, null));
      });
    } finally {
      loaded.cleanup();
    }
  }

  // ==========================================================================
  // Layer 2：按需載入本地 Tesseract.js v5.1.1 與智能語系決策 (支援韓文 kor)
  // ==========================================================================
  function resolveOcrLanguages(options = {}) {
    if (typeof options.lang === 'string' && options.lang.trim()) {
      return options.lang.trim();
    }

    let groupCurr = options.currency || '';
    let mainCurr = '';

    try {
      if (!groupCurr && typeof window !== 'undefined' && window.appState) {
        const state = window.appState;
        mainCurr = state.mainCurrency || 'HKD';
        const grp =
          (Array.isArray(state.groups) &&
            state.groups.find((g) => g.id === state.currentGroupId)) ||
          (Array.isArray(state.groups) ? state.groups[0] : null);
        if (grp) {
          groupCurr = grp.currency || '';
          mainCurr = grp.mainCurrency || mainCurr;
        }
      }
    } catch (_) {}

    // 當群組外幣或主貨幣為 KRW (韓元) 時，動態掛載 kor 韓文訓練集
    if (groupCurr === 'KRW' || mainCurr === 'KRW') {
      return 'eng+kor+chi_tra';
    }
    if (groupCurr === 'EUR' || groupCurr === 'USD') {
      return 'eng+chi_tra';
    }
    return 'eng+chi_tra+jpn';
  }

  async function loadTesseractOnDemand(options = {}) {
    if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
      return window.Tesseract;
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = options.cdnUrl || TESSERACT_CDN_URL;
      script.crossOrigin = 'anonymous';
      if (options.sriIntegrity) {
        script.integrity = options.sriIntegrity;
      }
      script.onload = () => {
        if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
          resolve(window.Tesseract);
        } else {
          reject(new Error('OCR 引擎介面驗證失敗'));
        }
      };
      script.onerror = () =>
        reject(new Error('離線環境尚未快取 OCR 引擎，已自動切換為快速解析'));
      document.head.appendChild(script);
    });
  }

  // ==========================================================================
  // Layer 3：免金鑰關鍵字錨點解析 (支援 HKD / JPY / TWD / USD / EUR / KRW)
  // ==========================================================================
  function normalizeFullWidthChars(str) {
    return String(str || '')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/，/g, ',')
      .replace(/．/g, '.')
      .replace(/￥/g, '¥')
      .replace(/￦/g, '₩');
  }

  function parseReceiptTextKeyless(rawText, fallbackFileName = '') {
    const cleanText = normalizeFullWidthChars(rawText).trim();
    const lines = cleanText
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    let detectedDate = new Date().toISOString().slice(0, 10);
    const reiwaMatch = cleanText.match(
      /(?:令和|R)\s*(\d{1,2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/i
    );
    if (reiwaMatch) {
      const year = 2018 + parseInt(reiwaMatch[1], 10);
      detectedDate = `${year}-${String(reiwaMatch[2]).padStart(2, '0')}-${String(
        reiwaMatch[3]
      ).padStart(2, '0')}`;
    } else {
      // 支援中/日 (年/月/日) 與韓文 (년/월/일) 及歐美日期格式
      const ymdRegex =
        /(20\d{2})\s*[-/.年년]\s*(0?[1-9]|1[0-2])\s*[-/.月월]\s*(0?[1-9]|[12]\d|3[01])[日일.]?/;
      const dmyRegex =
        /(0?[1-9]|[12]\d|3[01])\s*[-/.]\s*(0?[1-9]|1[0-2])\s*[-/.]\s*(20\d{2})/;
      for (const line of lines) {
        const m1 = line.match(ymdRegex);
        if (m1) {
          detectedDate = `${m1[1]}-${String(m1[2]).padStart(2, '0')}-${String(m1[3]).padStart(
            2,
            '0'
          )}`;
          break;
        }
        const m2 = line.match(dmyRegex);
        if (m2) {
          detectedDate = `${m2[3]}-${String(m2[2]).padStart(2, '0')}-${String(m2[1]).padStart(
            2,
            '0'
          )}`;
          break;
        }
      }
    }

    // 支援 6 大幣別優先順序偵測（含韓文 OCR 字元間距容錯）
    let detectedCurrency = 'HKD';
    if (/(HK\$|HKD|港幣|港元|八達通|Octopus|PayMe|FPS)/i.test(cleanText)) {
      detectedCurrency = 'HKD';
    } else if (/(NT\$|NTD|TWD|台幣|新台幣|統一發票|載具)/i.test(cleanText)) {
      detectedCurrency = 'TWD';
    } else if (
      /(₩|KRW|원|합\s*계|총\s*액|결\s*제\s*금\s*액|받\s*을\s*금\s*액|부\s*가\s*세|영\s*수\s*증|韓元|韓圜)/i.test(
        cleanText
      )
    ) {
      detectedCurrency = 'KRW';
    } else if (/(€|EUR|Euro|歐元|歐羅|MwSt|TVA|IVA)/i.test(cleanText)) {
      detectedCurrency = 'EUR';
    } else if (/(US\$|USD|美金|美元)/i.test(cleanText)) {
      detectedCurrency = 'USD';
    } else if (/(税込|外税|内税|お買上|領収|円|JPY|¥)/i.test(cleanText)) {
      detectedCurrency = 'JPY';
    }

    const tier1TotalAnchor =
      /(grand\s*total|net\s*total|amount\s*due|total\s*due|合\s*計|總\s*計|總\s*額|お買上計|税込合計|税込計|實付|應付|結帳金額|刷卡金額|합\s*계|총\s*액|총\s*금\s*액|결\s*제\s*금\s*액|받\s*을\s*금\s*액|승\s*인\s*금\s*액|gesamt|summe|montant\s*total|totale|importe\s*total)/i;
    const tier2SubtotalAnchor = /(\btotal\b|小\s*計|subtotal|計|소\s*계)/i;
    const excludeLineAnchor =
      /(change|お預り|お釣り|找續|找零|거\s*스\s*름\s*돈|받\s*은\s*돈|cash|現金預かり|tel|phone|電話|전\s*화|fax|會員|積分|point|invoice|單號|收據號碼|사\s*업\s*자|승\s*인\s*번\s*호|table|桌號|檯號|卡號|visa|master|\d+\s*%)/i;

    const amountBase =
      /(?:HK\$|NT\$|US\$|EUR|KRW|\$|¥|€|₩)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,2}))?\s*(?:円|원|EUR|KRW)?/g;
    const candidates = [];

    lines.forEach((line, idx) => {
      if (excludeLineAnchor.test(line)) return;
      const isTier1 = tier1TotalAnchor.test(line);
      const isTier2 = !isTier1 && tier2SubtotalAnchor.test(line);
      const prevLine = idx > 0 ? lines[idx - 1] : '';
      const isPrevLineTier1 = tier1TotalAnchor.test(prevLine) && !/\d/.test(prevLine);

      const amountPattern = new RegExp(amountBase.source, 'gi');
      let match;
      while ((match = amountPattern.exec(line)) !== null) {
        const rawInt = match[1];
        const intPart = rawInt.replace(/,/g, '');
        const decPart = match[2] ? `.${match[2]}` : '';
        const val = parseFloat(intPart + decPart);
        // 放寬上限至 5,000 萬以支援大額韓元 (KRW) 或日圓帳單
        if (isNaN(val) || val <= 0 || val >= 50000000) continue;

        const hasCurrencySymbol = /(HK\$|NT\$|US\$|EUR|KRW|\$|¥|€|₩|円|원)/i.test(match[0]);
        // 過濾無貨幣符號之年份 (2000-2100) 或無千分位逗號之 8 位數純整數 (如日期 20261024 或電話)
        if (!hasCurrencySymbol && !match[2] && Number.isInteger(val)) {
          if (val >= 2000 && val <= 2100) continue;
          if (!rawInt.includes(',') && intPart.length >= 8) continue;
        }

        let score = 10;
        if (isTier1 || isPrevLineTier1) score += 120;
        else if (isTier2) score += 70;
        if (hasCurrencySymbol) score += 30;
        if (rawInt.includes(',')) score += 15;
        if (idx >= lines.length * 0.45) score += 20;
        if (match[2]) score += 10;

        candidates.push({ val, score, line });
      }
    });

    let detectedAmount = 0;
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score || b.val - a.val);
      detectedAmount = candidates[0].val;
    }

    const skipMerchantAnchor =
      /^(welcome|歡迎光臨|領収書|領収証|レシート|영\s*수\s*증|receipt|tax\s*invoice|正式收據|交易明細|電話|tel|phone|date|日期|時間|time|table|桌號|店番|レジ|責No|\d+[-/]\d+)/i;
    const merchantKeywordBoost =
      /(店|餐廳|居酒屋|珈琲|カフェ|拉麵|燒肉|壽司|水產|藥妝|百貨|超市|堂|茶餐廳|冰室|火鍋|酒家|株式會社|マート|ドン・キホーテ|식당|갈비|고깃집|카페|커피|마트|백화점|면세점|약국|치킨|편의점|올리브영|Olive\s*Young|Restaurant|Cafe|Mart|Store|Bistro|Brasserie|Bakery|Supermarket)/i;

    let detectedMerchant = '';
    let bestMerchantScore = -1;
    for (let i = 0; i < Math.min(lines.length, 7); i++) {
      const stripped = lines[i].replace(/[*=~—\-_#【】「」[\]]+/g, '').trim();
      if (
        stripped.length >= 2 &&
        stripped.length <= 30 &&
        !skipMerchantAnchor.test(stripped) &&
        !/^\d+$/.test(stripped)
      ) {
        let mScore = 50 - i * 8;
        if (merchantKeywordBoost.test(stripped)) mScore += 40;
        if (mScore > bestMerchantScore) {
          bestMerchantScore = mScore;
          detectedMerchant = stripped;
        }
      }
    }
    if (!detectedMerchant && fallbackFileName) {
      detectedMerchant = fallbackFileName
        .replace(/\.[^/.]+$/, '')
        .replace(/^(IMG_|DSC_|Screenshot_|相片_|image_)/i, '')
        .slice(0, 20);
    }

    return {
      merchant: detectedMerchant || '聚餐/旅遊消費單據',
      date: detectedDate,
      amount: detectedAmount,
      currency: detectedCurrency,
      confidence: candidates.length > 0 ? 'high' : 'low',
      engine: '🛡️ 本地三層智能解析 (零上雲)',
      rawPreview: lines.slice(0, 8).join(' | '),
      _license: OPEN_SOURCE_NOTICE,
      _disclaimer: OCR_DISCLAIMER
    };
  }

  async function scanReceipt(fileOrBlob, options = {}) {
    const { rawHintText = '', onProgress = () => {}, signal, sriIntegrity } = options;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress('🔍 Layer 1：背景高對比二值化預處理...');
    const preprocessed = await preprocessReceiptImage(fileOrBlob, MAX_WIDTH);

    if (rawHintText && rawHintText.trim().length > 3) {
      onProgress('⚡ Layer 3：免 OCR 錨點極速解析...');
      const parsed = parseReceiptTextKeyless(rawHintText, fileOrBlob.name);
      return {
        ...parsed,
        engine: '⚡ 本地錨點極速解析',
        processedBlob: preprocessed.processedBlob
      };
    }

    try {
      const targetLangs = resolveOcrLanguages(options);
      onProgress(`🤖 Layer 2：啟動本地離線 OCR (${targetLangs})...`);
      const Tesseract = await loadTesseractOnDemand({ sriIntegrity });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { data } = await Tesseract.recognize(preprocessed.ocrDataUrl, targetLangs, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            onProgress(`🤖 辨識中 (${Math.round((m.progress || 0) * 100)}%)...`);
          }
        }
      });
      onProgress('🎯 Layer 3：定位金額與商戶...');
      const parsed = parseReceiptTextKeyless(data.text, fileOrBlob.name);
      return {
        ...parsed,
        engine: '🛡️ 本地三層 OCR (Worker 二值化 + 錨點)',
        processedBlob: preprocessed.processedBlob
      };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[OCR] Tesseract 失敗，fallback 檔名解析', err);
      const fallback = parseReceiptTextKeyless('', fileOrBlob.name);
      return {
        ...fallback,
        engine: '⚡ 離線單據壓縮帶入 (OCR未就緒)',
        processedBlob: preprocessed.processedBlob,
        _error: err.message
      };
    }
  }

  function getOpenSourceAttribution() {
    return {
      notice: OPEN_SOURCE_NOTICE,
      disclaimer: OCR_DISCLAIMER
    };
  }

  return {
    preprocessReceiptImage,
    parseReceiptTextKeyless,
    scanReceipt,
    getOpenSourceAttribution
  };
})();
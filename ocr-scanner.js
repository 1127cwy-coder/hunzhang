// ============================================================================
// 《混賬》(Messy Split) v7.2 - 純前端三層收據掃描引擎 (ocr-scanner.js)
// 審計強化內容：
// 1. [效能] 建立內嵌 Blob Web Worker + Transferable ArrayBuffer (零拷貝)，將 530 萬像素二值化運算移出主執行緒，消除 UI 卡頓
// 2. [功能] 支援 createImageBitmap({ imageOrientation: 'from-image' }) 自動修正手機直拍收據之 EXIF 旋轉方向
// 3. [資安] 鎖定 Tesseract.js 版本號 (v5.1.1)、強制設定 crossOrigin = 'anonymous' 與選用 SRI 雜湊驗證
// 4. [法律] 內建 Tesseract.js (Apache License 2.0) 開源授權標示與辨識誤差免責聲明
// ============================================================================

const OCRScanner = (() => {
  'use strict';

  const MAX_WIDTH = 1400;
  const MAX_HEIGHT = 3800; // 避免超長小票爆記憶體
  const PAD = 20;

  // 鎖定明確版本號，防止 CDN 浮動版本遭注入惡意程式碼
  const TESSERACT_CDN_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // 開源授權與免責聲明常數 (符合 Apache License 2.0 規範)
  const OPEN_SOURCE_NOTICE =
    'OCR Engine powered by Tesseract.js (Apache License 2.0, Copyright Naptha / Jerome Wu).';
  const OCR_DISCLAIMER =
    'OCR 辨識結果僅供輔助輸入參考，儲存前請自行核對單據金額。';

  // ==========================================================================
  // 背景像素二值化 Web Worker (使用 Transferable Objects 零拷貝傳輸)
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
      URL.revokeObjectURL(url);

      binarizationWorker.onmessage = (e) => {
        const { jobId, buffer } = e.data;
        const resolver = pendingWorkerJobs.get(jobId);
        if (resolver) {
          pendingWorkerJobs.delete(jobId);
          resolver.resolve(new Uint8ClampedArray(buffer));
        }
      };

      binarizationWorker.onerror = (err) => {
        console.warn('[OCR Worker] 執行異常，自動切換主執行緒兜底', err);
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
    } catch (err) {
      console.warn('[OCR] 無法建立 Blob Worker，改用主執行緒處理', err);
      return null;
    }
  }

  /**
   * 主執行緒二值化兜底函式（當環境不支援 Web Worker 時自動接手）
   */
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

  /**
   * 執行影像自適應二值化：優先使用零拷貝 Web Worker，失敗時無縫退回主執行緒
   */
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
          // 若 Worker 傳遞失敗，重新取得 ImageData 並由主執行緒完成
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

  /**
   * 讀取影像並自動套用 EXIF 旋轉方向校正
   */
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
      // 等比縮放 + 超長截斷
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      if (height > MAX_HEIGHT) {
        width = Math.round((width * MAX_HEIGHT) / height);
        height = MAX_HEIGHT;
      }

      // (A) 原色存檔畫布
      const archiveCanvas = document.createElement('canvas');
      archiveCanvas.width = width;
      archiveCanvas.height = height;
      const archiveCtx = archiveCanvas.getContext('2d');
      if (!archiveCtx) throw new Error('Canvas 不支援');
      archiveCtx.drawImage(loaded.source, 0, 0, width, height);

      // (B) OCR 高對比畫布
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
        // 優先 WebP，不支援則退回 JPEG
        tryToBlob('image/webp', 0.78, () => tryToBlob('image/jpeg', 0.78, null));
      });
    } finally {
      loaded.cleanup();
    }
  }

  // ==========================================================================
  // Layer 2：按需載入本地 Tesseract.js v5.1.1 (含 CORS 與選用 SRI 驗證)
  // ==========================================================================
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
  // Layer 3：免金鑰關鍵字錨點解析 (令和年份、多幣別優先序、排除電話找贖干擾)
  // ==========================================================================
  function parseReceiptTextKeyless(rawText, fallbackFileName = '') {
    const cleanText = String(rawText || '').trim();
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
      const ymdRegex =
        /(20\d{2})\s*[-/.年]\s*(0?[1-9]|1[0-2])\s*[-/.月]\s*(0?[1-9]|[12]\d|3[01])日?/;
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

    // 貨幣優先順序：HKD 優先於 JPY，避免 $ 誤判
    let detectedCurrency = 'HKD';
    if (/(HK\$|HKD|港幣|八達通|Octopus|PayMe|FPS)/i.test(cleanText)) detectedCurrency = 'HKD';
    else if (/(NT\$|TWD|台幣|統一發票|載具)/i.test(cleanText)) detectedCurrency = 'TWD';
    else if (/(US\$|USD)/i.test(cleanText)) detectedCurrency = 'USD';
    else if (/(税込|外税|内税|お買上|領収|円|JPY|¥|￥)/i.test(cleanText)) detectedCurrency = 'JPY';

    const tier1TotalAnchor =
      /(grand\s*total|net\s*total|amount\s*due|total\s*due|合計|總計|總額|お買上計|税込合計|税込計|實付|應付|結帳金額|刷卡金額)/i;
    const tier2SubtotalAnchor = /(\btotal\b|小計|subtotal|計)/i;
    const excludeLineAnchor =
      /(change|お預り|お釣り|找續|找零|cash|現金預かり|tel|phone|電話|fax|會員|積分|point|invoice|單號|收據號碼|table|桌號|檯號|卡號|visa|master|\d+\s*%)/i;

    const amountBase =
      /(?:HK\$|NT\$|US\$|\$|¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,2}))?\s*円?/g;
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
        const intPart = match[1].replace(/,/g, '');
        const decPart = match[2] ? `.${match[2]}` : '';
        const val = parseFloat(intPart + decPart);
        if (isNaN(val) || val <= 0 || val >= 1000000) continue;

        const hasCurrencySymbol = /(HK\$|NT\$|US\$|\$|¥|￥|円)/i.test(match[0]);
        if (!hasCurrencySymbol && val >= 2000 && val <= 2100 && Number.isInteger(val) && !match[2]) {
          continue;
        }

        let score = 10;
        if (isTier1 || isPrevLineTier1) score += 120;
        else if (isTier2) score += 70;
        if (hasCurrencySymbol) score += 30;
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
      /^(welcome|歡迎光臨|領収書|領収証|レシート|receipt|tax\s*invoice|正式收據|交易明細|電話|tel|phone|date|日期|時間|time|table|桌號|店番|レジ|責No|\d+[-/]\d+)/i;
    const merchantKeywordBoost =
      /(店|餐廳|居酒屋|珈琲|カフェ|拉麵|燒肉|壽司|水產|藥妝|百貨|超市|堂|茶餐廳|冰室|火鍋|酒家|株式會社|マート|ドン・キホーテ|Restaurant|Cafe|Mart|Store)/i;

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
      _disclaimer: OCR_DISCLAIMER,
      _debug: { candidates: candidates.slice(0, 5) }
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
      onProgress('🤖 Layer 2：啟動本地離線 OCR...');
      const Tesseract = await loadTesseractOnDemand({ sriIntegrity });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { data } = await Tesseract.recognize(preprocessed.ocrDataUrl, 'eng+chi_tra+jpn', {
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
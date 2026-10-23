// ============================================================================
// 《混賬》(Messy Split) v7.2 - 資料庫與加密金庫模組 (db-crypto.js)
// 審計強化內容：
// 1. [資安] PBKDF2 預設迭代次數提升至 OWASP 標準 600,000 次（並向下相容舊版 100,000 次紀錄）
// 2. [資安] 新增解密錯誤次數統計與指數退避冷卻機制 (Rate Limiting)，防禦自動化暴力破解
// 3. [資安] 新增 sanitizeVaultPayload()，強制過濾非 https:// 之 PayMe 連結，阻斷 javascript: XSS
// 4. [效能] ObjectURL 改以 Map 按資源 ID 與 groupId 精確追蹤，重複讀取與完團清理時零記憶體洩漏
// 5. [穩定] 全面攔截 QuotaExceededError 並提供密碼強度評估工具 evaluatePasswordStrength()
// ============================================================================

const DBCrypto = (() => {
  'use strict';

  const DB_NAME = 'MessySplitDB';
  const DB_VERSION = 7;
  const MEDIA_STORE = 'media_vault_store';
  const STATE_STORE = 'app_state_store';
  const VAULT_RECORD_KEY = 'encrypted_financial_vault';

  // OWASP 2023 PBKDF2-HMAC-SHA256 建議標準為 600,000 次；保留舊版常數供向下相容
  const PBKDF2_ITERATIONS = 600000;
  const LEGACY_PBKDF2_ITERATIONS = 100000;
  const SALT_BYTE_LENGTH = 16;
  const IV_BYTE_LENGTH = 12;
  const MAX_BLOB_SIZE = 15 * 1024 * 1024; // 15MB

  let dbInstance = null;

  // 追蹤所有已建立之 ObjectURL：url -> { id, groupId }
  const activeObjectURLMap = new Map();

  // 防暴力破解狀態追蹤
  let failedUnlockCount = 0;
  let unlockCooldownUntil = 0;

  async function initPersistentStorage() {
    if (navigator.storage?.persist) {
      try {
        if (await navigator.storage.persisted()) return true;
        const granted = await navigator.storage.persist();
        console.log(`[DBCrypto] 永久儲存: ${granted ? '✅ 已鎖定' : '⚠️ 系統管理'}`);
        return granted;
      } catch (e) {
        console.warn('[DBCrypto] persist 失敗', e);
        return false;
      }
    }
    return false;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (dbInstance) {
        try {
          if (dbInstance.objectStoreNames) return resolve(dbInstance);
        } catch (_) {}
        dbInstance = null;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        console.log(`[DBCrypto] onupgradeneeded v${DB_VERSION}`);
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const s = db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
          s.createIndex('by_group', 'groupId', { unique: false });
          s.createIndex('by_created', 'createdAt', { unique: false });
        } else {
          const tx = e.target.transaction;
          const store = tx.objectStore(MEDIA_STORE);
          if (!store.indexNames.contains('by_group')) {
            store.createIndex('by_group', 'groupId', { unique: false });
          }
          if (!store.indexNames.contains('by_created')) {
            store.createIndex('by_created', 'createdAt', { unique: false });
          }
        }
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE, { keyPath: 'key' });
        }
      };
      req.onblocked = () => console.warn('[DBCrypto] DB 升級被阻擋，請關閉其他分頁');
      req.onsuccess = (e) => {
        dbInstance = e.target.result;
        dbInstance.onversionchange = () => {
          console.warn('[DBCrypto] 版本變更，關閉舊連線');
          try {
            dbInstance.close();
          } catch (_) {}
          dbInstance = null;
        };
        resolve(dbInstance);
      };
      req.onerror = (e) => {
        console.error('[DBCrypto] 開啟失敗', e.target.error);
        reject(e.target.error);
      };
    });
  }

  function getRandomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  /**
   * 評估金庫密碼強度：建議至少 8 位且包含英數混合，並標示是否為預設弱密碼 '1234'
   */
  function evaluatePasswordStrength(password) {
    const str = String(password ?? '');
    const isDefaultPin = str === '1234';
    const hasLetter = /[A-Za-z]/.test(str);
    const hasDigit = /\d/.test(str);
    const isStrong = str.length >= 8 && hasLetter && hasDigit && !isDefaultPin;
    return {
      validMinLength: str.length >= 4,
      isDefaultPin,
      isStrong,
      recommendation: isStrong
        ? '密碼強度良好'
        : '建議設定至少 8 位英數混合密碼，以防止備份檔遭離線暴力破解'
    };
  }

  /**
   * 清洗與驗證收款金庫資料：強制阻斷 javascript: / data: 等偽協議連結
   */
  function sanitizeVaultPayload(rawPayload) {
    if (!rawPayload || typeof rawPayload !== 'object') return {};
    const clean = { ...rawPayload };

    if (typeof clean.paymeLink === 'string' && clean.paymeLink.trim() !== '') {
      const link = clean.paymeLink.trim();
      if (/^https:\/\/[a-z0-9.-]+\//i.test(link)) {
        clean.paymeLink = link;
      } else if (/^payme\.hsbc\//i.test(link)) {
        clean.paymeLink = 'https://' + link;
      } else {
        console.warn('[DBCrypto] 已攔截非 https:// 協定之收款連結');
        clean.paymeLink = '';
      }
    }

    if (typeof clean.fpsId === 'string') clean.fpsId = clean.fpsId.trim().slice(0, 64);
    if (typeof clean.bankCode === 'string') clean.bankCode = clean.bankCode.trim().slice(0, 16);
    if (typeof clean.bankAccount === 'string') clean.bankAccount = clean.bankAccount.trim().slice(0, 32);
    if (typeof clean.holderName === 'string') clean.holderName = clean.holderName.trim().slice(0, 64);

    return clean;
  }

  function checkUnlockRateLimit() {
    const now = Date.now();
    if (now < unlockCooldownUntil) {
      const waitSec = Math.ceil((unlockCooldownUntil - now) / 1000);
      throw new Error(`嘗試次數過多，請等待 ${waitSec} 秒後再試`);
    }
  }

  function recordUnlockFailure() {
    failedUnlockCount += 1;
    if (failedUnlockCount >= 5) {
      const lockMs = Math.min(60000, Math.pow(2, failedUnlockCount - 5) * 3000);
      unlockCooldownUntil = Date.now() + lockMs;
    }
  }

  function resetUnlockFailure() {
    failedUnlockCount = 0;
    unlockCooldownUntil = 0;
  }

  async function deriveAESKey(password, saltUint8, iterations = PBKDF2_ITERATIONS) {
    const safeIterations =
      Number.isFinite(Number(iterations)) && Number(iterations) >= 10000
        ? Number(iterations)
        : LEGACY_PBKDF2_ITERATIONS;

    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      enc.encode(String(password)),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltUint8, iterations: safeIterations, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // ==========================================================================
  // ObjectURL 精確追蹤與回收管理 (依資源 id 與 groupId 分類，徹底防止記憶體洩漏)
  // ==========================================================================
  function trackObjectURL(url, id = null, groupId = null) {
    if (id) {
      for (const [existingUrl, meta] of activeObjectURLMap.entries()) {
        if (meta.id === id) {
          try {
            URL.revokeObjectURL(existingUrl);
          } catch (_) {}
          activeObjectURLMap.delete(existingUrl);
        }
      }
    }
    activeObjectURLMap.set(url, { id, groupId });
    return url;
  }

  function revokeObjectURL(url) {
    if (!url) return;
    try {
      URL.revokeObjectURL(url);
      activeObjectURLMap.delete(url);
    } catch (_) {}
  }

  function revokeGroupObjectURLs(groupId) {
    if (!groupId) return;
    for (const [url, meta] of activeObjectURLMap.entries()) {
      if (meta.groupId === groupId) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
        activeObjectURLMap.delete(url);
      }
    }
  }

  function revokeAllObjectURLs() {
    for (const url of activeObjectURLMap.keys()) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
    activeObjectURLMap.clear();
  }

  // ==========================================================================
  // 個人收款金庫加解密 (PBKDF2 600,000 次 + AES-GCM 256-bit)
  // ==========================================================================
  async function saveEncryptedVault(password, vaultData) {
    const strength = evaluatePasswordStrength(password);
    if (!strength.validMinLength) {
      throw new Error('金庫密碼至少需 4 位字元');
    }
    if (!strength.isStrong) {
      console.warn('[DBCrypto] 資安提示：', strength.recommendation);
    }

    const sanitizedData = sanitizeVaultPayload(vaultData);
    const db = await openDB();
    const salt = getRandomBytes(SALT_BYTE_LENGTH);
    const iv = getRandomBytes(IV_BYTE_LENGTH);
    const aesKey = await deriveAESKey(password, salt, PBKDF2_ITERATIONS);
    const pt = new TextEncoder().encode(JSON.stringify(sanitizedData));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, pt);

    const record = {
      key: VAULT_RECORD_KEY,
      cipher: new Uint8Array(ct),
      iv,
      salt,
      iterations: PBKDF2_ITERATIONS,
      updatedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      tx.objectStore(STATE_STORE).put(record);
      tx.oncomplete = () =>
        resolve({
          success: true,
          updatedAt: record.updatedAt,
          passwordStrength: strength
        });
      tx.onerror = (e) => {
        if (e.target.error?.name === 'QuotaExceededError') {
          reject(new Error('裝置儲存空間不足，請先清理舊收據'));
        } else {
          reject(e.target.error);
        }
      };
    });
  }

  async function unlockEncryptedVault(password) {
    checkUnlockRateLimit();

    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get(VAULT_RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
    if (!record) return null;

    try {
      const iters = record.iterations || LEGACY_PBKDF2_ITERATIONS;
      const aesKey = await deriveAESKey(password, record.salt, iters);
      const ptBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        aesKey,
        record.cipher
      );
      resetUnlockFailure();
      const parsed = JSON.parse(new TextDecoder().decode(ptBuf));
      return sanitizeVaultPayload(parsed);
    } catch (_) {
      recordUnlockFailure();
      throw new Error('INVALID_VAULT_PASSWORD');
    }
  }

  // ==========================================================================
  // 單據原生 Blob 與加密收款 QR Code 存取
  // ==========================================================================
  async function saveBlobToMediaVault(id, blob, groupId = 'default') {
    if (!(blob instanceof Blob)) throw new Error('必須是 Blob 或 File 物件');
    if (blob.size > MAX_BLOB_SIZE) {
      throw new Error(`單據超過 ${MAX_BLOB_SIZE / 1024 / 1024}MB 上限`);
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const rec = {
        id,
        blob,
        mimeType: blob.type || 'image/webp',
        sizeKB: Math.round(blob.size / 1024),
        encrypted: false,
        groupId,
        createdAt: Date.now()
      };
      tx.objectStore(MEDIA_STORE).put(rec);
      tx.oncomplete = () => resolve(rec);
      tx.onerror = (e) => {
        if (e.target.error?.name === 'QuotaExceededError') {
          reject(new Error('儲存空間已滿，請於埋單頁清除舊團收據 Blob'));
        } else {
          reject(e.target.error);
        }
      };
    });
  }

  async function loadBlobObjectURL(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readonly');
      const req = tx.objectStore(MEDIA_STORE).get(id);
      req.onsuccess = () => {
        const res = req.result;
        if (res?.blob instanceof Blob) {
          resolve(trackObjectURL(URL.createObjectURL(res.blob), id, res.groupId || 'default'));
        } else {
          resolve(null);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function saveEncryptedQRBlob(id, qrBlob, password) {
    if (!(qrBlob instanceof Blob)) throw new Error('必須是 Blob 物件');
    if (!password || String(password).length < 4) {
      throw new Error('加密收款 QR 需要至少 4 位金庫密碼');
    }
    if (qrBlob.size > MAX_BLOB_SIZE) {
      throw new Error(`圖片超過 ${MAX_BLOB_SIZE / 1024 / 1024}MB 上限`);
    }

    const db = await openDB();
    const salt = getRandomBytes(SALT_BYTE_LENGTH);
    const iv = getRandomBytes(IV_BYTE_LENGTH);
    const aesKey = await deriveAESKey(password, salt, PBKDF2_ITERATIONS);
    const raw = await qrBlob.arrayBuffer();
    const encBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, raw);
    const encBlob = new Blob([encBuf], { type: 'application/octet-stream' });

    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const rec = {
        id,
        blob: encBlob,
        originalMimeType: qrBlob.type || 'image/webp',
        sizeKB: Math.round(encBlob.size / 1024),
        encrypted: true,
        iv,
        salt,
        iterations: PBKDF2_ITERATIONS,
        groupId: 'private_vault',
        createdAt: Date.now()
      };
      tx.objectStore(MEDIA_STORE).put(rec);
      tx.oncomplete = () => resolve(rec);
      tx.onerror = (e) => {
        if (e.target.error?.name === 'QuotaExceededError') {
          reject(new Error('裝置儲存空間不足'));
        } else {
          reject(e.target.error);
        }
      };
    });
  }

  async function loadEncryptedQRBlobURL(id, password) {
    checkUnlockRateLimit();

    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readonly');
      const req = tx.objectStore(MEDIA_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
    if (!record?.blob) return null;
    if (!record.encrypted) {
      return trackObjectURL(URL.createObjectURL(record.blob), id, record.groupId || 'private_vault');
    }

    try {
      const iters = record.iterations || LEGACY_PBKDF2_ITERATIONS;
      const aesKey = await deriveAESKey(password, record.salt, iters);
      const cipherBuf = await record.blob.arrayBuffer();
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        aesKey,
        cipherBuf
      );
      resetUnlockFailure();
      const restored = new Blob([plainBuf], { type: record.originalMimeType || 'image/webp' });
      return trackObjectURL(URL.createObjectURL(restored), id, 'private_vault');
    } catch (_) {
      recordUnlockFailure();
      throw new Error('INVALID_QR_PASSWORD');
    }
  }

  async function purgeGroupMediaBlobs(groupId) {
    const db = await openDB();
    // 同步釋放該群組所有已建立的預覽圖 ObjectURL，消除記憶體洩漏
    revokeGroupObjectURLs(groupId);

    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const store = tx.objectStore(MEDIA_STORE);
      const idx = store.index('by_group');
      const req = idx.openCursor(IDBKeyRange.only(groupId));
      let count = 0;
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) {
          cur.delete();
          count++;
          cur.continue();
        }
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function deleteVault() {
    const db = await openDB();
    revokeGroupObjectURLs('private_vault');
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      tx.objectStore(STATE_STORE).delete(VAULT_RECORD_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  return {
    initPersistentStorage,
    openDB,
    evaluatePasswordStrength,
    sanitizeVaultPayload,
    saveEncryptedVault,
    unlockEncryptedVault,
    saveBlobToMediaVault,
    loadBlobObjectURL,
    saveEncryptedQRBlob,
    loadEncryptedQRBlobURL,
    purgeGroupMediaBlobs,
    revokeObjectURL,
    revokeGroupObjectURLs,
    revokeAllObjectURLs,
    deleteVault
  };
})();
// ============================================================================
// 《混賬》(Messy Split) v7.4 - 資料庫與加密金庫模組 (db-crypto.js)
// 強化內容：
// 1. [資安強制] 徹底廢除預設密碼 1234；強制要求設定 8 位以上英數混合密碼，且最少包含 1 個英文大寫字元 (A-Z)
// 2. [資安] PBKDF2 預設迭代次數採用 OWASP 標準 600,000 次（向下相容舊版紀錄讀取）
// 3. [資安] 解密錯誤次數統計與指數退避冷卻機制 (Rate Limiting)，防禦暴力破解
// 4. [資安] sanitizeVaultPayload() 強制過濾非 https:// 之 PayMe 連結，阻斷偽協議 XSS
// 5. [效能] ObjectURL 以 Map 按資源 ID 與 groupId 精確追蹤回收，防止記憶體洩漏
// ============================================================================

const DBCrypto = (() => {
  'use strict';

  const DB_NAME = 'MessySplitDB';
  const DB_VERSION = 7;
  const MEDIA_STORE = 'media_vault_store';
  const STATE_STORE = 'app_state_store';
  const VAULT_RECORD_KEY = 'encrypted_financial_vault';

  const PBKDF2_ITERATIONS = 600000;
  const LEGACY_PBKDF2_ITERATIONS = 100000;
  const SALT_BYTE_LENGTH = 16;
  const IV_BYTE_LENGTH = 12;
  const MAX_BLOB_SIZE = 15 * 1024 * 1024; // 15MB

  let dbInstance = null;
  const activeObjectURLMap = new Map();

  let failedUnlockCount = 0;
  let unlockCooldownUntil = 0;

  async function initPersistentStorage() {
    if (navigator.storage?.persist) {
      try {
        if (await navigator.storage.persisted()) return true;
        const granted = await navigator.storage.persist();
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
          try {
            dbInstance.close();
          } catch (_) {}
          dbInstance = null;
        };
        resolve(dbInstance);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function getRandomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
  }

  /**
   * 嚴格評估金庫密碼強度：
   * 必須為 8 位或以上英數混合，且最少包含 1 個英文大寫字元 (A-Z) 與 1 個數字 (0-9)
   */
  function evaluatePasswordStrength(password) {
    const str = String(password ?? '');
    const hasMinLength = str.length >= 8;
    const hasUpper = /[A-Z]/.test(str);
    const hasLetter = /[A-Za-z]/.test(str);
    const hasDigit = /[0-9]/.test(str);
    const isStrong = hasMinLength && hasUpper && hasLetter && hasDigit;

    const missing = [];
    if (!hasMinLength) missing.push('至少 8 個字元');
    if (!hasUpper) missing.push('最少 1 個英文大楷 (A-Z)');
    if (!hasDigit) missing.push('最少 1 個數字 (0-9)');

    return {
      validMinLength: hasMinLength,
      hasUpper,
      hasDigit,
      isStrong,
      recommendation: isStrong
        ? '密碼強度符合安全規範（8 位以上英數混合且含英文大楷）'
        : `密碼未達標，尚缺：${missing.join('、')}`
    };
  }

  /**
   * 檢查 IndexedDB 中是否已建立加密收款金庫
   */
  async function hasEncryptedVault() {
    try {
      const db = await openDB();
      return await new Promise((resolve) => {
        const tx = db.transaction([STATE_STORE], 'readonly');
        const req = tx.objectStore(STATE_STORE).get(VAULT_RECORD_KEY);
        req.onsuccess = () => resolve(!!req.result);
        req.onerror = () => resolve(false);
      });
    } catch (_) {
      return false;
    }
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
      throw new Error(`密碼錯誤次數過多，請等待 ${waitSec} 秒後再試`);
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
  // ObjectURL 精確追蹤與回收管理
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
  // 個人收款金庫加解密 (強制 8 位以上英數混合 + 至少 1 大寫英文)
  // ==========================================================================
  async function saveEncryptedVault(password, vaultData) {
    const strength = evaluatePasswordStrength(password);
    if (!strength.isStrong) {
      throw new Error(strength.recommendation);
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

    if (!password) {
      throw new Error('EMPTY_VAULT_PASSWORD');
    }

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
    const strength = evaluatePasswordStrength(password);
    if (!strength.isStrong) {
      throw new Error(strength.recommendation);
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
    hasEncryptedVault,
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

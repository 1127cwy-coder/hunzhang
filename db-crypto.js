// ============================================================================
// 《混賬》(Messy Split) v7.0 - 資料庫與軍事級加密金庫模組 (db-crypto.js)
// 功能：
// 1. navigator.storage.persist() 申請永久儲存權限（防 iOS 7天清理）
// 2. IndexedDB (onupgradeneeded) 雙倉庫架構：
//    - media_vault_store：直接儲存原生二進位 Blob（收據、QR Code、頭像）
//    - app_state_store：儲存一般狀態與 AES-GCM 加密後的金庫密文
// 3. Web Crypto API：PBKDF2 (100,000次迭代) 密碼衍生金鑰 + AES-GCM (256-bit)
//    專門加密：FPS、PayMe、銀行戶口（銀行代碼+帳號+持有人）、QR Code Blob
// ============================================================================

const DBCrypto = (() => {
  const DB_NAME = 'MessySplitDB';
  const DB_VERSION = 7;
  const MEDIA_STORE = 'media_vault_store'; // 原生 Blob 媒體倉
  const STATE_STORE = 'app_state_store';   // 帳目狀態與加密金庫倉
  const VAULT_RECORD_KEY = 'encrypted_financial_vault';

  // PBKDF2 參數設定
  const PBKDF2_ITERATIONS = 100000;
  const SALT_BYTE_LENGTH = 16;
  const IV_BYTE_LENGTH = 12; // AES-GCM 標準建議 12 bytes (96 bits)

  let dbInstance = null;

  // --------------------------------------------------------------------------
  // 1. 啟動持久化儲存 (navigator.storage.persist)
  // --------------------------------------------------------------------------
  async function initPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const alreadyPersisted = await navigator.storage.persisted();
        if (alreadyPersisted) return true;
        const granted = await navigator.storage.persist();
        console.log(`[DBCrypto] 永久儲存權限狀態: ${granted ? '✅ 已鎖定保護' : '⚠️ 系統預設管理'}`);
        return granted;
      } catch (err) {
        console.warn('[DBCrypto] 無法呼叫 navigator.storage.persist():', err);
        return false;
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // 2. 開啟 IndexedDB 並處理版本升級 (onupgradeneeded)
  // --------------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      if (dbInstance) return resolve(dbInstance);

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log(`[DBCrypto] 執行 onupgradeneeded 資料庫結構升級 (v${DB_VERSION})`);

        // 倉庫 A：media_vault_store — 直接儲存原生 Blob 或加密後的二進位物件[cite: 3]
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const mediaStore = db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
          mediaStore.createIndex('by_group', 'groupId', { unique: false });
          mediaStore.createIndex('by_created', 'createdAt', { unique: false });
        }

        // 倉庫 B：app_state_store — 儲存帳目 JSON 與 AES-GCM 金庫密文[cite: 3]
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        dbInstance = event.target.result;
        resolve(dbInstance);
      };

      request.onerror = (event) => {
        console.error('[DBCrypto] IndexedDB 開啟失敗:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // --------------------------------------------------------------------------
  // 3. 密碼學輔助工具：PBKDF2 衍生金鑰 & AES-GCM 加解密核心
  // --------------------------------------------------------------------------
  
  // 產生密碼學安全隨機 Bytes
  function getRandomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  // 將使用者輸入的密碼 (如 '1234') + Salt 衍生為 256-bit AES-GCM 專用 CryptoKey
  async function deriveAESKey(password, saltUint8) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(String(password)),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltUint8,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false, // 金鑰不可被匯出 (non-extractable)，防止記憶體外洩
      ['encrypt', 'decrypt']
    );
  }

  // --------------------------------------------------------------------------
  // 4. 加密與解密收款金庫文字資料 (FPS / PayMe / 銀行下拉選單+帳號+持有人)
  // --------------------------------------------------------------------------

  /**
   * 加密並儲存個人收款金庫到 IndexedDB (app_state_store)
   * @param {string} password - 用戶金庫密碼 (如 '1234')
   * @param {Object} vaultData - 包含 { fpsId, paymeLink, bankCode, bankAccount, holderName, qrMediaId }
   */
  async function saveEncryptedVault(password, vaultData) {
    const db = await openDB();
    const salt = getRandomBytes(SALT_BYTE_LENGTH);
    const iv = getRandomBytes(IV_BYTE_LENGTH);
    const aesKey = await deriveAESKey(password, salt);

    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(JSON.stringify(vaultData));

    // 執行 AES-GCM 256-bit 加密 (自帶完整性驗證 Auth Tag，密碼錯或被竄改會直接拋錯)
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      plaintextBytes
    );

    const record = {
      key: VAULT_RECORD_KEY,
      cipher: new Uint8Array(ciphertextBuffer), // 直接以二進位 Uint8Array 存入 IndexedDB
      iv,
      salt,
      iterations: PBKDF2_ITERATIONS,
      updatedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      tx.objectStore(STATE_STORE).put(record);
      tx.oncomplete = () => resolve({ success: true, updatedAt: record.updatedAt });
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 輸入密碼解鎖並讀取個人收款金庫
   * @param {string} password - 用戶輸入的解鎖密碼
   * @returns {Promise<Object>} 解密後的收款資料物件
   */
  async function unlockEncryptedVault(password) {
    const db = await openDB();

    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get(VAULT_RECORD_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });

    if (!record) {
      return null; // 尚未建立過加密金庫
    }

    try {
      const aesKey = await deriveAESKey(password, record.salt);
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        aesKey,
        record.cipher
      );

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer));
    } catch (err) {
      // AES-GCM 若密碼錯誤，會在 decrypt 階段拋出 OperationError
      throw new Error('INVALID_VAULT_PASSWORD');
    }
  }

  // --------------------------------------------------------------------------
  // 5. 原生 Blob 媒體倉管理 (收據單據 & 加密版收款 QR Code Blob)
  // --------------------------------------------------------------------------

  /**
   * 將一般單據或頭像直接以原生 Blob 存入 media_vault_store (不轉 Base64)[cite: 3]
   */
  async function saveBlobToMediaVault(id, blob, groupId = 'default') {
    if (!(blob instanceof Blob)) {
      throw new Error('傳入的資料必須是原生 Blob 或 File 物件');
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const record = {
        id,
        blob, // 直接存原生 Blob[cite: 3]
        mimeType: blob.type || 'image/webp',
        sizeKB: Math.round(blob.size / 1024),
        encrypted: false,
        groupId,
        createdAt: Date.now()
      };
      tx.objectStore(MEDIA_STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 讀取一般單據 Blob 並回傳可用於 <img src="..."> 的 ObjectURL[cite: 3]
   */
  async function loadBlobObjectURL(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readonly');
      const req = tx.objectStore(MEDIA_STORE).get(id);
      req.onsuccess = () => {
        const res = req.result;
        if (res && res.blob instanceof Blob) {
          resolve(URL.createObjectURL(res.blob));
        } else {
          resolve(null);
        }
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 【專屬保護】將收款 QR Code 原生 Blob 進行 AES-GCM 加密後存入 media_vault_store
   * 即使有人打開瀏覽器 DevTools 查看 IndexedDB，也無法直接預覽你的收款 QR Code 圖片
   */
  async function saveEncryptedQRBlob(id, qrBlob, password) {
    const db = await openDB();
    const salt = getRandomBytes(SALT_BYTE_LENGTH);
    const iv = getRandomBytes(IV_BYTE_LENGTH);
    const aesKey = await deriveAESKey(password, salt);

    const rawArrayBuffer = await qrBlob.arrayBuffer();
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      rawArrayBuffer
    );

    // 將加密後的密文包裝為 application/octet-stream 原生 Blob 存入 media_vault_store
    const encryptedBlob = new Blob([encryptedBuffer], { type: 'application/octet-stream' });

    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const record = {
        id,
        blob: encryptedBlob, // 依然是原生 Blob，但內容已是 AES-GCM 密文
        originalMimeType: qrBlob.type || 'image/webp',
        sizeKB: Math.round(encryptedBlob.size / 1024),
        encrypted: true,
        iv,
        salt,
        groupId: 'private_vault',
        createdAt: Date.now()
      };
      tx.objectStore(MEDIA_STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 輸入密碼解密收款 QR Code Blob，並回傳可顯示的圖片 ObjectURL
   */
  async function loadEncryptedQRBlobURL(id, password) {
    const db = await openDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readonly');
      const req = tx.objectStore(MEDIA_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });

    if (!record || !record.blob) return null;
    if (!record.encrypted) {
      return URL.createObjectURL(record.blob);
    }

    try {
      const aesKey = await deriveAESKey(password, record.salt);
      const cipherBuffer = await record.blob.arrayBuffer();
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        aesKey,
        cipherBuffer
      );

      const restoredBlob = new Blob([decryptedBuffer], {
        type: record.originalMimeType || 'image/webp'
      });
      return URL.createObjectURL(restoredBlob);
    } catch (err) {
      throw new Error('INVALID_QR_PASSWORD');
    }
  }

  // --------------------------------------------------------------------------
  // 6. 完團一鍵清除特定群組的所有單據 Blob (釋放空間 & 保護私隱)
  // --------------------------------------------------------------------------
  async function purgeGroupMediaBlobs(groupId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([MEDIA_STORE], 'readwrite');
      const store = tx.objectStore(MEDIA_STORE);
      const index = store.index('by_group');
      const req = index.openCursor(IDBKeyRange.only(groupId));
      let deletedCount = 0;

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deletedCount++;
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(deletedCount);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // 對外公開 API
  return {
    initPersistentStorage,
    openDB,
    saveEncryptedVault,
    unlockEncryptedVault,
    saveBlobToMediaVault,
    loadBlobObjectURL,
    saveEncryptedQRBlob,
    loadEncryptedQRBlobURL,
    purgeGroupMediaBlobs
  };
})();
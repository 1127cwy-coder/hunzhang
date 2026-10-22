// ============================================================================
// 《混賬》(Messy Split) v7.0 - 完團報表匯出與自動備份模組 (export-backup.js)
// 功能：
// 1. 完團資料匯出：
//    - CSV (內建 UTF-8 BOM，完美解決香港繁體中文與日圓 ¥ 在 Excel 亂碼問題)
//    - Excel (.xls 多工作表 XML 格式，零外部套件、支援顏色標記與雙分頁：消費明細 + 最少步埋單)
//    - PDF (高質感 A4 向量排版結算報告，支援手機 Safari / Chrome 直接另存為 PDF)
// 2. 自動備份與完整還原引擎：
//    - 監聽頁面隱藏 (visibilitychange) 與定時快照備份至 IndexedDB (app_state_store)
//    - 支援連同 media_vault_store 內的原生 Blob 單據一併打包成 .messybackup 備份檔及完整還原
// ============================================================================

const ExportBackup = (() => {
  const DB_NAME = 'MessySplitDB';
  const DB_VERSION = 7;
  const MEDIA_STORE = 'media_vault_store';
  const STATE_STORE = 'app_state_store';
  const AUTO_BACKUP_KEY = 'auto_backup_snapshot';

  let autoBackupTimer = null;

  // --------------------------------------------------------------------------
  // 輔助工具：安全字串轉義與檔案下載觸發器
  // --------------------------------------------------------------------------
  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeCSV(val) {
    const str = String(val ?? '').replace(/\r?\n/g, ' ');
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 300);
  }

  function formatDateStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  // --------------------------------------------------------------------------
  // 1. 匯出 CSV 報表 (UTF-8 with BOM，Excel 直開不亂碼)
  // --------------------------------------------------------------------------
  /**
   * @param {Object} groupData - { name, currency, exchangeRate, members, expenses, settlements, poolBalance }
   */
  function exportToCSV(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = []
    } = groupData;

    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    const rows = [];

    // 區塊一：群組摘要
    rows.push(['【混賬 Messy Split — 完團結算總表】']);
    rows.push(['群組名稱', name, '匯出日期', formatDateStamp()]);
    rows.push(['主要貨幣', currency, '折算港幣匯率', exchangeRate]);
    rows.push([]);

    // 區塊二：消費明細
    rows.push(['【一、消費賬單明細】']);
    rows.push([
      '日期',
      '項目名稱',
      '墊支人/付款方式',
      `原幣金額 (${currency})`,
      '折合港幣 (HK$)',
      '參與分攤成員',
      '多退少補/自訂加項備註',
      '單據ID'
    ]);

    let totalOriginal = 0;
    let totalHKD = 0;

    expenses.forEach((exp) => {
      const amt = Number(exp.amount) || 0;
      const hkd = amt * (Number(exchangeRate) || 1);
      totalOriginal += amt;
      totalHKD += hkd;

      const payerName = exp.paidByPool
        ? '💰 公數資金池'
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;

      const splitNames = (exp.participants || [])
        .map((id) => memberMap[id] || id)
        .join('、');

      const extraNotes = exp.customExtras
        ? Object.entries(exp.customExtras)
            .filter(([, v]) => Number(v) > 0)
            .map(([id, v]) => `${memberMap[id] || id}: +${v}`)
            .join('；')
        : '-';

      rows.push([
        exp.date || formatDateStamp(),
        exp.title || '未命名消費',
        payerName,
        amt.toFixed(2),
        hkd.toFixed(2),
        splitNames,
        extraNotes,
        exp.receiptId || '無'
      ]);
    });

    rows.push([
      '總計',
      `共 ${expenses.length} 筆`,
      '',
      totalOriginal.toFixed(2),
      totalHKD.toFixed(2),
      '',
      '',
      ''
    ]);
    rows.push([]);

    // 區塊三：最少步埋單結果
    rows.push(['【二、最少步埋單結算行動表】']);
    rows.push(['欠款人 (需付錢)', '收款人 (債主)', '應付金額 (HK$)', '還款狀態']);

    if (settlements.length === 0) {
      rows.push(['🎉 全團帳目已結清，無須任何轉帳！', '', '', '已結清']);
    } else {
      settlements.forEach((s) => {
        const fromName = memberMap[s.from] || s.fromName || s.from;
        const toName = memberMap[s.to] || s.toName || s.to;
        const statusText =
          s.status === 'confirmed'
            ? '✅ 已收妥破鎖'
            : s.status === 'pending_confirm'
            ? '⏳ 待債主確認'
            : '🔒 待找數';
        rows.push([fromName, toName, Number(s.amountHKD || s.amount || 0).toFixed(2), statusText]);
      });
    }

    // 組合 CSV 字串並加上 \uFEFF (UTF-8 BOM)
    const csvContent = '\uFEFF' + rows.map((r) => r.map(escapeCSV).join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    triggerBlobDownload(blob, `${safeName}_完團結算_${formatDateStamp()}.csv`);
  }

  // --------------------------------------------------------------------------
  // 2. 匯出原生多工作表 Excel (.xls SpreadsheetML 格式，免外掛支援雙分頁與底色)
  // --------------------------------------------------------------------------
  function exportToExcel(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = []
    } = groupData;

    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));

    let expenseRowsXML = '';
    let totalHKD = 0;

    expenses.forEach((exp) => {
      const amt = Number(exp.amount) || 0;
      const hkd = amt * (Number(exchangeRate) || 1);
      totalHKD += hkd;
      const payerName = exp.paidByPool
        ? '公數資金池'
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;
      const splitNames = (exp.participants || []).map((id) => memberMap[id] || id).join('、');

      expenseRowsXML += `
        <Row>
          <Cell><Data ss:Type="String">${escapeHTML(exp.date || formatDateStamp())}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(exp.title || '未命名消費')}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(payerName)}</Data></Cell>
          <Cell><Data ss:Type="Number">${amt.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="Number">${hkd.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(splitNames)}</Data></Cell>
        </Row>`;
    });

    let settlementRowsXML = '';
    settlements.forEach((s) => {
      const fromName = memberMap[s.from] || s.fromName || s.from;
      const toName = memberMap[s.to] || s.toName || s.to;
      const amtHKD = Number(s.amountHKD || s.amount || 0).toFixed(2);
      const statusText =
        s.status === 'confirmed'
          ? '已收妥破鎖'
          : s.status === 'pending_confirm'
          ? '待債主確認'
          : '待找數';

      settlementRowsXML += `
        <Row>
          <Cell><Data ss:Type="String">${escapeHTML(fromName)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(toName)}</Data></Cell>
          <Cell><Data ss:Type="Number">${amtHKD}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(statusText)}</Data></Cell>
        </Row>`;
    });

    const workbookXML = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="TotalRow">
   <Font ss:Bold="1" ss:Color="#0F172A"/>
   <Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="1_消費明細">
  <Table>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">日期</Data></Cell>
    <Cell><Data ss:Type="String">項目名稱</Data></Cell>
    <Cell><Data ss:Type="String">墊支人</Data></Cell>
    <Cell><Data ss:Type="String">原幣金額 (${escapeHTML(currency)})</Data></Cell>
    <Cell><Data ss:Type="String">折合港幣 (HK$)</Data></Cell>
    <Cell><Data ss:Type="String">參與分攤團友</Data></Cell>
   </Row>
   ${expenseRowsXML}
   <Row ss:StyleID="TotalRow">
    <Cell><Data ss:Type="String">總計 (${expenses.length} 筆)</Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
    <Cell><Data ss:Type="Number">${totalHKD.toFixed(2)}</Data></Cell>
    <Cell><Data ss:Type="String"></Data></Cell>
   </Row>
  </Table>
 </Worksheet>
 <Worksheet ss:Name="2_最少步埋單">
  <Table>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">欠款人 (需付錢)</Data></Cell>
    <Cell><Data ss:Type="String">收款人 (債主)</Data></Cell>
    <Cell><Data ss:Type="String">應付港幣 (HK$)</Data></Cell>
    <Cell><Data ss:Type="String">目前狀態</Data></Cell>
   </Row>
   ${settlementRowsXML}
  </Table>
 </Worksheet>
</Workbook>`;

    const blob = new Blob([workbookXML], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    triggerBlobDownload(blob, `${safeName}_完團帳目表_${formatDateStamp()}.xls`);
  }

  // --------------------------------------------------------------------------
  // 3. 匯出高質感 PDF 完團結算單 (免笨重字型檔，原生向量列印/另存 PDF)
  // --------------------------------------------------------------------------
  function exportToPDF(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = [],
      poolBalance = 0
    } = groupData;

    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    const totalHKD = expenses.reduce(
      (sum, e) => sum + (Number(e.amount) || 0) * (Number(exchangeRate) || 1),
      0
    );

    const settlementRowsHTML =
      settlements.length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#059669;font-weight:bold;padding:16px;">🎉 全團帳目已結清，無須額外轉帳！</td></tr>`
        : settlements
            .map((s) => {
              const fromName = escapeHTML(memberMap[s.from] || s.fromName || s.from);
              const toName = escapeHTML(memberMap[s.to] || s.toName || s.to);
              const amt = Number(s.amountHKD || s.amount || 0).toFixed(2);
              const badge =
                s.status === 'confirmed'
                  ? '<span class="badge ok">✅ 已破鎖收妥</span>'
                  : s.status === 'pending_confirm'
                  ? '<span class="badge wait">⏳ 待確認</span>'
                  : '<span class="badge due">🔒 待找數</span>';
              return `<tr>
                <td><strong>${fromName}</strong></td>
                <td>➔ <strong>${toName}</strong></td>
                <td style="text-align:right;font-weight:700;color:#B91C1C;">HK$ ${amt}</td>
                <td style="text-align:center;">${badge}</td>
              </tr>`;
            })
            .join('');

    const expenseRowsHTML = expenses
      .map((e) => {
        const amt = Number(e.amount) || 0;
        const hkd = amt * (Number(exchangeRate) || 1);
        const payer = escapeHTML(
          e.paidByPool ? '💰 公數池' : memberMap[e.payerId] || e.payerName || e.payerId
        );
        const splitNames = escapeHTML(
          (e.participants || []).map((id) => memberMap[id] || id).join('、')
        );
        return `<tr>
          <td>${escapeHTML(e.date || formatDateStamp())}</td>
          <td><strong>${escapeHTML(e.title || '未命名')}</strong></td>
          <td>${payer}</td>
          <td style="text-align:right;">${escapeHTML(currency)} ${amt.toFixed(2)}</td>
          <td style="text-align:right;font-weight:600;">HK$ ${hkd.toFixed(2)}</td>
          <td style="font-size:11px;color:#475569;">${splitNames}</td>
        </tr>`;
      })
      .join('');

    const printHTML = `<!DOCTYPE html>
<html lang="zh-HK">
<head>
  <meta charset="UTF-8">
  <title>${escapeHTML(name)} - 混賬完團結算單</title>
  <style>
    @page { size: A4; margin: 14mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang HK", "Microsoft JhengHei", sans-serif; color: #1E293B; background: #FFF; margin: 0; padding: 20px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 3px solid #1E293B; padding-bottom: 12px; margin-bottom: 20px; }
    .brand { font-size: 24px; font-weight: 900; letter-spacing: 1px; }
    .sub { font-size: 12px; color: #64748B; margin-top: 4px; }
    .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
    .card { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10px; padding: 12px 16px; }
    .card-label { font-size: 11px; color: #64748B; font-weight: 600; }
    .card-val { font-size: 20px; font-weight: 800; color: #0F172A; margin-top: 4px; }
    h2 { font-size: 15px; background: #1E293B; color: #FFF; padding: 8px 12px; border-radius: 6px; margin: 20px 0 10px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 12px; }
    th, td { border: 1px solid #CBD5E1; padding: 8px 10px; text-align: left; }
    th { background: #F1F5F9; font-weight: 700; }
    .badge { padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .badge.ok { background: #D1FAE5; color: #065F46; }
    .badge.wait { background: #FEF3C7; color: #92400E; }
    .badge.due { background: #FEE2E2; color: #991B1B; }
    .footer { margin-top: 28px; font-size: 10px; color: #94A3B8; text-align: center; border-top: 1px dashed #CBD5E1; padding-top: 10px; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:16px;text-align:right;">
    <button onclick="window.print()" style="background:#1E293B;color:#FFF;border:none;padding:10px 18px;border-radius:8px;font-weight:bold;cursor:pointer;">🖨️ 列印 / 另存為 PDF</button>
  </div>
  <div class="header">
    <div>
      <div class="brand">混賬 Messy Split — 完團結算報告書</div>
      <div class="sub">群組名稱：${escapeHTML(name)} ｜ 結算匯率：1 ${escapeHTML(currency)} = ${exchangeRate} HKD</div>
    </div>
    <div style="text-align:right;font-size:12px;color:#475569;">
      <div>匯出日期：${formatDateStamp()}</div>
      <div>參與團友：${members.length} 人</div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="card">
      <div class="card-label">全團總開支 (折合港幣)</div>
      <div class="card-val">HK$ ${totalHKD.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="card-label">總消費筆數</div>
      <div class="card-val">${expenses.length} 筆</div>
    </div>
    <div class="card">
      <div class="card-label">公數池結餘</div>
      <div class="card-val">${escapeHTML(currency)} ${Number(poolBalance || 0).toFixed(2)}</div>
    </div>
  </div>

  <h2>⚡ 一、最少步埋單結算行動表</h2>
  <table>
    <thead>
      <tr><th>欠款人 (需付錢)</th><th>收款人 (債主)</th><th style="text-align:right;">應付金額 (HK$)</th><th style="text-align:center;">狀態</th></tr>
    </thead>
    <tbody>${settlementRowsHTML}</tbody>
  </table>

  <h2>🧾 二、全團消費賬單明細</h2>
  <table>
    <thead>
      <tr><th>日期</th><th>項目</th><th>墊支人</th><th style="text-align:right;">原幣金額</th><th style="text-align:right;">折合港幣</th><th>分攤團友</th></tr>
    </thead>
    <tbody>${expenseRowsHTML}</tbody>
  </table>

  <div class="footer">
    本報表由《混賬》(Messy Split) 自動生成。所有帳目與公數紀錄僅供團友間日常分攤核對，不涉及資金託管或儲值支付服務。
  </div>
  <script>setTimeout(() => window.print(), 350);</script>
</body>
</html>`;

    const printWin = window.open('', '_blank');
    if (printWin) {
      printWin.document.open();
      printWin.document.write(printHTML);
      printWin.document.close();
    } else {
      // 若手機瀏覽器阻擋彈出視窗，直接下載獨立可列印 HTML 報表
      const blob = new Blob([printHTML], { type: 'text/html;charset=utf-8;' });
      triggerBlobDownload(blob, `${name}_PDF結算單_${formatDateStamp()}.html`);
    }
  }

  // --------------------------------------------------------------------------
  // 4. 自動備份與完整打包還原系統 (整合 IndexedDB + media_vault_store Blob)
  // --------------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const mediaStore = db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
          mediaStore.createIndex('by_group', 'groupId', { unique: false });
          mediaStore.createIndex('by_created', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // 將背景快照靜默寫入 IndexedDB 的 app_state_store
  async function saveAutoSnapshot(getStateCallback) {
    try {
      const currentState = typeof getStateCallback === 'function' ? getStateCallback() : getStateCallback;
      if (!currentState) return false;

      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STATE_STORE], 'readwrite');
        tx.objectStore(STATE_STORE).put({
          key: AUTO_BACKUP_KEY,
          state: currentState,
          updatedAt: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (err) {
      console.warn('[ExportBackup] 自動快照儲存失敗:', err);
      return false;
    }
  }

  // 讀取最新一筆自動備份快照
  async function loadAutoSnapshot() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get(AUTO_BACKUP_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * 啟動全自動背景備份引擎：
   * 1. 每隔 intervalMs (預設 60 秒) 自動寫入本地 IndexedDB 快照
   * 2. 當用戶滑走 App / 切換分頁 (visibilitychange -> hidden) 時立即觸發緊急備份
   */
  function startAutoBackupEngine(getStateCallback, intervalMs = 60000) {
    if (autoBackupTimer) clearInterval(autoBackupTimer);

    autoBackupTimer = setInterval(() => {
      saveAutoSnapshot(getStateCallback);
    }, intervalMs);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        saveAutoSnapshot(getStateCallback);
      }
    });

    console.log('[ExportBackup] ✅ 自動備份引擎已啟動 (定時快照 + 離場即時保護)');
  }

  // 輔助：僅在匯出成單一外部備份檔時，將原生 Blob 序列化為可攜式結構，還原時再轉回原生 Blob
  function blobToPortableObject(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({ mimeType: blob.type, dataUrl: reader.result });
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function portableObjectToBlob(portable) {
    const res = await fetch(portable.dataUrl);
    return res.blob();
  }

  /**
   * 匯出完整離線備份檔 (.messybackup.json)
   * 包含所有群組帳目、AES-GCM 加密金庫密文，以及可選的 media_vault_store 單據圖片
   */
  async function downloadFullBackupFile(currentState, includeMediaBlobs = true) {
    const db = await openDB();

    // 1. 讀取加密金庫密文紀錄 (保持 AES-GCM 密文狀態匯出，確保備份檔外流也不洩漏銀行與PayMe)
    const encryptedVaultRecord = await new Promise((resolve) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get('encrypted_financial_vault');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });

    // 2. 讀取 media_vault_store 內的原生 Blob 單據
    const mediaPortableList = [];
    if (includeMediaBlobs) {
      const rawMediaRecords = await new Promise((resolve) => {
        const tx = db.transaction([MEDIA_STORE], 'readonly');
        const req = tx.objectStore(MEDIA_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });

      for (const item of rawMediaRecords) {
        if (item.blob instanceof Blob) {
          const portable = await blobToPortableObject(item.blob);
          mediaPortableList.push({
            id: item.id,
            groupId: item.groupId,
            encrypted: item.encrypted || false,
            originalMimeType: item.originalMimeType || item.mimeType,
            iv: item.iv ? Array.from(item.iv) : null,
            salt: item.salt ? Array.from(item.salt) : null,
            createdAt: item.createdAt,
            portableBlob: portable
          });
        }
      }
    }

    // 將加密金庫內的 Uint8Array 轉為一般 Array 以便 JSON 封裝
    const serializableVault = encryptedVaultRecord
      ? {
          ...encryptedVaultRecord,
          cipher: Array.from(encryptedVaultRecord.cipher || []),
          iv: Array.from(encryptedVaultRecord.iv || []),
          salt: Array.from(encryptedVaultRecord.salt || [])
        }
      : null;

    const backupBundle = {
      app: 'MessySplit',
      version: '7.0',
      exportedAt: new Date().toISOString(),
      state: currentState,
      encryptedVault: serializableVault,
      mediaCount: mediaPortableList.length,
      mediaVault: mediaPortableList
    };

    const blob = new Blob([JSON.stringify(backupBundle)], {
      type: 'application/json;charset=utf-8;'
    });
    triggerBlobDownload(blob, `混賬完整備份_${formatDateStamp()}.messybackup.json`);
  }

  /**
   * 從備份檔 (.messybackup.json) 完整還原帳目、加密金庫與原生 Blob 媒體庫
   * @param {File} backupFile - 用戶選擇的備份檔案
   */
  async function restoreFromBackupFile(backupFile) {
    const text = await backupFile.text();
    const bundle = JSON.parse(text);

    if (!bundle || bundle.app !== 'MessySplit') {
      throw new Error('無效的《混賬》備份檔案格式');
    }

    const db = await openDB();

    // 1. 還原狀態快照與 AES-GCM 加密金庫密文
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      const store = tx.objectStore(STATE_STORE);

      if (bundle.state) {
        store.put({
          key: AUTO_BACKUP_KEY,
          state: bundle.state,
          updatedAt: Date.now()
        });
      }

      if (bundle.encryptedVault) {
        store.put({
          ...bundle.encryptedVault,
          cipher: new Uint8Array(bundle.encryptedVault.cipher),
          iv: new Uint8Array(bundle.encryptedVault.iv),
          salt: new Uint8Array(bundle.encryptedVault.salt)
        });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // 2. 將備份檔內的圖片重新轉回原生 Blob 存入 media_vault_store
    if (Array.isArray(bundle.mediaVault) && bundle.mediaVault.length > 0) {
      for (const item of bundle.mediaVault) {
        if (item.portableBlob) {
          const restoredBlob = await portableObjectToBlob(item.portableBlob);
          await new Promise((resolve, reject) => {
            const tx = db.transaction([MEDIA_STORE], 'readwrite');
            tx.objectStore(MEDIA_STORE).put({
              id: item.id,
              blob: restoredBlob, // 還原回原生二進位 Blob！
              mimeType: restoredBlob.type,
              originalMimeType: item.originalMimeType,
              sizeKB: Math.round(restoredBlob.size / 1024),
              encrypted: item.encrypted || false,
              iv: item.iv ? new Uint8Array(item.iv) : undefined,
              salt: item.salt ? new Uint8Array(item.salt) : undefined,
              groupId: item.groupId || 'default',
              createdAt: item.createdAt || Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
          });
        }
      }
    }

    return {
      restoredState: bundle.state,
      mediaRestoredCount: (bundle.mediaVault || []).length,
      exportedAt: bundle.exportedAt
    };
  }

  return {
    exportToCSV,
    exportToExcel,
    exportToPDF,
    startAutoBackupEngine,
    saveAutoSnapshot,
    loadAutoSnapshot,
    downloadFullBackupFile,
    restoreFromBackupFile
  };
})();
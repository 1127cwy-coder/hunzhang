// ============================================================================
// 《混賬》(Messy Split) v7.2 - 完團報表匯出與自動備份模組 (export-backup.js)
// 審計強化內容：
// 1. [效能] downloadFullBackupFile 改用 Blob 分塊串流組裝，消除單一巨型 JSON 字串造成的記憶體峰值 (OOM)
// 2. [效能] 打包與還原單據迴圈加入 Event Loop 讓出機制 (yieldToMain)，防止多單據時凍結 UI
// 3. [資安] 對齊 OWASP 600,000 次 PBKDF2 迭代標準，並保留 100,000 次舊版備份向下相容
// 4. [法律] CSV / Excel / PDF 全面補齊「AS IS 算術與匯率免責條款」、「API 來源標示」與「PDPO 私隱提醒」
// ============================================================================

const ExportBackup = (() => {
  'use strict';

  const DB_NAME = 'MessySplitDB';
  const DB_VERSION = 7;
  const MEDIA_STORE = 'media_vault_store';
  const STATE_STORE = 'app_state_store';
  const AUTO_BACKUP_KEY = 'auto_backup_snapshot';
  const ENCRYPTED_VAULT_KEY = 'encrypted_financial_vault';

  const DEFAULT_PBKDF2_ITERATIONS = 600000;
  const LEGACY_PBKDF2_ITERATIONS = 100000;
  const MAX_BACKUP_SIZE = 100 * 1024 * 1024; // 100MB
  const SAFE_NAME_MAX = 80;

  // 法律免責與私隱合規條款常數
  const LEGAL_DISCLAIMER_TEXT =
    '【免責聲明】本報表之匯率折算、OCR 單據辨識與最少步結算金額按「現況 (AS IS)」提供，僅供算術參考；團友於實際轉帳前應自行核對單據原圖與金額，開發者對任何直接或間接財務誤差概不負責。匯率資料來源：Rates by Exchange Rate API。';
  const PRIVACY_NOTICE_TEXT =
    '【私隱提醒】本報表包含團友名稱與消費紀錄，請僅限於群組成員內部核對使用，切勿公開發布至公眾網路，以免觸犯香港《個人資料（私隱）條例》（第 486 章）。';

  let autoBackupTimer = null;
  let onVisibilityChange = null;

  // Dirty Flag 與上次儲存之狀態字串快取，避免每 60 秒重複無效寫入 IndexedDB
  let isStateDirty = false;
  let lastSavedStateJson = '';

  function markDirty() {
    isStateDirty = true;
  }

  function isDirty() {
    return isStateDirty;
  }

  // ==========================================================================
  // 基礎工具
  // ==========================================================================
  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureNumber(val, fallback = 1) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function sanitizeFileName(name) {
    const base = String(name || 'MessySplit')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return base.replace(/\.\./g, '_').slice(0, SAFE_NAME_MAX) || 'MessySplit';
  }

  function escapeCSV(val) {
    let str = String(val ?? '').replace(/\r?\n/g, ' ');
    // 防 CSV 公式注入：避免 Excel 將 = + - @ 開頭當作公式執行
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function formatCustomExtras(customExtras, memberMap, currency = '') {
    if (!customExtras || typeof customExtras !== 'object') return '-';
    const entries = Object.entries(customExtras).filter(([, v]) => ensureNumber(v, 0) > 0);
    if (entries.length === 0) return '-';
    const prefix = currency ? `${currency} ` : '+';
    return entries
      .map(([id, v]) => `${memberMap[id] || id}: ${prefix}${ensureNumber(v, 0)}`)
      .join('；');
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();

    const revoke = () => {
      try {
        if (a.parentNode) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (_) {}
    };
    setTimeout(revoke, 2000);
    window.addEventListener('focus', revoke, { once: true });
  }

  function formatDateStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ==========================================================================
  // 1. 匯出 CSV (UTF-8 BOM + 公式注入防護 + 免責與私隱聲明)
  // ==========================================================================
  function exportToCSV(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = [],
      poolBalance = 0,
      includePoolInSettlement = false
    } = groupData || {};

    const rate = ensureNumber(exchangeRate, 1);
    const poolBal = ensureNumber(poolBalance, 0);
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    const rows = [];

    rows.push(['【混賬 Messy Split — 完團結算總表】']);
    rows.push(['群組名稱', name, '匯出日期', formatDateStamp()]);
    rows.push(['主要貨幣', currency, '折算港幣匯率', rate]);
    rows.push([
      '公數資金池結餘',
      `${currency} ${poolBal.toFixed(2)} (約 HK$ ${(poolBal * rate).toFixed(2)})`,
      '公數餘額納入結算',
      includePoolInSettlement ? '是（已按比例退還折抵）' : '否（獨立保留於公數池）'
    ]);
    rows.push([]);

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
      const amt = ensureNumber(exp.amount, 0);
      const hkd = amt * rate;
      totalOriginal += amt;
      totalHKD += hkd;

      const payerName = exp.paidByPool
        ? '💰 公數資金池'
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;
      const splitNames = (exp.participants || []).map((id) => memberMap[id] || id).join('、');
      const extraNotes = formatCustomExtras(exp.customExtras, memberMap, currency);

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

    rows.push(['總計', `共 ${expenses.length} 筆`, '', totalOriginal.toFixed(2), totalHKD.toFixed(2), '', '', '']);
    rows.push([]);
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
        rows.push([fromName, toName, ensureNumber(s.amountHKD || s.amount, 0).toFixed(2), statusText]);
      });
    }

    rows.push([]);
    rows.push([LEGAL_DISCLAIMER_TEXT]);
    rows.push([PRIVACY_NOTICE_TEXT]);

    const csvContent = '\uFEFF' + rows.map((r) => r.map(escapeCSV).join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerBlobDownload(blob, `${sanitizeFileName(name)}_完團結算_${formatDateStamp()}.csv`);
  }

  // ==========================================================================
  // 2. 匯出 Excel (SpreadsheetML 雙分頁工作表，含自訂加項與法規聲明)
  // ==========================================================================
  function exportToExcel(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = []
    } = groupData || {};

    const rate = ensureNumber(exchangeRate, 1);
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    let expenseRowsXML = '';
    let totalHKD = 0;

    expenses.forEach((exp) => {
      const amt = ensureNumber(exp.amount, 0);
      const hkd = amt * rate;
      totalHKD += hkd;
      const payerName = exp.paidByPool
        ? '公數資金池'
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;
      const splitNames = (exp.participants || []).map((id) => memberMap[id] || id).join('、');
      const extraNotes = formatCustomExtras(exp.customExtras, memberMap, currency);

      expenseRowsXML += `
        <Row>
          <Cell><Data ss:Type="String">${escapeHTML(exp.date || formatDateStamp())}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(exp.title || '未命名消費')}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(payerName)}</Data></Cell>
          <Cell><Data ss:Type="Number">${amt.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="Number">${hkd.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(splitNames)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(extraNotes)}</Data></Cell>
        </Row>`;
    });

    let settlementRowsXML = '';
    settlements.forEach((s) => {
      const fromName = memberMap[s.from] || s.fromName || s.from;
      const toName = memberMap[s.to] || s.toName || s.to;
      const amtHKD = ensureNumber(s.amountHKD || s.amount, 0).toFixed(2);
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
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1E293B" ss:Pattern="Solid"/></Style>
  <Style ss:ID="TotalRow"><Font ss:Bold="1" ss:Color="#0F172A"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/></Style>
  <Style ss:ID="NoteRow"><Font ss:Size="9" ss:Color="#64748B"/></Style>
 </Styles>
 <Worksheet ss:Name="1_消費明細"><Table>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">日期</Data></Cell>
    <Cell><Data ss:Type="String">項目名稱</Data></Cell>
    <Cell><Data ss:Type="String">墊支人</Data></Cell>
    <Cell><Data ss:Type="String">原幣金額 (${escapeHTML(currency)})</Data></Cell>
    <Cell><Data ss:Type="String">折合港幣 (HK$)</Data></Cell>
    <Cell><Data ss:Type="String">參與分攤團友</Data></Cell>
    <Cell><Data ss:Type="String">自訂加項/不平均分攤備註</Data></Cell>
   </Row>
   ${expenseRowsXML}
   <Row ss:StyleID="TotalRow">
    <Cell><Data ss:Type="String">總計 (${expenses.length} 筆)</Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="Number">${totalHKD.toFixed(2)}</Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell>
   </Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(LEGAL_DISCLAIMER_TEXT)}</Data></Cell></Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(PRIVACY_NOTICE_TEXT)}</Data></Cell></Row>
  </Table></Worksheet>
 <Worksheet ss:Name="2_最少步埋單"><Table>
   <Row ss:StyleID="Header"><Cell><Data ss:Type="String">欠款人 (需付錢)</Data></Cell><Cell><Data ss:Type="String">收款人 (債主)</Data></Cell><Cell><Data ss:Type="String">應付港幣 (HK$)</Data></Cell><Cell><Data ss:Type="String">目前狀態</Data></Cell></Row>
   ${settlementRowsXML}
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(LEGAL_DISCLAIMER_TEXT)}</Data></Cell></Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(PRIVACY_NOTICE_TEXT)}</Data></Cell></Row>
  </Table></Worksheet>
</Workbook>`;

    const blob = new Blob([workbookXML], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    triggerBlobDownload(blob, `${sanitizeFileName(name)}_完團帳目表_${formatDateStamp()}.xls`);
  }

  // ==========================================================================
  // 3. 匯出 PDF (A4 可列印 HTML 報告書，含免責條款、API 歸屬與私隱提醒)
  // ==========================================================================
  function exportToPDF(groupData) {
    const {
      name = '未命名群組',
      currency = 'HKD',
      exchangeRate = 1,
      members = [],
      expenses = [],
      settlements = [],
      poolBalance = 0,
      includePoolInSettlement = false
    } = groupData || {};

    const rate = ensureNumber(exchangeRate, 1);
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    const totalHKD = expenses.reduce((sum, e) => sum + ensureNumber(e.amount, 0) * rate, 0);

    const settlementRowsHTML =
      settlements.length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#059669;font-weight:bold;padding:16px;">🎉 全團帳目已結清，無須額外轉帳！</td></tr>`
        : settlements
            .map((s) => {
              const fromName = escapeHTML(memberMap[s.from] || s.fromName || s.from);
              const toName = escapeHTML(memberMap[s.to] || s.toName || s.to);
              const amt = ensureNumber(s.amountHKD || s.amount, 0).toFixed(2);
              const badge =
                s.status === 'confirmed'
                  ? '<span class="badge ok">✅ 已破鎖收妥</span>'
                  : s.status === 'pending_confirm'
                  ? '<span class="badge wait">⏳ 待確認</span>'
                  : '<span class="badge due">🔒 待找數</span>';
              return `<tr><td><strong>${fromName}</strong></td><td>➔ <strong>${toName}</strong></td><td style="text-align:right;font-weight:700;color:#B91C1C;">HK$ ${amt}</td><td style="text-align:center;">${badge}</td></tr>`;
            })
            .join('');

    const expenseRowsHTML = expenses
      .map((e) => {
        const amt = ensureNumber(e.amount, 0);
        const hkd = amt * rate;
        const payer = escapeHTML(
          e.paidByPool ? '💰 公數池' : memberMap[e.payerId] || e.payerName || e.payerId
        );
        const splitNames = escapeHTML(
          (e.participants || []).map((id) => memberMap[id] || id).join('、')
        );
        const extraStr = formatCustomExtras(e.customExtras, memberMap, currency);
        const extraBadge =
          extraStr !== '-'
            ? `<div style="font-size:10px;color:#B45309;margin-top:2px;">➕ 自訂加項：${escapeHTML(extraStr)}</div>`
            : '';

        return `<tr><td>${escapeHTML(e.date || formatDateStamp())}</td><td><strong>${escapeHTML(e.title || '未命名')}</strong>${extraBadge}</td><td>${payer}</td><td style="text-align:right;">${escapeHTML(currency)} ${amt.toFixed(2)}</td><td style="text-align:right;font-weight:600;">HK$ ${hkd.toFixed(2)}</td><td style="font-size:11px;color:#475569;">${splitNames}</td></tr>`;
      })
      .join('');

    const poolNote = includePoolInSettlement ? '（已納入結算退還）' : '（未納入結算）';

    const printHTML = `<!DOCTYPE html>
<html lang="zh-HK"><head><meta charset="UTF-8"><title>${escapeHTML(name)} - 混賬完團結算單</title>
<style>
@page{size:A4;margin:14mm}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang HK","Microsoft JhengHei",sans-serif;color:#1E293B;background:#FFF;margin:0;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1E293B;padding-bottom:12px;margin-bottom:20px}
.brand{font-size:24px;font-weight:900}.sub{font-size:12px;color:#64748B;margin-top:4px}
.summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.card{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px}
.card-label{font-size:11px;color:#64748B;font-weight:600}.card-val{font-size:20px;font-weight:800;color:#0F172A;margin-top:4px}
h2{font-size:15px;background:#1E293B;color:#FFF;padding:8px 12px;border-radius:6px;margin:20px 0 10px}
table{width:100%;border-collapse:collapse;margin-bottom:18px;font-size:12px}th,td{border:1px solid #CBD5E1;padding:8px 10px;text-align:left}th{background:#F1F5F9;font-weight:700}
.badge{padding:3px 8px;border-radius:99px;font-size:11px;font-weight:700}.badge.ok{background:#D1FAE5;color:#065F46}.badge.wait{background:#FEF3C7;color:#92400E}.badge.due{background:#FEE2E2;color:#991B1B}
.footer{margin-top:28px;font-size:10px;color:#64748B;line-height:1.6;border-top:1px dashed #CBD5E1;padding-top:10px}
@media print{.no-print{display:none!important}}
</style></head><body>
<div class="no-print" style="margin-bottom:16px;text-align:right;"><button onclick="window.print()" style="background:#1E293B;color:#FFF;border:none;padding:10px 18px;border-radius:8px;font-weight:bold;cursor:pointer;">🖨️ 列印 / 另存為 PDF</button></div>
<div class="header"><div><div class="brand">混賬 Messy Split — 完團結算報告書</div><div class="sub">群組名稱：${escapeHTML(name)} ｜ 結算匯率：1 ${escapeHTML(currency)} = ${escapeHTML(String(rate))} HKD</div></div><div style="text-align:right;font-size:12px;color:#475569;"><div>匯出日期：${formatDateStamp()}</div><div>參與團友：${members.length} 人</div></div></div>
<div class="summary-grid"><div class="card"><div class="card-label">全團總開支 (折合港幣)</div><div class="card-val">HK$ ${totalHKD.toFixed(2)}</div></div><div class="card"><div class="card-label">總消費筆數</div><div class="card-val">${expenses.length} 筆</div></div><div class="card"><div class="card-label">公數池結餘 ${poolNote}</div><div class="card-val">${escapeHTML(currency)} ${ensureNumber(poolBalance, 0).toFixed(2)}</div></div></div>
<h2>⚡ 一、最少步埋單結算行動表</h2><table><thead><tr><th>欠款人 (需付錢)</th><th>收款人 (債主)</th><th style="text-align:right;">應付金額 (HK$)</th><th style="text-align:center;">狀態</th></tr></thead><tbody>${settlementRowsHTML}</tbody></table>
<h2>🧾 二、全團消費賬單明細</h2><table><thead><tr><th>日期</th><th>項目（含自訂加項）</th><th>墊支人</th><th style="text-align:right;">原幣金額</th><th style="text-align:right;">折合港幣</th><th>分攤團友</th></tr></thead><tbody>${expenseRowsHTML}</tbody></table>
<div class="footer">
  <div>● <strong>合規聲明：</strong>本報表由《混賬》(Messy Split) 自動生成。所有帳目與公數紀錄僅供團友間日常分攤算術核對，不涉及資金代收、託管或香港法例第 584 章儲值支付工具（SVF）服務。</div>
  <div>● ${escapeHTML(LEGAL_DISCLAIMER_TEXT)}</div>
  <div>● ${escapeHTML(PRIVACY_NOTICE_TEXT)}</div>
</div>
<script>setTimeout(()=>window.print(),350);</script></body></html>`;

    const printWin = window.open('', '_blank', 'noopener');
    if (printWin) {
      printWin.document.open();
      printWin.document.write(printHTML);
      printWin.document.close();
    } else {
      const blob = new Blob([printHTML], { type: 'text/html;charset=utf-8;' });
      triggerBlobDownload(blob, `${sanitizeFileName(name)}_PDF結算單_${formatDateStamp()}.html`);
    }
  }

  // ==========================================================================
  // 4. IndexedDB 連線與自動備份引擎 (含 Dirty Flag 省電保護)
  // ==========================================================================
  function openDB() {
    if (typeof DBCrypto !== 'undefined' && typeof DBCrypto.openDB === 'function') {
      return DBCrypto.openDB();
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const mediaStore = db.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
          mediaStore.createIndex('by_group', 'groupId', { unique: false });
          mediaStore.createIndex('by_created', 'createdAt', { unique: false });
        } else {
          const tx = event.target.transaction;
          const store = tx.objectStore(MEDIA_STORE);
          if (!store.indexNames.contains('by_group')) store.createIndex('by_group', 'groupId', { unique: false });
          if (!store.indexNames.contains('by_created')) store.createIndex('by_created', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STATE_STORE)) {
          db.createObjectStore(STATE_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
      req.onblocked = () => console.warn('[ExportBackup] DB upgrade blocked');
    });
  }

  async function saveAutoSnapshot(getStateCallback, force = true) {
    try {
      let currentState;
      if (typeof getStateCallback === 'function') {
        try {
          currentState = getStateCallback();
        } catch (err) {
          console.warn('[ExportBackup] getState 回調異常', err);
          return false;
        }
      } else {
        currentState = getStateCallback;
      }
      if (!currentState) return false;

      const currentJson = JSON.stringify(currentState);
      if (!force && !isStateDirty && currentJson === lastSavedStateJson) {
        return false; // 狀態無任何變更，略過 IndexedDB 磁碟寫入以省電
      }

      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([STATE_STORE], 'readwrite');
        tx.objectStore(STATE_STORE).put({
          key: AUTO_BACKUP_KEY,
          state: currentState,
          updatedAt: Date.now()
        });
        tx.oncomplete = () => {
          isStateDirty = false;
          lastSavedStateJson = currentJson;
          resolve(true);
        };
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch (err) {
      console.warn('[ExportBackup] 自動快照儲存失敗:', err);
      return false;
    }
  }

  async function loadAutoSnapshot() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get(AUTO_BACKUP_KEY);
      req.onsuccess = () => {
        const res = req.result || null;
        if (res && res.state) {
          try {
            lastSavedStateJson = JSON.stringify(res.state);
            isStateDirty = false;
          } catch (_) {}
        }
        resolve(res);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function stopAutoBackupEngine() {
    if (autoBackupTimer) {
      clearInterval(autoBackupTimer);
      autoBackupTimer = null;
    }
    if (onVisibilityChange) {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onVisibilityChange = null;
    }
    console.log('[ExportBackup] ⏹️ 自動備份引擎已停止');
  }

  function startAutoBackupEngine(getStateCallback, intervalMs = 60000) {
    stopAutoBackupEngine();
    const safeInterval = Math.max(10000, ensureNumber(intervalMs, 60000));
    autoBackupTimer = setInterval(() => {
      saveAutoSnapshot(getStateCallback, false);
    }, safeInterval);
    onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveAutoSnapshot(getStateCallback, false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    console.log(`[ExportBackup] ✅ 自動備份引擎已啟動 (每 ${safeInterval / 1000}s Dirty-Check + 離場保護)`);
  }

  // ==========================================================================
  // 5. 完整備份分塊打包與非阻塞還原 (防 OOM 崩潰 + 600,000 次 PBKDF2 對齊)
  // ==========================================================================
  function blobToPortableObject(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({ mimeType: blob.type, dataUrl: reader.result });
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    try {
      const commaIdx = dataUrl.indexOf(',');
      if (commaIdx === -1) throw new Error('無效的 DataURL 格式');
      const meta = dataUrl.slice(0, commaIdx);
      const base64 = dataUrl.slice(commaIdx + 1);
      const mimeMatch = meta.match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
      const binary = atob(base64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    } catch (e) {
      throw new Error('dataUrl 轉 Blob 失敗: ' + e.message);
    }
  }

  /**
   * 採用分塊 BlobParts 組裝 JSON，避免在記憶體內拼接單一數十 MB 的巨型字串導致手機瀏覽器 OOM 崩潰
   */
  async function downloadFullBackupFile(currentState, includeMediaBlobs = true) {
    const db = await openDB();

    const encryptedVaultRecord = await new Promise((resolve) => {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const req = tx.objectStore(STATE_STORE).get(ENCRYPTED_VAULT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });

    const serializableVault = encryptedVaultRecord
      ? {
          key: ENCRYPTED_VAULT_KEY,
          cipher: Array.from(encryptedVaultRecord.cipher || []),
          iv: Array.from(encryptedVaultRecord.iv || []),
          salt: Array.from(encryptedVaultRecord.salt || []),
          iterations: encryptedVaultRecord.iterations || DEFAULT_PBKDF2_ITERATIONS,
          updatedAt: encryptedVaultRecord.updatedAt || Date.now()
        }
      : null;

    let rawMediaRecords = [];
    if (includeMediaBlobs) {
      rawMediaRecords = await new Promise((resolve) => {
        const tx = db.transaction([MEDIA_STORE], 'readonly');
        const req = tx.objectStore(MEDIA_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    const blobParts = [];
    const headerMeta = {
      app: 'MessySplit',
      version: '7.2',
      exportedAt: new Date().toISOString(),
      state: currentState,
      encryptedVault: serializableVault
    };

    // 移除結尾的 '}'，改以分塊方式串接 mediaVault 陣列
    const headerJson = JSON.stringify(headerMeta);
    blobParts.push(headerJson.slice(0, -1));
    blobParts.push(',"mediaVault":[');

    let exportedMediaCount = 0;
    for (let i = 0; i < rawMediaRecords.length; i++) {
      const item = rawMediaRecords[i];
      if (item && item.blob instanceof Blob) {
        try {
          const portable = await blobToPortableObject(item.blob);
          const itemObj = {
            id: item.id,
            groupId: item.groupId,
            encrypted: item.encrypted || false,
            originalMimeType: item.originalMimeType || item.mimeType,
            iv: item.iv ? Array.from(item.iv) : null,
            salt: item.salt ? Array.from(item.salt) : null,
            iterations: item.iterations || DEFAULT_PBKDF2_ITERATIONS,
            createdAt: item.createdAt,
            portableBlob: portable
          };
          if (exportedMediaCount > 0) blobParts.push(',');
          blobParts.push(JSON.stringify(itemObj));
          exportedMediaCount++;

          // 每處理 5 張單據讓出主執行緒，保持 UI 流暢
          if (exportedMediaCount % 5 === 0) {
            await yieldToMain();
          }
        } catch (err) {
          console.warn('[ExportBackup] 單張單據打包失敗', item.id, err);
        }
      }
    }

    blobParts.push(`],"mediaCount":${exportedMediaCount}}`);

    const finalBlob = new Blob(blobParts, { type: 'application/json;charset=utf-8;' });
    if (finalBlob.size > MAX_BACKUP_SIZE) {
      console.warn('[ExportBackup] 備份檔已超過 100MB，還原時可能受限於裝置記憶體');
    }

    triggerBlobDownload(finalBlob, `混賬完整備份_${formatDateStamp()}.messybackup.json`);
  }

  async function restoreFromBackupFile(backupFile) {
    if (!backupFile) throw new Error('未選擇備份檔案');
    if (backupFile.size > MAX_BACKUP_SIZE) {
      throw new Error(
        `備份檔過大 (${(backupFile.size / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_BACKUP_SIZE / 1024 / 1024}MB`
      );
    }

    let text;
    try {
      text = await backupFile.text();
    } catch {
      throw new Error('讀取備份檔案失敗');
    }

    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new Error('備份檔案不是有效的 JSON');
    }

    if (!bundle || bundle.app !== 'MessySplit') {
      throw new Error('無效的《混賬》備份檔案格式');
    }

    const allowedVersions = ['7.0', '7.1', '7.2', '7'];
    if (bundle.version && !allowedVersions.includes(String(bundle.version))) {
      console.warn(`[ExportBackup] 備份版本 ${bundle.version} 與目前 7.2 可能不完全相容，仍嘗試還原`);
    }

    const db = await openDB();

    // 1. 還原狀態與 AES-GCM 加密金庫 (向下相容舊版 100,000 次與新版 600,000 次 iterations)
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      const store = tx.objectStore(STATE_STORE);
      if (bundle.state) {
        store.put({ key: AUTO_BACKUP_KEY, state: bundle.state, updatedAt: Date.now() });
        try {
          lastSavedStateJson = JSON.stringify(bundle.state);
          isStateDirty = false;
        } catch (_) {}
      }
      if (bundle.encryptedVault) {
        const v = bundle.encryptedVault;
        store.put({
          key: ENCRYPTED_VAULT_KEY,
          cipher: new Uint8Array(v.cipher || []),
          iv: new Uint8Array(v.iv || []),
          salt: new Uint8Array(v.salt || []),
          iterations: v.iterations || LEGACY_PBKDF2_ITERATIONS,
          updatedAt: v.updatedAt || v.createdAt || Date.now()
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });

    // 2. 非阻塞還原 media_vault_store 原生 Blob 單據與加密 QR Code
    let restoredMediaCount = 0;
    if (Array.isArray(bundle.mediaVault) && bundle.mediaVault.length > 0) {
      for (let i = 0; i < bundle.mediaVault.length; i++) {
        const item = bundle.mediaVault[i];
        if (!item?.portableBlob?.dataUrl) continue;
        try {
          const restoredBlob = dataUrlToBlob(item.portableBlob.dataUrl);
          await new Promise((resolve, reject) => {
            const tx = db.transaction([MEDIA_STORE], 'readwrite');
            tx.objectStore(MEDIA_STORE).put({
              id: item.id,
              blob: restoredBlob,
              mimeType: restoredBlob.type,
              originalMimeType: item.originalMimeType,
              sizeKB: Math.round(restoredBlob.size / 1024),
              encrypted: item.encrypted || false,
              iv: item.iv ? new Uint8Array(item.iv) : undefined,
              salt: item.salt ? new Uint8Array(item.salt) : undefined,
              iterations: item.iterations || LEGACY_PBKDF2_ITERATIONS,
              groupId: item.groupId || 'default',
              createdAt: item.createdAt || Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e.target.error);
          });
          restoredMediaCount++;

          if (restoredMediaCount % 5 === 0) {
            await yieldToMain();
          }
        } catch (err) {
          console.warn('[ExportBackup] 單張單據還原失敗', item.id, err);
        }
      }
    }

    return {
      restoredState: bundle.state,
      mediaRestoredCount: restoredMediaCount,
      exportedAt: bundle.exportedAt
    };
  }

  return {
    exportToCSV,
    exportToExcel,
    exportToPDF,
    startAutoBackupEngine,
    stopAutoBackupEngine,
    saveAutoSnapshot,
    loadAutoSnapshot,
    downloadFullBackupFile,
    restoreFromBackupFile,
    markDirty,
    isDirty
  };
})();
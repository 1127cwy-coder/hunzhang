// ============================================================================
// 《混賬》(Messy Split) v7.4 - 完團報表匯出與自動備份模組 (export-backup.js)
// 強化內容：
// 1. [匯出格式修復] 全面支援雙軌貨幣 (mainCurrency + 外幣)、每筆帳單獨立幣別與記帳當下匯率快照 (rateAtCreation)
// 2. [韓元/歐元精度] 支援 EUR 與 KRW 高精度匯率顯示 (最高 6 位小數)，防止韓元折算誤差
// 3. [公數明細匯出] CSV / Excel (三工作表) / PDF 全面納入「公數注資明細紀錄 (poolTopups)」與雙幣公數結餘
// 4. [效能与資安] 分塊 Blob 串流備份防 OOM、Dirty-Flag 省電快照、CSV 防公式注入
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

  const LEGAL_DISCLAIMER_TEXT =
    '【免責聲明】本報表之匯率折算、OCR 單據辨識與最少步結算金額按「現況 (AS IS)」提供，僅供算術參考；團友於實際轉帳前應自行核對單據原圖與金額，開發者對任何直接或間接財務誤差概不負責。匯率資料來源：Rates by Exchange Rate API。';
  const PRIVACY_NOTICE_TEXT =
    '【私隱提醒】本報表包含團友名稱與消費紀錄，請僅限於群組成員內部核對使用，切勿公開發布至公眾網路，以免觸犯香港《個人資料（私隱）條例》（第 486 章）。';

  let autoBackupTimer = null;
  let onVisibilityChange = null;
  let isStateDirty = false;
  let lastSavedStateJson = '';

  function markDirty() {
    isStateDirty = true;
  }

  function isDirty() {
    return isStateDirty;
  }

  // ==========================================================================
  // 基礎工具與高精度匯率格式化 (支援 KRW 6 位小數)
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

  function formatRate(rateVal) {
    const n = ensureNumber(rateVal, 1);
    if (n === 1) return '1';
    return Number(n.toFixed(6)).toString();
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

  function resolveExpenseSnapshot(exp, mainCurrency, foreignCurrency, defaultGroupRate) {
    const expCurr = exp.currency || foreignCurrency;
    const amt = ensureNumber(exp.amount, 0);
    const rateSnap =
      expCurr === mainCurrency
        ? 1
        : ensureNumber(exp.rateAtCreation, ensureNumber(defaultGroupRate, 1));
    const amtInMain = amt * rateSnap;
    return { expCurr, amt, rateSnap, amtInMain };
  }

  function resolvePoolSummary(groupData) {
    const mainC = groupData.mainCurrency || 'HKD';
    const foreignC =
      groupData.currency && groupData.currency !== 'NONE' ? groupData.currency : mainC;
    const gRate = ensureNumber(groupData.exchangeRate, 1);
    const poolBalances =
      groupData.poolBalances && typeof groupData.poolBalances === 'object'
        ? groupData.poolBalances
        : { [mainC]: 0, [foreignC]: ensureNumber(groupData.poolBalance, 0) };

    const foreignBal = ensureNumber(poolBalances[foreignC], 0);
    const mainBal = ensureNumber(poolBalances[mainC], 0);
    const totalInMain = mainBal + (foreignC !== mainC ? foreignBal * gRate : 0);

    const summaryText =
      foreignC === mainC
        ? `${mainC} ${mainBal.toFixed(2)}`
        : `外幣 ${foreignC} ${foreignBal.toFixed(2)} ＋ 主幣 ${mainC} ${mainBal.toFixed(2)} (合共折合 ${mainC} ${totalInMain.toFixed(2)})`;

    return { mainC, foreignC, gRate, foreignBal, mainBal, totalInMain, summaryText };
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
  // 1. 匯出 CSV (UTF-8 BOM + 雙幣匯率快照 + 公數注資明細 + 免責聲明)
  // ==========================================================================
  function exportToCSV(groupData) {
    const {
      name = '未命名群組',
      members = [],
      expenses = [],
      poolTopups = [],
      settlements = [],
      includePoolInSettlement = false
    } = groupData || {};

    const { mainC, foreignC, gRate, summaryText } = resolvePoolSummary(groupData || {});
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    const rows = [];

    rows.push(['【混賬 Messy Split — 完團結算總表】']);
    rows.push(['群組名稱', name, '匯出日期', formatDateStamp()]);
    rows.push([
      '結算主貨幣',
      mainC,
      '本團外幣與基準匯率',
      foreignC === mainC ? '無外幣 (單幣模式)' : `1 ${foreignC} = ${formatRate(gRate)} ${mainC}`
    ]);
    rows.push([
      '公數資金池結餘',
      summaryText,
      '公數餘額納入結算',
      includePoolInSettlement ? '是（已按出資比例退還折抵）' : '否（獨立保留於公數池）'
    ]);
    rows.push([]);

    // 一、消費賬單明細
    rows.push(['【一、消費賬單明細】']);
    rows.push([
      '日期',
      '項目名稱',
      '墊支人/付款方式',
      '原幣別',
      '原幣金額',
      '記帳匯率快照',
      `折合主貨幣 (${mainC})`,
      '參與分攤成員',
      '個人加項備註',
      '單據ID'
    ]);

    let totalInMain = 0;

    expenses.forEach((exp) => {
      const { expCurr, amt, rateSnap, amtInMain } = resolveExpenseSnapshot(
        exp,
        mainC,
        foreignC,
        gRate
      );
      totalInMain += amtInMain;

      const payerName = exp.paidByPool
        ? `💰 公數池 (${expCurr})`
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;
      const splitNames = (exp.participants || []).map((id) => memberMap[id] || id).join('、');
      const extraNotes = formatCustomExtras(exp.customExtras, memberMap, expCurr);

      rows.push([
        exp.date || formatDateStamp(),
        exp.title || '未命名消費',
        payerName,
        expCurr,
        amt.toFixed(2),
        formatRate(rateSnap),
        amtInMain.toFixed(2),
        splitNames,
        extraNotes,
        exp.receiptId || '無'
      ]);
    });

    rows.push([
      '消費總計',
      `共 ${expenses.length} 筆`,
      '',
      '',
      '',
      `合共 (${mainC})`,
      totalInMain.toFixed(2),
      '',
      '',
      ''
    ]);
    rows.push([]);

    // 二、公數注資明細紀錄
    rows.push(['【二、公數注資明細紀錄】']);
    rows.push([
      '注資日期',
      '注資幣別',
      '注資金額',
      '折算匯率快照',
      `折合主貨幣 (${mainC})`,
      '出資方式 / 出資人',
      '備註'
    ]);

    if (!Array.isArray(poolTopups) || poolTopups.length === 0) {
      rows.push(['尚無公數注資紀錄', '-', '0.00', '-', '0.00', '-', '-']);
    } else {
      poolTopups.forEach((t) => {
        const tCurr = t.currency || foreignC;
        const tAmt = ensureNumber(t.amount, 0);
        const tRate =
          tCurr === mainC ? 1 : ensureNumber(t.rateAtCreation, gRate);
        const tMain = tAmt * tRate;
        const contribLabel =
          t.contributor === 'ALL'
            ? '👥 全員平均夾錢'
            : `👤 ${memberMap[t.contributor] || t.contributor} 單獨出資`;
        rows.push([
          t.date || formatDateStamp(),
          tCurr,
          tAmt.toFixed(2),
          formatRate(tRate),
          tMain.toFixed(2),
          contribLabel,
          t.note || '-'
        ]);
      });
    }
    rows.push([]);

    // 三、最少步埋單結算行動表
    rows.push(['【三、最少步埋單結算行動表】']);
    rows.push(['欠款人 (需付錢)', '收款人 (債主)', `應付主貨幣 (${mainC})`, '還款狀態']);

    if (settlements.length === 0) {
      rows.push(['🎉 全團帳目已結清，無須任何轉帳！', '', '0.00', '已結清']);
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
        rows.push([
          fromName,
          toName,
          ensureNumber(s.amountHKD || s.amount, 0).toFixed(2),
          statusText
        ]);
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
  // 2. 匯出 Excel (SpreadsheetML 三分頁工作表：1_消費明細、2_公數注資明細、3_最少步埋單)
  // ==========================================================================
  function exportToExcel(groupData) {
    const {
      name = '未命名群組',
      members = [],
      expenses = [],
      poolTopups = [],
      settlements = []
    } = groupData || {};

    const { mainC, foreignC, gRate } = resolvePoolSummary(groupData || {});
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    let expenseRowsXML = '';
    let totalInMain = 0;

    expenses.forEach((exp) => {
      const { expCurr, amt, rateSnap, amtInMain } = resolveExpenseSnapshot(
        exp,
        mainC,
        foreignC,
        gRate
      );
      totalInMain += amtInMain;

      const payerName = exp.paidByPool
        ? `公數池 (${expCurr})`
        : memberMap[exp.payerId] || exp.payerName || exp.payerId;
      const splitNames = (exp.participants || []).map((id) => memberMap[id] || id).join('、');
      const extraNotes = formatCustomExtras(exp.customExtras, memberMap, expCurr);

      expenseRowsXML += `
        <Row>
          <Cell><Data ss:Type="String">${escapeHTML(exp.date || formatDateStamp())}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(exp.title || '未命名消費')}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(payerName)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(expCurr)}</Data></Cell>
          <Cell><Data ss:Type="Number">${amt.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="Number">${formatRate(rateSnap)}</Data></Cell>
          <Cell><Data ss:Type="Number">${amtInMain.toFixed(2)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(splitNames)}</Data></Cell>
          <Cell><Data ss:Type="String">${escapeHTML(extraNotes)}</Data></Cell>
        </Row>`;
    });

    let poolRowsXML = '';
    if (Array.isArray(poolTopups) && poolTopups.length > 0) {
      poolTopups.forEach((t) => {
        const tCurr = t.currency || foreignC;
        const tAmt = ensureNumber(t.amount, 0);
        const tRate = tCurr === mainC ? 1 : ensureNumber(t.rateAtCreation, gRate);
        const tMain = tAmt * tRate;
        const contribLabel =
          t.contributor === 'ALL'
            ? '全員平均夾錢'
            : `${memberMap[t.contributor] || t.contributor} 單獨出資`;
        poolRowsXML += `
          <Row>
            <Cell><Data ss:Type="String">${escapeHTML(t.date || formatDateStamp())}</Data></Cell>
            <Cell><Data ss:Type="String">${escapeHTML(tCurr)}</Data></Cell>
            <Cell><Data ss:Type="Number">${tAmt.toFixed(2)}</Data></Cell>
            <Cell><Data ss:Type="Number">${formatRate(tRate)}</Data></Cell>
            <Cell><Data ss:Type="Number">${tMain.toFixed(2)}</Data></Cell>
            <Cell><Data ss:Type="String">${escapeHTML(contribLabel)}</Data></Cell>
            <Cell><Data ss:Type="String">${escapeHTML(t.note || '-')}</Data></Cell>
          </Row>`;
      });
    } else {
      poolRowsXML = `<Row><Cell><Data ss:Type="String">尚無公數注資紀錄</Data></Cell></Row>`;
    }

    let settlementRowsXML = '';
    settlements.forEach((s) => {
      const fromName = memberMap[s.from] || s.fromName || s.from;
      const toName = memberMap[s.to] || s.toName || s.to;
      const amtMain = ensureNumber(s.amountHKD || s.amount, 0).toFixed(2);
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
          <Cell><Data ss:Type="Number">${amtMain}</Data></Cell>
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
    <Cell><Data ss:Type="String">墊支人/付款方式</Data></Cell>
    <Cell><Data ss:Type="String">原幣別</Data></Cell>
    <Cell><Data ss:Type="String">原幣金額</Data></Cell>
    <Cell><Data ss:Type="String">記帳匯率快照</Data></Cell>
    <Cell><Data ss:Type="String">折合主貨幣 (${escapeHTML(mainC)})</Data></Cell>
    <Cell><Data ss:Type="String">參與分攤團友</Data></Cell>
    <Cell><Data ss:Type="String">個人加項備註</Data></Cell>
   </Row>
   ${expenseRowsXML}
   <Row ss:StyleID="TotalRow">
    <Cell><Data ss:Type="String">總計 (${expenses.length} 筆)</Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String">合共 (${escapeHTML(mainC)})</Data></Cell><Cell><Data ss:Type="Number">${totalInMain.toFixed(2)}</Data></Cell><Cell><Data ss:Type="String"></Data></Cell><Cell><Data ss:Type="String"></Data></Cell>
   </Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(LEGAL_DISCLAIMER_TEXT)}</Data></Cell></Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(PRIVACY_NOTICE_TEXT)}</Data></Cell></Row>
  </Table></Worksheet>
 <Worksheet ss:Name="2_公數注資明細"><Table>
   <Row ss:StyleID="Header">
    <Cell><Data ss:Type="String">注資日期</Data></Cell>
    <Cell><Data ss:Type="String">注資幣別</Data></Cell>
    <Cell><Data ss:Type="String">注資金額</Data></Cell>
    <Cell><Data ss:Type="String">匯率快照</Data></Cell>
    <Cell><Data ss:Type="String">折合主貨幣 (${escapeHTML(mainC)})</Data></Cell>
    <Cell><Data ss:Type="String">出資方式 / 出資人</Data></Cell>
    <Cell><Data ss:Type="String">備註</Data></Cell>
   </Row>
   ${poolRowsXML}
  </Table></Worksheet>
 <Worksheet ss:Name="3_最少步埋單"><Table>
   <Row ss:StyleID="Header"><Cell><Data ss:Type="String">欠款人 (需付錢)</Data></Cell><Cell><Data ss:Type="String">收款人 (債主)</Data></Cell><Cell><Data ss:Type="String">應付主貨幣 (${escapeHTML(mainC)})</Data></Cell><Cell><Data ss:Type="String">目前狀態</Data></Cell></Row>
   ${settlementRowsXML}
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(LEGAL_DISCLAIMER_TEXT)}</Data></Cell></Row>
   <Row ss:StyleID="NoteRow"><Cell><Data ss:Type="String">${escapeHTML(PRIVACY_NOTICE_TEXT)}</Data></Cell></Row>
  </Table></Worksheet>
</Workbook>`;

    const blob = new Blob([workbookXML], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    triggerBlobDownload(blob, `${sanitizeFileName(name)}_完團帳目表_${formatDateStamp()}.xls`);
  }

  // ==========================================================================
  // 3. 匯出 PDF (A4 可列印 HTML 報告書，完整呈現雙幣快照與公數注資明細)
  // ==========================================================================
  function exportToPDF(groupData) {
    const {
      name = '未命名群組',
      members = [],
      expenses = [],
      poolTopups = [],
      settlements = [],
      includePoolInSettlement = false
    } = groupData || {};

    const { mainC, foreignC, gRate, summaryText } = resolvePoolSummary(groupData || {});
    const memberMap = Object.fromEntries(members.map((m) => [m.id, m.name]));
    let totalInMain = 0;

    const expenseRowsHTML = expenses
      .map((e) => {
        const { expCurr, amt, rateSnap, amtInMain } = resolveExpenseSnapshot(
          e,
          mainC,
          foreignC,
          gRate
        );
        totalInMain += amtInMain;

        const payer = escapeHTML(
          e.paidByPool ? `💰 公數池 (${expCurr})` : memberMap[e.payerId] || e.payerName || e.payerId
        );
        const splitNames = escapeHTML(
          (e.participants || []).map((id) => memberMap[id] || id).join('、')
        );
        const extraStr = formatCustomExtras(e.customExtras, memberMap, expCurr);
        const extraBadge =
          extraStr !== '-'
            ? `<div style="font-size:10px;color:#B45309;margin-top:2px;">➕ 自訂加項：${escapeHTML(extraStr)}</div>`
            : '';

        return `<tr>
          <td>${escapeHTML(e.date || formatDateStamp())}</td>
          <td><strong>${escapeHTML(e.title || '未命名')}</strong>${extraBadge}</td>
          <td>${payer}</td>
          <td style="text-align:right;">${escapeHTML(expCurr)} ${amt.toFixed(2)}<div style="font-size:9px;color:#64748B;">匯率: ${formatRate(rateSnap)}</div></td>
          <td style="text-align:right;font-weight:700;">${escapeHTML(mainC)} ${amtInMain.toFixed(2)}</td>
          <td style="font-size:11px;color:#475569;">${splitNames}</td>
        </tr>`;
      })
      .join('');

    const poolRowsHTML =
      !Array.isArray(poolTopups) || poolTopups.length === 0
        ? `<tr><td colspan="5" style="text-align:center;color:#64748B;padding:10px;">尚無公數注資紀錄</td></tr>`
        : poolTopups
            .map((t) => {
              const tCurr = t.currency || foreignC;
              const tAmt = ensureNumber(t.amount, 0);
              const tRate = tCurr === mainC ? 1 : ensureNumber(t.rateAtCreation, gRate);
              const tMain = tAmt * tRate;
              const contribLabel =
                t.contributor === 'ALL'
                  ? '👥 全員平均夾錢'
                  : `👤 ${memberMap[t.contributor] || t.contributor} 單獨出資`;
              return `<tr>
                <td>${escapeHTML(t.date || formatDateStamp())}</td>
                <td>${escapeHTML(contribLabel)}</td>
                <td style="text-align:right;">${escapeHTML(tCurr)} ${tAmt.toFixed(2)}</td>
                <td style="text-align:right;">${formatRate(tRate)}</td>
                <td style="text-align:right;font-weight:700;">${escapeHTML(mainC)} ${tMain.toFixed(2)}</td>
              </tr>`;
            })
            .join('');

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
              return `<tr><td><strong>${fromName}</strong></td><td>➔ <strong>${toName}</strong></td><td style="text-align:right;font-weight:700;color:#B91C1C;">${escapeHTML(mainC)} ${amt}</td><td style="text-align:center;">${badge}</td></tr>`;
            })
            .join('');

    const poolNote = includePoolInSettlement ? '（已納入結算退還）' : '（未納入結算）';
    const rateHeaderDesc =
      foreignC === mainC
        ? `單一主貨幣 (${escapeHTML(mainC)})`
        : `主幣 ${escapeHTML(mainC)} ｜ 外幣 1 ${escapeHTML(foreignC)} = ${escapeHTML(formatRate(gRate))} ${escapeHTML(mainC)}`;

    const printHTML = `<!DOCTYPE html>
<html lang="zh-HK"><head><meta charset="UTF-8"><title>${escapeHTML(name)} - 混賬完團結算單</title>
<style>
@page{size:A4;margin:14mm}body{font-family:-apple-system,BlinkMacSystemFont,"PingFang HK","Microsoft JhengHei",sans-serif;color:#1E293B;background:#FFF;margin:0;padding:20px}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1E293B;padding-bottom:12px;margin-bottom:20px}
.brand{font-size:24px;font-weight:900}.sub{font-size:12px;color:#64748B;margin-top:4px}
.summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px}
.card{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px 16px}
.card-label{font-size:11px;color:#64748B;font-weight:600}.card-val{font-size:16px;font-weight:800;color:#0F172A;margin-top:4px}
h2{font-size:14px;background:#1E293B;color:#FFF;padding:7px 12px;border-radius:6px;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11.5px}th,td{border:1px solid #CBD5E1;padding:7px 9px;text-align:left}th{background:#F1F5F9;font-weight:700}
.badge{padding:3px 8px;border-radius:99px;font-size:10px;font-weight:700}.badge.ok{background:#D1FAE5;color:#065F46}.badge.wait{background:#FEF3C7;color:#92400E}.badge.due{background:#FEE2E2;color:#991B1B}
.footer{margin-top:24px;font-size:10px;color:#64748B;line-height:1.6;border-top:1px dashed #CBD5E1;padding-top:10px}
@media print{.no-print{display:none!important}}
</style></head><body>
<div class="no-print" style="margin-bottom:16px;text-align:right;"><button onclick="window.print()" style="background:#1E293B;color:#FFF;border:none;padding:10px 18px;border-radius:8px;font-weight:bold;cursor:pointer;">🖨️ 列印 / 另存為 PDF</button></div>
<div class="header"><div><div class="brand">混賬 Messy Split — 完團結算報告書</div><div class="sub">群組名稱：${escapeHTML(name)} ｜ 幣別設定：${rateHeaderDesc}</div></div><div style="text-align:right;font-size:12px;color:#475569;"><div>匯出日期：${formatDateStamp()}</div><div>參與團友：${members.length} 人</div></div></div>
<div class="summary-grid"><div class="card"><div class="card-label">全團總開支 (折合 ${escapeHTML(mainC)})</div><div class="card-val">${escapeHTML(mainC)} ${totalInMain.toFixed(2)}</div></div><div class="card"><div class="card-label">消費與注資筆數</div><div class="card-val">消費 ${expenses.length} 筆 / 注資 ${(poolTopups || []).length} 筆</div></div><div class="card"><div class="card-label">公數池結餘 ${poolNote}</div><div class="card-val" style="font-size:13px;">${escapeHTML(summaryText)}</div></div></div>
<h2>⚡ 一、最少步埋單結算行動表 (以主貨幣 ${escapeHTML(mainC)} 結算)</h2><table><thead><tr><th>欠款人 (需付錢)</th><th>收款人 (債主)</th><th style="text-align:right;">應付金額 (${escapeHTML(mainC)})</th><th style="text-align:center;">狀態</th></tr></thead><tbody>${settlementRowsHTML}</tbody></table>
<h2>💰 二、公數資金池注資明細紀錄</h2><table><thead><tr><th>注資日期</th><th>出資方式 / 出資人</th><th style="text-align:right;">原幣注資額</th><th style="text-align:right;">匯率快照</th><th style="text-align:right;">折合主貨幣 (${escapeHTML(mainC)})</th></tr></thead><tbody>${poolRowsHTML}</tbody></table>
<h2>🧾 三、全團消費賬單明細</h2><table><thead><tr><th>日期</th><th>項目（含自訂加項）</th><th>墊支人/來源</th><th style="text-align:right;">原幣金額 (匯率快照)</th><th style="text-align:right;">折合 ${escapeHTML(mainC)}</th><th>分攤團友</th></tr></thead><tbody>${expenseRowsHTML}</tbody></table>
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
  // 4. IndexedDB 連線與自動備份引擎 (Dirty Flag 省電保護)
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
    });
  }

  async function saveAutoSnapshot(getStateCallback, force = true) {
    try {
      let currentState =
        typeof getStateCallback === 'function' ? getStateCallback() : getStateCallback;
      if (!currentState) return false;

      const currentJson = JSON.stringify(currentState);
      if (!force && !isStateDirty && currentJson === lastSavedStateJson) {
        return false;
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
  }

  // ==========================================================================
  // 5. 完整備份分塊打包與非阻塞還原
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
  }

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
      version: '7.4',
      exportedAt: new Date().toISOString(),
      state: currentState,
      encryptedVault: serializableVault
    };

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
    triggerBlobDownload(finalBlob, `混賬完整備份_${formatDateStamp()}.messybackup.json`);
  }

  async function restoreFromBackupFile(backupFile) {
    if (!backupFile) throw new Error('未選擇備份檔案');
    if (backupFile.size > MAX_BACKUP_SIZE) {
      throw new Error(
        `備份檔過大 (${(backupFile.size / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_BACKUP_SIZE / 1024 / 1024}MB`
      );
    }

    const text = await backupFile.text();
    const bundle = JSON.parse(text);

    if (!bundle || bundle.app !== 'MessySplit') {
      throw new Error('無效的《混賬》備份檔案格式');
    }

    const db = await openDB();

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

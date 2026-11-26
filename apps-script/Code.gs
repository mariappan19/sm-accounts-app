/**
 * SM Accounts app – backend for Office_Accounts_Master_2026.
 *
 * Paste this file into the sheet's Extensions → Apps Script editor,
 * set the APP_PIN script property, then Deploy → New deployment → Web app.
 *
 * The app only writes the input columns of Transactions
 * (B, D:K, N:O, R:U). Txn ID, Month, GST Amount, Total Amount,
 * Card Due Date, Running Bank Balance and Bank Movement are left to the
 * sheet's own formulas.
 */

const CONFIG = {
  TX_SHEET: 'Transactions',
  SUMMARY_SHEET: 'App_Summary',
  SETTINGS_SHEET: 'Settings_&_Lists',
  RECEIPTS_FOLDER_ID: '1_17rwzaEpcc4gyMuO8pLKDzBFWQmtu6k',
  MAX_ROW: 1000,            // Dashboard / Credit_Card totals read rows 2–1000
  MAX_FAILED_PINS: 5,
  LOCKOUT_SECONDS: 900,     // 15 minutes after 5 wrong PINs
  MAX_RECEIPT_BYTES: 8 * 1024 * 1024,
  MAX_AMOUNT: 10000000,
};

const LIST_HEADERS = {
  type: 'Type',
  department: 'Department',
  category: 'Category',
  paymentMode: 'Payment Mode',
  status: 'Status',
  gstRate: 'GST Rate',
  gstInvoice: 'GST Invoice Status',
  paidBy: 'Paid By / Payer',
};

const RECEIPT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

// ---------------------------------------------------------------- entry points

function doGet() {
  return json_({ ok: true, app: 'SM Accounts API' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkPin_(req.pin);
    switch (req.action) {
      case 'bootstrap':
        return json_({ ok: true, summary: getSummary_(), lists: getLists_() });
      case 'summary':
        return json_({ ok: true, summary: getSummary_() });
      case 'transactions':
        return json_({ ok: true, items: getTransactions_(req.filter, req.limit) });
      case 'add':
        return json_({ ok: true, result: addTransaction_(req.txn || {}) });
      default:
        throw new Error('Unknown action.');
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// ---------------------------------------------------------------- PIN

function checkPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  if (!expected) throw new Error('APP_PIN is not set in Script properties.');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= CONFIG.MAX_FAILED_PINS) {
    throw new Error('Too many wrong PINs. Try again in 15 minutes.');
  }
  if (String(pin || '') !== String(expected)) {
    cache.put('pinFails', String(fails + 1), CONFIG.LOCKOUT_SECONDS);
    throw new Error('Wrong PIN.');
  }
  if (fails) cache.remove('pinFails');
}

// ---------------------------------------------------------------- reads

function getSummary_() {
  const sh = sheet_(CONFIG.SUMMARY_SHEET);
  const rows = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 3).getDisplayValues();
  return rows
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) { return { label: r[0], value: r[2] || r[1] }; });
}

function getLists_() {
  const values = sheet_(CONFIG.SETTINGS_SHEET).getDataRange().getDisplayValues();
  const lists = {};
  Object.keys(LIST_HEADERS).forEach(function (key) {
    const header = LIST_HEADERS[key];
    let found = null;
    for (let r = 0; r < Math.min(values.length, 15) && !found; r++) {
      for (let c = 0; c < values[r].length; c++) {
        if (values[r][c] === header) { found = [r, c]; break; }
      }
    }
    const items = [];
    if (found) {
      for (let r = found[0] + 1; r < values.length; r++) {
        const v = values[r][found[1]];
        if (v === '') break;
        items.push(v);
      }
    }
    lists[key] = items;
  });
  return lists;
}

function getTransactions_(filter, limit) {
  const sh = sheet_(CONFIG.TX_SHEET);
  const last = lastDataRow_(sh);
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 22).getDisplayValues();
  let items = rows
    .filter(function (r) { return r[1] !== ''; })
    .map(function (r) {
      return {
        id: r[0], date: r[1], type: r[3], department: r[4], category: r[5],
        vendor: r[6], description: r[7], total: r[12], paymentMode: r[13],
        status: r[14], dueDate: r[15], hasReceipt: r[17] !== '', notes: r[18],
      };
    });
  if (filter === 'pending') {
    items = items.filter(function (t) {
      return t.status === 'Pending' || t.status === 'To Receive';
    });
  }
  items.reverse(); // newest rows first
  return items.slice(0, Math.min(Number(limit) || 50, 200));
}

// ---------------------------------------------------------------- write

function addTransaction_(t) {
  const lists = getLists_();
  const clean = validate_(t, lists);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_(CONFIG.TX_SHEET);
    const row = lastDataRow_(sh) + 1;
    if (row > CONFIG.MAX_ROW) {
      throw new Error('Transactions is full (row ' + CONFIG.MAX_ROW + '). Extend the sheet first.');
    }
    const txnId = 'TXN-' + ('000' + (row - 1)).slice(-3);

    let receiptCell = '';
    if (t.receipt && t.receipt.data) {
      const url = saveReceipt_(t.receipt, txnId, clean);
      receiptCell = '=HYPERLINK("' + url + '", "View Receipt")';
    }

    sh.getRange(row, 2).setValue(clean.date);                       // B Date
    sh.getRange(row, 4, 1, 8).setValues([[                          // D:K
      clean.type, clean.department, clean.category, clean.vendor,
      clean.description, clean.invoice, clean.amount, clean.gstRate,
    ]]);
    sh.getRange(row, 14, 1, 2).setValues([[clean.paymentMode, clean.status]]); // N:O
    sh.getRange(row, 18, 1, 4).setValues([[                         // R:U
      receiptCell, clean.notes, clean.gstInvoice, clean.paidBy,
    ]]);
    SpreadsheetApp.flush();

    const out = sh.getRange(row, 1, 1, 22).getDisplayValues()[0];
    return {
      row: row,
      id: out[0] || txnId,
      date: out[1],
      total: out[12],
      dueDate: out[15],
      balance: out[16],
      receipt: receiptCell !== '',
    };
  } finally {
    lock.releaseLock();
  }
}

function validate_(t, lists) {
  function req(name, label) {
    const v = String(t[name] == null ? '' : t[name]).trim();
    if (!v) throw new Error(label + ' is required.');
    return v;
  }
  function oneOf(name, label, fallback) {
    const v = String(t[name] == null ? '' : t[name]).trim() || fallback;
    if (!v) throw new Error(label + ' is required.');
    if (lists[name].indexOf(v) === -1) throw new Error(label + ' "' + v + '" is not in Settings_&_Lists.');
    return v;
  }

  const date = req('date', 'Date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be yyyy-mm-dd.');

  const amount = Number(t.amount);
  if (!isFinite(amount) || amount === 0) throw new Error('Base Amount must be a number other than 0.');
  if (Math.abs(amount) > CONFIG.MAX_AMOUNT) throw new Error('Base Amount looks too large.');

  const gstText = oneOf('gstRate', 'GST %', '0%');
  const gstRate = Number(gstText.replace('%', '')) / 100;

  return {
    date: date,
    type: oneOf('type', 'Type'),
    department: oneOf('department', 'Department', 'General'),
    category: oneOf('category', 'Category'),
    vendor: text_(req('vendor', 'Vendor / Client')),
    description: text_(req('description', 'Description')),
    invoice: text_(t.invoice),
    amount: Math.round(amount * 100) / 100,
    gstRate: gstRate,
    paymentMode: oneOf('paymentMode', 'Payment Mode'),
    status: oneOf('status', 'Status'),
    notes: text_(t.notes),
    gstInvoice: oneOf('gstInvoice', 'GST Invoice?', 'Not Applicable'),
    paidBy: oneOf('paidBy', 'Paid By / Payer', 'Company Account'),
  };
}

/** Keep typed text as text: stop it being read as a formula, number or date. */
function text_(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 500);
  return s ? "'" + s : '';
}

function saveReceipt_(receipt, txnId, clean) {
  const ext = RECEIPT_TYPES[receipt.mimeType];
  if (!ext) throw new Error('Receipt must be a JPG, PNG, WEBP or PDF file.');
  const bytes = Utilities.base64Decode(receipt.data);
  if (bytes.length > CONFIG.MAX_RECEIPT_BYTES) throw new Error('Receipt file is larger than 8 MB.');

  const root = DriveApp.getFolderById(CONFIG.RECEIPTS_FOLDER_ID);
  const month = clean.date.slice(0, 7);
  const it = root.getFoldersByName(month);
  const folder = it.hasNext() ? it.next() : root.createFolder(month);

  const vendor = clean.vendor.replace(/^'/, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40);
  const name = txnId + '_' + clean.date + '_' + vendor + '.' + ext;
  const file = folder.createFile(Utilities.newBlob(bytes, receipt.mimeType, name));
  return file.getUrl();
}

// ---------------------------------------------------------------- helpers

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found.');
  return sh;
}

/** Last row with a Date in column B (other columns hold array formulas). */
function lastDataRow_(sh) {
  const n = sh.getMaxRows() - 1;
  const vals = sh.getRange(2, 2, n, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== '' && vals[i][0] !== null) return i + 2;
  }
  return 1;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to approve permissions and check the setup. */
function testSetup() {
  Logger.log('Summary: ' + JSON.stringify(getSummary_()));
  Logger.log('Lists: ' + JSON.stringify(getLists_()));
  Logger.log('Last data row: ' + lastDataRow_(sheet_(CONFIG.TX_SHEET)));
  Logger.log('Receipts folder: ' + DriveApp.getFolderById(CONFIG.RECEIPTS_FOLDER_ID).getName());
  Logger.log('PIN set: ' + Boolean(PropertiesService.getScriptProperties().getProperty('APP_PIN')));
}

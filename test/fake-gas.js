// Minimal stand-in for the Apps Script services Code.gs uses, so the real
// backend code can be exercised locally against an in-memory copy of the sheet.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

class FakeSheet {
  constructor(name, rows, cols) {
    this.name = name;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(''));
    this.formulas = {}; // "r,c" -> formula text
  }
  getMaxRows() { return this.grid.length; }
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) if (this.grid[r].some((v) => v !== '')) return r + 1;
    return 0;
  }
  getRange(row, col, nr = 1, nc = 1) { return new FakeRange(this, row, col, nr, nc); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), this.grid[0].length); }
  display(r, c) { const v = this.grid[r][c]; return this.fmt ? this.fmt(r, c, v) : (v instanceof Date ? iso(v) : String(v)); }
}

class FakeRange {
  constructor(sh, row, col, nr, nc) {
    if (row < 1 || col < 1 || row - 1 + nr > sh.grid.length || col - 1 + nc > sh.grid[0].length) {
      throw new Error(`Range out of bounds on ${sh.name}: R${row}C${col} ${nr}x${nc}`);
    }
    Object.assign(this, { sh, row, col, nr, nc });
  }
  map(fn) { const out = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) r.push(fn(this.row - 1 + i, this.col - 1 + j)); out.push(r); } return out; }
  getValues() { return this.map((r, c) => this.sh.grid[r][c]); }
  getDisplayValues() { return this.map((r, c) => this.sh.display(r, c)); }
  setValue(v) { this.setValues([[v]]); return this; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('setValues size mismatch');
    this.sh.writes = (this.sh.writes || []).concat([{ a1: colLetter(this.col) + this.row, nr: this.nr, nc: this.nc }]);
    vals.forEach((row, i) => row.forEach((v, j) => {
      const r = this.row - 1 + i, c = this.col - 1 + j;
      delete this.sh.formulas[r + ',' + c];
      this.sh.grid[r][c] = parseInput(v, this.sh, r, c);
    }));
    return this;
  }
}

function iso(d) { return d.toISOString().slice(0, 10); }

/** Parse a written value the way Sheets does for typed input. */
function parseInput(v, sh, r, c) {
  if (typeof v !== 'string') return v;
  if (v.startsWith("'")) return v.slice(1);
  if (v.startsWith('=')) { sh.formulas[r + ',' + c] = v; return v; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T00:00:00Z');
  if (v !== '' && !isNaN(Number(v))) return Number(v);
  if (/^[+\-@]/.test(v)) throw new Error('Unescaped text would be parsed as a formula: ' + v);
  return v;
}

function inr(n) { return (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function makeEnv(opts = {}) {
  const tx = new FakeSheet('Transactions', 1000, 22);
  tx.grid[0] = ['Txn ID', 'Date', 'Month', 'Type', 'Department', 'Category', 'Vendor / Client', 'Description', 'Invoice / Ref No.', 'Base Amount (₹)', 'GST %', 'GST Amount (₹)', 'Total Amount (₹)', 'Payment Mode', 'Status', 'Card Due Date', 'Running Bank Balance (₹)', 'Receipt Drive Link', 'Notes', 'GST Invoice?', 'Paid By / Payer', 'Bank Movement (₹)'];
  const seed = [
    ['2026-10-31', 'Expense', 'Marketing & Training', 'Training & Sessions', 'Tagmango', 'AI Tools session', 14479333637, 1999, 0, 'Credit Card', 'Pending', '', 'Statement', 'Not Applicable', 'Company Account'],
    ['2026-11-02', 'Income', 'General', 'Capital / Family Support', 'Subha', 'Funds received', '', 5000, 0, 'UPI(Gpay)', 'Received', '', 'GPay', 'Not Applicable', 'Subha (Founder / Capital)'],
  ];
  seed.forEach((s, i) => {
    const r = i + 1;
    tx.grid[r][1] = new Date(s[0] + 'T00:00:00Z');
    [3, 4, 5, 6, 7, 8, 9, 10].forEach((c, k) => { tx.grid[r][c] = s[1 + k]; });
    tx.grid[r][13] = s[9]; tx.grid[r][14] = s[10]; tx.grid[r][17] = s[11]; tx.grid[r][18] = s[12]; tx.grid[r][19] = s[13]; tx.grid[r][20] = s[14];
  });
  // Emulate the sheet's array formulas (A, C, L, M, P, Q, V) for display.
  tx.fmt = (r, c, v) => {
    const row = tx.grid[r];
    const date = row[1];
    if (r === 0) return String(v);
    if (!(date instanceof Date)) return c === 1 || [0, 2, 11, 12, 15, 16, 21].includes(c) ? '' : String(v);
    const base = Number(row[9]) || 0, rate = Number(row[10]) || 0;
    const gst = Math.round(base * rate * 100) / 100, total = Math.round((base + gst) * 100) / 100;
    const move = (rr) => {
      const x = tx.grid[rr]; const b = Number(x[9]) || 0, t = b + Math.round(b * (Number(x[10]) || 0) * 100) / 100;
      if (x[3] === 'Income' && ['Received', 'Paid'].includes(x[14]) && x[13] !== 'Director / Founder Paid') return t;
      if (x[3] === 'Expense' && x[13] !== 'Credit Card' && x[13] !== 'Director / Founder Paid' && x[14] === 'Paid') return -t;
      return 0;
    };
    switch (c) {
      case 0: return 'TXN-' + String(r).padStart(3, '0');
      case 1: return iso(date);
      case 2: return iso(date).slice(0, 7);
      case 9: return inr(base);
      case 10: return Math.round(rate * 100) + '%';
      case 11: return inr(gst);
      case 12: return inr(total);
      case 15: {
        if (row[13] !== 'Credit Card') return '';
        const m = date.getUTCMonth() + 1 + (date.getUTCDate() > 21 ? 1 : 0);
        return iso(new Date(Date.UTC(date.getUTCFullYear(), m, 8)));
      }
      case 16: { let s = 0; for (let k = 1; k <= r; k++) if (tx.grid[k][1] instanceof Date) s += move(k); return inr(s); }
      case 17: return row[17] ? 'View Receipt' : '';
      case 21: return inr(move(r));
      default: return String(v);
    }
  };

  const summary = new FakeSheet('App_Summary', 30, 4);
  [['Label', 'Value', 'Display'], ['Bank / Cash Balance', 11569, '₹11,569.00'], ['Credit Card Owed', 40546.79, '₹40,546.79'],
    ['Net Cash Position', -28977.79, '-₹28,977.79'], ['Card Utilisation', 0.27, '27.0%'], ['Next Card Due Date', '', '08-Dec-2026'],
    ['Last Updated', '', '25-Nov-2026']].forEach((r, i) => { summary.grid[i] = r.concat(['']); });

  const settings = new FakeSheet('Settings_&_Lists', 30, 13);
  const lists = {
    5: ['Type', 'Income', 'Expense', 'Card Payment', 'Reimbursement'],
    6: ['Department', 'Operations', 'IT & Software', 'Admin & Office', 'Marketing & Training', 'General'],
    7: ['Category', 'Office Equipment & Accessories', 'Bills & Utilities', 'Food & Refreshments', 'Software & Subscriptions', 'Training & Sessions', 'Capital / Family Support', 'Miscellaneous Expense'],
    8: ['Payment Mode', 'Credit Card', 'Debit Card', 'UPI(Gpay)', 'Net Banking', 'Cash', 'Director / Founder Paid'],
    9: ['Status', 'Paid', 'Received', 'Pending', 'To Receive', 'Approved'],
    10: ['GST Rate', '0%', '5%', '12%', '18%', '28%'],
    11: ['GST Invoice Status', 'Yes - GST Invoice', 'Pending Invoice', 'Not Applicable'],
    12: ['Paid By / Payer', 'Company Account', 'Founder / Director', 'Personal Card (To Reimburse)'],
  };
  settings.grid[2][1] = 'COMPANY PARAMETERS';
  Object.entries(lists).forEach(([c, vals]) => vals.forEach((v, i) => { settings.grid[2 + i][Number(c)] = v; }));

  const sheets = { Transactions: tx, App_Summary: summary, 'Settings_&_Lists': settings };
  const props = { APP_PIN: opts.pin === undefined ? '2468' : opts.pin };
  const cache = {};
  const files = [];
  const folders = {};

  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
    Utilities: { base64Decode: (s) => Array.from(Buffer.from(s, 'base64')), newBlob: (bytes, type, name) => ({ bytes, type, name }) },
    DriveApp: {
      getFolderById: (id) => ({
        getName: () => 'Receipts',
        getFoldersByName: (n) => { let done = !folders[n]; return { hasNext: () => !done, next: () => { done = true; return folders[n]; } }; },
        createFolder: (n) => (folders[n] = { name: n, createFile: (blob) => { files.push({ folder: n, ...blob }); return { getUrl: () => 'https://drive.google.com/file/d/FAKE' + files.length + '/view' }; } }),
      }),
    },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);

  return {
    ctx, sheets, files, folders, cache,
    post(body) { return JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body); },
  };
}

module.exports = { makeEnv };

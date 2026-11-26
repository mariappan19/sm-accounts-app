// Runs the real Code.gs against the fake sheet. `node test/backend.test.js`
const assert = require('assert');
const { makeEnv } = require('./fake-gas');

let n = 0;
function test(name, fn) { fn(); n++; console.log('ok -', name); }

const good = {
  date: '2026-11-26', type: 'Expense', department: 'Admin & Office', category: 'Food & Refreshments',
  vendor: 'Saravana Bhavan', description: '-Team lunch =SUM(1)', invoice: '00123', amount: 1000,
  gstRate: '18%', paymentMode: 'Credit Card', status: 'Pending', notes: '@note', gstInvoice: 'Yes - GST Invoice', paidBy: 'Company Account',
};

test('wrong PIN is refused and locks out after 5 tries', () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) assert.strictEqual(env.post({ action: 'summary', pin: '0000' }).error, 'Wrong PIN.');
  assert.match(env.post({ action: 'summary', pin: '2468' }).error, /Too many wrong PINs/);
});

test('missing APP_PIN property is reported', () => {
  const env = makeEnv({ pin: null });
  assert.match(env.post({ action: 'summary', pin: '' }).error, /APP_PIN is not set/);
});

test('bootstrap returns summary and all eight lists', () => {
  const r = makeEnv().post({ action: 'bootstrap', pin: '2468' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.summary[0].label, 'Bank / Cash Balance');
  assert.strictEqual(r.summary[0].value, '₹11,569.00');
  assert.deepStrictEqual(r.lists.type, ['Income', 'Expense', 'Card Payment', 'Reimbursement']);
  assert.deepStrictEqual(r.lists.gstRate, ['0%', '5%', '12%', '18%', '28%']);
  assert.strictEqual(r.lists.paidBy[0], 'Company Account');
  assert.strictEqual(Object.keys(r.lists).length, 8);
});

test('add writes only input columns, in the next row, with text kept as text', () => {
  const env = makeEnv();
  const r = env.post({ action: 'add', pin: '2468', txn: good });
  assert.ok(r.ok, r.error);
  const tx = env.sheets.Transactions;
  assert.strictEqual(r.result.row, 4);
  assert.strictEqual(r.result.id, 'TXN-003');
  assert.strictEqual(r.result.total, '₹1,180.00');
  assert.strictEqual(r.result.dueDate, '2027-01-08'); // 26 Nov is after the 21st statement day
  const row = tx.grid[3];
  assert.ok(row[1] instanceof Date);
  assert.deepStrictEqual(row.slice(3, 11), ['Expense', 'Admin & Office', 'Food & Refreshments', 'Saravana Bhavan', '-Team lunch =SUM(1)', '00123', 1000, 0.18]);
  assert.deepStrictEqual(row.slice(13, 15), ['Credit Card', 'Pending']);
  assert.deepStrictEqual(row.slice(17, 21), ['', '@note', 'Yes - GST Invoice', 'Company Account']);
  // Formula columns A, C, L, M, P, Q, V never written
  const written = tx.writes.map((w) => w.a1 + ':' + w.nc);
  assert.deepStrictEqual(written, ['B4:1', 'D4:8', 'N4:2', 'R4:4']);
});

test('defaults fill department, GST, invoice status and payer', () => {
  const env = makeEnv();
  const t = { date: '2026-11-26', type: 'Expense', category: 'Bills & Utilities', vendor: 'BSNL', description: 'Broadband', amount: 799, paymentMode: 'UPI(Gpay)', status: 'Paid' };
  const r = env.post({ action: 'add', pin: '2468', txn: t });
  assert.ok(r.ok, r.error);
  const row = env.sheets.Transactions.grid[3];
  assert.strictEqual(row[4], 'General');
  assert.strictEqual(row[10], 0);
  assert.strictEqual(row[19], 'Not Applicable');
  assert.strictEqual(row[20], 'Company Account');
  assert.strictEqual(r.result.dueDate, '');
  assert.strictEqual(r.result.balance, '₹4,201.00'); // 5,000 received - 799 paid by UPI
});

test('values outside Settings_&_Lists are rejected and nothing is written', () => {
  const env = makeEnv();
  const r = env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { category: 'Party' }) });
  assert.match(r.error, /Category "Party" is not in Settings_&_Lists/);
  assert.strictEqual(env.sheets.Transactions.writes, undefined);
});

test('bad amount and bad date are rejected', () => {
  const env = makeEnv();
  assert.match(env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { amount: 'abc' }) }).error, /Base Amount/);
  assert.match(env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { amount: 0 }) }).error, /Base Amount/);
  assert.match(env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { date: '26/11/2026' }) }).error, /yyyy-mm-dd/);
});

test('receipt is saved in a month folder and linked like existing rows', () => {
  const env = makeEnv();
  const data = Buffer.from('fake-jpeg').toString('base64');
  const r = env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { receipt: { mimeType: 'image/jpeg', data } }) });
  assert.ok(r.ok, r.error);
  assert.strictEqual(env.files.length, 1);
  assert.strictEqual(env.files[0].folder, '2026-11');
  assert.strictEqual(env.files[0].name, 'TXN-003_2026-11-26_Saravana_Bhavan.jpg');
  assert.strictEqual(env.sheets.Transactions.grid[3][17], '=HYPERLINK("https://drive.google.com/file/d/FAKE1/view", "View Receipt")');
});

test('unsupported receipt type is refused before any write', () => {
  const env = makeEnv();
  const r = env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { receipt: { mimeType: 'text/html', data: 'PGI+' } }) });
  assert.match(r.error, /JPG, PNG, WEBP or PDF/);
  assert.strictEqual(env.sheets.Transactions.writes, undefined);
});

test('consecutive adds go to consecutive rows; pending filter and order', () => {
  const env = makeEnv();
  env.post({ action: 'add', pin: '2468', txn: good });
  const r2 = env.post({ action: 'add', pin: '2468', txn: Object.assign({}, good, { status: 'Paid', paymentMode: 'Cash' }) });
  assert.strictEqual(r2.result.id, 'TXN-004');
  const all = env.post({ action: 'transactions', pin: '2468', filter: 'all' }).items;
  assert.deepStrictEqual(all.map((t) => t.id), ['TXN-004', 'TXN-003', 'TXN-002', 'TXN-001']);
  const pend = env.post({ action: 'transactions', pin: '2468', filter: 'pending' }).items;
  assert.deepStrictEqual(pend.map((t) => t.id), ['TXN-003', 'TXN-001']);
});

test('full sheet (row 1000) is refused', () => {
  const env = makeEnv();
  const tx = env.sheets.Transactions;
  tx.grid[999][1] = new Date('2026-11-01T00:00:00Z');
  assert.match(env.post({ action: 'add', pin: '2468', txn: good }).error, /Transactions is full/);
});

test('bad JSON and unknown action give clean errors', () => {
  const env = makeEnv();
  assert.strictEqual(env.post('{not json').ok, false);
  assert.strictEqual(env.post({ action: 'drop', pin: '2468' }).error, 'Unknown action.');
});

console.log(`\n${n} backend tests passed`);

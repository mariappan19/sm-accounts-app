// Drives the web app on an emulated phone, with the real Code.gs answering
// through the fake sheet. `node test/e2e.test.js [screenshot-dir]`
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { makeEnv } = require('./fake-gas');

const WEB = path.join(__dirname, '../docs');
const API = 'https://script.google.com/macros/s/AKfycbTEST123/exec';
const shots = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(WEB) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(8765, r));
  const env = makeEnv();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(API, async (route) => {
    const body = route.request().postData();
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(env.post(body)) });
  });
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, name + '.png'), fullPage: true }); };

  await page.goto('http://localhost:8765/');
  await page.waitForSelector('#screen-setup:not([hidden])');
  await shot('1-setup');

  // Wrong URL format is caught locally
  await page.fill('#setup-url', 'https://example.com/x');
  await page.fill('#setup-pin', '2468');
  await page.click('#setup-form button[type=submit]');
  assert.match(await page.textContent('#setup-error'), /ends with \/exec/);

  // Wrong PIN comes back from the backend
  await page.fill('#setup-url', API);
  await page.fill('#setup-pin', '1111');
  await page.click('#setup-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#setup-error').textContent.length > 0);
  assert.strictEqual(await page.textContent('#setup-error'), 'Wrong PIN.');
  env.cache.pinFails && delete env.cache.pinFails;

  await page.fill('#setup-pin', '2468');
  await page.check('#setup-remember');
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('.stat');
  assert.match(await page.textContent('#summary'), /₹11,569\.00/);
  assert.match(await page.textContent('#summary-note'), /25-Nov-2026/);
  await shot('2-home');

  // Add an expense with a receipt photo
  await page.click('.tabbar [data-goto=add]');
  const f = '#add-form ';
  assert.strictEqual(await page.inputValue(f + '[name=type]'), 'Expense');
  await page.selectOption(f + '[name=category]', 'Food & Refreshments');
  await page.selectOption(f + '[name=department]', 'Admin & Office');
  await page.fill(f + '[name=vendor]', 'Saravana Bhavan');
  await page.fill(f + '[name=description]', 'Team lunch');
  await page.fill(f + '[name=amount]', '1000');
  await page.selectOption(f + '[name=gstRate]', '5%');
  assert.match(await page.textContent('#total-preview'), /₹1,050\.00/);
  await page.selectOption(f + '[name=paymentMode]', 'Credit Card');
  assert.strictEqual(await page.inputValue(f + '[name=status]'), 'Pending', 'card spend defaults to Pending');
  await page.selectOption(f + '[name=paymentMode]', 'UPI(Gpay)');
  assert.strictEqual(await page.inputValue(f + '[name=status]'), 'Paid', 'UPI spend defaults to Paid');
  await page.setInputFiles(f + '[name=receipt]', path.join(WEB, 'icons/icon-512.png'));
  await page.waitForSelector('#receipt-preview:not([hidden])');
  await shot('3-add');

  // Empty required field blocks submit
  await page.fill(f + '[name=vendor]', '');
  await page.click('#add-submit');
  assert.match(await page.textContent('#add-error'), /Vendor \/ Client/);
  await page.fill(f + '[name=vendor]', 'Saravana Bhavan');

  await page.click('#add-submit');
  await page.waitForSelector('#toast:not([hidden])');
  const toast = await page.textContent('#toast');
  assert.match(toast, /Saved TXN-003 · ₹1,050\.00 · bank ₹3,950\.00/);
  const row = env.sheets.Transactions.grid[3];
  assert.deepStrictEqual([row[3], row[5], row[6], row[9], row[10], row[13], row[14]],
    ['Expense', 'Food & Refreshments', 'Saravana Bhavan', 1000, 0.05, 'UPI(Gpay)', 'Paid']);
  assert.strictEqual(env.files.length, 1);
  assert.strictEqual(env.files[0].type, 'image/jpeg');
  assert.strictEqual(await page.inputValue(f + '[name=vendor]'), '', 'form cleared after save');
  await shot('4-saved');

  // Entries list
  await page.click('.tabbar [data-goto=list]');
  await page.waitForSelector('.txn');
  assert.strictEqual(await page.locator('.txn').count(), 1, 'one pending entry (TXN-001)');
  await page.click('.seg[data-filter=all]');
  await page.waitForFunction(() => document.querySelectorAll('.txn').length === 3);
  assert.match(await page.textContent('.txn'), /Team lunch.*TXN-003.*receipt ✓/s);
  await shot('5-entries');

  // Reload: PIN remembered, goes straight in; lock returns to PIN screen
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  await page.click('.tabbar [data-goto=more]');
  await shot('6-more');
  await page.click('[data-action=lock]');
  await page.waitForSelector('#screen-lock:not([hidden])');

  // Manifest and service worker are valid for install
  const manifest = await (await page.request.get('http://localhost:8765/manifest.webmanifest')).json();
  assert.strictEqual(manifest.display, 'standalone');
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
  assert.ok(sw, 'service worker registered');

  // Dark mode renders
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('7-lock-dark');

  assert.deepStrictEqual(errors, []);
  console.log('e2e passed');
  await browser.close();
  server.close();
})().catch(async (e) => { console.error(e); process.exit(1); });

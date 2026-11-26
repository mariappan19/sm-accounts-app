/* SM Accounts – mobile front end for Office_Accounts_Master_2026. */
(function () {
  'use strict';

  const KEY_URL = 'sm.apiUrl';
  const KEY_PIN = 'sm.pin';
  const KEY_LISTS = 'sm.lists';
  const KEY_VENDORS = 'sm.vendors';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } },
  };

  const state = {
    apiUrl: store.get(KEY_URL) || '',
    pin: store.get(KEY_PIN) || '',
    lists: parse(store.get(KEY_LISTS)) || null,
    filter: 'pending',
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  // ------------------------------------------------------------ API

  async function api(action, payload) {
    if (!state.apiUrl) throw new Error('Backend URL is not set.');
    let res;
    try {
      res = await fetch(state.apiUrl, {
        method: 'POST',
        // text/plain keeps this a "simple" request, which Apps Script accepts without CORS preflight.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action, pin: state.pin }, payload || {})),
        redirect: 'follow',
      });
    } catch (e) {
      if (navigator.onLine === false) throw new Error('No internet connection. Nothing was saved. Try again when you are online.');
      throw new Error('Could not reach the backend. Nothing was saved. In Apps Script, check Deploy → Manage deployments: "Who has access" must be "Anyone", and the URL must end in /exec.');
    }
    let data;
    try { data = await res.json(); } catch (e) {
      throw new Error('The backend did not reply correctly. Check the web app URL and that it is deployed for "Anyone".');
    }
    if (!data.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // ------------------------------------------------------------ screens

  function show(id) {
    ['#screen-setup', '#screen-lock', '#app'].forEach((s) => { $(s).hidden = s !== id; });
  }

  function goto(tab) {
    $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + tab; });
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.goto === tab));
    $('#title').textContent = { home: 'Home', add: 'Add transaction', list: 'Entries', more: 'More' }[tab];
    window.scrollTo(0, 0);
    if (tab === 'list') loadList();
    if (tab === 'more') $('#more-url').textContent = 'Connected to: ' + shortUrl(state.apiUrl);
  }

  function shortUrl(u) { return u.length > 60 ? u.slice(0, 40) + '…' + u.slice(-12) : u; }

  function busy(on, text) {
    $('#busy').hidden = !on;
    $('#busy-text').textContent = text || 'Working…';
  }

  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 4000);
  }

  // ------------------------------------------------------------ start / unlock

  async function start() {
    if (!state.apiUrl) return show('#screen-setup');
    if (!state.pin) return show('#screen-lock');
    try {
      busy(true, 'Loading…');
      await bootstrap();
      show('#app');
      goto('home');
    } catch (e) {
      show('#screen-lock');
      $('#lock-error').textContent = e.message;
      if (/PIN/i.test(e.message)) { state.pin = ''; store.del(KEY_PIN); }
    } finally {
      busy(false);
    }
  }

  async function bootstrap() {
    const data = await api('bootstrap');
    state.lists = data.lists;
    store.set(KEY_LISTS, JSON.stringify(data.lists));
    renderSummary(data.summary);
    fillLists();
  }

  async function unlock(url, pin, remember, errorEl) {
    errorEl.textContent = '';
    state.apiUrl = url;
    state.pin = pin;
    try {
      busy(true, 'Connecting…');
      await bootstrap();
      store.set(KEY_URL, url);
      if (remember) store.set(KEY_PIN, pin); else store.del(KEY_PIN);
      show('#app');
      goto('home');
    } catch (e) {
      state.pin = '';
      errorEl.textContent = e.message;
    } finally {
      busy(false);
    }
  }

  // ------------------------------------------------------------ home

  function renderSummary(items) {
    const box = $('#summary');
    box.textContent = '';
    const big = ['Bank / Cash Balance', 'Net Cash Position'];
    let updated = '';
    items.forEach((it) => {
      if (it.label === 'Last Updated') { updated = it.value; return; }
      const d = document.createElement('div');
      d.className = 'stat' + (big.indexOf(it.label) !== -1 ? ' big' : '');
      const l = document.createElement('div');
      l.className = 'label';
      l.textContent = it.label;
      const v = document.createElement('div');
      v.className = 'value' + (/^-/.test(it.value) ? ' neg' : '');
      v.textContent = it.value;
      d.append(l, v);
      box.append(d);
    });
    $('#summary-note').textContent = updated ? 'Dashboard last updated: ' + updated : '';
  }

  // ------------------------------------------------------------ add form

  function fillLists() {
    if (!state.lists) return;
    $$('select[data-list]').forEach((sel) => {
      const items = state.lists[sel.dataset.list] || [];
      const keep = sel.value;
      sel.textContent = '';
      if (sel.required) sel.append(new Option('Choose…', ''));
      items.forEach((v) => sel.append(new Option(v, v)));
      if (items.indexOf(keep) !== -1) sel.value = keep;
    });
    setDefaults();
    renderVendors();
  }

  function setDefaults() {
    const f = $('#add-form');
    if (!f.date.value) f.date.value = today();
    if (!f.type.value && hasOption(f.type, 'Expense')) f.type.value = 'Expense';
    if (!f.department.value && hasOption(f.department, 'General')) f.department.value = 'General';
    if (hasOption(f.gstRate, '0%') && !f.gstRate.dataset.touched) f.gstRate.value = '0%';
    if (hasOption(f.gstInvoice, 'Not Applicable') && !f.gstInvoice.dataset.touched) f.gstInvoice.value = 'Not Applicable';
    if (hasOption(f.paidBy, 'Company Account') && !f.paidBy.dataset.touched) f.paidBy.value = 'Company Account';
    autoStatus();
    updateTotal();
  }

  function hasOption(sel, v) { return Array.from(sel.options).some((o) => o.value === v); }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** Suggest a status the way the sheet is used: card spends stay Pending until the bill is paid. */
  function autoStatus() {
    const f = $('#add-form');
    if (f.status.dataset.touched) return;
    let s = '';
    if (f.type.value === 'Income') s = 'Received';
    else if (f.paymentMode.value === 'Credit Card') s = 'Pending';
    else if (f.paymentMode.value) s = 'Paid';
    if (s && hasOption(f.status, s)) f.status.value = s;
  }

  function updateTotal() {
    const f = $('#add-form');
    const base = Number(f.amount.value) || 0;
    const rate = (Number(String(f.gstRate.value || '0').replace('%', '')) || 0) / 100;
    const gst = Math.round(base * rate * 100) / 100;
    $('#total-preview').textContent = inr(base + gst) + (gst ? '  (GST ' + inr(gst) + ')' : '');
  }

  function inr(n) {
    return (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function rememberVendor(v) {
    const list = parse(store.get(KEY_VENDORS)) || [];
    const next = [v].concat(list.filter((x) => x !== v)).slice(0, 40);
    store.set(KEY_VENDORS, JSON.stringify(next));
    renderVendors();
  }

  function renderVendors() {
    const dl = $('#vendor-list');
    dl.textContent = '';
    (parse(store.get(KEY_VENDORS)) || []).forEach((v) => dl.append(new Option(v)));
  }

  let receiptPayload = null;

  async function onReceiptChange(e) {
    receiptPayload = null;
    const img = $('#receipt-preview');
    img.hidden = true;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      busy(true, 'Preparing receipt…');
      if (file.type === 'application/pdf') {
        if (file.size > 8 * 1024 * 1024) throw new Error('PDF is larger than 8 MB.');
        receiptPayload = { mimeType: 'application/pdf', data: await toBase64(file) };
      } else if (/^image\//.test(file.type)) {
        const blob = await shrinkImage(file, 1600, 0.75);
        receiptPayload = { mimeType: 'image/jpeg', data: await toBase64(blob) };
        img.src = URL.createObjectURL(blob);
        img.hidden = false;
      } else {
        throw new Error('Choose a photo or a PDF.');
      }
    } catch (err) {
      e.target.value = '';
      $('#add-error').textContent = err.message;
    } finally {
      busy(false);
    }
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(blob);
    });
  }

  function shrinkImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open the photo.')); };
      img.src = url;
    });
  }

  async function onSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const err = $('#add-error');
    err.textContent = '';
    const missing = Array.from(f.querySelectorAll('[required]')).filter((el) => !String(el.value).trim());
    if (missing.length) {
      err.textContent = 'Please fill in: ' + missing.map((el) => el.closest('label').firstChild.textContent.trim()).join(', ');
      missing[0].focus();
      return;
    }
    if (Number(f.amount.value) === 0) { err.textContent = 'Base Amount cannot be 0.'; return; }

    const txn = {};
    ['date', 'type', 'department', 'category', 'vendor', 'description', 'invoice', 'amount',
      'gstRate', 'paymentMode', 'status', 'notes', 'gstInvoice', 'paidBy'].forEach((k) => { txn[k] = f[k].value; });
    txn.amount = Number(txn.amount);
    if (receiptPayload) txn.receipt = receiptPayload;

    const btn = $('#add-submit');
    btn.disabled = true;
    try {
      busy(true, receiptPayload ? 'Uploading receipt and saving…' : 'Saving…');
      const { result } = await api('add', { txn: txn });
      rememberVendor(txn.vendor);
      resetForm(f);
      toast('Saved ' + result.id + ' · ' + result.total +
        (result.dueDate ? ' · card due ' + result.dueDate : '') +
        ' · bank ' + result.balance, 6000);
      refreshSummary();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      busy(false);
      btn.disabled = false;
    }
  }

  function resetForm(f) {
    const keepDate = f.date.value;
    f.reset();
    $$('#add-form [data-touched]').forEach((el) => delete el.dataset.touched);
    receiptPayload = null;
    $('#receipt-preview').hidden = true;
    f.date.value = keepDate;
    setDefaults();
  }

  async function refreshSummary() {
    try { renderSummary((await api('summary')).summary); } catch (e) { /* shown on next refresh */ }
  }

  // ------------------------------------------------------------ list

  async function loadList() {
    const ul = $('#txn-list');
    ul.innerHTML = '<li class="muted">Loading…</li>';
    try {
      const { items } = await api('transactions', { filter: state.filter, limit: 60 });
      ul.textContent = '';
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'muted';
        li.textContent = state.filter === 'pending' ? 'Nothing pending.' : 'No entries yet.';
        ul.append(li);
        return;
      }
      items.forEach((t) => ul.append(txnItem(t)));
    } catch (e) {
      ul.textContent = '';
      const li = document.createElement('li');
      li.className = 'error';
      li.textContent = e.message;
      ul.append(li);
    }
  }

  function txnItem(t) {
    const li = document.createElement('li');
    li.className = 'txn';
    const top = document.createElement('div');
    top.className = 'top';
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = t.description || t.vendor;
    const amt = document.createElement('div');
    amt.className = 'amt';
    amt.textContent = t.total;
    top.append(desc, amt);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [t.id, t.date, t.vendor, t.paymentMode].filter(Boolean).join(' · ') +
      (t.dueDate ? ' · due ' + t.dueDate : '') + (t.hasReceipt ? ' · receipt ✓' : '');
    const badge = document.createElement('span');
    badge.className = 'badge ' + String(t.status).toLowerCase().replace(/\s+/g, '-');
    badge.textContent = t.status;
    meta.append(badge);
    li.append(top, meta);
    return li;
  }

  // ------------------------------------------------------------ install prompt (Android)

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#install-btn').hidden = false;
  });

  // ------------------------------------------------------------ wiring

  function wire() {
    $('#setup-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = $('#setup-url').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
        $('#setup-error').textContent = 'Paste the Web app URL from Apps Script. It ends with /exec.';
        return;
      }
      unlock(url, $('#setup-pin').value, $('#setup-remember').checked, $('#setup-error'));
    });

    $('#lock-form').addEventListener('submit', (e) => {
      e.preventDefault();
      unlock(state.apiUrl, $('#lock-pin').value, $('#lock-remember').checked, $('#lock-error'));
    });

    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) { goto(go.dataset.goto); return; }
      const act = e.target.closest('[data-action]');
      if (!act) return;
      const a = act.dataset.action;
      if (a === 'refresh') { refreshSummary(); if (!$('#tab-list').hidden) loadList(); toast('Refreshed', 1500); }
      if (a === 'lock') { state.pin = ''; store.del(KEY_PIN); $('#lock-pin').value = ''; show('#screen-lock'); }
      if (a === 'forget-pin') { store.del(KEY_PIN); toast('Saved PIN removed from this phone.'); }
      if (a === 'reset') {
        if (!confirm('Disconnect this phone? You will need the backend URL and PIN again.')) return;
        [KEY_URL, KEY_PIN, KEY_LISTS].forEach(store.del);
        state.apiUrl = ''; state.pin = '';
        show('#screen-setup');
      }
    });

    $$('.seg').forEach((b) => b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      $$('.seg').forEach((x) => x.classList.toggle('active', x === b));
      loadList();
    }));

    const f = $('#add-form');
    f.addEventListener('submit', onSubmit);
    f.receipt.addEventListener('change', onReceiptChange);
    f.amount.addEventListener('input', updateTotal);
    ['status', 'gstRate', 'gstInvoice', 'paidBy'].forEach((n) =>
      f[n].addEventListener('change', () => { f[n].dataset.touched = '1'; updateTotal(); }));
    ['type', 'paymentMode'].forEach((n) => f[n].addEventListener('change', autoStatus));

    $('#install-btn').addEventListener('click', async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      $('#install-btn').hidden = true;
    });

    if (state.lists) fillLists();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  wire();
  start();
})();

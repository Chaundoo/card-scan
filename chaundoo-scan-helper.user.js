// ==UserScript==
// @name         Chaundoo Card Scan Helper
// @namespace    https://chaundoo.github.io/card-scan/
// @version      1.2.0
// @updateURL    https://chaundoo.github.io/card-scan/chaundoo-scan-helper.user.js
// @downloadURL  https://chaundoo.github.io/card-scan/chaundoo-scan-helper.user.js
// @description  Reads the TCGplayer / eBay page you open from Chaundoo Card Scan and sends the sales and listings back to it. Nothing leaves your browser.
// @match        https://chaundoo.github.io/card-scan/*
// @match        https://www.tcgplayer.com/product/*
// @match        https://www.tcgplayer.com/search/*
// @match        https://www.ebay.com/sch/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  const VER = '1.2.0';
  const hasGM4 = typeof GM !== 'undefined' && GM && GM.getValue;
  const get = (k, d) => hasGM4 ? GM.getValue(k, d) : Promise.resolve(GM_getValue(k, d));
  const set = (k, v) => hasGM4 ? GM.setValue(k, v) : Promise.resolve(GM_setValue(k, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = s => { const m = String(s || '').replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? +m[0] : null; };
  const txt = el => (el && (el.innerText || el.textContent) || '').trim();
  const PENDING_MAX = 15 * 60e3, KEEP = 3 * 3600e3;

  /* ---------- on the Card Scan site ---------- */
  if (location.host === 'chaundoo.github.io') {
    document.documentElement.dataset.ccsHelper = VER;
    const delivered = {};
    async function deliver(key) {
      if (!key) return;
      const all = await get('results', {});
      for (const src of ['tcg', 'ebaySold', 'ebayList']) {
        const r = all[key + '|' + src];
        if (r && delivered[key + src] !== r.at) {
          window.postMessage({ ccs: 'result', key, source: src, payload: r }, location.origin);
          delivered[key + src] = r.at;
        }
      }
    }
    window.addEventListener('message', async e => {
      if (e.origin !== location.origin) return;
      const d = e.data || {};
      if (d.ccs === 'pending') {
        await set('pending_' + d.source, { key: d.key, url: d.url, label: d.label, productId: d.productId, cond: d.cond, at: Date.now() });
      } else if (d.ccs === 'poll') {
        Object.keys(delivered).forEach(k => delete delivered[k]);
        deliver(d.key);
      }
    });
    setInterval(() => deliver(document.documentElement.dataset.ccsKey), 1500);
    return;
  }

  /* ---------- floating panel on TCGplayer / eBay ---------- */
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#1b2540;color:#fff;font:600 14px/1.35 system-ui,-apple-system,sans-serif;border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:290px';
  box.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><span style="width:12px;height:12px;border-radius:50%;background:#e3a800;flex:none"></span><span data-s>Chaundoo Scan</span></div><div style="display:flex;gap:6px;margin-top:8px"><button data-go style="flex:1;border:0;border-radius:8px;padding:7px 10px;background:#e3a800;color:#1b1400;font:700 13px system-ui">Read this page</button><button data-x style="border:0;border-radius:8px;padding:7px 9px;background:#2c3a63;color:#fff;font:700 13px system-ui">×</button></div>';
  document.body.appendChild(box);
  const status = t => { box.querySelector('[data-s]').textContent = t; };
  box.querySelector('[data-x]').onclick = () => box.remove();

  const isTcg = location.host === 'www.tcgplayer.com';
  const isTcgSearch = isTcg && location.pathname.startsWith('/search/');
  const source = isTcg ? 'tcg' : (/[?&]LH_Sold=1/.test(location.search) ? 'ebaySold' : 'ebayList');

  async function save(payload) {
    const p = await get('pending_' + source, null);
    if (!p || Date.now() - p.at > PENDING_MAX) { status('Not linked to a card. Start from Card Scan → Open & read.'); return false; }
    const all = await get('results', {});
    for (const k of Object.keys(all)) if (Date.now() - (all[k].at || 0) > KEEP) delete all[k];
    all[p.key + '|' + source] = { ...payload, at: Date.now(), via: 'helper', url: location.href };
    await set('results', all);
    status('Sent to Card Scan ✓ — switch back to that tab' + (p.label ? ' (' + p.label + ')' : ''));
    return true;
  }

  /* ---------- TCGplayer reader ---------- */
  async function waitFor(sel, ms) { const t = Date.now(); while (Date.now() - t < ms) { const el = document.querySelector(sel); if (el) return el; await sleep(250); } return null; }
  async function readTcg() {
    status('Reading TCGplayer…');
    await waitFor('.price-guide__points', 15000);
    await waitFor('.listing-item', 8000);
    await waitFor('.price-guide__latest-sales .modal__activator', 6000);
    await sleep(600);
    const rowVal = (root, label) => { for (const tr of (root || document).querySelectorAll('tr')) { const td = tr.querySelectorAll('td'); if (td.length >= 2 && txt(td[0]).startsWith(label)) return num(txt(td[1])); } return null; };
    const pts = document.querySelector('.price-guide__points-container') || document;
    const out = { market: rowVal(pts, 'Market Price'), recent: rowVal(pts, 'Most Recent Sale'), condLabel: txt(document.querySelector('.price-guide__points-condition')), sales: [], listings: [] };
    // open the sales history snapshot (same as tapping "View More Data")
    let rowsEl = document.querySelector('.latest-sales-table__tbody tr');
    if (!rowsEl) {
      const btn = document.querySelector('.price-guide__latest-sales .modal__activator') || [...document.querySelectorAll('button, .modal__activator, a')].find(b => /View More Data/i.test(b.textContent || ''));
      if (btn) { btn.click(); rowsEl = await waitFor('.latest-sales-table__tbody tr', 8000); }
    }
    for (const tr of document.querySelectorAll('.latest-sales-table__tbody tr')) {
      const c = tr.querySelector('.latest-sales-table__tbody__condition');
      const condLine = txt(c && c.querySelector('div')) || txt(c);
      const note = txt(c).replace(condLine, '').trim();
      out.sales.push({ date: txt(tr.querySelector('.latest-sales-table__tbody__date')), cond: condLine, note, qty: num(txt(tr.querySelector('[class*="quantity"]'))) || 1, price: num(txt(tr.querySelector('.latest-sales-table__tbody__price'))) });
    }
    const close = document.querySelector('.modal__close'); if (close && out.sales.length) close.click();
    for (const li of [...document.querySelectorAll('.listing-item')].slice(0, 30)) {
      const shipT = txt(li.querySelector('.listing-item__listing-data__info__shipping-message'));
      out.listings.push({
        price: num(txt(li.querySelector('.listing-item__listing-data__info__price'))),
        ship: /included|free/i.test(shipT) ? 0 : (num(shipT) || 0),
        cond: txt(li.querySelector('.listing-item__condition')),
        seller: txt(li.querySelector('.seller-info__name, [class*="seller-info__name"]'))
      });
    }
    out.listings = out.listings.filter(l => l.price);
    if (!out.sales.length && !out.listings.length && out.market == null) { status('Couldn\'t find prices yet. Wait for the page to load, then tap Read this page.'); return; }
    await save(out);
  }

  /* ---------- eBay reader ---------- */
  async function readEbay() {
    status('Reading eBay…');
    if (/captcha|splashui/i.test(location.href)) { status('eBay wants a human check. Do it, then tap Read this page.'); return; }
    await waitFor('li.s-card, li.s-item, ul.srp-results > li', 10000);
    const items = [];
    for (const li of document.querySelectorAll('li.s-card, li.s-item, ul.srp-results > li')) {
      const t = li.innerText || '';
      let title = txt(li.querySelector('.s-card__title, .s-item__title, [role="heading"]'));
      title = title.replace(/^New Listing\s*/i, '').replace(/Opens in a new window or tab/i, '').trim();
      if (!title || /^Shop on eBay/i.test(title)) continue;
      const pEl = li.querySelector('.s-card__price, .s-item__price');
      const price = num(txt(pEl) || (t.match(/\$[\d,]+\.\d{2}/) || [''])[0]);
      if (!price) continue;
      const dm = t.match(/Sold\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
      const sm = t.match(/\+\s*\$([\d,]+\.\d{2})\s*(shipping|delivery|postage)/i);
      const img = li.querySelector('img');
      const a = li.querySelector('a[href*="/itm/"]');
      items.push({ title, price, ship: /free (shipping|delivery)/i.test(t) ? 0 : (sm ? num(sm[1]) : 0), date: dm ? dm[1] : null, img: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '', url: a ? a.href.split('?')[0] : '' });
      if (items.length >= 40) break;
    }
    if (!items.length) {
      // nothing matched every word: retry once with the numbers/extra codes dropped (name words and exclusions kept)
      const u = new URL(location.href);
      if (!u.searchParams.get('ccsRetry')) {
        const q = u.searchParams.get('_nkw') || '';
        const looser = q.split(/\s+/).filter(t => t.startsWith('-') || !/[\d()\/]/.test(t)).join(' ');
        if (looser && looser !== q) {
          u.searchParams.set('_nkw', looser); u.searchParams.set('ccsRetry', '1');
          status('No exact matches. Trying a broader search…'); location.replace(u.toString()); return;
        }
      }
      status('No results found on this page.'); return;
    }
    await save({ items });
  }

  const run = () => (isTcgSearch ? Promise.resolve(status('Tap your card in the results. I\'ll read it on its page.')) : isTcg ? readTcg() : readEbay()).catch(e => status('Error: ' + e.message));
  box.querySelector('[data-go]').onclick = run;

  // Auto-read when this tab was opened from Card Scan in the last 15 minutes
  (async () => {
    const p = await get('pending_' + source, null);
    if (!p || Date.now() - p.at > PENDING_MAX) { status('Chaundoo Scan: tap to read'); return; }
    if (isTcgSearch) { status('Tap your card in these results. I\'ll read it on its page' + (p.label ? ' (' + p.label + ')' : '') + '.'); box.querySelector('[data-go]').style.display = 'none'; return; }
    if (isTcg && p.productId && !location.pathname.includes('/product/' + p.productId)) { status('Different product than Card Scan picked. Tap to read anyway.'); return; }
    status('Linked to ' + (p.label || 'card') + '…');
    await sleep(isTcg ? 2500 : 800);
    run();
  })();
})();

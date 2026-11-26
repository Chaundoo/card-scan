// ==UserScript==
// @name         Chaundoo Card Scan Helper
// @namespace    https://chaundoo.github.io/card-scan/
// @version      1.5.2
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
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      www.ebay.com
// @connect      ebay.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  const VER = '1.5.2';
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
        await set('pending_' + d.source, { key: d.key, url: d.url, label: d.label, productId: d.productId, cond: d.cond, num: d.num || '', at: Date.now() });
      } else if (d.ccs === 'poll') {
        Object.keys(delivered).forEach(k => delete delivered[k]);
        deliver(d.key);
      }
    });
    setInterval(() => deliver(document.documentElement.dataset.ccsKey), 1500);

    /* photos for the sold slideshow: Card Scan asks for one listing at a time (the one on screen and the next).
       One page at a time with a pause between, newest ask first, kept for 7 days, stops if eBay asks for a human check. */
    const gmx = (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) ? GM.xmlHttpRequest.bind(GM) : (typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : null);
    if (gmx) {
      document.documentElement.dataset.ccsPhotos = '1';
      const queue = []; let busy = false, pauseUntil = 0;
      const reply = (url, imgs, error) => window.postMessage({ ccs: 'photosResult', url, imgs: imgs || [], error: error || '' }, location.origin);
      const page = url => new Promise((res, rej) => gmx({ method: 'GET', url, timeout: 20000, headers: { Accept: 'text/html' }, onload: r => res(r), onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')) }));
      const big = u => String(u || '').replace(/s-l\d+(\.\w+)(\?.*)?$/, 's-l1600$1');
      function photosOf(html) {
        const d = new DOMParser().parseFromString(html, 'text/html'); const seen = new Set(), out = [];
        const add = u => { const m = String(u || '').match(/i\.ebayimg\.com\/images\/g\/([A-Za-z0-9_~-]{6,})\//); if (!m || seen.has(m[1])) return; seen.add(m[1]); out.push(big(u.startsWith('//') ? 'https:' + u : u)); };
        // the listing's own gallery only (not "similar items" further down)
        d.querySelectorAll('.ux-image-carousel-item img, .ux-image-carousel img, [data-testid="ux-image-carousel"] img').forEach(i => add(i.getAttribute('data-zoom-src') || i.getAttribute('data-src') || i.getAttribute('src')));
        if (!out.length) { const og = d.querySelector('meta[property="og:image"]'); if (og) add(og.content); }
        return out;
      }
      async function pump() {
        if (busy) return; busy = true;
        try {
          while (queue.length) {
            const url = queue.shift();
            const cache = await get('photos2', {}); const hit = cache[url];
            if (hit && Date.now() - hit.at < 7 * 864e5) { reply(url, hit.imgs); continue; }
            if (Date.now() < pauseUntil) { reply(url, null, 'check'); continue; }
            // ?nordt=true stops eBay from redirecting a sold listing to a similar one that's still for sale
            let r; try { r = await page(url + '?nordt=true&orig_cvip=true'); } catch (e) { reply(url, null, 'network'); await sleep(1500); continue; }
            const html = r.responseText || '';
            if (/splashui|captcha|challenge/i.test(r.finalUrl || '') || (r.status === 403) || (/captcha/i.test(html.slice(0, 20000)) && !/ux-image-carousel/.test(html))) {
              pauseUntil = Date.now() + 3 * 60e3; reply(url, null, 'check'); queue.length = 0; break;
            }
            if (r.status >= 400) { reply(url, null, 'http' + r.status); await sleep(1500); continue; }
            // make sure the page is this listing and not another one eBay swapped in
            const id = url.match(/\/itm\/(\d+)/)[1];
            const pd = new DOMParser().parseFromString(html, 'text/html');
            const canon = (pd.querySelector('link[rel="canonical"]') || {}).href || '';
            const ogu = (pd.querySelector('meta[property="og:url"]') || {}).content || '';
            const same = [r.finalUrl || '', canon, ogu].some(x => x.includes(id));
            if (!same) { reply(url, null, 'moved'); await sleep(600); continue; }
            const imgs = photosOf(html).slice(0, 12);
            const c2 = await get('photos2', {}); c2[url] = { imgs, at: Date.now() };
            const ks = Object.keys(c2); if (ks.length > 300) ks.sort((a, b) => c2[a].at - c2[b].at).slice(0, ks.length - 300).forEach(k => delete c2[k]);
            await set('photos2', c2); reply(url, imgs);
            await sleep(500 + Math.random() * 400); // still one page at a time, gentle on eBay
          }
        } finally { busy = false; }
      }
      window.addEventListener('message', e => {
        if (e.origin !== location.origin) return; const d = e.data || {};
        if (d.ccs !== 'photos' || !/^https:\/\/www\.ebay\.com\/itm\/\d+$/.test(d.url || '')) return;
        (async () => {
          // photos fetched before answer at once, no eBay page visit
          const hit = (await get('photos2', {}))[d.url];
          if (hit && Date.now() - hit.at < 7 * 864e5) { reply(d.url, hit.imgs); return; }
          const i = queue.indexOf(d.url); if (i >= 0) queue.splice(i, 1);
          // the sale on screen goes first, then the ones right after it; ones you swiped past are dropped
          if ((d.ahead || 0) <= 0) queue.unshift(d.url); else queue.push(d.url);
          if (queue.length > 4) queue.length = 4;
          pump();
        })();
      });
    }
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
  const onSearch = () => isTcg && location.pathname.startsWith('/search/');
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
  async function readTcgPage() {
    await waitFor('.price-guide__points', 15000);
    await waitFor('.listing-item', 8000);
    await waitFor('.price-guide__latest-sales .modal__activator', 6000);
    await sleep(600);
    const rowVal = (root, label) => { for (const tr of (root || document).querySelectorAll('tr')) { const td = tr.querySelectorAll('td'); if (td.length >= 2 && txt(td[0]).startsWith(label)) return num(txt(td[1])); } return null; };
    const pts = document.querySelector('.price-guide__points-container') || document;
    const bodyT = document.body.innerText || '';
    const nm = bodyT.match(/Card Number[^:]*:\s*([A-Za-z-]*\d+(?:\s*\/\s*[A-Za-z-]*\d+)?)/i);
    const h1 = txt(document.querySelector('h1'));
    const hn = h1.match(/(?:^|\s-\s)([A-Za-z]{0,4}\d{1,3}\/[A-Za-z]{0,4}\d{1,3})(?:\s|$)/); // Japanese pages: number only in the title
    const extra = { number: nm ? nm[1].replace(/\s/g, '') : (hn ? hn[1] : ''), title: h1, setName: h1.includes(' - ') ? h1.split(' - ').slice(1).join(' - ').replace(/\s*\([^)]*\)\s*$/, '') : '' };
    const out = { market: rowVal(pts, 'Market Price'), recent: rowVal(pts, 'Most Recent Sale'), condLabel: txt(document.querySelector('.price-guide__points-condition')), sales: [], listings: [], ...extra };
    // open the sales history snapshot (same as tapping "View More Data")
    let rowsEl = document.querySelector('.latest-sales-table__tbody tr');
    if (!rowsEl) {
      const btn = document.querySelector('.price-guide__latest-sales .modal__activator') || [...document.querySelectorAll('button, .modal__activator, a')].find(b => /View More Data/i.test(b.textContent || ''));
      if (btn) { btn.click(); rowsEl = await waitFor('.latest-sales-table__tbody tr', 8000); }
    }
    // signed in, the sales window can show more: press "Load more" a few times
    for (let i = 0; i < 6; i++) {
      const n0 = document.querySelectorAll('.latest-sales-table__tbody tr').length;
      const more = [...document.querySelectorAll('button, a')].find(b => /load more/i.test(b.textContent || '') && b.offsetParent);
      if (!more) break; more.click();
      const t0 = Date.now(); while (Date.now() - t0 < 4000 && document.querySelectorAll('.latest-sales-table__tbody tr').length === n0) await sleep(250);
      if (document.querySelectorAll('.latest-sales-table__tbody tr').length === n0) break;
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
    return out;
  }

  // TCGplayer only shows a short list of the latest sales for all conditions together. Filtering the page to one condition
  // (Condition=Lightly+Played in the address) shows that condition's own, longer history. So a full read visits each condition in turn.
  const CONDS = [['NM', 'Near Mint'], ['LP', 'Lightly Played'], ['MP', 'Moderately Played'], ['HP', 'Heavily Played'], ['DMG', 'Damaged']];
  const condOf = v => (CONDS.find(c => c[1].toLowerCase() === String(v || '').toLowerCase()) || [null])[0];
  const pidHere = () => (location.pathname.match(/\/product\/(\d+)/) || [])[1] || '';
  function condUrl(name) { const u = new URL(location.href); if (name) u.searchParams.set('Condition', name); else u.searchParams.delete('Condition'); return u.toString(); }
  async function readTcg() {
    const pid = pidHere(); const here = new URL(location.href).searchParams.get('Condition');
    let sw = await get('sweep', null);
    if (sw && (sw.pid !== pid || Date.now() - sw.at > 6 * 60 * 1000)) { sw = null; await set('sweep', null); }
    // part of a full read: add this condition, then go to the next one
    if (sw && here && condOf(here) === CONDS[sw.i][0]) {
      status('Reading all conditions: ' + CONDS[sw.i][0] + ' (' + (sw.i + 1) + '/' + CONDS.length + ')…');
      const out = await readTcgPage();
      sw.sales.push(...out.sales); sw.listings.push(...out.listings); sw.done.push(CONDS[sw.i][0]); sw.i++; sw.at = Date.now();
      if (sw.i < CONDS.length) { await set('sweep', sw); location.replace(condUrl(CONDS[sw.i][1])); return; }
      await set('sweep', null);
      const ok = await save({ ...sw.base, sales: sw.sales, listings: sw.listings, conds: sw.done });
      if (ok) status('Read all 5 conditions (' + sw.sales.length + ' sales) ✓ Sent to Card Scan');
      return;
    }
    // you filtered the page to one condition yourself: send just that condition (Card Scan keeps the others)
    if (here && condOf(here)) {
      status('Reading ' + here + ' only…');
      const out = await readTcgPage();
      if (!out.sales.length && !out.listings.length && out.market == null) { status('Couldn\'t find prices yet. Wait for the page to load, then tap Read this page.'); return; }
      await save({ ...out, conds: [condOf(here)] });
      return;
    }
    // the normal page: read it, then visit each condition
    status('Reading TCGplayer…');
    const base = await readTcgPage();
    if (!base.sales.length && !base.listings.length && base.market == null) { status('Couldn\'t find prices yet. Wait for the page to load, then tap Read this page.'); return; }
    const { sales, listings, ...info } = base;
    await set('sweep', { pid, i: 0, at: Date.now(), base: info, sales: [], listings: [], done: [] });
    status('Now reading each condition (NM, LP, MP, HP, DMG)…');
    location.replace(condUrl(CONDS[0][1]));
  }

  /* ---------- eBay reader ---------- */
  async function readEbay() {
    status('Reading eBay…');
    if (/captcha|splashui/i.test(location.href)) { status('eBay wants a human check. Do it, then tap Read this page.'); return; }
    await waitFor('li.s-card, li.s-item, ul.srp-results > li', 10000);
    const items = [];
    for (const li of document.querySelectorAll('li.s-card, li.s-item, ul.srp-results > li')) {
      const t = li.innerText || '';
      // eBay pads thin results with "Results matching fewer words": those aren't your card, so stop there
      if (/results matching fewer words|fewer words/i.test(t) && !li.querySelector('a[href*="/itm/"]')) break;
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
      items.push({ title, price, ship: /free (shipping|delivery)/i.test(t) ? 0 : (sm ? num(sm[1]) : 0), date: dm ? dm[1] : null, img: img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '', url: a ? a.href.split('?')[0] : '', bo: /best offer accepted/i.test(t), auction: /\d+\s+bids?\b/i.test(t) });
      if (items.length >= 60) break;
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

  const run = () => (onSearch() ? Promise.resolve(status('Tap your card in the results. I\'ll read it on its page.')) : isTcg ? readTcg() : readEbay()).catch(e => status('Error: ' + e.message));
  box.querySelector('[data-go]').onclick = run;

  // TCGplayer search page: open the result whose number matches the card (or the only result)
  async function pickResult(num) {
    await waitFor('.search-result, .blank-slate, .search-results__no-results', 12000); await sleep(1200);
    const res = [...document.querySelectorAll('.search-result')].map(el => ({ el, t: txt(el), a: el.querySelector('a[href*="/product/"]') })).filter(x => x.a);
    if (!res.length) return null;
    const norm = n => String(n || '').toUpperCase().replace(/^([A-Z-]*)0*(\d)/, '$1$2');
    if (num) { const want = norm(num); const hit = res.filter(x => (x.t.match(/#\s*([A-Za-z-]*\d+)/g) || []).some(h => norm(h.replace(/#\s*/, '')) === want));
      if (hit.length === 1) return hit[0].a.href; }
    return res.length === 1 ? res[0].a.href : null;
  }

  // Auto-read when this tab was opened from Card Scan in the last 15 minutes
  let readFor = '';
  async function autoRead() {
    const here = location.pathname;
    const p = await get('pending_' + source, null);
    const go = box.querySelector('[data-go]');
    if (go) go.style.display = '';
    if (!p || Date.now() - p.at > PENDING_MAX) { status('Chaundoo Scan: tap to read'); return; }
    if (onSearch()) {
      status('Looking for your card in these results…'); if (go) go.style.display = 'none';
      const pick = await pickResult(p.num);
      if (pick) { status('Found it, opening ' + (p.label || 'your card') + '…'); location.href = pick; return; }
      status('Tap your card in these results. I\'ll read it on its page' + (p.label ? ' (' + p.label + ')' : '') + '.'); return;
    }
    if (isTcg && p.productId && !here.includes('/product/' + p.productId)) { status('Different product than Card Scan picked. Tap to read anyway.'); return; }
    if (isTcg) { const sw = await get('sweep', null); if (sw && sw.pid === pidHere()) { if (go) go.style.display = 'none'; await sleep(1500); run(); return; } }
    if (readFor === here) return; readFor = here;
    status('Linked to ' + (p.label || 'card') + '…');
    await sleep(isTcg ? 2500 : 800);
    if (location.pathname !== here) return; // moved on while waiting
    run();
  }
  autoRead();
  // TCGplayer changes pages without reloading (tapping a search result), so watch the address
  if (isTcg) {
    let last = location.href;
    setInterval(() => { if (location.href !== last) { last = location.href; if (location.pathname.includes('/product/') || onSearch()) autoRead(); } }, 600);
  }
})();

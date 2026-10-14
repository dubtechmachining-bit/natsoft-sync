#!/usr/bin/env node
/**
 * Natsoft Formula Vee scraper (Playwright).
 *
 * Usage:
 *   node scrape.js --circuit "Winton" --date 2026-10-03 [--class "Formula Vee"] [--out ./out] [--headed]
 *
 * First run: use --headed so you can watch it. Every step saves a screenshot
 * and the page text into <out>/_discovery/ so the LABELS below can be tuned.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/* ---- Everything site-specific that you may need to tune ---- */
const LABELS = {
  home: 'http://racing.natsoft.com.au/results',
  categoryTitle: 'Circuit Racing',      // menu picture's title attribute
  sessionType: /qualif|race/i,          // session names to keep (within the class)
  skipSession: /practice|test/i,        // sessions to ignore
  lapChart: /lap\s*chart/i,
  lapTimes: /lap\s*times|all\s*laps|driver\s*laps|laps\b/i,
  results: /results?|classification|final/i,
};
const STEP_WAIT = 2500; // ms to let the Natsoft JS app settle after a click

/* ---- args ---- */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const circuit = arg('circuit');
const dateStr = arg('date');
const klass = arg('class', 'Formula Vee');
const eventFilter = arg('event', '');            // optional, e.g. --event VMRC
const outDir = path.resolve(arg('out', './out'));
const headed = !!arg('headed', false);
const homeUrl = arg('url', LABELS.home);          // e.g. --url http://racing.natsoft.com.au/results
const useChrome = !!arg('chrome', false);          // use your installed Google Chrome instead of bundled Chromium
if (!circuit || !dateStr) { console.error('Need --circuit and --date YYYY-MM-DD'); process.exit(1); }

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slug = s => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function dateVariants(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mon = dt.toLocaleString('en-AU', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  const monL = dt.toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' });
  const dow = dt.toLocaleString('en-AU', { weekday: 'short', timeZone: 'UTC' });
  const dd = String(d).padStart(2, '0'), mm = String(m).padStart(2, '0');
  return [
    `${dow} ${mon} ${dd}`, `${mon} ${dd}`, `${dd} ${mon} ${y}`, `${d} ${mon} ${y}`,
    `${d} ${monL} ${y}`, `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${iso}`, `${dd} ${mon}`, `${d} ${mon}`,
  ];
}
const dateRe = new RegExp(dateVariants(dateStr).map(esc).join('|'), 'i');

fs.mkdirSync(path.join(outDir, '_discovery'), { recursive: true });
let snapN = 0;
async function snap(page, label) {
  const base = path.join(outDir, '_discovery', `${String(++snapN).padStart(2, '0')}-${slug(label)}`);
  await page.screenshot({ path: base + '.png' }).catch(e => console.warn('  [screenshot failed]', e.message.split('\n')[0]));
  const txt = await pageText(page);
  fs.writeFileSync(base + '.txt', txt);
  const frames = page.frames();
  let html = `<!-- url: ${page.url()}  frames: ${frames.length} -->\n`;
  for (const f of frames) {
    html += `\n<!-- FRAME ${f.url()} -->\n` + (await f.content().catch(() => '(could not read frame)'));
  }
  fs.writeFileSync(base + '.html', html);
  console.log(`  [snap] ${label}  (url: ${page.url()}, frames: ${frames.length}, text chars: ${txt.length}, html chars: ${html.length})`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Text of the current view: prefers <pre> blocks (Natsoft reports), searches all frames. */
async function pageText(page) {
  for (const f of page.frames()) {
    const pres = await f.$$eval('pre', els => els.map(e => e.innerText)).catch(() => []);
    if (pres.length) return pres.join('\n');
  }
  const parts = [];
  for (const f of page.frames()) parts.push(await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => ''));
  return parts.join('\n');
}
async function reportText(page) {
  // Full report incl. header (title block is in a table above the <pre>s)
  const parts = [];
  for (const f of page.frames()) {
    const t = await f.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (/natsoft|lap|pos/i.test(t) && t.length > 200) parts.push(t);
  }
  return (parts.sort((a, b) => b.length - a.length)[0] || await pageText(page)).replace(/\r?\n/g, '\r\n');
}

/** Click first visible element (in any frame) whose text matches. */
async function clickText(page, re, { nth = 0 } = {}) {
  // Only consider VISIBLE matches (Natsoft keeps hidden leftovers from earlier screens in the page)
  for (const f of page.frames()) {
    const loc = f.getByText(re);
    const n = await loc.count().catch(() => 0);
    let seen = 0;
    for (let i = 0; i < n; i++) {
      const item = loc.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      if (seen++ < nth) continue;
      await item.click({ timeout: 8000 });
      await sleep(STEP_WAIT);
      return true;
    }
  }
  return false;
}
/** Click an image/button by its title attribute (Natsoft menu items are <img title="...">). */
async function clickTitle(page, title) {
  for (const f of page.frames()) {
    const loc = f.locator(`[title="${title}"]`).first();
    if (await loc.count().catch(() => 0)) { await loc.click({ timeout: 8000 }); await sleep(STEP_WAIT); return true; }
  }
  return false;
}
async function listTexts(page, re) {
  const out = [];
  for (const f of page.frames()) {
    const loc = f.getByText(re);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      if (!(await loc.nth(i).isVisible().catch(() => false))) continue;
      const t = (await loc.nth(i).innerText().catch(() => '')).trim().split('\n')[0];
      if (t) out.push(t);
    }
  }
  return [...new Set(out)];
}

/** dd/mm/yyyy strings for date and +/-3 days, closest first (list shows the meeting's last day). */
function listDates(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const out = [];
  for (const off of [0, 1, -1, 2, -2, 3, -3]) {
    const dt = new Date(Date.UTC(y, m - 1, d + off));
    out.push(`${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`);
  }
  return out;
}

/** Find the meeting row (same line as a blue "View" link) matching circuit + date, and click View. */
async function clickRound(page) {
  const dates = listDates(dateStr);
  for (const f of page.frames()) {
    const res = await f.evaluate(({ circuit, dates, ev }) => {
      const leaves = [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0 && (e.textContent || '').trim())
        .map(e => ({ e, t: e.textContent.trim(), r: e.getBoundingClientRect() }))
        .filter(x => x.r.height > 0);
      const rows = [];
      for (const v of leaves.filter(x => x.t === 'View')) {
        // Method 1: largest ancestor that contains exactly this one View link
        let a = v.e.parentElement, best = null;
        while (a && a !== document.body) {
          const n = [...a.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === 'View').length;
          if (n !== 1) break;
          best = a; a = a.parentElement;
        }
        const t1 = best ? best.innerText.replace(/\s*\n\s*/g, ' | ').trim() : '';
        // Method 2: every text cell vertically overlapping the View link
        const vc = (v.r.top + v.r.bottom) / 2;
        const cells = leaves.filter(x => x.r.top - 3 <= vc && x.r.bottom + 3 >= vc && x.r.height < 80);
        cells.sort((p, q) => p.r.left - q.r.left);
        const t2 = cells.map(c => c.t).join(' | ');
        rows.push({ view: v.e, text: t1.length >= t2.length ? t1 : t2 });
      }
      const low = s => s.toLowerCase();
      const cands = rows.filter(r => low(r.text).includes(low(circuit)));
      return { rows: rows.length, sample: rows.slice(0, 4).map(r => r.text), cands, all: cands.map(c => c.text), pick: (() => {
        for (let i = 0; i < dates.length; i++) {
          let m = cands.filter(c => c.text.includes(dates[i]));
          if (ev) m = m.filter(c => low(c.text).includes(low(ev)));
          else { const nm = m.filter(c => !/trackschool|pit lane|test day|open day/i.test(c.text)); if (nm.length) m = nm; }
          if (m.length) { m[0].view.setAttribute('data-nfv-target', '1'); return { text: m[0].text, dateUsed: dates[i], matches: m.map(x => x.text) }; }
        }
        return null;
      })() };
    }, { circuit, dates, ev: eventFilter }).catch(() => null);
    if (!res || !res.rows) continue;
    console.log('  Sample rows read:\n   - ' + res.sample.join('\n   - '));
    console.log(`  Found ${res.rows} meeting rows; ${res.all.length} mention "${circuit}"`);
    if (!res.pick) { console.warn('  Rows for this circuit:\n   - ' + res.all.slice(0, 15).join('\n   - ')); return false; }
    if (res.pick.matches.length > 1) console.warn('  Several rows matched; using the first. Use --event "name" to choose:\n   - ' + res.pick.matches.join('\n   - '));
    console.log(`  Using: ${res.pick.text}  (list date ${res.pick.dateUsed})`);
    await f.locator('[data-nfv-target="1"]').first().click({ timeout: 8000 });
    await sleep(STEP_WAIT);
    return true;
  }
  return false;
}

/** On the meeting page: find this class's qualifying/race rows and tag their Result/Times/Chart links. */
async function tagSessions(page) {
  for (const f of page.frames()) {
    const res = await f.evaluate(({ klass }) => {
      const leaves = [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0 && e.textContent.trim())
        .map(e => ({ e, t: e.textContent.trim(), r: e.getBoundingClientRect() }))
        .filter(x => x.r.width > 0 && x.r.height > 0);
      const re = new RegExp(klass, 'i');
      const out = [];
      for (const s of leaves) {
        if (!re.test(s.t) || !/qualif|race/i.test(s.t) || /practice|warm\s*up|test/i.test(s.t)) continue;
        const vc = (s.r.top + s.r.bottom) / 2;
        const row = leaves.filter(x => x.r.top - 3 <= vc && x.r.bottom + 3 >= vc && x.r.height < 80)
                          .sort((a, b) => a.r.left - b.r.left);
        const info = { name: s.t, left: row.filter(x => x.r.left < s.r.left).map(x => x.t).join(' '), has: {}, counts: {} };
        const idx = out.length;
        const mkey = info.left.match(/\b[A-Z]\d+\b/);
        const key = mkey ? mkey[0] : 'S' + idx;      // session code (Q4, R3, R8...) is stable; position is not
        info.key = key;
        const right = row.filter(x => x.r.left > s.r.left);
        for (const [k, w] of [['result', 'Result'], ['times', 'Times'], ['chart', 'Chart']]) {
          const i = right.findIndex(x => x.t === w);
          if (i < 0) continue;
          right[i].e.setAttribute('data-nfv', key + ':' + k);
          info.has[k] = true;
          if (right[i + 1]) { right[i + 1].e.setAttribute('data-nfv-n', key + ':' + k); info.counts[k] = right[i + 1].t; }
        }
        out.push(info);
      }
      return out;
    }, { klass: esc(klass) }).catch(() => []);
    if (res.length) return { frame: f, sessions: res };
  }
  return { frame: null, sessions: [] };
}

const alnum = t => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Click a link; Natsoft opens the report in a new window. Natsoft sometimes shows the PREVIOUS
 * report first, so wait until the header mentions the expected session, retrying if it never does.
 */
async function openAndRead(page, getLoc, expect) {
  const ctx = page.context();
  const want = alnum(expect);
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const popupP = ctx.waitForEvent('page', { timeout: 7000 }).catch(() => null);
    const loc = await getLoc();
    await loc.click({ timeout: 8000 });
    const pop = await popupP;
    if (!pop) return last;
    await pop.waitForLoadState('domcontentloaded').catch(() => {});
    let text = '';
    for (let i = 0; i < 24; i++) {                       // up to ~12s for the right report to appear
      text = await pop.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
      if (text.trim().length > 150 && alnum(text).includes(want)) break;
      await sleep(500);
    }
    const url = pop.url();
    await pop.close().catch(() => {});
    last = { text, url, verified: alnum(text).includes(want) };
    if (last.verified) return last;
    console.log(`  report did not match "${expect}" (attempt ${attempt}/3), retrying...`);
    await sleep(2000);
  }
  return last;
}

/** home -> Circuit Racing -> round -> class. Leaves the page on the session list. */
async function openSessionList(page, log) {
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const loaded = await page.waitForSelector('#LoadingPage', { state: 'hidden', timeout: 60000 }).then(() => true).catch(() => false);
  console.log(loaded ? '  Natsoft app finished loading' : '  WARNING: Natsoft app still showing the loading screen after 60s');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(STEP_WAIT);
  if (log) await snap(page, 'home');

  if (!(await clickTitle(page, LABELS.categoryTitle))) throw new Error('Could not find "Circuit Racing". See _discovery/01-home.*');
  if (log) await snap(page, 'circuit-racing');

  if (!(await clickRound(page))) {
    throw new Error('Could not find the round. Check the rows printed above, and _discovery/02-circuit-racing.txt.');
  }
  if (log) await snap(page, 'round');

  // The meeting page lists every session; Formula Vee rows are picked out by tagSessions().
}

(async () => {
  const browser = await chromium.launch({
    headless: !headed,
    ...(useChrome ? { channel: 'chrome' } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) console.log('  [browser ' + m.type() + ']', m.text().slice(0, 200)); });
  page.on('pageerror', e => console.log('  [page error]', String(e).slice(0, 200)));
  page.on('requestfailed', r => console.log('  [request failed]', r.url().slice(0, 150), r.failure() && r.failure().errorText));
  const folder = path.join(outDir, slug(`${circuit}-${dateStr}`));
  fs.mkdirSync(folder, { recursive: true });

  try {
    await openSessionList(page, true);

    let { frame, sessions } = await tagSessions(page);
    console.log(`Found ${sessions.length} "${klass}" qualifying/race sessions:`);
    sessions.forEach((x, i) => console.log(`  ${i + 1}. ${x.left} | ${x.name}  [${Object.keys(x.has).join(', ')}]`));
    if (!sessions.length) throw new Error(`No "${klass}" qualifying/race rows found on the meeting page. See _discovery/03-round.*`);

    const KINDS = [['result', 'results'], ['times', 'lap-times'], ['chart', 'lap-chart']];
    for (let i = 0; i < sessions.length; i++) {
      const x = sessions[i];
      const code = x.key;
      const pcode = code.replace(/^([A-Z])(\d)$/, '$10$2');   // R3 -> R03 so files sort in order
      const base = `${pcode}-${slug(x.name)}`;
      console.log(`\n[${i + 1}/${sessions.length}] ${code} ${x.name}`);
      for (const [k, label] of KINDS) {
        if (!x.has[k]) { console.log(`  (no ${label} link for this session)`); continue; }
        // Natsoft redraws the page after each report opens, so re-tag the links before every click
        const getLoc = (attr) => async () => {
          const sel = `[${attr}="${x.key}:${k}"]`;
          let fresh = await tagSessions(page);
          if (fresh.frame) frame = fresh.frame;
          // Scroll the row into view FIRST and let Natsoft finish redrawing, then find it again
          await frame.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
          await sleep(1200);
          fresh = await tagSessions(page);
          if (fresh.frame) frame = fresh.frame;
          if (!(await frame.locator(sel).count().catch(() => 0))) {
            console.log(`  could not see ${x.key}:${k}. Sessions visible now: ` + fresh.sessions.map(z => `${z.key}[${Object.keys(z.has).join(',')}]`).join('  '));
          }
          return frame.locator(sel).first();
        };
        let got = await openAndRead(page, getLoc('data-nfv'), x.name);
        if (!got && x.counts[k]) got = await openAndRead(page, getLoc('data-nfv-n'), x.name);
        if (!got) {
          await snap(page, `${base}-${k}-no-window`);
          throw new Error(`Clicking ${label} for ${code} did not open a new window. The page may have changed in place; see _discovery for the latest snapshot.`);
        }
        const file = path.join(folder, `${base}-${label}${got.verified ? '' : '-UNVERIFIED'}.txt`);
        fs.writeFileSync(file, got.text.replace(/\r?\n/g, '\r\n'));
        const title = got.text.split(/\r?\n/).map(t => t.trim()).filter(Boolean).slice(0, 4).join(' / ');
        console.log(`  saved ${label}${got.verified ? '' : '  *** UNVERIFIED ***'}  (${got.text.length} chars)  [${title.slice(0, 110)}]`);
        await sleep(600);
      }
    }
    console.log(`\nDone. Files in ${folder}`);
  } catch (e) {
    console.error('\nSTOPPED:', e.message);
    await snap(page, 'error-state').catch(() => {});
    console.error(`Discovery files are in ${path.join(outDir, '_discovery')}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

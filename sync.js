#!/usr/bin/env node
/**
 * Asks your WordPress site which rounds are due, scrapes Natsoft for each one,
 * and uploads the .txt files back to WordPress.
 *
 *   WP_URL=https://yoursite.com WP_TOKEN=xxxx node sync.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WP_URL = (process.env.WP_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.WP_TOKEN || '';
if (!WP_URL || !TOKEN) { console.error('Set WP_URL and WP_TOKEN.'); process.exit(1); }

const api = (route, opts = {}) => fetch(`${WP_URL}/?rest_route=/natsoft/v1/${route}`, {
  ...opts,
  headers: { 'X-Natsoft-Token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

(async () => {
  let failed = false;
  const res = await api('pending');
  if (!res.ok) { console.error(`Could not read pending rounds: HTTP ${res.status}\n${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const { today, rounds } = await res.json();
  console.log(`Site date ${today}. Rounds due for checking: ${rounds.length}`);

  for (const r of rounds) {
    console.log(`\n=== Round ${r.id}: ${r.circuit} ${r.start}${r.end !== r.start ? ' to ' + r.end : ''} ${r.event || ''}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsoft-'));
    const args = ['scrape.js', '--circuit', r.circuit, '--date', r.end || r.start, '--class', r.class || 'Formula Vee', '--out', tmp];
    if (r.event) args.push('--event', r.event);
    spawnSync('node', args, { cwd: __dirname, stdio: 'inherit' });

    // The scraper writes into <tmp>/<circuit-date>/ (ignore the _discovery folder)
    const dir = fs.readdirSync(tmp).map(d => path.join(tmp, d)).find(d => !path.basename(d).startsWith('_') && fs.statSync(d).isDirectory());
    const files = dir
      ? fs.readdirSync(dir).filter(f => f.endsWith('.txt') && !/UNVERIFIED/i.test(f)).sort()
          .map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
      : [];
    console.log(`Collected ${files.length} verified file(s) for round ${r.id}.`);

    const up = await api('upload', { method: 'POST', body: JSON.stringify({ round_id: r.id, files }) });
    const body = await up.text();
    if (!up.ok) { failed = true; console.error(`Upload failed (HTTP ${up.status}): ${body.slice(0, 300)}`); }
    else console.log(`Uploaded: ${body}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

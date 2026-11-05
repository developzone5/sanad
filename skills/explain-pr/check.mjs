#!/usr/bin/env node
// check.mjs — click through a rendered walkthrough in headless Chrome, at laptop and phone size, with real mouse
// clicks. Fails on a script error, a click that does not move to the next slide, a code-walk step or a station
// that does not bring its code into view, or a page wider than the screen.
// Usage: node check.mjs <page.html>      (Chrome or Edge from the usual install paths, or set CHROME=<path>)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node check.mjs <page.html>'); process.exit(2); }
const candidates = [process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = candidates.find((c) => c && fs.existsSync(c));
if (!chrome) { console.error('NOT RUN: no Chrome or Edge found (set CHROME=<path>).'); process.exit(3); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-pr-check-'));
// SwiftShader gives headless Chrome a software WebGL, so the 3D journey really runs here too.
const proc = spawn(chrome, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', '--remote-allow-origins=*', '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
  proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } });
});
const finish = (code) => { try { proc.kill(); } catch { /* already gone */ } setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ } process.exit(code); }, 300); };

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const waiting = new Map(), errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function click(selector) {
  const r = await evaluate(`(() => { const e = ${selector}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (hit === e || e.contains(hit)) }; })()`);
  if (!r) return 'missing';
  if (!r.ok) return 'covered';
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(60);
  return 'ok';
}
const wide = () => evaluate('Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, innerWidth - Math.round(visualViewport ? visualViewport.width : innerWidth))');

const problems = [];
let slides = 0;
const url = 'file:///' + path.resolve(file).split(path.sep).join('/');
const pageLang = () => evaluate('document.documentElement.lang + "/" + document.documentElement.dir');
await send('Runtime.enable');
// Each size is walked twice: in the page's default language, then after the language button (the choice must
// survive a reload, and the direction must follow the language).
for (const [label0, w, h, mobile, switchLang] of [['laptop', 1440, 900, false, false], ['laptop', 1440, 900, false, true], ['phone', 390, 844, true, false], ['phone', 390, 844, true, true]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send('Page.navigate', { url: url + '#0' });
  await sleep(500);
  if (!switchLang && label0 === 'laptop') {
    const first = await pageLang();
    if (!/^(ar\/rtl|en\/ltr)$/.test(first)) problems.push(`default language/direction is "${first}"`);
  }
  if (switchLang) {
    const before = await pageLang();
    const c = await click(`document.getElementById('lang')`);
    await send('Page.navigate', { url: url + '#0' });
    await sleep(500);
    const after = await pageLang();
    if (c !== 'ok' || after === before || !/^(ar\/rtl|en\/ltr)$/.test(after)) problems.push(`${label0}: language button ${c}: ${before} → ${after} after a reload`);
  }
  const label = `${label0} ${(await pageLang()).split('/')[0]}`;
  for (let n = 0; n < 200; n++) {
    const where = await evaluate(`document.getElementById('where')?.textContent || location.hash`);
    if ((await wide()) > 0) problems.push(`${label}: page wider than the screen at "${where}"`);
    // A case picked under the 3D view is sent through it; a quiz answer shows right or wrong.
    if (await evaluate(`!!document.querySelector('.casechip:not([aria-pressed="true"])')`)) {
      const c = await click(`document.querySelector('.casechip:not([aria-pressed="true"])')`);
      const on = await evaluate(`document.querySelectorAll('.casechip[aria-pressed="true"]').length`);
      if (c !== 'ok' || on !== 1) problems.push(`${label}: case button ${c}, ${on} selected at "${where}"`);
    }
    if (await evaluate(`!!document.querySelector('.qopt:not(:disabled)')`)) {
      const c = await click(`document.querySelector('.qopt:not(:disabled)')`);
      const shown = await evaluate(`(() => { const a = document.querySelector('.qans'); return !!a && !a.hidden && a.textContent.length > 0; })()`);
      if (c !== 'ok' || !shown) problems.push(`${label}: quiz answer ${c}, feedback ${shown ? 'shown' : 'missing'} at "${where}"`);
    }
    // The code walk: a step button and a station that opens its code each bring that step's card into view.
    const stepShown = `(() => { const a = document.activeElement; if (!a || !a.classList.contains('wstep')) return 'not focused'; const b = a.getBoundingClientRect(); return b.top < innerHeight && b.bottom > 0 ? 'ok' : 'off screen'; })()`;
    if (await evaluate(`!!document.querySelector('.wnav .wbtn')`)) {
      const c = await click(`[...document.querySelectorAll('.wnav .wbtn')].pop()`);
      await sleep(900);
      const shown = await evaluate(stepShown);
      if (c !== 'ok' || shown !== 'ok') problems.push(`${label}: walk step button ${c}, step ${shown} at "${where}"`);
    }
    if (await evaluate(`!!document.querySelector('.lbl3d.go, .flat .st.go')`)) {
      await evaluate(`scrollTo(0, 0)`);
      await sleep(200);
      const c = await click(`document.querySelector('.lbl3d.go, .flat .st.go')`);
      await sleep(900);
      const shown = await evaluate(stepShown);
      if (c !== 'ok' || shown !== 'ok') problems.push(`${label}: station → code ${c}, step ${shown} at "${where}"`);
    }
    if (await evaluate(`!!document.querySelector('.seg .old')`)) {
      const a = await click(`document.querySelector('.seg .old')`), b = await click(`document.querySelector('.seg button:not(.old)')`);
      if (a !== 'ok' || b !== 'ok') problems.push(`${label}: Old/New switch ${a}/${b} at "${where}"`);
    }
    if (await evaluate(`document.getElementById('next').disabled`)) break;
    const before = await evaluate('location.hash');
    const c = await click(`document.getElementById('next')`);
    if (c !== 'ok' || (await evaluate('location.hash')) === before) { problems.push(`${label}: Next did not move (${c}) at "${where}"`); break; }
    if (label0 === 'laptop' && !switchLang) slides++;
  }
  // Leave the next walk in the default language.
  if (switchLang) await click(`document.getElementById('lang')`);
}
errors.forEach((e) => problems.push('script error: ' + e));
ws.close();
if (problems.length) { console.log('FAIL\n- ' + [...new Set(problems)].join('\n- ')); finish(1); }
else { console.log(`PASS: clicked through ${slides + 1} slides in both languages at laptop and phone size; no script errors, no sideways scroll.`); finish(0); }

#!/usr/bin/env node
// browser-check.mjs — each page a change touches, opened in a real browser before the owner's own check.
//
// 2026-11-25 (owner, batch x task 2): a page change reached the owner unopened, and the owner found by hand what a
// browser run shows in a minute: a console error, a failed request, a missing text, the wrong role's view. This tool
// opens each page of the task's plan once per role and once per language the ticket names, and records: the page
// loaded; the console errors; the failed requests; and for each ticket line that names something visible, whether it
// was seen. One screenshot per page, role and language goes to <notes>/browser/. It prints a short table for the final
// report. No guard reads its result.
//
// The browser tool belongs to Sanad, never to the project (owner's words, 2026-11-25: "Sanad keeps its own copy in its
// own folder and drives the Edge or Chrome already on this PC. Nothing is added to any project."). `setup` installs
// playwright-core, pinned, once in Sanad's own folder (~/.claude/tools/browser-check; SANAD_BROWSER_TOOL_DIR in tests);
// it drives the installed Edge, else Chrome (channel msedge / chrome), and downloads no browser. On a PC without that
// install, or without Edge and Chrome, the run prints one line, `BROWSER CHECK: NOT DONE — …`, exits 3, and the step is
// not done.
//
// Where the test accounts come from: the site file, outside every repository and outside the notes folder. The site
// file is `--site <file>`, else `git config sanad.browserSite`, else ~/.claude/state/browser-sites/<repository folder
// name>.json. It holds the sign-in steps, how a language is chosen, and one account per role:
//   { "url": "http://localhost:3000",   (the one address the accounts belong to: no password is typed anywhere else)
//     "login": { "path": "/login", "user": "#login-email", "password": "#login-password", "submit": "button[type=submit]" },
//     "language": { "localStorage": { "ui-storage": "{\"state\":{\"language\":\"{lang}\"},\"version\":0}" } },
//     "accounts": { "Teacher": { "user": "teacher@example.test", "passwordEnv": "EQ_TEACHER_PASSWORD" } } }
// A role's password is `passwordEnv` (an environment variable, preferred) or `password`. No password is ever written
// to the notes, the table, the report or the screenshots' names; the table names the role only.
//
// The task's plan is <notes>/browser-plan.json, written by the builder from the ticket:
//   { "url": "http://localhost:3000", "pages": ["/settings"], "roles": ["Teacher", "Admin"], "languages": ["ar", "en"],
//     "lines": [{ "id": "T1", "see": { "ar": ["معلم"], "en": ["Teacher"] }, "pages": ["/settings"], "roles": ["Teacher"] }] }
// `see` is a list of texts (any language) or one list per language. `pages` and `roles` on a line limit where it is
// looked for (default: every page and role of the plan).
//
// Usage: node browser-check.mjs setup
//        node browser-check.mjs run --notes <dir> [--plan <file>] [--site <file>] [--repo <path>] [--url <base url>]
//        node browser-check.mjs status
// Exit 0: every row passed. 1: a row failed (fix it, or write it as a note with the reason; never leave it out of the
// report). 2: a usage error (a bad plan or site file). 3: NOT DONE (no browser tool or no browser on this PC).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const PLAYWRIGHT_VERSION = '1.65.0';
export const toolDir = (env = process.env) => env.SANAD_BROWSER_TOOL_DIR || path.join(os.homedir(), '.claude', 'tools', 'browser-check');
class UsageError extends Error {}
const usage = (m) => new UsageError(m);
const slash = (p) => String(p).replace(/\\/g, '/');

// ---- the plan and the site file ------------------------------------------------------------------------------

const LANG = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
export function readPlan(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw usage('the plan is not valid JSON'); }
  const out = [];
  if (!p || typeof p !== 'object') throw usage('the plan is not an object');
  if (p.url !== undefined && !/^https?:\/\/[^\s]+$/.test(String(p.url))) out.push('url is an http(s) address');
  if (!Array.isArray(p.pages) || !p.pages.length || !p.pages.every((x) => typeof x === 'string' && x.startsWith('/'))) out.push('pages is a list of paths that start with /');
  if (!Array.isArray(p.roles) || !p.roles.length || !p.roles.every((x) => typeof x === 'string' && x.trim())) out.push('roles is a list of role names from the ticket');
  const langs = p.languages === undefined ? [''] : p.languages;
  if (!Array.isArray(langs) || !langs.length || !langs.every((x) => x === '' || LANG.test(String(x)))) out.push('languages is a list of language codes (ar, en)');
  const lines = p.lines === undefined ? [] : p.lines;
  if (!Array.isArray(lines)) out.push('lines is a list');
  else for (const [i, l] of lines.entries()) {
    const at = `line ${l && l.id ? l.id : i + 1}`;
    if (!l || !/^T\d+$/.test(String(l.id || ''))) { out.push(`${at}: id is the ticket line's T<n>`); continue; }
    const see = l.see;
    const okList = (v) => Array.isArray(v) && v.length && v.every((s) => typeof s === 'string' && s.trim());
    if (!(okList(see) || (see && typeof see === 'object' && !Array.isArray(see) && Object.values(see).length && Object.values(see).every(okList)))) out.push(`${at}: see is a list of texts, or one list per language`);
    // Review round (2026-11-25): a line with texts for one language only was never looked for in the others, and its
    // rows passed. One list per language must name every language of the plan.
    else if (!Array.isArray(see)) {
      const missing = (Array.isArray(langs) ? langs : []).filter((g) => !Object.prototype.hasOwnProperty.call(see, g));
      if (missing.length) out.push(`${at}: see has no texts for ${missing.map((g) => g || 'the plan without languages').join(', ')}: give a list for every language of the plan, or one list for all`);
    }
    if (l.pages !== undefined && !(Array.isArray(l.pages) && l.pages.length && l.pages.every((x) => p.pages && p.pages.includes(x)))) out.push(`${at}: its pages are pages of the plan`);
    if (l.roles !== undefined && !(Array.isArray(l.roles) && l.roles.length && l.roles.every((x) => p.roles && p.roles.includes(x)))) out.push(`${at}: its roles are roles of the plan`);
  }
  if (out.length) throw usage(`the plan: ${out.join('; ')}`);
  return { url: p.url ? String(p.url).replace(/\/+$/, '') : '', pages: p.pages, roles: p.roles, languages: langs, lines };
}
export function readSite(text, roles, env = process.env) {
  let s;
  try { s = JSON.parse(text); } catch { throw usage('the site file is not valid JSON'); }
  const out = [];
  const l = s && s.login;
  if (!l || typeof l.path !== 'string' || !l.path.startsWith('/') || !['user', 'password', 'submit'].every((k) => typeof l[k] === 'string' && l[k])) out.push('login holds path, user, password and submit (CSS selectors)');
  const accounts = (s && s.accounts) || {};
  for (const r of roles) {
    const a = accounts[r];
    if (!a || typeof a.user !== 'string' || !a.user) { out.push(`no account for the role ${r}`); continue; }
    if (a.passwordEnv !== undefined ? !env[a.passwordEnv] : typeof a.password !== 'string' || !a.password) out.push(`the role ${r} has no password (${a.passwordEnv ? `the variable ${a.passwordEnv} is empty` : 'password or passwordEnv'})`);
  }
  if (s && s.language !== undefined && !(s.language.localStorage && typeof s.language.localStorage === 'object')) out.push('language holds localStorage: { key: value with {lang} }');
  // Review round (2026-11-25): the plan's address decided where the saved passwords were typed. The site file names
  // the one address its accounts belong to; a run on any other address types no password.
  if (!s || !/^https?:\/\/[^\s/]+/.test(String(s.url || ''))) out.push('url is the address the accounts belong to (http://localhost:3000): no password is typed anywhere else');
  if (out.length) throw usage(`the site file: ${out.join('; ')}`);
  const secret = (r) => (accounts[r].passwordEnv !== undefined ? env[accounts[r].passwordEnv] : accounts[r].password);
  return { login: l, language: s.language || null, user: (r) => accounts[r].user, secret, url: s.url ? String(s.url).replace(/\/+$/, '') : '' };
}
export function siteFile(repo, given, env = process.env) {
  if (given) return path.resolve(given);
  let configured = '';
  try { configured = execFileSync('git', ['-C', repo, 'config', '--get', 'sanad.browserSite'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { configured = ''; }
  if (configured) return path.resolve(configured);
  let top = repo;
  try { top = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().replace(/[\\/]\.git$/, ''); } catch { /* the folder itself */ }
  const state = env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
  return path.join(state, 'browser-sites', `${path.basename(top)}.json`);
}

// ---- the rows ------------------------------------------------------------------------------------------------

// One row per page, role and language, in plan order.
export function rowsOf(plan) {
  const rows = [];
  for (const page of plan.pages) for (const role of plan.roles) for (const lang of plan.languages) rows.push({ page, role, lang });
  return rows;
}
// The texts a row must show: per line, the texts for that row's language.
export function textsFor(plan, row) {
  const out = [];
  for (const l of plan.lines) {
    if (l.pages && !l.pages.includes(row.page)) continue;
    if (l.roles && !l.roles.includes(row.role)) continue;
    const texts = Array.isArray(l.see) ? l.see : row.lang && l.see[row.lang] ? l.see[row.lang] : null;
    if (texts) out.push({ id: l.id, texts });
  }
  return out;
}
const safe = (s) => String(s || 'all').replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'root';
// A short hash of the page keeps two pages apart that read the same once cleaned (/a/b and /a-b, review round).
const tag = (s) => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0; return h.toString(16).padStart(8, '0').slice(0, 6); };
export const shotName = (row) => `${safe(row.page)}-${tag(row.page)}-${safe(row.role)}${row.lang ? '-' + safe(row.lang) : ''}.png`;
// A row passes when the page loaded, no console error, no failed request, every ticket line was seen, and its
// screenshot was saved (review round: a failed capture left a passing row with a path to nothing).
export const rowPassed = (r) => r.loaded && !r.consoleErrors.length && !r.failedRequests.length && r.lines.every((l) => l.seen) && Boolean(r.screenshot);
// Every saved password, hidden in a text the run records (a page that logs or sends it, review round).
export function redact(text, secrets) {
  let s = String(text);
  for (const x of secrets) if (x && String(x).length >= 3) s = s.split(String(x)).join('[hidden]');
  return s;
}
// The path of an address, without a trailing slash, its query or its fragment.
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') || '/'; } catch { return ''; } };

// The short table for the final report. A password never reaches it: the row holds the role, never the account.
export function tableText(results) {
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 120);
  const out = ['| page | role | language | loaded | console errors | failed requests | ticket lines seen | screenshot |', '|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    const lines = r.lines.length ? r.lines.map((l) => `${l.id} ${l.seen ? '✓' : '✗ ' + cell(l.missing.join(', '))}`).join(' · ') : '–';
    out.push(`| ${cell(r.page)} | ${cell(r.role)} | ${r.lang || '–'} | ${r.loaded ? '✓' : '✗ ' + cell(r.why || '')} | ${r.consoleErrors.length ? `${r.consoleErrors.length}: ${cell(r.consoleErrors[0])}` : '0'} | ${r.failedRequests.length ? `${r.failedRequests.length}: ${cell(r.failedRequests[0])}` : '0'} | ${lines} | ${slash(r.screenshot || '–')} |`);
  }
  const failed = results.filter((r) => !rowPassed(r)).length;
  out.push('', `BROWSER CHECK: ${results.length} row(s), ${failed} failed${failed ? ' — fix each failed row, or write it as a note with the reason; it stays in the report' : ''}`);
  return out.join('\n') + '\n';
}

// ---- the browser ---------------------------------------------------------------------------------------------

// playwright-core from Sanad's own folder, or null with the reason.
export function loadPlaywright(env = process.env) {
  const dir = toolDir(env);
  try { return { pw: createRequire(path.join(dir, 'package.json'))('playwright-core'), dir }; } catch {
    return { pw: null, dir, why: `no browser tool in Sanad's folder ${slash(dir)} — run: node ${slash(fileURLToPath(import.meta.url))} setup` };
  }
}
// The installed Edge, else Chrome. Never a downloaded browser.
export async function launch(pw, channels = ['msedge', 'chrome']) {
  const tried = [];
  for (const channel of channels) {
    try { return { browser: await pw.chromium.launch({ channel, headless: true }), channel }; } catch (e) { tried.push(`${channel}: ${String(e.message).split('\n')[0]}`); }
  }
  return { browser: null, why: `no Edge or Chrome could start on this PC (${tried.join('; ')})` };
}

const SAME = (base, u) => { try { return new URL(u).origin === new URL(base).origin; } catch { return false; } };
// One row in a fresh context: sign in as the role, set the language, open the page, record.
async function checkRow(browser, base, site, plan, row, shotDir, timeoutMs) {
  const r = { ...row, loaded: false, why: '', consoleErrors: [], failedRequests: [], lines: [], screenshot: '' };
  const context = await browser.newContext({ locale: row.lang || undefined });
  try {
    if (row.lang && site.language) {
      const entries = Object.entries(site.language.localStorage).map(([k, v]) => [k, String(v).replace(/\{lang\}/g, row.lang)]);
      await context.addInitScript((pairs) => { for (const [k, v] of pairs) { try { window.localStorage.setItem(k, v); } catch { /* storage blocked */ } } }, entries);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    let signedIn = false;
    // The browser's own favicon request is no page fault: its "Failed to load resource" line is left out.
    page.on('console', (m) => {
      if (!signedIn || m.type() !== 'error') return;
      const at = (m.location && m.location().url) || '';
      if (/\/favicon\.ico(?:[?#]|$)/.test(at)) return;
      r.consoleErrors.push(m.text() + (at && /Failed to load resource/.test(m.text()) ? ` (${at})` : ''));
    });
    page.on('pageerror', (e) => { if (signedIn) r.consoleErrors.push(String(e.message || e)); });
    page.on('requestfailed', (q) => { if (signedIn) r.failedRequests.push(`${q.method()} ${q.url()} — ${(q.failure() && q.failure().errorText) || 'failed'}`); });
    page.on('response', (s) => { if (signedIn && s.status() >= 400 && SAME(base, s.url())) r.failedRequests.push(`${s.request().method()} ${s.url()} — ${s.status()}`); });
    await page.goto(base + site.login.path, { waitUntil: 'domcontentloaded' });
    // The password is typed only on the site file's own address (a redirect elsewhere gets none).
    if (!SAME(site.url, page.url())) { r.why = `the sign-in page is not on ${site.url}: no password typed`; return r; }
    await page.fill(site.login.user, site.user(row.role));
    await page.fill(site.login.password, site.secret(row.role));
    await Promise.all([page.waitForURL((u) => !String(u).includes(site.login.path), { timeout: timeoutMs }).catch(() => null), page.click(site.login.submit)]);
    if (page.url().includes(site.login.path)) { r.why = 'sign-in failed'; return r; }
    signedIn = true;
    const res = await page.goto(base + row.page, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => null);
    if (!res) r.why = 'no answer';
    else if (res.status() >= 400) r.why = `status ${res.status()}`;
    else if (page.url().includes(site.login.path)) r.why = 'sent back to sign-in';
    // A redirect to another page (a dashboard with status 200) is not the page (review round).
    else if (pathOf(page.url()) !== pathOf(base + row.page)) r.why = `opened ${pathOf(page.url())}, not the page`;
    else r.loaded = true;
    for (const want of textsFor(plan, row)) {
      const missing = [];
      for (const t of want.texts) {
        const seen = await page.getByText(t, { exact: false }).first().isVisible({ timeout: Math.min(timeoutMs, 5000) }).catch(() => false);
        if (!seen) missing.push(t);
      }
      r.lines.push({ id: want.id, seen: missing.length === 0, missing });
    }
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, shotName(row));
    await page.screenshot({ path: shot, fullPage: true });
    r.screenshot = shot;   // only once it is saved
    return r;
  } catch (e) {
    r.why = r.why || String(e.message || e).split('\n')[0].slice(0, 160);
    return r;
  } finally {
    await context.close().catch(() => null);
    const secrets = [site.secret(row.role)];
    r.why = redact(r.why, secrets);
    r.consoleErrors = r.consoleErrors.map((t) => redact(t, secrets));
    r.failedRequests = r.failedRequests.map((t) => redact(t, secrets));
  }
}

export async function runCheck({ plan, site, notes, url, browser, timeoutMs = 15000 }) {
  const base = (url || plan.url || site.url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw usage('no address: give --url, or url in the plan or the site file');
  if (!SAME(site.url, base)) throw usage(`the address ${base} is not the site file's address ${site.url}: its accounts are typed only there`);
  const shotDir = path.join(notes, 'browser');
  const results = [];
  for (const row of rowsOf(plan)) results.push(await checkRow(browser, base, site, plan, row, shotDir, timeoutMs));
  return results;
}

// ---- setup ---------------------------------------------------------------------------------------------------

export function setup(env = process.env) {
  const dir = toolDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'sanad-browser-check', private: true, description: "Sanad's own browser tool (browser-check.mjs); never part of a project", dependencies: { 'playwright-core': PLAYWRIGHT_VERSION } }, null, 2) + '\n');
  // One fixed command line (no value from outside): the shell finds npm on every system.
  const r = spawnSync(`npm install --no-fund --ignore-scripts --save-exact playwright-core@${PLAYWRIGHT_VERSION}`, { cwd: dir, encoding: 'utf8', shell: true, windowsHide: true, timeout: 600000 });
  if (r.status !== 0) throw new Error(`npm install failed in ${slash(dir)}:\n${(r.stdout || '') + (r.stderr || '')}`.slice(0, 2000));
  return dir;
}

// ---- the command line ----------------------------------------------------------------------------------------

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { o._.push(k); continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw usage(`${k} needs a value`);
    o[k.slice(2)] = argv[++i];
  }
  return o;
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parse(rest);
  if (cmd === 'setup') { const dir = setup(); process.stdout.write(`BROWSER TOOL: playwright-core ${PLAYWRIGHT_VERSION} in ${slash(dir)} (drives the installed Edge or Chrome; no browser downloaded)\n`); return 0; }
  if (cmd === 'status') {
    const { pw, dir, why } = loadPlaywright();
    if (!pw) { process.stdout.write(`BROWSER CHECK: NOT DONE — ${why}\n`); return 3; }
    const { browser, channel, why: noBrowser } = await launch(pw);
    if (!browser) { process.stdout.write(`BROWSER CHECK: NOT DONE — ${noBrowser}\n`); return 3; }
    await browser.close();
    process.stdout.write(`BROWSER TOOL: ready — ${slash(dir)}, browser ${channel}\n`);
    return 0;
  }
  if (cmd !== 'run') throw usage('give one of setup, status, run');
  if (!o.notes) throw usage('run needs --notes <dir>');
  const notes = path.resolve(o.notes);
  // Review round (2026-11-25): a run that ended NOT DONE, with a usage error or a crash left an older passing result in
  // the notes, which read as this run's. Every run first takes the old result away; a run that does not finish leaves
  // its own NOT DONE line in browser.md.
  try { fs.rmSync(path.join(notes, 'browser.json'), { force: true }); } catch { /* none */ }
  const notDone = (why) => {
    const line = `BROWSER CHECK: NOT DONE — ${why}`;
    try { fs.mkdirSync(notes, { recursive: true }); fs.writeFileSync(path.join(notes, 'browser.md'), line + '\n'); } catch { /* the line still prints */ }
    return line;
  };
  let plan, sf, site;
  try {
    const planFile = o.plan ? path.resolve(o.plan) : path.join(notes, 'browser-plan.json');
    if (!fs.existsSync(planFile)) throw usage(`no plan: write ${slash(planFile)} from the ticket (pages, roles, languages, the lines that name something visible)`);
    plan = readPlan(fs.readFileSync(planFile, 'utf8'));
    sf = siteFile(o.repo ? path.resolve(o.repo) : process.cwd(), o.site);
    if (!fs.existsSync(sf)) throw usage(`no site file ${slash(sf)}: it holds the sign-in steps, the address and one test account per role (see the head of this tool); the owner makes it, outside every repository`);
    site = readSite(fs.readFileSync(sf, 'utf8'), plan.roles);
  } catch (e) { notDone(e.message); throw e; }
  const { pw, why } = loadPlaywright();
  if (!pw) { process.stdout.write(notDone(why) + '\n'); return 3; }
  const { browser, channel, why: noBrowser } = await launch(pw);
  if (!browser) { process.stdout.write(notDone(noBrowser) + '\n'); return 3; }
  let results;
  try { results = await runCheck({ plan, site, notes, url: o.url, browser }); } catch (e) { notDone(e.message); throw e; } finally { await browser.close().catch(() => null); }
  const table = tableText(results);
  fs.writeFileSync(path.join(notes, 'browser.md'), `Browser check (${channel}), accounts from ${slash(sf)}\n\n` + table);
  fs.writeFileSync(path.join(notes, 'browser.json'), JSON.stringify({ at: new Date().toISOString(), channel, rows: results.map((r) => ({ ...r, passed: rowPassed(r) })) }, null, 2) + '\n');
  process.stdout.write(`Browser: ${channel} · accounts: the site file ${slash(sf)} (no password is shown)\n` + table);
  return results.every(rowPassed) ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`BROWSER-CHECK: ${e.message}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  });
}

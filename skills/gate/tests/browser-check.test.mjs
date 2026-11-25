// browser-check.mjs (2026-11-25, owner batch x task 2): each page of the plan, once per role and language, in the
// installed Edge or Chrome, driven by Sanad's own copy of playwright-core. The pure parts are tested always; the real
// browser run needs that copy (browser-check.mjs setup) and Edge or Chrome, and says so when they are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPlan, readSite, rowsOf, textsFor, shotName, tableText, rowPassed, runCheck, loadPlaywright, launch, siteFile, toolDir } from '../scripts/browser-check.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'browser-check.mjs');
const roots = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(d); return d; };
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const PLAN = { url: 'http://localhost:1', pages: ['/settings', '/users'], roles: ['Teacher', 'Admin'], languages: ['ar', 'en'],
  lines: [{ id: 'T1', see: { ar: ['معلم'], en: ['Teacher'] }, roles: ['Teacher'] }, { id: 'T2', see: ['EduQuest'], pages: ['/users'] }] };
const SITE = { login: { path: '/login', user: '#u', password: '#p', submit: '#go' }, language: { localStorage: { 'ui-storage': '{"state":{"language":"{lang}"}}' } },
  accounts: { Teacher: { user: 't@x.test', password: 'Secret-T-123' }, Admin: { user: 'a@x.test', passwordEnv: 'BC_TEST_ADMIN_PW' } } };

test('the plan: pages, roles from the ticket, languages, and each visible line with its texts', () => {
  const p = readPlan(JSON.stringify(PLAN));
  assert.deepEqual(p.languages, ['ar', 'en']);
  assert.throws(() => readPlan('{'), /not valid JSON/);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, pages: ['settings'] })), /pages is a list of paths that start with \//);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, roles: [] })), /roles is a list/);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, languages: ['Arabic'] })), /languages is a list of language codes/);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, lines: [{ id: 'X1', see: ['a'] }] })), /id is the ticket line's T<n>/);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, lines: [{ id: 'T1', see: [] }] })), /see is a list of texts/);
  assert.throws(() => readPlan(JSON.stringify({ ...PLAN, lines: [{ id: 'T1', see: ['a'], roles: ['Parent'] }] })), /its roles are roles of the plan/);
});

test('one row per page, role and language; each row gets only its own lines, in its own language', () => {
  const p = readPlan(JSON.stringify(PLAN));
  const rows = rowsOf(p);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[0], { page: '/settings', role: 'Teacher', lang: 'ar' });
  assert.deepEqual(textsFor(p, { page: '/settings', role: 'Teacher', lang: 'ar' }), [{ id: 'T1', texts: ['معلم'] }]);
  assert.deepEqual(textsFor(p, { page: '/settings', role: 'Teacher', lang: 'en' }), [{ id: 'T1', texts: ['Teacher'] }]);
  assert.deepEqual(textsFor(p, { page: '/settings', role: 'Admin', lang: 'en' }), []);
  assert.deepEqual(textsFor(p, { page: '/users', role: 'Admin', lang: 'ar' }), [{ id: 'T2', texts: ['EduQuest'] }]);
  assert.equal(shotName({ page: '/users/42/edit', role: 'Teacher', lang: 'ar' }), 'users-42-edit-Teacher-ar.png');
  assert.equal(shotName({ page: '/', role: 'Admin', lang: '' }), 'root-Admin.png');
});

test('the site file: sign-in steps and one account per role; a password from the environment; a missing one is named', () => {
  const env = { BC_TEST_ADMIN_PW: 'Secret-A-456' };
  const s = readSite(JSON.stringify(SITE), ['Teacher', 'Admin'], env);
  assert.equal(s.secret('Admin'), 'Secret-A-456');
  assert.equal(s.user('Teacher'), 't@x.test');
  assert.throws(() => readSite(JSON.stringify(SITE), ['Teacher', 'Admin'], {}), /the role Admin has no password \(the variable BC_TEST_ADMIN_PW is empty\)/);
  assert.throws(() => readSite(JSON.stringify(SITE), ['Parent'], env), /no account for the role Parent/);
  assert.throws(() => readSite(JSON.stringify({ ...SITE, login: { path: '/login' } }), ['Teacher'], env), /login holds path, user, password and submit/);
});

test('the site file lives outside the repository: --site, else git config sanad.browserSite, else the state folder by repository name', () => {
  const repo = tmp('bc-repo-');
  execFileSync('git', ['init', '-q', repo]);
  const state = tmp('bc-state-');
  assert.equal(siteFile(repo, '', { SANAD_STATE_DIR: state }), path.join(state, 'browser-sites', `${path.basename(repo)}.json`));
  assert.equal(siteFile(repo, 'x.json', {}), path.resolve('x.json'));
  execFileSync('git', ['-C', repo, 'config', 'sanad.browserSite', path.join(state, 'mine.json')]);
  assert.equal(siteFile(repo, '', { SANAD_STATE_DIR: state }), path.join(state, 'mine.json'));
});

test('the table: one row each, a failed row says why and stays in it; it names roles, never an account or a password', () => {
  const ok = { page: '/settings', role: 'Teacher', lang: 'ar', loaded: true, consoleErrors: [], failedRequests: [], lines: [{ id: 'T1', seen: true, missing: [] }], screenshot: 'n/browser/settings-Teacher-ar.png' };
  const bad = { page: '/users', role: 'Admin', lang: 'en', loaded: false, why: 'status 500', consoleErrors: ['TypeError: x is undefined'], failedRequests: ['GET http://h/api/users — 500'], lines: [{ id: 'T2', seen: false, missing: ['EduQuest'] }], screenshot: '' };
  assert.ok(rowPassed(ok));
  assert.ok(!rowPassed(bad));
  const text = tableText([ok, bad]);
  assert.match(text, /^\| page \| role \| language \| loaded \| console errors \| failed requests \| ticket lines seen \| screenshot \|/);
  assert.match(text, /\| \/settings \| Teacher \| ar \| ✓ \| 0 \| 0 \| T1 ✓ \| n\/browser\/settings-Teacher-ar\.png \|/);
  assert.match(text, /\| \/users \| Admin \| en \| ✗ status 500 \| 1: TypeError: x is undefined \| 1: GET http:\/\/h\/api\/users — 500 \| T2 ✗ EduQuest \|/);
  assert.match(text, /BROWSER CHECK: 2 row\(s\), 1 failed — fix each failed row, or write it as a note with the reason; it stays in the report/);
  assert.doesNotMatch(text, /@x\.test|Secret/);
});

test('without Sanad\'s browser tool the run says so in one line, exits 3, and is not done', () => {
  const notes = tmp('bc-notes-');
  fs.writeFileSync(path.join(notes, 'browser-plan.json'), JSON.stringify(PLAN));
  const site = path.join(tmp('bc-site-'), 'site.json');
  fs.writeFileSync(site, JSON.stringify(SITE));
  const r = spawnSync(process.execPath, [script, 'run', '--notes', notes, '--site', site], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SANAD_BROWSER_TOOL_DIR: tmp('bc-empty-'), BC_TEST_ADMIN_PW: 'x' } });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /^BROWSER CHECK: NOT DONE — no browser tool in Sanad's folder .* — run: node .*browser-check\.mjs setup/);
  assert.ok(!fs.existsSync(path.join(notes, 'browser.json')), 'no result is written');
});

test('a run with no plan or no site file is a usage error that names the file to write', () => {
  const notes = tmp('bc-notes-');
  const r = spawnSync(process.execPath, [script, 'run', '--notes', notes], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no plan: write .*browser-plan\.json from the ticket/);
  fs.writeFileSync(path.join(notes, 'browser-plan.json'), JSON.stringify(PLAN));
  const s = spawnSync(process.execPath, [script, 'run', '--notes', notes, '--site', path.join(notes, 'none.json')], { encoding: 'utf8', windowsHide: true });
  assert.equal(s.status, 2);
  assert.match(s.stderr, /no site file .*none\.json: it holds the sign-in steps and one test account per role/);
});

// A small site: a sign-in form, a page whose role word follows the language stored in localStorage, a page with a
// console error and a failing request.
function site() {
  const page = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signed = /session=ok/.test(req.headers.cookie || '');
    const send = (code, html, head = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...head }); res.end(html); };
    if (u.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const ok = (f.get('u') === 't@x.test' && f.get('p') === 'Secret-T-123') || (f.get('u') === 'a@x.test' && f.get('p') === 'Secret-A-456');
        if (ok) send(302, '', { location: '/home', 'set-cookie': 'session=ok; path=/' }); else send(302, '', { location: '/login?bad=1' });
      });
      return;
    }
    if (u.pathname === '/login') return send(200, page('<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="go" type="submit">Go</button></form>'));
    if (!signed) return send(302, '', { location: '/login' });
    if (u.pathname === '/home') return send(200, page('home'));
    if (u.pathname === '/settings') return send(200, page('<p id="r"></p><script>const s=JSON.parse(localStorage.getItem("ui-storage")||"{}");document.getElementById("r").textContent=(s.state&&s.state.language)==="ar"?"معلم":"Teacher";</script>'));
    if (u.pathname === '/broken') return send(200, page('<p>EduQuest</p><script>console.error("boom on load");fetch("/api/missing");</script>'));
    if (u.pathname === '/api/missing') { res.writeHead(500); return res.end('no'); }
    return send(404, page('nothing'));
  });
}

const { pw } = loadPlaywright();
test('a real run in the installed Edge or Chrome: loaded, console errors, failed requests, ticket lines and one screenshot per row', { skip: pw ? false : `Sanad's browser tool is not installed in ${toolDir()} (browser-check.mjs setup)` }, async (t) => {
  const { browser, why } = await launch(pw);
  if (!browser) { t.skip(why); return; }
  const server = site();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const notes = tmp('bc-run-');
  try {
    const plan = readPlan(JSON.stringify({ url, pages: ['/settings', '/broken'], roles: ['Teacher'], languages: ['ar', 'en'],
      lines: [{ id: 'T1', see: { ar: ['معلم'], en: ['Teacher'] }, pages: ['/settings'] }, { id: 'T2', see: ['Not on the page'], pages: ['/broken'] }] }));
    const s = readSite(JSON.stringify(SITE), plan.roles, {});
    const rows = await runCheck({ plan, site: s, notes, browser, timeoutMs: 8000 });
    assert.equal(rows.length, 4);
    const [arSettings, enSettings, arBroken] = rows;
    assert.ok(rowPassed(arSettings), JSON.stringify(arSettings));
    assert.deepEqual(arSettings.lines, [{ id: 'T1', seen: true, missing: [] }]);
    assert.ok(rowPassed(enSettings), JSON.stringify(enSettings));
    assert.ok(arBroken.loaded);
    assert.match(arBroken.consoleErrors.join('\n'), /boom on load/);
    assert.match(arBroken.failedRequests.join('\n'), /\/api\/missing — 500/);
    assert.deepEqual(arBroken.lines, [{ id: 'T2', seen: false, missing: ['Not on the page'] }]);
    for (const r of rows) assert.ok(fs.statSync(r.screenshot).size > 0, r.screenshot);
    assert.deepEqual(fs.readdirSync(path.join(notes, 'browser')).sort(), ['broken-Teacher-ar.png', 'broken-Teacher-en.png', 'settings-Teacher-ar.png', 'settings-Teacher-en.png']);
    assert.doesNotMatch(JSON.stringify(rows) + tableText(rows), /Secret-T-123/);
    const wrong = readSite(JSON.stringify({ ...SITE, accounts: { Teacher: { user: 't@x.test', password: 'wrong' } } }), plan.roles, {});
    const refused = await runCheck({ plan: { ...plan, pages: ['/settings'], languages: ['en'] }, site: wrong, notes, browser, timeoutMs: 4000 });
    assert.deepEqual([refused[0].loaded, refused[0].why], [false, 'sign-in failed']);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

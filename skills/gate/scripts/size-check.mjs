#!/usr/bin/env node
// size-check.mjs — size a task from facts, not feelings: tiny, small, medium or big, and the roles
// each size needs.
//
// Sanad sizes every implementation before code (boss-routing.md). A size picked by feel was wrong
// more than once (2026-11-05: a "small fix" changed a function with two callers and three
// reviewers found the same regression). This reads what the change touches — access rules, the
// database, money, files and URLs, concurrency, dependencies, the shared API contract, how many
// callers each changed function has — and maps those facts to a size by fixed rules. It runs
// twice: on the planned files before code (--files) and on the real diff before review (--base);
// with --was <size> it fails when the real change grew past the size it was routed at.
//
// Usage: node size-check.mjs --repo <path> (--base <ref> | --files <a,b,...>) [--was <size>] [--json]
// Exit 0: sized (and not grown). 1: --was given and the change grew. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStack } from './stack.mjs';
import { TEST_FILE } from './check-ticket-lines.mjs';

export const SIZES = ['tiny', 'small', 'medium', 'big'];
const CODE = /\.(?:cs|[cm]?[jt]sx?|py|go|java|kt|rb|php|sql|razor|cshtml|vue|svelte)$/i;
const DOC = /\.(?:md|mdx|txt|rst|adoc)$|(?:^|\/)(?:LICENSE|CHANGELOG)[^/]*$/i;
const LOCALE = /(?:^|\/)(?:locales?|i18n|lang|translations?)\/.+\.(?:json|[jt]s|ya?ml)$|\.resx$/i;
const STYLE = /\.(?:css|scss|sass|less)$/i;
const SERVER_TS = /(?:^|\/)(?:app\/(?:.+\/)?route\.[jt]s|pages\/api\/.+\.[jt]s|middleware\.[jt]s|[^/]+\.server\.[jt]sx?)$/i;

// One rule per signal: the size it forces, the seat it calls, and how it is found.
export const SIGNALS = {
  schema: { size: 'big', seat: 'Database expert', label: 'database schema or migration' },
  access: { size: 'big', seat: 'Security auditor', label: 'server access rules' },
  files: { size: 'big', seat: 'Security auditor', label: 'server file or URL handling' },
  concurrency: { size: 'big', seat: 'Skeptic', label: 'concurrency, transactions or background work' },
  dependency: { size: 'big', seat: 'user approval for the package', label: 'a dependency change' },
  callersMany: { size: 'big', seat: 'Architect', label: 'a changed function with more than 10 callers' },
  query: { size: 'medium', seat: 'Database expert', label: 'database query shape' },
  contract: { size: 'medium', seat: 'contract check on both halves', label: 'the shared API contract' },
  serverEntry: { size: 'medium', seat: 'access check in every new server entry', label: 'a server action or route handler' },
  money: { size: 'medium', seat: 'boss confirms money or not', label: 'money words' },
  accessUi: { size: 'medium', seat: 'server check behind each UI gate', label: 'role gating in the UI' },
  filesUi: { size: 'medium', seat: 'server check of what the client sends', label: 'file or URL handling in the client' },
  concurrencyUi: { size: 'medium', seat: 'Skeptic', label: 'timers or cross-tab state in the client' },
  infra: { size: 'medium', seat: 'deploy check', label: 'infrastructure or startup config' },
  split: { size: 'medium', seat: 'PR plan: split it', label: 'more than 400 logic lines or 30 files' },
  // Does not raise the size; adds the Client state lens (the seat on a panel, its checks in every review brief).
  clientState: { size: 'small', seat: 'Client state checks (the Client state seat on a panel)', label: 'client state (URL, cache, storage)' },
};

const DB_FILE = /\b(?:DbContext|DbSet<|IQueryable<|_context\b|_db\b|dbContext\b|prisma\.|knex\b|drizzle\b|getRepository\(|createQueryBuilder\()/;
const RE = {
  schemaPath: /(?:^|\/)(?:Migrations|migrations?|prisma\/migrations|drizzle|db\/migrate)\/.+|(?:^|\/)schema\.prisma$|\.sql$|ModelSnapshot\.cs$|(?:DbContext|EntityTypeConfiguration|Configuration)\.cs$/i,
  schemaLine: /\b(?:modelBuilder|HasIndex|HasKey|HasAlternateKey|ToTable|HasColumnType|HasMaxLength|IEntityTypeConfiguration|migrationBuilder|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|COLUMN))\b/i,
  query: /\.(?:Where|Include|ThenInclude|OrderBy\w*|ThenBy\w*|GroupBy|Join|SelectMany|Select|Any|All|Count|LongCount|Sum|Max|Min|Average|First\w*|Single\w*|Last\w*|ToList\w*|ToArray\w*|ToDictionary\w*|AsNoTracking\w*|AsSplitQuery|Skip|Take|ExecuteUpdate\w*|ExecuteDelete\w*|findMany|findFirst|findUnique|groupBy|aggregate|upsert)\s*\(|\bFromSql\w*\(|\bSqlQuery\w*\(|\bExecuteSql\w*\(|\bsql`|\bSELECT\s.+\sFROM\s/i,
  access: /\[(?:Authorize|AllowAnonymous)\b|RequireAuthorization|AuthorizeAsync|IAuthorizationHandler|AuthorizationPolicy|\bPolicy\s*=|\bRoles\s*=|ClaimTypes\.|User\.(?:FindFirst\w*|IsInRole|Identity|Claims)|HttpContext\.User|SignInAsync|SignOutAsync|getServerSession|\bauth\(\)|\bcurrentUser\b|\bisAdmin\b|\bhasRole\b|\bcanManage\b|\btenant\w*|\bcampusIds?\b|\bownerId\b|\bowner\b.*==/i,
  accessUi: /\bRoleGuard\b|\bProtectedRoute\b|\ballowedRoles\b|\bhasRole\b|\bisAdmin\b|\bcanManage\b|\brole\s*===?\s*['"]/i,
  files: /IFormFile|multipart|Content-Disposition|PresignedUrl|GetPreSignedURL|presign\w*|\bupload\w*|\bdownload\w*|\bRedirect\w*\(|\bredirect\(|new URL\(|HttpClient|\bReturnUrl\b|\breturnUrl\b|Path\.Combine|File\.(?:Open|Read|Write)\w*|FileStream|ZipArchive|\bcreateReadStream\b|\bwriteFile\w*\(/i,
  money: /\b(?:price|amount|payment|invoice|refund|wallet|currency|billing|payout|subtotal|discount|tax(?:es)?)\w*\b/i,
  concurrency: /\block\s*\(|SemaphoreSlim|Interlocked\.|BackgroundService|IHostedService|Channel<|Parallel\.|BeginTransaction\w*|TransactionScope|IsolationLevel|RowVersion|ConcurrencyCheck|\[Timestamp\]|DbUpdateConcurrencyException|FOR\s+UPDATE|idempoten\w*|\bMutex\b|SKIP\s+LOCKED/i,
  concurrencyUi: /\bsetInterval\(|BroadcastChannel|navigator\.locks|\bstorage\b.*addEventListener|visibilitychange/i,
  clientState: /\b(?:useSearchParams|setSearchParams|URLSearchParams|searchParams|useParams|localStorage|sessionStorage|queryKey|invalidateQueries|setQueryData|getQueryData|removeQueries|history\.(?:push|replace)State)\b|\bparams\.(?:get|set|delete|append)\(|\bnavigate\(/,
  contractPath: /(?:^|\/)(?:DTOs?|Contracts?|Dtos)\/|Dto\.cs$|Request\.cs$|Response\.cs$/i,
  contractLine: /\[Http(?:Get|Post|Put|Delete|Patch)\b|\[Route\(|\bMap(?:Get|Post|Put|Delete|Patch|Group)\(|ProducesResponseType/,
  contractClient: /(?:^|\/)src\/(?:types|api)\/.+\.[jt]sx?$/i,
  infra: /(?:^|\/)(?:Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml|nginx[^/]*\.conf|appsettings[^/]*\.json|\.env[^/]*|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|Program\.cs|Startup\.cs|web\.config)$|(?:^|\/)\.github\/workflows\//i,
  lockfile: /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|Directory\.Packages\.props)$/i,
  depLine: /^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"[~^<>=]*[\dx*]|<PackageReference\b|<PackageVersion\b/,
};

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  } catch (error) { if (allowFail) return ''; throw error; }
}

// Changed files since the merge base with <base>, committed and not, as added/removed lines.
export function readDiff(repo, base) {
  const from = git(repo, ['merge-base', base, 'HEAD']).trim();
  const files = new Map();
  let cur = null, oldName = '';
  for (const line of git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', from]).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { cur = null; oldName = ''; continue; }
    if (!cur && line.startsWith('--- ')) { oldName = line.slice(4).replace(/^a\//, '').trim(); continue; }
    if (!cur && line.startsWith('+++ ')) {
      const newName = line.slice(4).replace(/^b\//, '').trim();
      const deleted = newName === '/dev/null';
      const name = deleted ? oldName : newName;
      cur = files.get(name) || { name, added: [], removed: [], hunks: [], deleted };
      files.set(name, cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) { cur.hunks.push({ start: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]) }); continue; }
    if (!cur) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  for (const name of git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) {
    let text = ''; try { text = fs.readFileSync(path.join(repo, name), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    files.set(name, { name, added: lines, removed: [], hunks: [{ start: 1, count: lines.length }] });
  }
  return [...files.values()].filter(f => f.added.length || f.removed.length);
}

const KIND = name => TEST_FILE.test(name) ? 'test' : DOC.test(name) ? 'doc' : LOCALE.test(name) ? 'locale' : STYLE.test(name) ? 'style' : 'code';

// Signal → list of "file:hint" pieces of evidence.
export function signals(files, { plan = false, repo } = {}) {
  const found = new Map();
  const add = (key, where) => { if (!found.has(key)) found.set(key, []); if (found.get(key).length < 3) found.get(key).push(where); };
  for (const f of files) {
    const kind = KIND(f.name);
    if (kind !== 'code' && !RE.infra.test(f.name) && !RE.lockfile.test(f.name) && !/package\.json$|\.csproj$/i.test(f.name)) continue;
    const base = path.basename(f.name);
    const lines = plan ? [] : [...f.added, ...f.removed];
    const hit = re => lines.some(l => re.test(l));
    const server = /\.cs$|\.py$|\.go$|\.java$|\.kt$|\.rb$|\.php$|\.sql$/i.test(f.name) || SERVER_TS.test(f.name) || (!plan && f.added.some(l => /^\s*['"]use server['"]/.test(l))) || (repo && /\.[cm]?[jt]sx?$/.test(f.name) && fileText(repo, f.name).slice(0, 200).includes('use server'));
    if (RE.lockfile.test(f.name) || ((/package\.json$|\.csproj$/i.test(f.name)) && (plan || hit(RE.depLine)))) add('dependency', base);
    if (RE.infra.test(f.name)) add('infra', base);
    if (kind !== 'code') continue;
    if (RE.schemaPath.test(f.name) || hit(RE.schemaLine)) add('schema', base);
    if (!plan && hit(RE.query) && repo && DB_FILE.test(fileText(repo, f.name))) add('query', base);
    if (RE.contractPath.test(f.name) || hit(RE.contractLine)) add('contract', base);
    if (RE.contractClient.test(f.name)) add('contract', base);
    if (SERVER_TS.test(f.name) || (!plan && f.added.some(l => /^\s*['"]use server['"]/.test(l)))) add('serverEntry', base);
    if (/(?:^|\/)middleware\.[jt]s$/i.test(f.name)) add('access', base);
    if (plan) {
      if (/(?:^|\/)[^/]*(?:Auth|Authorization|Permission|Policy|Tenant|Identity)[^/]*\.(?:cs|[jt]s)$/i.test(f.name)) add(server ? 'access' : 'accessUi', base);
      continue;
    }
    if (server ? hit(RE.access) : hit(RE.accessUi)) add(server ? 'access' : 'accessUi', base);
    if (hit(RE.files)) add(server ? 'files' : 'filesUi', base);
    if (hit(RE.concurrency) && server) add('concurrency', base);
    if (hit(RE.concurrencyUi)) add('concurrencyUi', base);
    if (!server && hit(RE.clientState)) add('clientState', base);
    if (lines.some(l => RE.money.test(l.replace(/(["'`]).*?\1/g, '')))) add('money', base);
  }
  return found;
}

const texts = new Map();
function fileText(repo, name) {
  if (!texts.has(name)) { let t = ''; try { t = fs.readFileSync(path.join(repo, name), 'utf8'); } catch { /* deleted */ } texts.set(name, t); }
  return texts.get(name);
}

// The functions a change edits: the nearest definition above each hunk, and definitions inside it.
const DEFS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?(?:useCallback|useMemo|memo|forwardRef)\(/,
  /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|new|extern|unsafe)\s+)+[\w<>[\],.?() ]+?\s+([A-Za-z_]\w*)\s*(?:<[^>()]*>)?\s*\(/,
  /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/,
];
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'render', 'function', 'get', 'set', 'then', 'map', 'filter', 'main', 'Main', 'Dispose', 'ToString', 'Equals', 'GetHashCode', 'default', 'new', 'using', 'lock', 'foreach', 'it', 'test', 'describe']);
function defName(line) {
  for (const re of DEFS) { const m = re.exec(line); if (m && !NOT_NAMES.has(m[1]) && m[1].length >= 3) return m[1]; }
  return '';
}
const indent = line => /^\s*/.exec(line || '')[0].replace(/\t/g, '    ').length;
// A local function is called only from its own file; an exported or public one from anywhere.
const SHARED = /^\s*(?:export\b|(?:public|internal|protected)\b)/;
export function changedSymbols(repo, files) {
  const names = new Map();
  const keep = (n, f, line) => { if (n && !names.has(n)) names.set(n, { file: f.name, shared: SHARED.test(line) }); };
  for (const f of files) {
    if (KIND(f.name) !== 'code' || !CODE.test(f.name)) continue;
    const lines = fileText(repo, f.name).split(/\r?\n/);
    for (const h of f.hunks) {
      const from = Math.max(0, h.start - 1), to = Math.min(lines.length, from + Math.max(h.count, 1));
      for (let i = from; i < to; i++) keep(defName(lines[i]), f, lines[i]);
      // The enclosing function: the nearest definition above whose body holds the hunk (deeper indent).
      let first = from; while (first < to - 1 && !String(lines[first] || '').trim()) first++;
      const depth = indent(lines[first]);
      for (let i = from - 1; i >= Math.max(0, from - 200); i--) {
        const n = defName(lines[i]);
        if (!n) continue;
        if (depth > indent(lines[i])) keep(n, f, lines[i]);
        break;
      }
    }
  }
  return [...names.entries()].slice(0, 12).map(([name, v]) => ({ name, ...v }));
}

export function callers(repo, symbols) {
  return symbols.map(({ name, file, shared = true }) => {
    const rows = git(repo, ['grep', '-n', '-w', '-I', '--no-color', '-e', name], { allowFail: true }).split(/\r?\n/).filter(Boolean)
      .map(l => { const m = /^(.+?):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null; })
      .filter(r => r && (shared || r.file === file) && defName(r.text) !== name && !/^\s*(?:\/\/|\*|#)/.test(r.text) && !SKIP_PATH.test(r.file));
    // Two calls on one line are two callers.
    const word = new RegExp('(?<![\\w$])' + name.replace(/[$]/g, '\\$') + '(?![\\w$])', 'g');
    const uses = list => list.reduce((n, r) => n + Math.max(1, (r.text.match(word) || []).length), 0);
    const code = rows.filter(r => !TEST_FILE.test(r.file));
    return { name, file, count: uses(code), tests: uses(rows) - uses(code), where: code.slice(0, 6).map(r => (r.file === file ? path.basename(r.file) : r.file) + ':' + r.line) };
  });
}
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|bin|obj|\.claude|\.agents|docs\/db)\//i;

export function decide(found, callerRows, files) {
  const logic = files.filter(f => KIND(f.name) === 'code');
  const lines = logic.reduce((n, f) => n + f.added.length + f.removed.length, 0);
  if (lines > 400 || logic.length > 30) found.set('split', [`${logic.length} code files, ${lines} lines`]);
  const many = callerRows.filter(c => c.count > 10);
  if (many.length) found.set('callersMany', many.map(c => `${c.name} ×${c.count}`));
  let size = files.length && files.every(f => KIND(f.name) !== 'code' && !RE.infra.test(f.name) && !RE.lockfile.test(f.name) && !/package\.json$|\.csproj$/i.test(f.name)) ? 'tiny' : 'small';
  for (const key of found.keys()) if (SIZES.indexOf(SIGNALS[key].size) > SIZES.indexOf(size)) size = SIGNALS[key].size;
  return { size, lines, codeFiles: logic.length };
}

export function roles(size, found) {
  const seats = [...new Set([...found.keys()].map(k => SIGNALS[k].seat))];
  const reviewers = 'reviewers: whole-diff (Sonnet), fresh eyes (Opus), other engine (Codex)';
  if (size === 'tiny') return ['self-review and the mechanical checks; no reviewer'];
  if (size === 'small') return [reviewers, ...seats.map(s => '+ ' + s)];
  if (size === 'medium') return ['boss answers the open question first (boss-only)', reviewers, ...seats.map(s => '+ ' + s)];
  return ['boss + expert panel before code (Pragmatist + a seat per open question)', ...seats.map(s => '+ ' + s), 'risk reviewer (Opus) on the risk files', reviewers];
}

export function sizeTask({ repo, base, files: planned }) {
  const root = path.resolve(git(path.resolve(repo), ['rev-parse', '--show-toplevel']).trim());
  texts.clear();
  const plan = !base;
  const files = plan ? planned.map(n => ({ name: n.replace(/\\/g, '/'), added: [], removed: [], hunks: [] })) : readDiff(root, base);
  const found = signals(files, { plan, repo: root });
  const callerRows = plan ? [] : callers(root, changedSymbols(root, files));
  const { size, lines, codeFiles } = decide(found, callerRows, files);
  let stack = null; try { stack = readStack(root); } catch { /* not fatal */ }
  return { mode: plan ? 'plan' : 'diff', size, stack: stack && stack.line, signals: Object.fromEntries(found), roles: roles(size, found), callers: callerRows, files: files.length, codeFiles, lines };
}

export function format(r, was) {
  const out = [];
  if (r.stack) out.push('Stack: ' + r.stack);
  const why = Object.entries(r.signals).map(([k, w]) => `${SIGNALS[k].label} (${w.join(', ')})`);
  out.push(`SIZE: ${r.size} (${r.mode}) — ${why.length ? why.join('; ') : r.size === 'tiny' ? 'docs, tests, texts or styles only' : 'behavior code with no risk signal'}`);
  out.push('  roles: ' + r.roles.join('; '));
  const named = r.callers.filter(c => c.count || c.tests);
  if (named.length) out.push('  callers: ' + named.map(c => `${c.name} ×${c.count}${c.tests ? ` (+${c.tests} in tests)` : ''}${c.where.length ? ' [' + c.where.join(', ') + ']' : ''}`).join('; '));
  if (r.mode === 'diff') out.push(`  files: ${r.files} (${r.codeFiles} code, ${r.lines} code lines changed)`);
  if (was && SIZES.indexOf(r.size) > SIZES.indexOf(was)) out.push(`SIZE GREW: ${was} → ${r.size}. Add before review: ${r.roles.join('; ')}`);
  return out.join('\n');
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') { o.json = true; continue; }
    if (!['--repo', '--base', '--files', '--was'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if (!o.repo || (!o.base === !o.files)) throw new Error('--repo and exactly one of --base or --files are required.');
  if (o.was && !SIZES.includes(o.was)) throw new Error('--was must be one of ' + SIZES.join(', ') + '.');
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = args(process.argv.slice(2));
    const r = sizeTask({ repo: o.repo, base: o.base, files: o.files ? o.files.split(',').map(s => s.trim()).filter(Boolean) : null });
    process.stdout.write((o.json ? JSON.stringify(r) : format(r, o.was)) + '\n');
    process.exitCode = o.was && SIZES.indexOf(r.size) > SIZES.indexOf(o.was) ? 1 : 0;
  } catch (error) {
    process.stderr.write('SIZE: ' + String(error.message).split('\n')[0] + '\nUsage: node size-check.mjs --repo <path> (--base <ref> | --files <a,b,...>) [--was <size>] [--json]\n');
    process.exitCode = 2;
  }
}

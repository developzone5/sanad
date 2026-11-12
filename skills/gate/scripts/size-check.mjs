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
// Text-only locale data: data files under a locale folder (EduQuest keeps its 277 locale bundles as
// `export default {...}` .ts modules under locales/), JSON or YAML under i18n/, messages.<lang>.json and
// .resx. Code in an i18n folder is code (2026-11-12: the i18next setup in i18n/index.ts sized "tiny").
const LOCALE = /(?:^|\/)(?:locales?|translations?|langs?)\/(?:[^/]+\/)*[^/]+\.(?:json|ya?ml|[cm]?[jt]s)$|(?:^|\/)i18n\/(?:[^/]+\/)*[^/]+\.(?:json|ya?ml)$|(?:^|\/)messages\.[\w-]+\.json$|\.resx$/i;
// Data and pictures hold no logic lines (2026-11-12: a JSON fixture, a test snapshot or an SVG counted
// toward the 400-line split). Binary files are listed by name and never read as lines.
const NOT_LOGIC = /\.(?:json|snap|svg)$/i;
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

// A file that names any DbContext type (AppDbContext, GetRequiredService<AppDbContext>(), an
// IDbContextFactory<…>) or a DbSet is a database file, whatever its local variable is called
// (2026-11-12: BulkImportWorker.cs keeps its AppDbContext in a local `context`; `\bDbContext` missed it).
const DB_FILE = /\w*DbContext\b|IDbContextFactory<|\b(?:DbSet<|IQueryable<|_context\b|_db\b|dbContext\b|prisma\.|knex\b|drizzle\b|getRepository\(|createQueryBuilder\()/;
// A file named like an access file, or under an Auth, Authorization, Security or Permissions folder, is
// access code in plan and diff mode alike (2026-11-12: in diff mode a change in
// Api/Auth/LocalUserViewAuthorizer.cs with no access word on the changed line sized small).
const AUTH_FILE = /(?:^|\/)[^/]*(?:Auth|Authorization|Permission|Policy|Tenant|Identity)[^/]*\.(?:cs|[jt]s)$|(?:^|\/)(?:Auth|Authorization|Security|Permissions)\/(?:[^/]+\/)*[^/]+$/i;
// The same test without the word "Policy": a name or folder that says access by itself.
const AUTH_NAME = /(?:^|\/)[^/]*(?:Auth|Authorization|Permission|Tenant|Identity)[^/]*\.(?:cs|[jt]s)$|(?:^|\/)(?:Auth|Authorization|Security|Permissions)\/(?:[^/]+\/)*[^/]+$/i;
const RE = {
  schemaPath: /(?:^|\/)(?:Migrations|migrations?|prisma\/migrations|drizzle|db\/migrate)\/.+|(?:^|\/)schema\.prisma$|\.sql$|ModelSnapshot\.cs$|(?:DbContext|EntityTypeConfiguration|Configuration)\.cs$/i,
  schemaLine: /\b(?:modelBuilder|HasIndex|HasKey|HasAlternateKey|ToTable|HasColumnType|HasMaxLength|IEntityTypeConfiguration|migrationBuilder|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|COLUMN))\b/i,
  query: /\.(?:Where|Include|ThenInclude|OrderBy\w*|ThenBy\w*|GroupBy|Join|SelectMany|Select|Any|All|Count|LongCount|Sum|Max|Min|Average|First\w*|Single\w*|Last\w*|ToList\w*|ToArray\w*|ToDictionary\w*|AsNoTracking\w*|AsSplitQuery|Skip|Take|ExecuteUpdate\w*|ExecuteDelete\w*|findMany|findFirst|findUnique|groupBy|aggregate|upsert)\s*\(|\bFromSql\w*\(|\bSqlQuery\w*\(|\bExecuteSql\w*\(|\bsql`|\bSELECT\s.+\sFROM\s/i,
  access: /\[(?:Authorize|AllowAnonymous)\b|RequireAuthorization|AuthorizeAsync|IAuthorizationHandler|AuthorizationPolicy|\bPolicy\s*=|\bRoles\s*=|ClaimTypes\.|User\.(?:FindFirst\w*|IsInRole|Identity|Claims)|HttpContext\.User|SignInAsync|SignOutAsync|getServerSession|\bauth\(\)|\bisAdmin\b|\bhasRole\b|\bcanManage\b/i,
  // A field that scopes data (campus, tenant, owner, the current user) is an access rule only on a line that
  // compares or filters with it; a DTO field, a projection or a parameter is not (2026-11-12, audit C18:
  // CampusId alone sits on 7,966 backend lines, so any edited line with it sized "big").
  accessField: /\b(?:currentUser|tenant\w*|campusIds?|ownerId|owner)\b/i,
  compare: /\.(?:Where|Any|All|Contains)\s*\(|\.(?:First|Single)\w*\s*\(|\bif\s*\(|[!=]==?|&&|\|\||\s\?\s|\?\?|\[Authorize|\bRoles\b|\bClaims\b/,
  accessUi: /\bRoleGuard\b|\bProtectedRoute\b|\ballowedRoles\b|\bhasRole\b|\bisAdmin\b|\bcanManage\b|\brole\s*===?\s*['"]/i,
  // Stored-file code counts by its calls (a file storage service, S3 object calls and keys, file name and
  // extension handling), not by words: with comments no longer read, commit ff3b3b0405, which copies a stored
  // file across schools, had no "files" word left in its code (2026-11-12).
  files: /IFormFile|\bFormData\b|multipart|Content-Disposition|PresignedUrl|GetPreSignedURL|presign\w*|\bupload\w*|\bdownload\w*|\bRedirect\w*\(|\bredirect\(|new URL\(|HttpClient|\bReturnUrl\b|\breturnUrl\b|Path\.(?:Combine|GetExtension|GetFileName\w*)|File\.(?:Open|Read|Write)\w*|FileStream|ZipArchive|\bcreateReadStream\b|\bwriteFile\w*\(|FileStorage|\b(?:Put|Get|Copy|Delete)Objects?(?:Async|Request)?\b|\w*StorageKey\b|\bObjectKey\b/i,
  money: /\b(?:price|amount|payment|invoice|refund|wallet|currency|billing|payout|subtotal|discount)\w*\b/i,
  // "tax" as its own word or a camelCase part (taxRate, TotalTax), never inside taxonomy or syntax.
  tax: /(?:\b[Tt]ax|[a-z0-9_]Tax)(?:es)?(?![a-z])/,
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
// Signals are read in code only (codeOnly below): a word in a comment, an i18n key or a log text is no
// signal. These few are code that lives inside string text, so they are read in the whole line: SQL (in
// upper case, as written in code), the multipart and download headers, and the browser event names.
const RAW = {
  query: /\bSELECT\s.+\sFROM\s/,
  concurrency: /\bFOR\s+UPDATE\b|\bSKIP\s+LOCKED\b/,
  schema: /\b(?:CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|COLUMN))\b/,
  files: /multipart\/form-data|content-disposition/i,
  concurrencyUi: /addEventListener\(\s*['"`](?:storage|visibilitychange)['"`]/,
};

/**
 * One source line as code only: string and template literals emptied (their quotes kept, so `role === ''`
 * still reads as a compare) and `//` and `/* *\/` comment text removed (2026-11-12, audit C18). One pass,
 * left to right. A quote with no closing quote on the line is plain text, and so is one whose "string" would
 * run into ` //` (an apostrophe in JSX text, "Don't", paired with one in a trailing comment); a URL in a
 * string has no space before its `//`.
 */
export function codeOnly(line) {
  const s = String(line ?? '');
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') break;
    if (c === '/' && s[i + 1] === '*') { const end = s.indexOf('*/', i + 2); if (end < 0) break; out += ' '; i = end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c && !(s[j] === '/' && s[j + 1] === '/' && /\s/.test(s[j - 1]))) j += s[j] === '\\' ? 2 : 1;
      if (s[j] === '/') j = s.length;
      if (j < s.length) { out += c + c; i = j + 1; continue; }
    }
    out += c; i++;
  }
  return out;
}

function git(repo, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  } catch (error) { if (allowFail) return ''; throw error; }
}

// Changed files since the merge base with <base>, committed and not, as added/removed lines. A pure
// rename and a binary file have no lines: they go to `extra.renamed` ("old → new") and `extra.binary`
// (2026-11-12: both were dropped without a word, and a new untracked picture counted as code lines).
export function readDiff(repo, base, extra = {}) {
  const from = git(repo, ['merge-base', base, 'HEAD']).trim();
  const files = new Map();
  extra.renamed = []; extra.binary = [];
  let cur = null, oldName = '', block = null;
  const endBlock = () => {
    if (!block || block.lines) return;
    if (block.binary) extra.binary.push(block.name);
    else if (block.renameFrom && block.renameTo) extra.renamed.push(`${block.renameFrom} → ${block.renameTo}`);
  };
  for (const line of git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', from]).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      endBlock();
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      block = { name: m ? m[2] : line.slice(11), lines: false };
      cur = null; oldName = ''; continue;
    }
    if (!cur && block) {
      if (line.startsWith('rename from ')) { block.renameFrom = line.slice(12).trim(); continue; }
      if (line.startsWith('rename to ')) { block.renameTo = line.slice(10).trim(); continue; }
      if (/^Binary files .* differ$/.test(line)) { block.binary = true; continue; }
    }
    if (!cur && line.startsWith('--- ')) { oldName = line.slice(4).replace(/^a\//, '').trim(); continue; }
    if (!cur && line.startsWith('+++ ')) {
      if (block) block.lines = true;
      const newName = line.slice(4).replace(/^b\//, '').trim();
      const deleted = newName === '/dev/null';
      const name = deleted ? oldName : newName;
      cur = files.get(name) || { name, oldName: oldName === '/dev/null' ? null : oldName, from, added: [], removed: [], hunks: [], deleted };
      files.set(name, cur);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      cur.hunks.push({
        oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]),
        start: Number(h[3]), count: h[4] === undefined ? 1 : Number(h[4]),
      });
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  endBlock();
  for (const name of git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean)) {
    let bytes; try { bytes = fs.readFileSync(path.join(repo, name)); } catch { continue; }
    // Git's own test: a NUL byte in the first 8000 bytes means a binary file.
    if (bytes.subarray(0, 8000).includes(0)) { extra.binary.push(name); continue; }
    const lines = bytes.toString('utf8').split(/\r?\n/);
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
    // Each signal reads the changed lines as code (comments and strings out); `raw` reads the whole line.
    const code = plan ? [] : changedCode(repo, f);
    const hit = (re, raw) => code.some(l => re.test(l)) || (!!raw && lines.some(l => raw.test(l)));
    const server = /\.cs$|\.py$|\.go$|\.java$|\.kt$|\.rb$|\.php$|\.sql$/i.test(f.name) || SERVER_TS.test(f.name) || (!plan && f.added.some(l => /^\s*['"]use server['"]/.test(l))) || (repo && /\.[cm]?[jt]sx?$/.test(f.name) && fileText(repo, f.name).slice(0, 200).includes('use server'));
    if (RE.lockfile.test(f.name) || ((/package\.json$|\.csproj$/i.test(f.name)) && (plan || lines.some(l => RE.depLine.test(l))))) add('dependency', base);
    if (RE.infra.test(f.name)) add('infra', base);
    if (kind !== 'code') continue;
    if (RE.schemaPath.test(f.name) || hit(RE.schemaLine, RAW.schema)) add('schema', base);
    if (!plan && repo && DB_FILE.test(fileText(repo, f.name)) && queryChanged(repo, f)) add('query', base);
    if (RE.contractPath.test(f.name) || hit(RE.contractLine)) add('contract', base);
    if (RE.contractClient.test(f.name)) add('contract', base);
    if (SERVER_TS.test(f.name) || (!plan && f.added.some(l => /^\s*['"]use server['"]/.test(l)))) add('serverEntry', base);
    if (/(?:^|\/)middleware\.[jt]s$/i.test(f.name)) add('access', base);
    // "Policy" alone names business rules as often as access rules (ExamPolicy.cs = exam settings): in
    // diff mode, where the text can be read, such a file counts only when it speaks of authorization.
    const policyOnly = !plan && repo && !AUTH_NAME.test(f.name) && !/authoriz|ClaimsPrincipal|\[Authorize|\bIdentity\b|\bRoles?\b/i.test(fileText(repo, f.name));
    if (AUTH_FILE.test(f.name) && !policyOnly) add(server ? 'access' : 'accessUi', base);
    if (plan) continue;
    const scopedFilter = code.some(l => RE.accessField.test(l) && RE.compare.test(l));
    if (server ? hit(RE.access) || scopedFilter : hit(RE.accessUi)) add(server ? 'access' : 'accessUi', base);
    if (hit(RE.files, RAW.files)) add(server ? 'files' : 'filesUi', base);
    if (hit(RE.concurrency, RAW.concurrency) && server) add('concurrency', base);
    if (hit(RE.concurrencyUi, RAW.concurrencyUi)) add('concurrencyUi', base);
    if (!server && hit(RE.clientState)) add('clientState', base);
    if (hit(RE.money) || hit(RE.tax)) add('money', base);
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
// Opened minus closed brackets on one line, strings and line comments left out.
function bracketBalance(line) {
  const code = String(line || '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
  let n = 0;
  for (const c of code) { if (c === '{' || c === '(' || c === '[') n++; else if (c === '}' || c === ')' || c === ']') n--; }
  return n;
}
/**
 * For each line of a C-style source (JS/TS/C#/Java…), whether it holds any code — false for blank lines and lines
 * that are only `//`, `/* … *\/` or JSX `{/* … *\/}` comment, including the inside of a multi-line comment.
 */
export function codeLines(text) {
  const lines = String(text).split(/\r?\n/);
  let inBlock = false, jsx = false;
  return lines.map((line) => {
    let j = 0;
    while (j < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', j);
        if (end < 0) return false;
        inBlock = false; j = end + 2;
        if (jsx) { const close = /^\s*\}/.exec(line.slice(j)); if (close) j += close[0].length; jsx = false; }
        continue;
      }
      const rest = line.slice(j);
      if (/^\s/.test(rest)) { j++; continue; }
      if (rest.startsWith('{/*')) { inBlock = true; jsx = true; j += 3; continue; }
      if (rest.startsWith('/*')) { inBlock = true; j += 2; continue; }
      if (rest.startsWith('//')) return false;
      return true;
    }
    return false;
  });
}
const C_STYLE = /\.(?:cs|[cm]?[jt]sx?|java|kt|go|php|vue|svelte)$/i;
const oldTexts = new Map();
function oldText(repo, f) {
  const key = `${f.from}:${f.oldName || f.name}`;
  if (!oldTexts.has(key)) {
    let t = '';
    if (f.from && f.oldName !== null) { try { t = git(repo, ['show', key]); } catch { /* new file */ } }
    oldTexts.set(key, t);
  }
  return oldTexts.get(key);
}
// A hunk that changes only comments or blank lines, on both sides, changes no function (2026-11-09: a reworded
// JSX comment in a dialog sized a one-line style fix "big", because the dialog has eleven callers).
function commentOnlyHunk(repo, f, h) {
  if (!C_STYLE.test(f.name) || h.oldStart == null) return false;
  const now = codeLines(fileText(repo, f.name)), before = codeLines(oldText(repo, f));
  for (let i = h.start - 1; i < h.start - 1 + h.count; i++) if (now[i]) return false;
  for (let i = h.oldStart - 1; i < h.oldStart - 1 + h.oldCount; i++) if (before[i]) return false;
  return true;
}

// The changed lines of a file (added and removed) as code only: lines that are all comment (a block comment's
// inside, a JSX comment) are left out by the file's own reading, and codeOnly empties strings and trailing comments.
function changedCode(repo, f) {
  if (!repo || !C_STYLE.test(f.name)) return [...f.added, ...f.removed].map(codeOnly);
  const now = fileText(repo, f.name).split(/\r?\n/), nowCode = codeLines(now.join('\n'));
  const old = f.from && f.oldName !== null ? oldText(repo, f).split(/\r?\n/) : [];
  const oldCode = old.length ? codeLines(old.join('\n')) : [];
  const out = [];
  for (const h of f.hunks) {
    const first = h.count ? h.start - 1 : h.start;
    for (let i = first; i < first + h.count; i++) if (nowCode[i]) out.push(codeOnly(now[i]));
    if (h.oldStart != null) for (let i = h.oldStart - 1; i < h.oldStart - 1 + h.oldCount; i++) if (oldCode[i]) out.push(codeOnly(old[i]));
  }
  return out;
}

// A line that ends a statement: blank, a comment only, `;` at its end, or a lone `}`.
function endsStatement(line) {
  const t = String(line ?? '').replace(/\/\/.*$/, '').trim();
  return t === '' || t.endsWith(';') || t === '}';
}
// Whether a hunk changes a query's shape. A query is often wrapped, so a changed predicate on the line under
// `.Where(a =>` holds no query word (2026-11-12, audit C4b). Each hunk is read with up to three unchanged
// lines above and below it that belong to the same statement (no `;` or lone `}` between): a whole three-line
// window would count a plain line next to every finished query. Comment lines and comment-only hunks do not count.
function queryChanged(repo, f) {
  const text = fileText(repo, f.name), now = text.split(/\r?\n/);
  const code = C_STYLE.test(f.name) ? codeLines(text) : null;
  const old = f.from && f.oldName !== null ? oldText(repo, f).split(/\r?\n/) : [];
  const oldCode = code && old.length ? codeLines(old.join('\n')) : null;
  for (const h of f.hunks) {
    if (commentOnlyHunk(repo, f, h)) continue;
    const seen = [];
    const first = h.count ? h.start - 1 : h.start, end = first + h.count;
    for (let i = first; i < end; i++) if (!code || code[i]) seen.push(now[i]);
    const removed = [];
    if (h.oldStart != null) for (let i = h.oldStart - 1; i < h.oldStart - 1 + h.oldCount; i++) if (!oldCode || oldCode[i]) removed.push(old[i]);
    seen.push(...removed);
    for (let i = first - 1, k = 0; i >= 0 && k < 3 && !endsStatement(now[i]); i--, k++) if (!code || code[i]) seen.push(now[i]);
    let last = h.count ? now[end - 1] : removed[removed.length - 1];
    for (let i = end, k = 0; i < now.length && k < 3 && !endsStatement(last); i++, k++) { if (!code || code[i]) seen.push(now[i]); last = now[i]; }
    if (seen.some(l => RE.query.test(codeOnly(l)) || RAW.query.test(String(l ?? '')))) return true;
  }
  return false;
}

// A local function is called only from its own file; an exported or public one from anywhere.
const SHARED = /^\s*(?:export\b|(?:public|internal|protected)\b)/;
// Callers are counted for the first 12 changed functions; the output names how many more there were
// (2026-11-12: the rest were dropped without a word).
const MAX_SYMBOLS = 12;
export function changedSymbols(repo, files) { return allChangedSymbols(repo, files).slice(0, MAX_SYMBOLS); }
function allChangedSymbols(repo, files) {
  const names = new Map();
  const keep = (n, f, line, at) => { if (n && !names.has(n)) names.set(n, { file: f.name, shared: SHARED.test(line), at }); };
  for (const f of files) {
    if (KIND(f.name) !== 'code' || !CODE.test(f.name)) continue;
    const lines = fileText(repo, f.name).split(/\r?\n/);
    for (const h of f.hunks) {
      if (commentOnlyHunk(repo, f, h)) continue;
      const from = Math.max(0, h.start - 1), to = Math.min(lines.length, from + Math.max(h.count, 1));
      for (let i = from; i < to; i++) keep(defName(lines[i]), f, lines[i], i);
      // The enclosing function: the nearest definition above whose body is still open at the hunk
      // (brackets opened since its line are not all closed). Scanned to the top of the file, so a
      // change deep in a large component still names that component; a sibling helper that ended
      // before the hunk is skipped.
      // s[j] = brackets opened from line j down to the hunk and still open there. A bracket opened
      // on line j (or up to two lines below a definition, for a brace on its own line) holds the
      // hunk when s[j] is above every s[k] below it.
      let first = from; while (first < to - 1 && !String(lines[first] || '').trim()) first++;
      const depth = indent(lines[first]);
      const s = new Map(), maxBelow = new Map();
      let sum = 0, best = 0;
      for (let i = from - 1; i >= 0; i--) {
        maxBelow.set(i, best);
        sum += bracketBalance(lines[i]);
        s.set(i, sum);
        best = Math.max(best, sum);
        const n = defName(lines[i]);
        if (!n || depth <= indent(lines[i])) continue;
        // A lone `{` one or two lines down is this definition's body (a brace on its own line).
        const opener = [i, i + 1, i + 2].filter(j => j === i || String(lines[j] || '').trim() === '{');
        const holds = opener.some(j => j < from && s.get(j) > maxBelow.get(j));
        if (holds) { keep(n, f, lines[i], i); break; }
      }
    }
  }
  return [...names.entries()].map(([name, v]) => ({ name, ...v }));
}

// A JavaScript or TypeScript export is reached only through an import of its own file. A same-named
// function in another file (each page's local `buildSchema`) or a word in a doc is not a caller
// (2026-11-09: 35 such hits sized a change whose two functions had one caller each "big"). An import
// counts only when its path resolves to the file: a relative path, or `@/` = `src/` of the nearest
// package folder, with or without the extension or `/index` (2026-11-12, audit C19: matching by base
// name made api/users.ts and types/users.ts share callers; EduQuest has 152 shared base names).
const JS = /\.[cm]?[jt]sx?$/i;
const JS_EXT = /\.[cm]?[jt]sx?$/i;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const importsCache = new Map(), skipCache = new Map();
function packageDir(repo, file) {
  for (let dir = path.posix.dirname(file); dir && dir !== '.' && dir !== '/'; dir = path.posix.dirname(dir)) {
    if (fs.existsSync(path.join(repo, dir, 'package.json'))) return dir;
  }
  return '';
}
function resolveSpec(repo, from, spec) {
  let p;
  if (/^\.\.?(?:\/|$)/.test(spec)) p = path.posix.join(path.posix.dirname(from), spec);
  else if (spec.startsWith('@/')) p = path.posix.join(packageDir(repo, from), 'src', spec.slice(2));
  else return null;
  return p.replace(/\/$/, '').replace(JS_EXT, '');
}
// The repo paths (no extension) that a file's import, export-from, import() and require() specifiers name.
function importTargets(repo, file) {
  if (!importsCache.has(file)) {
    const out = new Set();
    for (const m of fileText(repo, file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`]([^'"`\n]+)['"`]/gm)) {
      const p = resolveSpec(repo, file, m[1]);
      if (p) out.add(p);
    }
    importsCache.set(file, out);
  }
  return importsCache.get(file);
}
const importsFile = (repo, from, target) => {
  const t = target.replace(JS_EXT, '');
  for (const p of importTargets(repo, from)) if (p === t || p + '/index' === t) return true;
  return false;
};
// The files that reach `name` of `file`: the file itself, every file that imports it, and through one
// re-export (`export { name } from './file'`, a barrel) that file's importers.
export function reachingFiles(repo, file, name, candidates) {
  const targets = [file];
  const reach = new Set([file]);
  const reExport = new RegExp(`export\\s*(?:\\*|\\{[^}]*\\b${escapeRe(name)}\\b[^}]*\\})\\s*from`);
  for (let pass = 0; pass < 2; pass++) {
    for (const f of candidates) {
      if (reach.has(f) || !JS.test(f)) continue;
      if (!targets.some(t => importsFile(repo, f, t))) continue;
      reach.add(f);
      if (reExport.test(fileText(repo, f))) targets.push(f);
    }
  }
  return reach;
}
// The lines of a JS/TS file that name a symbol without calling it: import statements (all their lines),
// export lists and `export … from`, and `export default X;` (2026-11-12, audit C19: a component used in
// 4 files counted 12 "callers").
function jsSkipLines(repo, file) {
  if (!skipCache.has(file)) {
    const lines = fileText(repo, file).split(/\r?\n/), skip = new Set();
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*export\s+default\s+[A-Za-z_$][\w$.]*\s*;?\s*$/.test(lines[i])) { skip.add(i + 1); continue; }
      if (!/^\s*(?:import\b(?!\s*\()|export\s+(?:type\s+)?(?:\*|\{))/.test(lines[i])) continue;
      // The statement runs to its closing brace, its `from '…'`, its `;` or, for `import './x'`, its path.
      for (let j = i; j < lines.length && j < i + 80; j++) {
        skip.add(j + 1);
        if (/[};]|\bfrom\s*['"`]|^\s*import\s+['"`]/.test(lines[j])) { i = j; break; }
      }
    }
    skipCache.set(file, skip);
  }
  return skipCache.get(file);
}

// C#: the type that declares the method on line `at` — the nearest class, record, struct or interface above
// it that is less indented — and the interfaces its declaration line lists. A method is reached through its
// type, so a C# caller sits in a file that names that type, I<Type> or one of those interfaces (2026-11-12,
// audit M6: TUW-243 changed AssignmentPublishRules.Apply, and the bare name `Apply` matched every other
// class's Apply: 18 "callers", sized big; it has 2).
const CS = /\.cs$/i;
const TYPE_DECL = /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|unsafe|file|new)\s+)*(?:class|record(?:\s+(?:class|struct))?|struct|interface)\s+([A-Za-z_]\w*)/;
function declaringType(lines, at) {
  if (at == null || !lines[at]) return { name: '', names: [] };
  const depth = indent(lines[at]);
  for (let i = at - 1; i >= 0; i--) {
    const m = TYPE_DECL.exec(lines[i] || '');
    if (!m || indent(lines[i]) >= depth) continue;
    const bases = (/:\s*([^{]+)/.exec(lines[i].slice(m[0].length)) || ['', ''])[1].replace(/<[^<>]*>/g, '').split(/[\s,]+/).filter(b => /^I[A-Z]\w*$/.test(b));
    return { name: m[1], names: [...new Set([m[1], 'I' + m[1], ...bases])] };
  }
  return { name: '', names: [] };
}
// An interface member's own declaration (`Task SaveAsync(int id);`) names the method without calling it.
const memberDecl = name => new RegExp(`^\\s*(?!(?:return|await|throw|yield|new|else|case|using|var|in|is|not|select|let|where|from|orderby|group|join|on|into)\\b)[A-Za-z_][\\w<>\\[\\],.? ]*?\\s${escapeRe(name)}\\s*(?:<[^>()]*>)?\\s*\\(`);

export function callers(repo, symbols) {
  return symbols.map(({ name, file, shared = true, at }) => {
    // --untracked: a caller in a new file not yet added to git counts too (2026-11-12, audit C16).
    const all = git(repo, ['grep', '--untracked', '-n', '-w', '-I', '--no-color', '-e', name], { allowFail: true }).split(/\r?\n/).filter(Boolean)
      .map(l => { const m = /^(.+?):(\d+):(.*)$/.exec(l); return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null; })
      .filter(r => r && CODE.test(r.file) && !SKIP_PATH.test(r.file));
    let rows = all.filter(r => (shared || r.file === file) && defName(r.text) !== name && !/^\s*(?:\/\/|\*|#)/.test(r.text));
    if (shared && JS.test(file)) {
      const reach = reachingFiles(repo, file, name, [...new Set(rows.map(r => r.file))]);
      rows = rows.filter(r => reach.has(r.file));
    }
    // C#: only files that name the declaring type count, and a call through another type that declares the
    // same name (`HomeworkSettingsRules.Apply(`) is that type's. An extension method (`this` first
    // parameter) is called on any value, so it keeps the plain name search.
    let others = null;
    const defLines = CS.test(file) ? fileText(repo, file).split(/\r?\n/) : [];
    const type = shared ? declaringType(defLines, at) : { name: '', names: [] };
    const extension = type.name && /\(\s*this\s|^\s*this\s/.test(defLines[at] + '\n' + (defLines[at + 1] || ''));
    if (type.name && !extension) {
      const names = new RegExp(`\\b(?:${type.names.map(escapeRe).join('|')})\\b`);
      const decl = memberDecl(name);
      rows = rows.filter(r => r.file === file || (names.test(fileText(repo, r.file))
        && !(CS.test(r.file) && /\binterface\s+[A-Za-z_]/.test(fileText(repo, r.file)) && decl.test(r.text))));
      const otherTypes = new Set();
      for (const r of all) {
        if (!CS.test(r.file) || defName(r.text) !== name) continue;
        const t = declaringType(fileText(repo, r.file).split(/\r?\n/), r.line - 1).name;
        if (t && !type.names.includes(t)) otherTypes.add(t);
      }
      if (otherTypes.size) others = new RegExp(`\\b(?:${[...otherTypes].map(escapeRe).join('|')})\\s*\\.\\s*$`);
    }
    // Two calls on one line are two callers; a use inside a string or a trailing comment, a closing JSX tag
    // and a call through another type that declares the same name are none.
    const word = new RegExp('(?<![\\w$])' + name.replace(/[$]/g, '\\$') + '(?![\\w$])', 'g');
    const usesOf = r => {
      if (JS.test(r.file) && jsSkipLines(repo, r.file).has(r.line)) return 0;
      if (!(r.text.match(word) || []).length) return 1;
      const text = codeOnly(r.text);
      let n = 0;
      for (const m of text.matchAll(word)) {
        const before = text.slice(0, m.index);
        if (before.endsWith('</') || (others && others.test(before))) continue;
        n++;
      }
      return n;
    };
    const counted = rows.map(r => ({ ...r, n: usesOf(r) })).filter(r => r.n > 0);
    const uses = list => list.reduce((n, r) => n + r.n, 0);
    const code = counted.filter(r => !TEST_FILE.test(r.file));
    return { name, file, count: uses(code), tests: uses(counted) - uses(code), where: code.slice(0, 6).map(r => (r.file === file ? path.basename(r.file) : r.file) + ':' + r.line) };
  });
}
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|bin|obj|\.claude|\.agents|docs\/db)\//i;

export function decide(found, callerRows, files) {
  const logic = files.filter(f => KIND(f.name) === 'code' && !NOT_LOGIC.test(f.name));
  const lines = logic.reduce((n, f) => n + f.added.length + f.removed.length, 0);
  if (lines > 400 || logic.length > 30) found.set('split', [`${logic.length} code files, ${lines} lines`]);
  const many = callerRows.filter(c => c.count > 10);
  if (many.length) found.set('callersMany', many.map(c => `${c.name} ×${c.count}`));
  let size = files.length && files.every(f => KIND(f.name) !== 'code' && !RE.infra.test(f.name) && !RE.lockfile.test(f.name) && !/package\.json$|\.csproj$/i.test(f.name)) ? 'tiny' : 'small';
  for (const key of found.keys()) if (SIZES.indexOf(SIGNALS[key].size) > SIZES.indexOf(size)) size = SIGNALS[key].size;
  return { size, lines, codeFiles: logic.length };
}

// The reviewers each size gets are the ones review-brief.mjs writes into launch.md: a tiny or small change
// gets ONE review, the Claude fresh eyes (user rule 2026-11-11). 2026-11-12: these lines still said "no
// reviewer" for tiny and three reviewers for small.
export function roles(size, found) {
  const seats = [...new Set([...found.keys()].map(k => SIGNALS[k].seat))];
  const reviewers = 'reviewers: whole-diff (Sonnet), fresh eyes (Opus), other engine (Codex)';
  if (size === 'tiny' || size === 'small') return ['one review: fresh eyes (Opus)', ...seats.map(s => '+ ' + s)];
  if (size === 'medium') return ['boss answers the open question first (boss-only)', reviewers, ...seats.map(s => '+ ' + s)];
  return ['boss + expert panel before code (Pragmatist + a seat per open question)', ...seats.map(s => '+ ' + s), 'risk reviewer (Opus) on the risk files', reviewers];
}

export function sizeTask({ repo, base, files: planned }) {
  const root = path.resolve(git(path.resolve(repo), ['rev-parse', '--show-toplevel']).trim());
  texts.clear();
  oldTexts.clear();
  importsCache.clear();
  skipCache.clear();
  const plan = !base;
  const extra = { renamed: [], binary: [] };
  const files = plan ? planned.map(n => ({ name: n.replace(/\\/g, '/'), added: [], removed: [], hunks: [] })) : readDiff(root, base, extra);
  const found = signals(files, { plan, repo: root });
  const symbols = plan ? [] : allChangedSymbols(root, files);
  const callerRows = callers(root, symbols.slice(0, MAX_SYMBOLS));
  const { size, lines, codeFiles } = decide(found, callerRows, files);
  let stack = null; try { stack = readStack(root); } catch { /* not fatal */ }
  return { mode: plan ? 'plan' : 'diff', size, stack: stack && stack.line, signals: Object.fromEntries(found), roles: roles(size, found), callers: callerRows,
    moreSymbols: Math.max(0, symbols.length - MAX_SYMBOLS), files: files.length, codeFiles, lines, renamed: extra.renamed, binary: extra.binary };
}

export function format(r, was) {
  const out = [];
  if (r.stack) out.push('Stack: ' + r.stack);
  const why = Object.entries(r.signals).map(([k, w]) => `${SIGNALS[k].label} (${w.join(', ')})`);
  out.push(`SIZE: ${r.size} (${r.mode}) — ${why.length ? why.join('; ') : r.size === 'tiny' ? 'docs, tests, texts or styles only' : 'behavior code with no risk signal'}`);
  out.push('  roles: ' + r.roles.join('; '));
  const named = r.callers.filter(c => c.count || c.tests).map(c => `${c.name} ×${c.count}${c.tests ? ` (+${c.tests} in tests)` : ''}${c.where.length ? ' [' + c.where.join(', ') + ']' : ''}`);
  if (r.moreSymbols) named.push(`+${r.moreSymbols} more changed functions not counted`);
  if (named.length) out.push('  callers: ' + named.join('; '));
  if (r.mode === 'diff') out.push(`  files: ${r.files} (${r.codeFiles} code, ${r.lines} code lines changed)`);
  if (r.renamed && r.renamed.length) out.push('  renamed: ' + r.renamed.join(', '));
  if (r.binary && r.binary.length) out.push('  binary: ' + r.binary.join(', '));
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

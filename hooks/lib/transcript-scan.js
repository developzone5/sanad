/*
 * transcript-scan.js — shared transcript + shell-command analysis for the hooks.
 *
 * Used by stop-gate.js (Stop) and policy-guard.js (PreToolUse: push gate).
 *
 * Everything here is deterministic and fail-open: a torn transcript line, an
 * unreadable file, or an odd command shape degrades toward "nothing found",
 * never toward a throw that could brick a hook.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { invalidVerificationTarget, nativeVerificationTarget, verificationTarget } = require('./verification-target.cjs');
// The hooks' process, when there is one (a test sandbox may have none).
const proc = typeof process === 'object' && process ? process : null;

// ---------------------------------------------------------------------------
// What counts as code
// ---------------------------------------------------------------------------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const CODE_EXT = new RegExp(
  '\\.(' +
  'cs|csproj|vbproj|fsproj|razor|cshtml|' +          // .NET
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|' +      // JS/TS
  'py|ipynb|go|rb|php|java|kt|kts|rs|swift|scala|' + // other backends
  'dart|lua|ex|exs|fs|fsx|vb|groovy|pl|' +
  'c|cc|cpp|cxx|h|hpp|' +                            // C/C++
  'sh|bash|ps1|psm1|' +                              // shell scripts
  'sln|props|targets|yaml|yml|toml|xml|config|ini|' +   // build/configuration
  'sql|css|scss|less' +                              // db + styles
  ')$', 'i'
);
const CODE_BASENAME = /(^|[/\\])dockerfile[^/\\]*$/i;
// Config/locale JSON whose syntax breaks a build: appsettings*, tsconfig*,
// launchSettings, and anything under a src/ tree (i18n bundles).
const CODE_JSON = /(^|[/\\])(appsettings[^/\\]*|tsconfig[^/\\]*|launchSettings)\.json$|(^|[/\\])src[/\\].*\.json$/i;
const MANIFEST_BASENAME = /(^|[/\\])(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/\\]*\.txt|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|global\.json|docker-compose(\.[^/\\]+)?\.ya?ml|compose(\.[^/\\]+)?\.ya?ml)$/i;
// Paths that never oblige a verify: Claude's and Codex's own config, memory,
// scratch, specs, vendored/VCS-internal trees, device files. The temp folder
// (the session scratchpad lives in it) is named literally or by its variable.
const EXEMPT = /((^|[/\\])\.claude([/\\]|$)|(^|[/\\])\.codex([/\\]|$)|[/\\]memory[/\\]|[/\\]specs[/\\]|[/\\]node_modules[/\\]|[/\\]\.git[/\\]|^\/tmp\/|^\/private\/tmp\/|^\/(?:private\/)?var\/folders\/|^\$\{?(?:TEMP|TMP|TMPDIR)\}?[/\\]|^\$env:(?:TEMP|TMP)[/\\]|^%(?:TEMP|TMP)%[/\\]|^\/dev\/|^\/proc\/)/i;
// The Windows temp folder is exempt only outside a git work tree: real worktrees live there too, and
// edits in them never counted (2026-11-12, audit H3: no check asked, no timer).
const TEMP_DIR = /AppData\/Local\/Temp/i;
const workTreeDirs = new Map(); // folder -> inside a work tree rooted below the temp folder (for this process)
function inTempWorkTree(p) {
  const local = p.replace(/^\/([A-Za-z])\//, '$1:/');   // Git Bash spells C:/ as /c/
  const m = TEMP_DIR.exec(local);
  if (!m) return false;
  const top = local.slice(0, m.index + m[0].length);
  // Walk up from the file's folder to the temp folder; a folder that does not exist yet has no .git,
  // so the nearest existing parent decides.
  const seen = [];
  let dir = local.replace(/\/+$/, '').replace(/\/[^/]*$/, ''), inside = false;
  while (dir.length > top.length) {
    if (workTreeDirs.has(dir)) { inside = workTreeDirs.get(dir); break; }
    seen.push(dir);
    let found = false;
    try { found = fs.existsSync(dir + '/.git'); } catch (e) { found = false; }
    if (found) { inside = true; break; }
    dir = dir.replace(/\/[^/]*$/, '');
  }
  for (const d of seen) workTreeDirs.set(d, inside);
  return inside;
}

function stripQuotes(s) { return String(s || '').replace(/^["']+|["']+$/g, ''); }

// A relative name written by a shell command lands in the folder that command is
// in (its `cd`, else the tool's folder). Judge it there: `cd <scratchpad> && sed -i
// … find.sql` writes the scratchpad, not the project (2026-11-08). Unknown folder or
// an unexpanded variable: the name is judged as written (conservative).
function inFolder(p, base) {
  const s = stripQuotes(p);
  if (!base || !s || /^(?:[A-Za-z]:[\\/]|[\\/~$%<])/.test(s)) return s;
  return String(base).replace(/[\\/]+$/, '') + '/' + s;
}

// `a/b/../c` is `a/c`: a name that climbs out of an exempt folder is judged where it lands.
function collapseDots(p) {
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '.') continue;
    const last = parts[parts.length - 1];
    if (part === '..' && parts.length && last !== '..' && last !== '' && !/^[A-Za-z]:$/.test(last)) { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

function isCodePath(p) {
  p = stripQuotes(p).replace(/[),;]+$/, '');
  if (!p) return false;
  // Claude-managed worktrees contain application code, even though their
  // absolute path starts inside .claude. Apply exemptions within that checkout.
  p = collapseDots(p.replace(/\\/g, '/')).replace(/^.*(?:^|\/)\.claude\/worktrees\/[^/]+\//i, '');
  if (EXEMPT.test(p)) return false;
  if (!(CODE_EXT.test(p) || CODE_BASENAME.test(p) || CODE_JSON.test(p) || MANIFEST_BASENAME.test(p))) return false;
  return !TEMP_DIR.test(p) || inTempWorkTree(p);
}

// ---------------------------------------------------------------------------
// Shell command shape
// ---------------------------------------------------------------------------

// One command grammar for every hook: segment splitting and tokenizing live in
// shell-command.cjs (quote- and heredoc-aware); re-exported here unchanged.
const shellCommand = require('./shell-command.cjs');
const { parseCommand, shellPath } = shellCommand;
// The same command is split and tokenized many times while it is judged; a whole session has tens of
// thousands of commands (2026-11-12: the first read of a 449 MB session spent seconds here). Each
// caller gets its own copy, so the remembered answer cannot be changed.
function remembered(fn) {
  const seen = new Map();
  return (s) => {
    const key = String(s == null ? '' : s);
    let v = seen.get(key);
    if (!v) { v = fn(key); if (seen.size >= 4000) seen.clear(); seen.set(key, v); }
    return v.slice();
  };
}
const splitSegments = remembered(shellCommand.splitSegments);
const tokenize = remembered(shellCommand.tokenize);

// A verify command: build, test, lint or typecheck. Starting a server or an
// arbitrary helper script is not verification. Matched at the START (after env-var
// prefixes / benign wrappers), never as a free substring — so `git commit -m
// "fix go test"` or `echo run pytest` never spoof a verify.
const VERIFY_BODY =
  'dotnet\\s+(build|test|publish)\\b|' +
  '(npm|pnpm|yarn|bun)\\s+(test\\b|build\\b|run\\s+(build|test|typecheck|check|lint)(?:[\\s:]|$))|' +
  'npx\\s+(vitest|jest|playwright\\s+test|tsc|mocha|eslint)\\b|' +
  'deno\\s+(test|check)\\b|node\\s+--(check|test)\\b|' +
  'pytest\\b|python3?\\s+-m\\s+(pytest|unittest)\\b|' +
  'go\\s+(test|build|vet)\\b|cargo\\s+(test|build|check|clippy)\\b|' +
  'mvn\\b|gradlew?\\b|make\\s+(test|check|build)|' +
  'mix\\s+(test|compile)|swift\\s+(test|build)|flutter\\s+(test|build)|' +
  'docker\\s+(compose\\s+)?build|' +
  'vitest|jest\\b|phpunit|rspec|tsc\\b';
const VERIFY_ANCHORED = new RegExp('^(?:' + VERIFY_BODY + ')', 'i');

function verificationWords(seg) {
  const s = String(seg).trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '') // VAR=val prefixes
    .replace(/^(?:sudo|time|env|command|timeout\s+\d+[smh]?)\s+/, '');      // benign wrappers
  const tokens = tokenize(s);
  if (!tokens.length) return [];
  // A bare assignment (`N="C:/…/tuw238"`) runs nothing: keep it as written. Read as a
  // program it showed as `tuw238`, and `T=C:/tools/vitest` passed as a test run (2026-11-09).
  if (tokens.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return tokens;
  const target = nativeVerificationTarget(tokens[0], tokens.slice(1));
  return [target.executable, ...target.args];
}

function verificationCommand(seg) { return verificationWords(seg).join(' '); }

// `ssh [options] host <command>`: the command it runs on the other machine, or ''
// when there is none (-N, a tunnel). A test run on a second machine is a test run:
// its own output is still judged by the same failure markers (2026-11-05).
const SSH_VALUE_OPTS = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w']);
function remoteCommand(words) {
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { i++; break; }
    if (!w.startsWith('-') || w === '-') break;
    if (SSH_VALUE_OPTS.has(w)) { i++; continue; }
    if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(w)) { if (w.includes('N')) return ''; continue; }
    // -oKey=value, -p22 and similar joined forms carry their value.
  }
  return words.slice(i + 1).join(' ').trim();
}
function isSsh(words) { return /^ssh(?:\.exe)?$/i.test(String(words[0] || '').split(/[\\/]/).pop()); }

function segmentIsVerify(seg) {
  const words = verificationWords(seg);
  if (isSsh(words)) {
    const inner = remoteCommand(words);
    return !!inner && splitSegments(inner).some(segmentIsVerify);
  }
  const command = words.join(' ');
  if (/(?:^|\s)(?:--list-tests|--collect-only|--collectonly|--passWithNoTests|--help|--version)(?:\s|=|$)/i.test(command)) return false;
  // A fixer rewrites the code it checks: it is an edit, not a passing check (2026-11-12, audit H14).
  if (/(?:^|\s)--fix(?:\s|=|$)/i.test(command)) return false;
  // TypeScript inventory/help commands can exit 0 without checking any source.
  if (/^(?:npx\s+)?tsc\b/i.test(command) && /(?:^|\s)(?:--listFilesOnly|--showConfig|--help|--version|-h|-v)(?:\s|=|$)/i.test(command)) return false;
  // A red-proof run that ends with green on the fixed tree runs the tests on the code as it is: a test run
  // (2026-11-11, TUW-242: a proved tree left the stop asking for tests on every turn of a paused task). Its
  // other modes (warm, drop copies, restore, show the remote command) and a run without --then-green test
  // no fixed tree.
  if (/^node(?:\.exe)?\s+\S*red-proof\.mjs(?:\s|$)/i.test(command)) {
    const own = command.split(/\s--\s/)[0];
    return /(?:^|\s)--then-green(?:\s|$)/.test(own) && !/(?:^|\s)--(?:warm|drop-copies|restore|show-remote)(?:\s|$)/.test(own);
  }
  return VERIFY_ANCHORED.test(command);
}

function hasVerify(cmd) { return splitSegments(cmd).some(segmentIsVerify); }

// The list operator after each segment ('' after the last), with the same boundaries as
// splitSegments in shell-command.cjs. When the two ever disagree (the shared grammar changed),
// the caller gets null and treats every check as one whose exit code it cannot see.
function segmentOps(cmd) {
  cmd = String(cmd || '');
  const out = [];
  let cur = '', q = null, i = 0;
  const cut = (op) => {
    const text = cur.trim();
    cur = '';
    if (text) out.push({ text, op });
    else if (out.length && out[out.length - 1].op === '&&') out[out.length - 1].op = op;
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[i + 1]; i++; }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; i++; continue; }
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        const eol = cmd.indexOf('\n', i);
        if (eol === -1) { cur += cmd.slice(i); i = cmd.length; continue; }
        cur += cmd.slice(i, eol);
        let j = eol + 1, end = cmd.length;
        while (j < cmd.length) {
          let nl = cmd.indexOf('\n', j);
          if (nl === -1) nl = cmd.length;
          if (cmd.slice(j, nl).replace(/^\t+/, '').trim() === m[2]) { end = nl; break; }
          j = nl + 1;
        }
        i = end;
        continue;
      }
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) { cut(cmd.slice(i, i + 2)); i += 2; continue; }
    if (ch === ';' || ch === '\n' || ch === '|') { cut(ch); i++; continue; }
    if (ch === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { cut('&'); i++; continue; }
    cur += ch;
    i++;
  }
  cut('');
  const plain = splitSegments(cmd);
  return plain.length === out.length && plain.every((s, n) => s === out[n].text) ? out : null;
}

// A check's exit code reaches the tool only when it ends its pipeline and nothing after it but `&&`
// follows: `| tail`, `; echo`, `|| true`, `&` or a later `;` command replace it (2026-11-12, audit H4:
// `… vitest run > log; sed … | grep … | head -8` with eight failures exited 0 and read as a pass).
const HIDING_OPS = new Set([';', '\n', '||', '&']);
function exitHidden(ops, i) {
  if (ops[i].op === '|') return true;
  for (let j = i; j < ops.length - 1; j++) if (HIDING_OPS.has(ops[j].op)) return true;
  return false;
}

// Which runner a check is, for its own pass marker.
function checkRunner(seg) {
  const c = verificationCommand(seg);
  if (/^node(?:\.exe)?\s+\S*red-proof\.mjs(?:\s|$)/i.test(c)) return 'red-proof';
  if (/^dotnet\s+test\b/i.test(c)) return 'dotnet-test';
  if (/^dotnet\s+(?:build|publish)\b/i.test(c)) return 'dotnet-build';
  if (/^node\s+--test\b/i.test(c)) return 'node-test';
  if (/^(?:npx\s+)?vitest\b/i.test(c)) return 'vitest';
  if (/^(?:npx\s+)?jest\b/i.test(c)) return 'jest';
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:test\b|run\s+test)/i.test(c)) return 'js-test';
  return 'unknown';
}

// The command's exit code is a display step's (`| head`, `; echo done`, `|| true`), so a non-zero code
// says nothing about the check. Any other last step (a `git stash pop`) failing is a real failure.
const SHOW_STEP = /^(?:echo|printf|true|:|Write-Host|Write-Output|exit\s+0)(?:\s|$)/i;
function exitIsDisplay(cmd) {
  const segs = splitSegments(cmd);
  const last = segs[segs.length - 1] || '';
  const words = verificationWords(last);
  if (isSsh(words)) return exitIsDisplay(remoteCommand(words));
  return isDisplaySegment(last) || SHOW_STEP.test(String(last).trim());
}

// The checks in a command whose exit code is hidden: { runners, realExit }, or null when every check's
// exit code is visible. runners: the hidden checks only (a visible one is proved by the exit code).
// realExit: the command's own exit code is a real step's, not a display tail's. A remote command over
// ssh is judged the same way inside.
function hiddenCheckRunners(cmd) {
  const plain = splitSegments(cmd);
  const ops = segmentOps(cmd);
  const runners = [];
  plain.forEach((seg, i) => {
    if (!segmentIsVerify(seg)) return;
    const hidden = !ops || exitHidden(ops, i);
    const words = verificationWords(seg);
    if (isSsh(words)) {
      const inner = remoteCommand(words);
      if (hidden) runners.push(...splitSegments(inner).filter(segmentIsVerify).map(checkRunner));
      else { const nested = hiddenCheckRunners(inner); if (nested) runners.push(...nested.runners); }
    } else if (hidden) runners.push(checkRunner(seg));
  });
  return runners.length ? { runners, realExit: !exitIsDisplay(cmd) } : null;
}

// Display-only consumers after a pipe (grep, head, tail, tee, Select-String …)
// change what is shown, not what was verified: they are not part of a check's
// identity, so a rerun with a different tail clears the same failure (2026-10-12;
// before, `… | head -5` and `… | head -20` were two different failed checks and
// cost whole extra suite runs). Setup/cleanup segments (git stash …) stay in the
// identity: a failed compound command is still retried as a whole.
const DISPLAY_RE = /^(?:grep|egrep|fgrep|rg|head|tail|tee|cat|sort|uniq|wc|cut|tr|less|more|column|findstr|awk|sed\s+-n|Select-String|Select-Object|Out-String|Out-File|Out-Null|Out-Host|Tee-Object|Format-Table|Format-List|ForEach-Object|Where-Object|Measure-Object|sls|select|%|\?)(?:\s|$)/i;
function isDisplaySegment(seg) {
  const s = String(seg).trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '');
  return DISPLAY_RE.test(s);
}
function identitySegments(segs) {
  const kept = segs.filter((s) => !isDisplaySegment(s));
  return kept.length ? kept : segs;
}
// Stream redirections (`2>&1`, `> out.txt`, `2>/dev/null`) do not change the check either.
function stripRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*>&(?:\d+|-)$/.test(w)) continue;                 // 2>&1, >&2
    if (/^(?:&>|\d*>>?|<)$/.test(w)) { i++; continue; }       // > file, 2> file, >> file, < file
    if (/^(?:&>|\d*>>?)\S+$/.test(w) && !/^\d+$/.test(w)) continue; // 2>/dev/null, >out.txt
    out.push(w);
  }
  return out;
}

// Preserve environment overrides in retry identity; they may choose a different
// provider/configuration even when the executable and test arguments are equal.
function verificationIdentity(seg) {
  const environment = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/.exec(String(seg).trim())[0];
  return environment + stripRedirects(verificationWords(seg)).join(' ');
}

// A real-provider run: the affected flow exercised against MySQL or the live API
// (a query inside the db container, a mysql client, an HTTP request to a local
// port, the project's smoke script, or applying a migration). Required after
// the last edit when the outgoing diff adds ExecuteUpdate/ExecuteDelete, raw SQL
// or a migration — InMemory tests cannot prove that code (missed-bugs 2026-09-15).
const PROVIDER_RE = new RegExp(
  '^(' +
  'docker\\s+(compose\\s+)?exec\\s+[^\\n]*\\b(mysql|mariadb|psql|db)\\b|' +
  'mysql(sh)?\\s+-[uhp]|' +
  'curl(\\.exe)?\\s+[^\\n]*(localhost|127\\.0\\.0\\.1|host\\.docker\\.internal)(:\\d{2,5})?/|' +
  'Invoke-(RestMethod|WebRequest)\\s+[^\\n]*(localhost|127\\.0\\.0\\.1)|' +
  '(node|bash|sh|pwsh|powershell|python3?)\\s+\\S*smoke\\S*|' +
  'dotnet\\s+ef\\s+database\\s+update' +
  ')', 'i');

// A connectivity probe proves the database or API is up, not that the changed
// query or write works: `SELECT 1`, `SELECT VERSION()`, `SHOW TABLES`, a health
// or swagger endpoint. The affected query/request must run instead.
const TRIVIAL_SQL = /^(?:select\s+(?:\d+|'[^']*'|version\(\)|now\(\)|database\(\)|user\(\)|current_(?:date|time|timestamp)(?:\(\))?|@@[\w.]+)(?:\s+as\s+\w+)?|show\s+(?:databases|schemas|tables|status|processlist|variables\b.*)|status)$/i;
const TRIVIAL_URL = /^https?:\/\/[^/]+\/(?:health|healthz|ready|readiness|live|liveness|ping|swagger)(?:[/?#].*)?$/i;

function trivialProviderProbe(seg) {
  const sql = /\s-e\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(String(seg));
  if (sql) {
    const statements = (sql[1] ?? sql[2] ?? sql[3] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    if (statements.length && statements.every((s) => TRIVIAL_SQL.test(s))) return true;
  }
  return verificationWords(seg).some((w) => TRIVIAL_URL.test(w));
}

function segmentIsProvider(seg) {
  const command = verificationCommand(seg);
  if (!PROVIDER_RE.test(command)) return false;
  if (trivialProviderProbe(seg)) return false;
  // Plain curl treats HTTP failures as process success. Expected rejections
  // belong in a smoke script that asserts the status and exits on mismatch.
  const words = verificationWords(seg);
  if (/^curl$/i.test(words[0])) {
    // Require the failure option first, so a header/data argument named --fail
    // cannot masquerade as an option. Config files and later transfers can
    // override that option or replace the exit status; use an asserted smoke
    // script for those shapes instead.
    if (!/^(?:--fail(?:-with-body)?|-[sSfL]*f[sSfL]*)$/.test(words[1] || '')) return false;
    const valueOptions = new Set(['-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '-X', '--request', '-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-u', '--user', '-b', '--cookie', '-c', '--cookie-jar', '-A', '--user-agent', '-e', '--referer']);
    const flags = new Set(['--silent', '--show-error', '--location', '--head', '--include', '--show-headers', '--globoff', '--fail', '--fail-with-body']);
    const urls = [];
    for (let i = 2; i < words.length; i++) {
      const word = words[i];
      if (valueOptions.has(word)) { if (++i >= words.length) return false; continue; }
      if (flags.has(word) || /^-[sSfLIig]+$/.test(word)) continue;
      if (word === '--url') { if (++i >= words.length) return false; urls.push(words[i]); continue; }
      // Unsupported option forms are neutral, never guessed. Use an asserted
      // smoke script for compound transfers, config files and advanced options.
      if (word.startsWith('-')) return false;
      urls.push(word);
    }
    return urls.length === 1 && /^https?:\/\/(?:localhost|127\.0\.0\.1|host\.docker\.internal)(?::\d{1,5})?(?:\/|$)/i.test(urls[0]) && !/[{}\[\]]/.test(urls[0]);
  }
  return !words.some((word, index) => /^-sk[a-z]*(?::|=|$)/i.test(word) ||
    (/^-(?:errora[a-z]*|ea)(?::|=|$)/i.test(word) && !/^Stop$/i.test(word.includes(':') ? word.slice(word.indexOf(':') + 1) : words[index + 1] || '')));
}

// Shell writes to code files. Returns the code paths a segment writes (or a
// sentinel like '<patch>' when the write has no named path). Over-approximates
// on purpose: a segment that carries a write indicator counts every code path
// it names.
const WRITE_TOOL = /(^|[\s(])(sed\s+(-[a-zA-Z]*i|--in-place)|tee(\s+-a)?\s|Set-Content|Out-File|Add-Content|WriteAllText|WriteAllLines|AppendAllText|cp\s|mv\s|copy\s|move\s|Copy-Item|Move-Item|csharpier\s+format)/i;
const PATHLESS_WRITE = /(^|[\s(])(git\s+apply|patch\s|dotnet\s+ef\s+migrations\s+add|npm\s+(install|i|uninstall|remove|add|rm)\b|pnpm\s+(add|remove|install)\b|yarn\s+(add|remove)\b|dotnet\s+(add|remove)\s+(package|reference))/i;
// Git operations that replace working-tree content change the code as surely as
// an edit: evidence collected before them no longer describes the source.
const GIT_CONTENT_CHANGE = /(^|[\s(;&|])git(?:\.exe)?(?:\s+-[Cc]\s+\S+)*\s+(?:merge|pull|rebase|cherry-pick|revert|reset|switch|checkout|restore|am|stash(?!\s+(?:list|show)(?=\s|$)))(?=\s|$)/i;
const REDIRECT = /(^|[^0-9&>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
const COPY_PROGRAM = /^(?:cp|copy|copy-item|cpi)$/i;

// A copy writes only its destination; its sources are read. A directory
// destination (no file extension) receives each source under its own name.
// Returns null when the shape is unclear, so the caller stays conservative.
function copyWrites(tokens) {
  let dest, destIndex = -1;
  const sources = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^(?:-destination|-t|--target-directory)$/i.test(t)) { dest = tokens[++i]; destIndex = i; continue; }
    if (/^--target-directory=/i.test(t)) { dest = t.slice(t.indexOf('=') + 1); destIndex = i; continue; }
    if (/^-(?:path|literalpath)$/i.test(t)) { if (tokens[i + 1] !== undefined) sources.push(tokens[++i]); continue; }
    if (t.startsWith('-')) continue;
    sources.push(t);
  }
  if (destIndex === -1) dest = sources.pop();
  if (dest === undefined || !sources.length) return null;
  const target = stripQuotes(dest).replace(/[\\/]+$/, '');
  if (/\.[A-Za-z0-9]+$/.test(target.split(/[\\/]/).pop())) return [target];
  return sources.map(s => target + '/' + stripQuotes(s).split(/[\\/]/).pop());
}

// A plain move to a fetched remote ref (`git checkout --detach FETCH_HEAD`, `git switch
// --detach origin/staging`): it shows upstream code and writes none of its own. Any other
// option (-b, -f, --, a pathspec, git -c, GIT_* variables) is an ordinary git change.
const REMOTE_REF = /^(?:FETCH_HEAD|(?:refs\/remotes\/)?(?:origin|upstream)\/\S+|refs\/remotes\/\S+)$/;
function remoteCheckout(seg) {
  const words = tokenize(String(seg).trim());
  if (!/^git(?:\.exe)?$/i.test(String(words[0] || '').split(/[\\/]/).pop())) return false;
  let i = 1;
  while (words[i] === '-C') i += 2;
  const sub = String(words[i] || '').toLowerCase();
  if (sub !== 'checkout' && sub !== 'switch') return false;
  const refs = [];
  for (const w of stripRedirects(words.slice(i + 1))) {
    if (/^(?:-q|--quiet|--detach|--progress|--no-progress)$/.test(w) || (sub === 'switch' && w === '-d')) continue;
    if (w.startsWith('-')) return false;
    refs.push(w);
  }
  return refs.length === 1 && REMOTE_REF.test(refs[0]);
}

// base: the folder the segment runs in, for relative names (see inFolder).
function segmentEditPaths(seg, base) {
  const out = [];
  let m;
  // A command sent over ssh runs on another machine: its git checkout or file writes change nothing
  // here (2026-11-08: a checkout on the remote test machine blocked two stops here). Only a local
  // redirection of its output can write a file here.
  if (/^(?:ssh|scp)(?:\.exe)?$/i.test(String(tokenize(seg)[0] || '').split(/[\\/]/).pop())) {
    const unquoted = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    REDIRECT.lastIndex = 0;
    while ((m = REDIRECT.exec(unquoted)) !== null) if (isCodePath(inFolder(m[2], base))) out.push(stripQuotes(m[2]));
    return [...new Set(out)];
  }
  REDIRECT.lastIndex = 0;
  while ((m = REDIRECT.exec(seg)) !== null) {
    if (isCodePath(inFolder(m[2], base))) out.push(stripQuotes(m[2]));
  }
  if (WRITE_TOOL.test(seg)) {
    const tokens = tokenize(seg);
    const program = String(tokens[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
    const written = COPY_PROGRAM.test(program) ? copyWrites(tokens) : null;
    for (const t of written || tokens) if (isCodePath(inFolder(t, base))) out.push(stripQuotes(t));
  }
  for (const t of deletedPaths(seg)) if (isCodePath(inFolder(t, base))) out.push(stripQuotes(t));
  if (PATHLESS_WRITE.test(seg) || formatterWrites(seg)) out.push('<generated>');
  if (GIT_CONTENT_CHANGE.test(seg)) out.push(remoteCheckout(seg) ? '<git-remote>' : '<git>');
  return [...new Set(out)];
}

// A deleted code file changes the code like an edit; a formatter or fixer rewrites the files it is
// given (2026-11-12, audit H14: neither counted, and `eslint --fix` even passed as a check). Judged
// by the program that runs, never by text inside quotes.
const DELETE_PROGRAM = /^(?:rm|rmdir|rd|del|erase|ri|remove-item|rimraf|unlink)$/;
// PowerShell options whose value is not a path.
const VALUE_OPTION = /^-(?:value|encoding|itemtype|filter|include|exclude|inputobject|delimiter|stream|width|erroraction|ea|warningaction|wa)$/i;
function programArgs(seg) {
  const s = String(seg).trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '')
    .replace(/^(?:sudo|time|env|command|nohup|timeout\s+\d+[smh]?)\s+/, '').replace(/^&\s+/, '');
  const words = tokenize(s);
  return { program: String(words[0] || '').split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase(), args: words.slice(1) };
}
function pathArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTION.test(args[i])) { i++; continue; }
    if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}
function gitSubcommand(args) {
  let i = 0;
  while (i < args.length && /^-[Cc]$/.test(args[i])) i += 2;
  return { sub: String(args[i] || '').toLowerCase(), rest: args.slice(i + 1) };
}
function deletedPaths(seg) {
  const { program, args } = programArgs(seg);
  if (DELETE_PROGRAM.test(program)) return pathArgs(args);
  if (program === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if (sub === 'rm' && !rest.includes('--cached')) return pathArgs(rest);   // --cached keeps the file
  }
  return [];
}
function formatterWrites(seg) {
  const words = verificationWords(seg);
  if (!words.length) return false;
  const { executable: name, args } = verificationTarget(words[0], words.slice(1));
  const has = (re) => args.some((a) => re.test(a));
  if (has(/^--(?:help|version)$/)) return false;
  if (name === 'dotnet') {
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'format') return !has(/^--verify-no-changes$/);
    if (sub === 'csharpier') return !/^check$/i.test(args[1] || '') && !has(/^--check$/);
    return false;
  }
  if (name === 'csharpier') return !/^check$/i.test(args[0] || '') && !has(/^--check$/);
  if (name === 'prettier') return has(/^(?:--write|-w)$/);
  if (name === 'eslint') return has(/^--fix$/);
  // `npx <tool> --fix|--write`, `npm run lint -- --fix`.
  return /^(?:npx|npm|pnpm|yarn|bun)$/.test(String(words[0]).toLowerCase()) && has(/^--(?:fix|write)$/);
}

// Every file a shell segment writes or deletes, code or not, for check-lock-guard: any change to a
// file git tracks or would add voids a running source-bound check (2026-11-12, audit H14: only code
// paths were refused, so a note or a spec written during a suite lost the whole run). Paths as written.
const NULL_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|tty)|nul:?|\$null|con:?)$/i;
const MOVE_PROGRAM = /^(?:mv|move|move-item|mi|ren|rename|rename-item|rni)$/;
const TOUCH_PROGRAM = /^(?:touch|new-item|ni)$/;
const CONTENT_PROGRAM = /^(?:set-content|sc|add-content|ac|out-file|clear-content|clc)$/;
// Same length as the text, quoted characters blanked: an operator inside quotes is no redirection.
function blankQuoted(s) {
  let out = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { out += ch === q ? ch : '_'; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}
function redirectTargets(seg) {
  const s = String(seg), b = blankQuoted(s), out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== '>') continue;
    if (b[i + 1] === '>') i++;
    if (b[i + 1] === '&') continue;                       // 2>&1, >&2
    let j = i + 1;
    while (j < b.length && /\s/.test(b[j])) j++;
    let k = j;
    if (b[j] === '"' || b[j] === "'") { k = b.indexOf(b[j], j + 1); k = k === -1 ? b.length : k + 1; }
    else while (k < b.length && !/[\s;&|<>()]/.test(b[k])) k++;
    const target = stripQuotes(s.slice(j, k));
    if (target && !NULL_TARGET.test(target)) out.push(target);
    i = Math.max(i, k - 1);
  }
  return out;
}
function segmentWritePaths(seg) {
  const out = redirectTargets(seg);
  const { program, args } = programArgs(seg);
  const tokens = [program, ...args];
  if (DELETE_PROGRAM.test(program) || MOVE_PROGRAM.test(program) || program === 'tee' || program === 'tee-object') out.push(...pathArgs(args));
  else if (TOUCH_PROGRAM.test(program)) { if (!args.some((a, i) => /^-itemtype$/i.test(args[i - 1] || '') && /^directory$/i.test(a))) out.push(...pathArgs(args)); }
  else if (COPY_PROGRAM.test(program)) out.push(...(copyWrites(tokens) || pathArgs(args)));
  else if (program === 'sed' && args.some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) {
    // The script is the first plain argument unless -e/-f name it.
    const named = args.some((a) => /^(?:-e|-f|--expression|--file)(?:=|$)/.test(a));
    const files = [];
    for (let i = 0; i < args.length; i++) {
      if (/^(?:-e|-f|--expression|--file)$/.test(args[i])) { i++; continue; }
      if (!args[i].startsWith('-')) files.push(args[i]);
    }
    out.push(...(named ? files : files.slice(1)));
  } else if (CONTENT_PROGRAM.test(program)) {
    const named = args.findIndex((a) => /^-(?:path|literalpath|filepath)$/i.test(a));
    const first = pathArgs(args)[0];
    if (named !== -1 && args[named + 1] !== undefined) out.push(args[named + 1]);
    else if (first !== undefined) out.push(first);
  } else if (program === 'git') {
    const { sub, rest } = gitSubcommand(args);
    if ((sub === 'rm' && !rest.includes('--cached')) || sub === 'mv') out.push(...pathArgs(rest));
  }
  for (const m of String(seg).matchAll(/(?:WriteAll(?:Text|Lines|Bytes)|AppendAll(?:Text|Lines))\(\s*(["'])([^"']+)\1/gi)) out.push(m[2]);
  return [...new Set(out.map(stripQuotes).filter(Boolean))];
}
const GIT_CHANGE = /^<git(?:-remote)?>$/;

// Resolve simple variables assigned earlier in the same command (`W=C:/tmp/x; cp a
// "$W/b.js"`, or PowerShell `$W = "..."`), so a path is judged by its real location.
// Unknown variables stay literal and still count as possible code paths.
function expandVariables(segs) {
  const vars = new Map();
  const expand = s => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => vars.has(name) ? vars.get(name) : m);
  return segs.map(seg => {
    const a = /^\s*(?:export\s+)?\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]+)\s*$/.exec(String(seg));
    if (a) { vars.set(a[1], stripQuotes(expand(a[2]))); return String(seg); }
    return expand(String(seg));
  });
}

// Every git content change is '<git>' here: a move to a remote ref still changes the
// working tree (check-lock-guard refuses it while a check runs on that tree).
function shellEditPaths(cmd) {
  const out = [];
  for (const seg of expandVariables(splitSegments(cmd))) out.push(...segmentEditPaths(seg).map((p) => GIT_CHANGE.test(p) ? '<git>' : p));
  return [...new Set(out)];
}

// check-lock-guard: every file a shell command writes or deletes, resolved in the folder its segment
// runs in (a `cd` earlier in the command, else the tool's folder). opts: { cwd, tool, home, tmp }.
// A path that cannot be resolved literally (a variable, a glob) is left out, as before.
function shellWriteTargets(cmd, opts = {}) {
  const records = parseCommand(cmd, opts);
  const texts = expandVariables(records.map((r) => r.text));
  const out = [];
  records.forEach((rec, i) => {
    for (const p of segmentWritePaths(texts[i])) {
      const resolved = shellPath(p, rec.cwd == null ? opts.cwd : rec.cwd, opts);
      if (resolved) out.push({ path: resolved, shown: p });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Did a verify command PASS? Judged from its recorded result.
// ---------------------------------------------------------------------------

const FAIL_MARKERS = [
  /^Exit code [1-9]\d*/m,
  /Build FAILED/i,
  /\b[1-9]\d* Error\(s\)/,
  /\berror (CS|MSB|TS|NU|NETSDK)\d{3,5}\b/,
  /\bFailed!\s/,                        // dotnet test summary on failure
  /Test Run Failed/i,
  /\b[1-9]\d* failed\b/i,               // pytest / vitest / jest tallies
  /npm ERR!|npm error\b|ELIFECYCLE/,
  /error during build/i,
  /✖\s+\d+\s+problems?\s*\([1-9]\d*\s+errors?\b/, // warnings are not errors
  /Traceback \(most recent call last\)/,
  /FAILED \(failures=/,
  /(?:BUILD|TEST|TSC|ESLINT|LINT|TYPECHECK|SETUP|CLEANUP)_EXIT=(?:[1-9]|-\d)/,
  /The build failed\./i,
  // red-proof.mjs proved nothing. Its exit code is lost behind a pipe (`… | tail`), so its own verdict counts.
  /RED-PROOF: (?:NOT PROVED|NOT RED|SETUP|TIMEOUT|REMOTE-DOWN|ENVIRONMENT)\b/,
  /^\s*GREEN ✗/m,
  // One failed test, as each runner lists it: a display tail can keep these lines and cut the summary
  // (2026-11-12, audit H4). vitest/jest ` FAIL  file > case` and `× case`; dotnet `Failed Name [12 ms]`
  // and xUnit `[FAIL]`; node:test `✖ case` (not eslint's `✖ N problems`, whose warnings are no failure),
  // its `ℹ fail N` summary and TAP `not ok` (not a TODO/SKIP one).
  /^\s*FAIL\s+\S/m,
  /^\s*× \S/m,
  /^\s*Failed [\w.`+<>,-]+(?:\([^)\n]*\))? \[/m,
  /\[FAIL\]/,
  /^\s*✖ (?!\d+ problems?\b)\S/m,
  /^\s*ℹ fail [1-9]/m,
  /^not ok \d+(?![^\n]*#\s*(?:TODO|SKIP)\b)/m,
  // MSBuild's own error line for any analyzer or generator code (`x.cs(23,5): error RMG012: …`): a build
  // with one passed behind `| grep … | head` in a real session (2026-11-12).
  /\): error [A-Z]{2,}\d{2,}\s*:/,
];
// The tool's own exit-code line: no proof either way when something after the check hides its code.
const EXIT_LINE = FAIL_MARKERS[0];

// What each runner prints only when all of its tests passed. Behind a display tail the summary is the
// only proof left (2026-11-12, audit H4); a runner with no marker here gets no credit there.
const PASS_MARKERS = {
  vitest: [/^\s*Tests\s+\d+ passed\b/m],
  jest: [/^Tests:\s+(?:\d+ (?:skipped|todo), )*\d+ passed, \d+ total/m],
  'node-test': [/^\s*ℹ fail 0\s*$/m, /^# fail 0\s*$/m],
  'dotnet-test': [/\bPassed!\s/, /\bFailed:\s+0\b/, /^\s*Test Run Successful\./m],
  'dotnet-build': [/\bBuild succeeded\b/, /^\s*0 Error\(s\)/m],
  'red-proof': [/^\s*GREEN ✓/m],
};
PASS_MARKERS['js-test'] = [...PASS_MARKERS.vitest, ...PASS_MARKERS.jest, ...PASS_MARKERS['node-test']];
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function resultText(block, entry) {
  let s = '';
  if (block) {
    if (typeof block.content === 'string') s += block.content;
    else if (Array.isArray(block.content)) {
      for (const c of block.content) if (c && typeof c.text === 'string') s += c.text + '\n';
    }
  }
  const t = entry && entry.toolUseResult;
  if (t && typeof t === 'object') {
    if (typeof t.stdout === 'string') s += '\n' + t.stdout;
    if (typeof t.stderr === 'string') s += '\n' + t.stderr;
    if (typeof t.task?.output === 'string') s += '\n' + t.task.output;
  }
  return s;
}

function verifyFailed(text, isError) {
  if (isError) return true;
  const t = String(text || '').replace(ANSI, '');
  return FAIL_MARKERS.some((re) => re.test(t));
}

function userRejected(block, entry) {
  if (entry && entry.toolDenialKind) return true;
  const t = block && typeof block.content === 'string' ? block.content : '';
  return /doesn't want to proceed|user rejected|was rejected/i.test(t);
}

// ---------------------------------------------------------------------------
// Transcript loading. The whole session counts, read line by line, never as one
// string (2026-11-12, audit H17: above 80 MB only the last 16 MB was read, so an
// older reviewer run, check, failure or edit vanished; one session is 426 MB).
// What the scan learned is kept in a small cache per transcript (see below), so
// a later hook call reads only the bytes appended since.
// ---------------------------------------------------------------------------

// Each complete ('\n'-ended) line of the bytes [start, end) of an open file, to onLine. Returns the
// offset after the last complete line, and the bytes after it (a last line still being written, or a
// file that does not end with a newline) for the caller to judge.
const READ_CHUNK = 8 * 1024 * 1024;
// The host's copies of API requests are most of a long transcript's bytes and never events (see
// feedLine): such a line is passed over before it is even decoded. So are its backups of edited files
// (`file-history-snapshot` / `-delta`: no message, never an event; 2026-11-12: 256 of a 450 MB session).
const REQUEST_COPY = Buffer.from('{"type":"api-request');
const HISTORY_COPY = Buffer.from('{"type":"file-history-');
// onChunk(done), when given, runs after each chunk, when every line before done has been judged.
function readLines(fd, start, end, onLine, onChunk) {
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK, end - start)));
  let pos = start, done = start, pieces = [];
  while (pos < end) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
    if (!(n > 0)) break;
    const data = buf.subarray(0, n);
    let from = 0, nl;
    while ((nl = data.indexOf(10, from)) !== -1) {
      const bytes = pieces.length ? Buffer.concat([...pieces, data.subarray(from, nl)]) : data.subarray(from, nl);
      pieces = [];
      from = nl + 1;
      done = pos + from;
      if (bytes.length >= REQUEST_COPY.length && bytes.compare(REQUEST_COPY, 0, REQUEST_COPY.length, 0, REQUEST_COPY.length) === 0) continue;
      if (bytes.length >= HISTORY_COPY.length && bytes.compare(HISTORY_COPY, 0, HISTORY_COPY.length, 0, HISTORY_COPY.length) === 0) continue;
      onLine(bytes.toString('utf8'), done);
    }
    if (from < n) pieces.push(Buffer.from(data.subarray(from)));   // the buffer is reused: keep a copy
    pos += n;
    if (onChunk) onChunk(done);
  }
  return { done, tail: pieces.length ? Buffer.concat(pieces).toString('utf8') : '' };
}

function readBytes(fd, start, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  const n = length > 0 ? fs.readSync(fd, buf, 0, length, start) : 0;
  return buf.subarray(0, n);
}

// ---------------------------------------------------------------------------
// Scan: last qualifying code edit, last PASSING verify, last FAILED verify, and
// last gate verdict line — all as sequence numbers in true block order.
//
// Edits and verifies are credited when their RESULT arrives (a tool use the
// user rejected, or an Edit that errored, changed nothing). A shell command
// that both edits and verifies is ordered by segment: `sed -i … && dotnet
// build` verifies AFTER its edit; `dotnet build; sed -i …` does not.
// ---------------------------------------------------------------------------

// A line can matter only if it holds one of these. Plain substring searches: one regex alternation
// over long result lines cost seconds on a 449 MB session (2026-11-12).
// The last four (2026-11-12): a reviewer's hand-back, a NOTE outcome line, and a push command handed over
// in a code block (see "Reviewer notes" below). A report's RECOMMEND line is in a tool result: it passes already.
const MAYBE_PARTS = ['"tool_use"', '"tool_result"', 'GATE:', 'REVIEW:', 'CHECK RETIRED:', 'PROBE EXPECTED:', '"commandMode":"task-notification"', '<task-notification>',
  'Subagent hand-back', 'NOTE ', 'git push', 'gh pr create'];
const maybeLine = (l) => MAYBE_PARTS.some((part) => l.includes(part));
// A message the user may have typed: a user entry, or a prompt the host queued while the assistant worked.
const maybeHuman = (l) => l.includes('"type":"user"') || l.includes('"commandMode":"prompt"');
const GATE_RE = /^GATE:\s*(PASS|FAIL)\b/gm;
const REVIEW_RE = /^REVIEW:\s*(PASS|FAIL)\b/gm;
// An explicit, auditable retirement of a completed failed check that cannot
// legitimately pass (a typo, an obsolete target). It clears that failure only
// after the named replacement check passes later; see gate command-evidence.md.
// The Sanad Step 3.5 reviewer prompt starts with this marker; only such an agent
// run, launched after the last change and completed, backs a REVIEW verdict.
const REVIEWER_PROMPT = /^\s*You are the independent reviewer\b/i;
const RETIRE_RE = /^CHECK RETIRED:\s*(\{.*\})\s*$/gm;
// A review probe: a test written to FAIL because it proves someone else's bug
// (e.g. a PR under review). Declared after its red run, it quiets the STOP hook
// only — the push guard still counts it as a failure, so nothing ships red.
const PROBE_RE = /^PROBE EXPECTED:\s*(\{.*\})\s*$/gm;
function commandIdentity(text) { return identitySegments(splitSegments(String(text || ''))).map(verificationIdentity).join(' ; ').trim().replace(/\s+/g, ' '); }
// A command named in a CHECK RETIRED / PROBE EXPECTED line: its identity, or the text
// exactly as written. The stop message shows a check's identity without its quotes, so
// that shown text, read again as a command, splits a quoted `a && b` or `s/x;y/` into
// other segments and never matched (2026-11-09). The shown text itself is compared as is.
function namedCommand(text) {
  return [commandIdentity(text), String(text || '').trim().replace(/\s+/g, ' ')].filter(Boolean);
}

function verificationResult(block, entry) {
  const t = entry.toolUseResult || {};
  const text = resultText(block, entry);
  const exit = t.task?.exitCode ?? t.exitCode ?? t.exit_code;
  if (verifyFailed(text, block.is_error === true) || t.interrupted === true ||
      (exit !== undefined && exit !== null && Number(exit) !== 0) ||
      /^(failed|killed|cancelled|canceled)$/.test(t.task?.status || '')) return 'failed';
  if (stillRunning(t, text)) return 'pending';
  return 'passed';
}
function stillRunning(t, text) {
  return !!(t.backgroundTaskId || t.background_task_id ||
    /^(running|pending|queued)$/.test(t.task?.status || '') ||
    /^(timeout|not_ready)$/.test(t.retrieval_status || '') ||
    /running in background|running in the background|command still running/i.test(text));
}

// A check whose exit code was hidden (see hiddenCheckRunners): a failure line fails it, every check's
// own pass marker passes it, anything else proves nothing ('none': no credit, no failure). A non-zero
// exit still fails it when the last step is a real one (a setup or cleanup step failed).
function hiddenVerificationResult(block, entry, hidden) {
  const t = entry.toolUseResult || {};
  const text = resultText(block, entry).replace(ANSI, '');
  const exit = t.task?.exitCode ?? t.exitCode ?? t.exit_code;
  const nonZero = block.is_error === true || (exit !== undefined && exit !== null && Number(exit) !== 0) || t.task?.status === 'failed' || EXIT_LINE.test(text);
  if (FAIL_MARKERS.some((re) => re !== EXIT_LINE && re.test(text)) || t.interrupted === true ||
      /^(killed|cancelled|canceled)$/.test(t.task?.status || '') || (hidden.realExit && nonZero)) return 'failed';
  if (stillRunning(t, text)) return 'pending';
  const runners = hidden.runners || [];
  return runners.length && runners.every((r) => (PASS_MARKERS[r] || []).some((re) => re.test(text))) ? 'passed' : 'none';
}

function isEvidenceCommand(segment) {
  const words = tokenize(segment);
  // The installed helper lives under some user's .claude folder; any other evidence.mjs is a stray script.
  return words.length === 4 && /^node(?:\.exe)?$/i.test((words[0] || '').split(/[\\/]/).pop()) &&
    /(?:^|\/)\.claude\/skills\/gate\/scripts\/evidence\.mjs$/i.test((words[1] || '').replace(/\\/g, '/')) && words[2] === '--spec';
}

// A receipt's command is a list of words, not a shell line. A run on the test machine is judged from
// those words as they are: `ssh <host> "<remote command>"`, the remote command its last word. Rebuilt as
// one quoted line and split into words again, a remote command with quotes of its own
// (`… && (for /f "usebackq …" %a in (…) do @set "%a=%b") && dotnet test …`) kept a backslash before each
// quote, was never split at `&&`, and every passing run of it had no receipt, so it read as FAILED
// (2026-11-11: each backend run on the test machine, since its database settings came in that way).
function receiptIsVerify(executable, args) {
  const words = [executable, ...args];
  if (isSsh(words)) {
    const inner = remoteCommand(words);
    return !!inner && splitSegments(inner).some(segmentIsVerify);
  }
  return segmentIsVerify(words.map(word => '"' + word.replace(/"/g, '\\"') + '"').join(' '));
}

function checkReceipt(block, entry) {
  for (const line of resultText(block, entry).split('\n')) {
    if (!line.startsWith('CHECK_COMPLETED ')) continue;
    try {
      const record = JSON.parse(line.slice('CHECK_COMPLETED '.length));
      if (!/^[a-f0-9-]{36}$/i.test(record.runId || '') || typeof record.cwd !== 'string' || typeof record.executable !== 'string' || !Array.isArray(record.args) || record.args.some(arg => typeof arg !== 'string') || !['passed', 'failed'].includes(record.status)) continue;
      if (!receiptIsVerify(record.executable, record.args)) continue;
      const invalidTarget = invalidVerificationTarget(record.executable, record.args, record.cwd);
      const passed = !invalidTarget && record.status === 'passed' && record.nativeExitCode === 0 && !record.reason && !record.signal && verificationResult(block, entry) === 'passed';
      return { key: record.cwd.replace(/\\/g, '/').toLowerCase() + '\n' + JSON.stringify([record.executable, ...record.args]), outcome: passed ? 'passed' : 'failed', record };
    } catch { /* incomplete or forged output is not a completed check */ }
  }
  return null;
}

// A host-written background completion: { id, status, exitCode, file } or null.
const NOTE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
function parseNotification(text) {
  const field = name => (new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(text) || [])[1];
  const id = field('task-id');
  if (!id) return null;
  const exit = /\(exit code (-?\d+)\)/.exec(field('summary') || '');
  // An agent's finish notice also carries its final report (2026-11-12: the reviewer's notes are read from it).
  const from = text.indexOf('<result>'), to = text.lastIndexOf('</result>');
  return { id, status: field('status') || '', exitCode: exit ? Number(exit[1]) : undefined, file: field('output-file'), summary: field('summary') || '', result: from !== -1 && to > from ? text.slice(from + 8, to) : '' };
}

// The host delivers a completion notice as its own attachment entry, or, when
// it lands while the user is typing, as the same tags at the start of the
// user's next message (plain text, possibly several notices). Both count.
function taskNotifications(entry) {
  const a = entry.attachment;
  if (a && a.commandMode === 'task-notification' && typeof a.prompt === 'string') {
    const note = parseNotification(a.prompt);
    return note ? [note] : [];
  }
  if (entry.type !== 'user' || !entry.message) return [];
  const c = entry.message.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) && c.length > 0 && c.every(b => b && b.type === 'text' && typeof b.text === 'string') ? c.map(b => b.text).join('\n')
    : '';
  if (!text.includes('<task-notification>')) return [];
  return [...text.matchAll(NOTE_RE)].map(m => parseNotification(m[1])).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Reviewer notes (2026-11-12). Rule 5: every note a second AI reviewer writes is fixed, or the user
// decides it; the author never decides alone. As text only, the rule did not hold: three reviewer notes
// were dropped without being shown to the user, and a teammate then reported the same things as bugs.
// A note is a finding line in a reviewer report. It stays open until a later assistant text line says
//   NOTE <n>: fixed — <what changed and its test>
//   NOTE <n>: user — "<words the user typed after that report>"
// The stop gate refuses a passing verdict, and the push guard a push, while a note is open.
// ---------------------------------------------------------------------------

// A finding line: an optional list marker, optional bold, then the kind and its separator. "No Blocker
// or Bug found" and "Bugs: none" do not start with a kind followed by its separator, so they are no note.
// A short qualifier may sit before the separator: real reports write `Gap (low) —`, `Bug (rare race) —`
// and `EXTRA TEST (optional): …` (2026-11-12, 19 such findings in one session would have been dropped).
const QUALIFIER = '(?:\\*\\*|__)?(?:\\s*\\([^()\\n]{1,80}\\))?(?:\\*\\*|__)?';
const NOTE_LINE = new RegExp('^(\\s*)((?:[-*•]|\\d{1,3}[.)])\\s+)?(?:(?:\\*\\*|__)\\s*)?' +
  '(?:(Blocker|Bug|Gap|Question)' + QUALIFIER + '(?:\\s+[—–](?:\\s|$)|\\s+-(?:\\s|$)|\\s*:)|(EXTRA TEST)' + QUALIFIER + ':)');
const FENCE_LINE = /^\s*(```|~~~)/;
const NOTE_CHARS = 300;
// Each note of a report, in order: { kind, text }. Text: the line without its list marker, plus its
// more-indented continuation lines, cut to 300 characters. A note with nothing after its separator
// (`EXTRA TEST:` over a list) takes the lines below it up to a blank line. Lines in a code block are examples.
function reportNotes(report) {
  const rows = String(report || '').replace(/\r/g, '').split('\n');
  const indent = (l) => /^\s*/.exec(l)[0].length;
  const notes = [];
  let fence = '';
  for (let i = 0; i < rows.length; i++) {
    const f = FENCE_LINE.exec(rows[i]);
    if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = ''; continue; }
    if (fence) continue;
    const m = NOTE_LINE.exec(rows[i]);
    if (!m) continue;
    const parts = [rows[i].slice(m[1].length + (m[2] || '').length)];
    const said = rows[i].slice(m[0].length).trim();
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (!next.trim() || NOTE_LINE.test(next) || FENCE_LINE.test(next) || (said && indent(next) <= indent(rows[i]))) break;
      parts.push(next);
    }
    notes.push({ kind: m[3] || m[4], text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS) });
  }
  return notes;
}

// A helper's hand-back: { id, report } or null. The host writes it twice in one session: queued (an
// attachment that starts with `<agent-message from="…">`) and delivered (a user entry that starts with
// "Another Claude session sent a message:"); the newest host also puts an indented note above the frame
// (2026-11-12: 66 of 125 reviewer runs had only the delivered copy). The frame line is at column zero
// and the agent's tag comes before it; every report line is indented by two spaces, so the first line
// at column zero (the closing tag) ends the report, and a report cannot forge a frame of its own.
const HAND_BACK = '[Subagent hand-back]';
const HAND_BACK_FRAME = /^\[Subagent hand-back\]/m;
function handBack(text) {
  const s = String(text || '');
  const frame = HAND_BACK_FRAME.exec(s);
  const tag = frame ? /<agent-message from="([^"]+)">/.exec(s.slice(0, frame.index)) : null;
  if (!tag) return null;
  const start = s.indexOf('\n', frame.index);
  const out = [];
  if (start !== -1) {
    for (const line of s.slice(start + 1).split('\n')) {
      if (line.startsWith('  ')) out.push(line.slice(2));
      else if (!line.trim()) out.push('');
      else break;
    }
  }
  return { id: tag[1], report: out.join('\n') };
}

// A finish notice sent while the agent still waits on its own background work: it has not reported, so
// it neither completes the review nor carries a report (2026-11-12, seen in a real session). Matched where
// the host writes it (the start of the result, or the summary), so a report that quotes the words still counts.
const INTERIM_RESULT = /^\s*This agent has not reported yet\b/i;
const INTERIM_SUMMARY = /\bis waiting on its own background work\b/i;
const interimNotice = (note) => INTERIM_RESULT.test(note.result || '') || INTERIM_SUMMARY.test(note.summary || '');
// A reviewer run is complete: credit it for the push gate and the task timer.
function creditReviewer(st, agent, seq, at) {
  reviewDone(st, agent.at, String(at || ''));
  if (agent.launch > st.res.lastReviewerRun) { st.res.lastReviewerRun = agent.launch; st.res.lastReviewerResult = seq; }
}

// The other engine's report is read from a file: a tool result with a line that starts with its
// verdict. The report runs from that line on. The Read tool shows a number and a tab before each line.
const RECOMMEND_LINE = /^RECOMMEND: (?:PASS|FAIL)(?![|\w])/m;
const READ_NUMBERED = /^\s*\d+[\t→]RECOMMEND: (?:PASS|FAIL)(?![|\w])/m;
function recommendReport(text) {
  let s = String(text || '');
  if (!s.includes('RECOMMEND: ')) return '';
  if (!RECOMMEND_LINE.test(s) && READ_NUMBERED.test(s)) s = s.split('\n').map((l) => l.replace(/^\s*\d+[\t→]/, '')).join('\n');
  const m = RECOMMEND_LINE.exec(s);
  return m ? s.slice(m.index) : '';
}

// key: one reviewer run ('<agent id>@<launch seq>'). A run can reach the transcript twice, as its
// hand-back and in its finish notice; the notice may hold the same report, or only a pointer to the
// hand-back ("…delivered to you as a message…", "…has not reported yet…"), and either can come first.
// So a later copy adds only the notes that run has not given yet (reportKeys: '<key>#<note number>').
// A report without a key (a file the author shows) adds only notes whose text is new in the session,
// so the same file shown twice gives each note once.
// at: the entry's time. A report from before the lock's start time (st.since) gives no notes at all, so a
// running session is not blocked by its history; a report with no time counts (follow-up A).
function addReport(st, report, key, seq, at) {
  if (typeof st.since === 'number') { const t = Date.parse(at || ''); if (Number.isFinite(t) && t < st.since) return; }
  const notes = st.res.reviewNotes;
  for (const note of reportNotes(report)) {
    const seen = key ? st.reportKeys.some((k) => k.startsWith(key + '#') && (notes[Number(k.slice(key.length + 1)) - 1] || {}).text === note.text)
      : notes.some((n) => n.text === note.text);
    if (seen) continue;
    notes.push({ n: notes.length + 1, kind: note.kind, text: note.text, outcome: null });
    st.noteSeqs.push(seq);
    if (key) st.reportKeys.push(key + '#' + notes.length);
  }
}

// What the user typed, compared without case and with spaces collapsed (curly quotes made straight).
function userText(s) {
  return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}
// The words of a message the user typed, or null. This host marks the user's own turns with
// origin.kind "human" (queued while the assistant worked: humanTurn). Tool results, hook messages,
// system reminders, notices and a helper's hand-back are not the user. An older host writes no origin:
// then a message the host or a tool wrote starts with a tag or a fixed phrase.
const HOST_BLOCKS = /<(task-notification|system-reminder)>[\s\S]*?<\/\1>/g;
function humanWords(entry) {
  const a = entry.attachment;
  if (a && typeof a === 'object') {
    if (a.type !== 'queued_command' || a.commandMode !== 'prompt' || a.isMeta || typeof a.prompt !== 'string') return null;
    const human = a.origin && typeof a.origin === 'object' ? a.origin.kind === 'human' : a.humanTurn === true;
    return human && !a.prompt.startsWith('<agent-message') ? a.prompt.replace(HOST_BLOCKS, '').trim() || null : null;
  }
  if (entry.type !== 'user' || !entry.message || entry.message.role !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
  const c = entry.message.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) && c.length && c.every((b) => b && (b.type === 'text' || b.type === 'image')) ? c.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n')
    : null;
  if (text === null) return null;
  const own = text.replace(HOST_BLOCKS, '').trim();
  if (entry.origin && typeof entry.origin === 'object') return entry.origin.kind === 'human' && own ? own : null;
  return own && !/^(?:<|\[Request interrupted|Stop hook feedback|Caveat:)/.test(own) && !HAND_BACK_FRAME.test(own) ? own : null;
}

// The oldest report that still has an open note: only the user's words after it can close a note.
function oldestOpenReport(st) {
  let from = Infinity;
  st.res.reviewNotes.forEach((n, i) => { if (!n.outcome && st.noteSeqs[i] < from) from = st.noteSeqs[i]; });
  return from;
}
// The user's words are kept only while a note is open, and at most about 60 000 characters (the
// newest), so the saved scan state stays small.
const USER_WORDS_CHARS = 60000;
function pruneUserWords(st) {
  const from = oldestOpenReport(st);
  st.userWords = from === Infinity ? [] : st.userWords.filter((w) => w.seq > from);
  let total = 0;
  for (let i = st.userWords.length - 1; i >= 0; i--) {
    total += st.userWords[i].text.length;
    if (total > USER_WORDS_CHARS) { st.userWords = st.userWords.slice(i + 1); break; }
  }
}
function humanTurn(st, words) {
  const seq = ++st.seq;
  st.res.turnClaim = false;
  if (oldestOpenReport(st) === Infinity) return;
  st.userWords.push({ seq, text: userText(words).slice(0, USER_WORDS_CHARS) });
  pruneUserWords(st);
}

// An outcome line in an assistant text (code blocks already removed): optional list marker, bold or
// backtick, then `NOTE <n>: fixed|user —`.
const OUTCOME_RE = /^[ \t]*(?:[-*•][ \t]+)?(?:\*\*|`)?NOTE[ \t]+(\d{1,4})[ \t]*:[ \t]*(fixed|user|Fixed|User|FIXED|USER)\b(?:\*\*)?[ \t]*[—–-][ \t]*(.*)$/gm;
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// Each outcome line of a text (code blocks removed) on notes; seqs: each note's report seq; words: the
// user's words kept for open notes. A note already closed stays as it is, so applying twice changes nothing.
function applyOutcomes(notes, seqs, words, plain) {
  if (!notes.length || !/NOTE[ \t]+\d/.test(plain)) return false;
  for (const m of plain.matchAll(OUTCOME_RE)) applyOutcome(notes, seqs, words, Number(m[1]), m[2], m[3]);
  return true;
}
// The notes still open once the final text's own outcome lines count: the host hands the stop gate that
// text before the transcript may hold it (2026-11-12, follow-up C). The scan result is not changed.
function openNotesAfter(r, text) {
  const notes = (r && Array.isArray(r.reviewNotes) ? r.reviewNotes : []).map((n) => ({ ...n }));
  applyOutcomes(notes, (r && r.reviewNoteSeqs) || [], (r && r.reviewUserWords) || [], String(text || '').replace(FENCED, ''));
  return notes.filter((n) => !n.outcome);
}
function applyOutcome(notes, seqs, words, n, kind, rest) {
  const note = notes[n - 1];
  if (!note || note.outcome) return;
  const said = String(rest).replace(/[`*\s]+$/, '').trim();
  if (kind.toLowerCase() === 'fixed') {
    // `<what changed and its test>` is the format example, not an answer.
    if (said.length >= 12 && !/^<[^>]*>$/.test(said)) { note.outcome = 'fixed'; delete note.problem; }
    else note.problem = 'a fixed line must say what changed and its test (12 characters or more)';
    return;
  }
  const q = /["“]([^"“”]*)["”]/.exec(said);
  const quote = q ? userText(q[1]) : '';
  if (quote.length < 8) { note.problem = 'a user line needs the user\'s exact words in quotes (8 characters or more)'; return; }
  const after = seqs[n - 1];
  if (words.some((w) => w.seq > after && w.text.includes(quote))) { note.outcome = 'user'; delete note.problem; }
  else note.problem = 'the quoted words are not in a message the user typed after this report';
}

// The final text claims the review passed: a line that starts with `REVIEW: PASS` or `GATE: PASS`
// (code blocks included: shown to the user, it still reads as a pass), or a code block with a command
// that runs `git push` or `gh pr create` (the user pushes by hand when the author hands one over).
const CLAIM_LINE = /^[ \t]*(?:REVIEW|GATE):[ \t]*PASS\b/m;
const CODE_BLOCK = /(```|~~~)[^\n]*\n([\s\S]*?)\1/g;
const PUSH_COMMAND = /(?:^|[\s;&|(])git(?:\.exe)?(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+push\b|(?:^|[\s;&|(])gh(?:\.exe)?\s+pr\s+create\b/m;
function claimsReview(text) {
  const s = String(text || '');
  if (CLAIM_LINE.test(s)) return true;
  for (const m of s.matchAll(CODE_BLOCK)) if (PUSH_COMMAND.test(m[2])) return true;
  return false;
}

// The open notes as the stop gate and the push guard show them; at most 40 lines of notes.
const SHOWN_NOTES = 40;
function openNotesMessage(open) {
  const list = Array.isArray(open) ? open : [];
  if (!list.length) return '';
  const rows = list.slice(0, SHOWN_NOTES).map((n) => 'NOTE ' + n.n + ' (' + n.kind + '): ' + String(n.text).slice(0, 140) + (n.problem ? ' — still open: ' + n.problem : ''));
  if (list.length > SHOWN_NOTES) rows.push('… and ' + (list.length - SHOWN_NOTES) + ' more open notes, up to NOTE ' + list[list.length - 1].n + '.');
  const k = list[0].n;
  return 'Reviewer notes without an outcome (rule 5: every reviewer note is fixed, or the user decides it):\n' + rows.join('\n') + '\n' +
    'To ask the user about a note, stop with the question and no verdict line or push command.\n' +
    'Answer each one in your next message, on its own line: `NOTE ' + k + ': fixed — <what changed and its test>` or `NOTE ' + k + ': user — "<the user\'s exact words>"`. A note is never closed by the author\'s own judgement.';
}

// The reducer state of one scan: plain data only (Maps and Sets become arrays in the cache), so a
// later call continues where the last one stopped (2026-11-12, audit H17).
function newScanState() {
  return {
    res: { lastEdit: -1, lastEditPath: '', lastNonGitEdit: -1, lastNonRemoteEdit: -1, remoteCheckouts: [], lastGitRepo: '', passedTrees: [], passingReceipts: [], lastVerify: -1, lastVerifyResult: -1, lastFailedVerify: -1, lastFailedVerifyStop: -1, lastProbeFailure: -1, lastPendingVerify: -1, lastPendingVerifyStop: -1, lastCancelledVerify: -1, lastCancelledVerifyCommand: '', lastGate: -1, lastGateVerdict: '', lastGateAt: '', lastReview: -1, lastReviewVerdict: '', completedCheck: null, lastBoundCheck: -1, lastProviderRun: -1, lastProviderResult: -1, lastFailedProvider: -1, lastPendingProvider: -1, lastReviewerRun: -1, lastReviewerResult: -1, lastReviewText: '', lastRangeDiff: -1,
      // Reviewer notes: { n, kind, text, outcome: null | 'fixed' | 'user', problem? }; the open ones are set by
      // finishScan. turnClaim: an assistant text since the user's last message has a REVIEW/GATE: PASS line or a
      // handed-over push (the stop gate's answer when the host does not send the last message).
      // reviewerLaunched: this session launched an independent reviewer (a report in a tool result counts only then).
      reviewNotes: [], openReviewNotes: [], turnClaim: false, reviewerLaunched: false },
    seq: 0,
    pending: new Map(), // tool_use_id -> { editSeq, editPath, verifySeq }
    background: new Map(), // task id -> originating command (not its polling command)
    finishedUncollected: new Set(), // background task ids whose finish notice carried no exit code
    verificationStates: new Map(), // retries clear only the same command's failure
    providerStates: new Map(),
    reviewerCalls: new Map(),  // Agent tool_use id -> launch seq (reviewer prompt)
    reviewerAgents: new Map(), // agent id -> { launch, at } (latest run, incl. SendMessage follow-ups)
    // For the task timer: each finished reviewer run, { launchAt, doneAt } (the entries' own times). A review
    // runs beside the other stages, so the timer lists it apart (2026-11-11: the report showed no review time).
    reviewerAt: new Map(),     // Agent tool_use id -> the launch entry's time
    reviews: [],
    // Every helper agent still working: launched in the background and not yet reported done. While one
    // launched after the last change works, the stop waits for it instead of asking for a check (2026-11-06).
    helperCalls: new Map(),    // tool_use id -> seq
    helpersRunning: new Map(), // agent id -> launch seq
    retirements: [], // CHECK RETIRED lines: { seq, failed: [names], replacement: [names] }
    probes: [],      // PROBE EXPECTED lines: { seq, command: [names] }
    passes: [],      // passing verifications: { seq, command }
    stopCalls: new Map(),      // TaskStop tool_use id -> background task id
    remoteCheckouts: [],       // moves to a fetched remote ref: { seq, repo }
    helperEdits: [],           // helper agents' edits not yet placed in time: { t, file, pos, edit }
    helperPending: new Map(),  // '<helper file>\n<tool_use id>' -> a helper's edit awaiting its result
    noteSeqs: [],              // the seq of the report each reviewer note came in (same order as res.reviewNotes)
    reportKeys: [],            // each note a reviewer run gave: '<agent id>@<launch seq>#<note number>' (see addReport)
    userWords: [],             // what the user typed while a note was open: { seq, text } (see pruneUserWords)
  };
}
const STATE_MAPS = ['pending', 'background', 'verificationStates', 'providerStates', 'reviewerCalls', 'reviewerAgents', 'reviewerAt', 'helperCalls', 'helpersRunning', 'stopCalls', 'helperPending'];
const STATE_LISTS = ['reviews', 'retirements', 'probes', 'passes', 'remoteCheckouts', 'helperEdits', 'noteSeqs', 'reportKeys', 'userWords'];
function saveState(st) {
  const o = { ...st, finishedUncollected: [...st.finishedUncollected] };
  for (const k of STATE_MAPS) o[k] = [...st[k]];
  delete o.since;   // the start time belongs to the cache record, which is used only with the same one
  return o;
}
// A cached state of any other shape is ignored (the scan starts from zero).
function restoreState(o) {
  const st = newScanState();
  if (!o || typeof o !== 'object' || !o.res || typeof o.res !== 'object' || typeof o.seq !== 'number' || !Array.isArray(o.finishedUncollected)) return null;
  for (const k of STATE_MAPS) {
    if (!Array.isArray(o[k]) || !o[k].every((e) => Array.isArray(e) && e.length === 2)) return null;
    st[k] = new Map(o[k]);
  }
  for (const k of STATE_LISTS) { if (!Array.isArray(o[k])) return null; st[k] = o[k]; }
  for (const [k, v] of Object.entries(st.res)) if (typeof o.res[k] !== typeof v || Array.isArray(o.res[k]) !== Array.isArray(v)) return null;
  st.finishedUncollected = new Set(o.finishedUncollected);
  st.res = o.res; st.seq = o.seq;
  return st;
}

// The edit (and check) facts of an Edit-like or shell tool use, the same for the session and its helpers
// (editsOnly: a helper's, whose checks never count; only whether it verifies is kept, for the error rule).
function fillToolRecord(rec, blk, entry, seq, editsOnly = false) {
  if (EDIT_TOOLS.has(blk.name)) {
    const p = String(blk.input.file_path || blk.input.notebook_path || '');
    if (isCodePath(p)) { rec.editSeq = seq; rec.editPath = p; rec.nonGitEditSeq = seq; rec.nonRemoteEditSeq = seq; }
    return;
  }
  const segs = splitSegments(String(blk.input.command || ''));
  // A failed compound command must be retried as a whole; a success in
  // another directory or only its last test cannot erase that failure.
  // Display tails and redirections are not part of the identity (see identitySegments).
  if (!editsOnly) {
    rec.verifyKey = String(blk.input.cwd || blk.input.workdir || entry.cwd || '') + '\n' + identitySegments(segs).map(verificationIdentity).join(' ; ');
    rec.command = commandIdentity(blk.input.command);
    if (segs.length === 1 && isEvidenceCommand(segs[0])) { rec.evidence = true; rec.verifySeq = seq + 0.001; }
  }
  const expanded = expandVariables(segs);
  // A red-proof bundle (`git stash push; <test>; git stash pop`) restores
  // the code it set aside, so its stash steps are not a net change; its
  // own failure accounting (setup/cleanup markers) still applies.
  const stashBundle = segs.some((s) => /\bgit(?:\.exe)?\s+stash(?:\s+(?:push|save))?(?:\s|$)/i.test(s) && !/\bstash\s+(?:pop|apply|list|show)\b/i.test(s)) &&
    segs.some((s) => /\bgit(?:\.exe)?\s+stash\s+(?:pop|apply)\b/i.test(s));
  // The folder a git change lands in: its `-C <dir>`, else the last `cd <dir>`
  // before it in the same command, else the tool's own working directory.
  let cdDir = String(blk.input.cwd || blk.input.workdir || entry.cwd || '');
  for (let i = 0; i < segs.length; i++) {
    const frac = seq + (i + 1) / 1000;
    const cd = /^\s*(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*$/i.exec(String(expanded[i]));
    if (cd) cdDir = stripQuotes(cd[1]);
    if (segmentIsVerify(segs[i])) rec.verifySeq = frac;
    if (!editsOnly && segs.length === 1 && segmentIsProvider(segs[i])) rec.providerSeq = frac;
    if (!editsOnly && segs.length === 1 && /^git(?:\.exe)?\s+range-diff\s/i.test(String(segs[i]).trim())) rec.rangeDiffSeq = frac;
    const paths = segmentEditPaths(expanded[i], cdDir).filter((p) => !(stashBundle && p === '<git>' && /\bstash\b/i.test(segs[i])));
    if (paths.length) {
      rec.editSeq = frac; rec.editPath = paths[0];
      if (paths.some((p) => !GIT_CHANGE.test(p))) rec.nonGitEditSeq = frac;
      if (paths.some((p) => p !== '<git-remote>')) rec.nonRemoteEditSeq = frac;
      if (paths.some((p) => GIT_CHANGE.test(p))) {
        const dashC = /\bgit(?:\.exe)?\s+-C\s+("[^"]+"|'[^']+'|\S+)/i.exec(String(expanded[i]));
        const repo = dashC ? stripQuotes(dashC[1]) : cdDir;
        if (GIT_CHANGE.test(paths[0])) rec.gitRepo = repo;
        if (paths.includes('<git-remote>')) rec.remotes.push({ seq: frac, repo });
      }
    }
  }
  // A check whose exit code a later part of the command hides is judged by its output alone (H4).
  if (!editsOnly && rec.verifySeq !== -1 && !rec.evidence) {
    const hidden = hiddenCheckRunners(String(blk.input.command || ''));
    if (hidden) rec.hidden = hidden;
  }
}
const emptyRecord = (background) => ({ editSeq: -1, editPath: '', nonGitEditSeq: -1, nonRemoteEditSeq: -1, remotes: [], verifySeq: -1, verifyKey: '', evidence: false, providerSeq: -1, rangeDiffSeq: -1, gitRepo: '', background });

function reviewDone(st, launchAt, doneAt) {
  if (launchAt && doneAt && !st.reviews.some((r) => r.launchAt === launchAt)) st.reviews.push({ launchAt, doneAt });
}

// The tool ids a line's tool_result blocks answer (as the host writes them: compact JSON, so quotes
// inside a result's text are escaped and never match).
const RESULT_ID = /"tool_use_id":"([^"\\]+)"/g;
function answersAny(l, maps) {
  let found = false;
  for (const m of l.matchAll(RESULT_ID)) { found = true; if (maps.some((map) => map.has(m[1]))) return true; }
  return !found;   // no id read: judge the whole line
}

// One line of the session's own transcript.
function feedLine(st, l) {
  // The host also writes a copy of each API request (`api-request-blob`): old tool calls,
  // results and verdicts again, out of order. Copies are not events (2026-11-09: copied
  // launches stayed "pending" and refused a PR; a copied old pass could follow a newer edit).
  if (l.startsWith('{"type":"api-request')) return;
  if (!maybeLine(l) && !maybeHuman(l)) return;
  // A result no recorded call waits for changes nothing (most of a long session: Read, Grep and the
  // like), so it is not parsed (2026-11-12: the first read of a 449 MB session). One with a reviewer
  // report's RECOMMEND line still counts: its notes need an outcome.
  if (l.includes('"type":"tool_result"') && !answersAny(l, [st.pending, st.helperCalls, st.reviewerCalls, st.stopCalls]) && !l.includes('RECOMMEND: ')) return;
  let entry = null;
  try { entry = JSON.parse(l); } catch (e) { return; }
  if (!entry || /^api-request/.test(String(entry.type || ''))) return;
  placeHelperEdits(st, entry.timestamp);
  const res = st.res;
  // The user's own words: a later `NOTE n: user — "…"` line must quote them (2026-11-12).
  const words = humanWords(entry);
  if (words !== null) humanTurn(st, words);
  // A reviewer's final report handed back by the host, queued or delivered (see handBack). It is also
  // the run's finish: an agent that hands back has reported (2026-11-12, follow-up E).
  const a = entry.attachment && typeof entry.attachment === 'object' ? entry.attachment : null;
  const c = entry.message && entry.message.content;
  const handedText = a && typeof a.prompt === 'string' ? a.prompt
    : entry.type === 'user' ? (typeof c === 'string' ? c : Array.isArray(c) && c.length && c.every((b) => b && b.type === 'text') ? c.map((b) => String(b.text || '')).join('\n') : '') : '';
  const handed = handedText.includes(HAND_BACK) ? handBack(handedText) : null;
  if (handed) {
    const agent = st.reviewerAgents.get(handed.id);
    if (agent) {
      const seq = ++st.seq;
      addReport(st, handed.report, handed.id + '@' + agent.launch, seq, entry.timestamp);
      creditReviewer(st, agent, seq, entry.timestamp);
    }
    return;
  }
  const notes = taskNotifications(entry);
  if (notes.length > 0) {
    for (const note of notes) {
      // This host reports a finished background command as a task-notification
      // attachment instead of a TaskOutput result. The command's saved output
      // file is its collected result; a completion without an exit code stays pending.
      st.seq++;
      if (st.background.has(note.id) && (note.status !== 'completed' || note.exitCode !== undefined)) {
        let output = '';
        try { output = note.file ? fs.readFileSync(note.file, 'utf8') : ''; } catch (e) { output = ''; }
        settle(st, { ...st.background.get(note.id), editSeq: -1, taskId: note.id },
          { type: 'tool_result', content: output, is_error: false },
          { toolUseResult: { task: { id: note.id, status: note.status, exitCode: note.exitCode } } });
      } else if (st.background.has(note.id)) st.finishedUncollected.add(note.id);
      if (st.helpersRunning.has(note.id) && /^(?:completed|failed|killed|cancelled|canceled|stopped)$/.test(note.status)) st.helpersRunning.delete(note.id);
      // An independent reviewer agent finished: credit the run it completed. A notice sent while it still
      // waits on its own background work is no finish (2026-11-12, follow-up E: such a run counted as a
      // completed review before its report existed); its hand-back or a later notice finishes it.
      const agent = st.reviewerAgents.get(note.id);
      const finished = !!agent && note.status === 'completed' && !interimNotice(note);
      // Its finish notice can carry its report too (see addReport: each note counts once per run).
      if (finished && note.result) addReport(st, note.result, note.id + '@' + agent.launch, st.seq, entry.timestamp);
      if (finished) creditReviewer(st, agent, st.seq, entry.timestamp);
    }
    // A bundled notice shares the entry with the user's own words; nothing else there is scanned.
    return;
  }
  const msg = entry.message;
  const content = msg && Array.isArray(msg.content) ? msg.content : (Array.isArray(entry.content) ? entry.content : null);
  if (!content) return;

  for (const blk of content) {
    const seq = ++st.seq;
    if (!blk || typeof blk !== 'object') continue;

    if (blk.type === 'text' && typeof blk.text === 'string' && msg && msg.role === 'assistant') {
      const plain = blk.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
      const g = [...plain.matchAll(GATE_RE)].pop();
      if (g) { res.lastGate = seq + (g.index + 1) / (plain.length + 1); res.lastGateVerdict = g[1]; res.lastGateAt = String(entry.timestamp || ''); }
      const rv = [...plain.matchAll(REVIEW_RE)].pop();
      if (rv) {
        res.lastReview = seq + (rv.index + 1) / (plain.length + 1); res.lastReviewVerdict = rv[1];
        res.lastReviewText = plain.slice(rv.index).split('\n')[0];
      }
      for (const m of plain.matchAll(RETIRE_RE)) {
        try {
          const r = JSON.parse(m[1]);
          if ([r.failed, r.replacement, r.reason].every((v) => typeof v === 'string' && v.trim())) {
            st.retirements.push({ seq: seq + (m.index + 1) / (plain.length + 1), failed: namedCommand(r.failed), replacement: namedCommand(r.replacement) });
          }
        } catch (e) { /* a malformed retirement retires nothing */ }
      }
      for (const m of plain.matchAll(PROBE_RE)) {
        try {
          const p = JSON.parse(m[1]);
          if ([p.command, p.reason].every((v) => typeof v === 'string' && v.trim())) {
            st.probes.push({ seq: seq + (m.index + 1) / (plain.length + 1), command: namedCommand(p.command) });
          }
        } catch (e) { /* a malformed probe declaration covers nothing */ }
      }
      // Reviewer notes (2026-11-12): what this turn claims, and each note's outcome line.
      if (claimsReview(blk.text)) res.turnClaim = true;
      if (applyOutcomes(res.reviewNotes, st.noteSeqs, st.userWords, plain)) pruneUserWords(st);
      continue;
    }

    // A reviewer report in a tool result: the other engine's report read from a file (2026-11-12). Only in
    // a session that launched an independent reviewer: an old report file or a test fixture read during
    // other work is no review (follow-up D).
    if (blk.type === 'tool_result' && res.reviewerLaunched && !(blk.tool_use_id && st.reviewerCalls.has(blk.tool_use_id)) && l.includes('RECOMMEND: ')) {
      const report = recommendReport(resultText(blk, null));
      if (report) addReport(st, report, '', seq, entry.timestamp);
    }

    if (blk.type === 'tool_use' && blk.input && typeof blk.input === 'object') {
      const rec = emptyRecord(blk.input.run_in_background === true);
      if (EDIT_TOOLS.has(blk.name) || SHELL_TOOLS.has(blk.name)) {
        fillToolRecord(rec, blk, entry, seq);
      } else if ((blk.name === 'TaskStop' || blk.name === 'KillShell') && st.background.has(String(blk.input.task_id || blk.input.shell_id || ''))) {
        st.stopCalls.set(blk.id, String(blk.input.task_id || blk.input.shell_id));   // judged when its result arrives
      } else if (blk.name === 'Agent' && REVIEWER_PROMPT.test(String(blk.input.prompt || ''))) {
        st.reviewerCalls.set(blk.id, seq);                  // agent id arrives with the result
        st.reviewerAt.set(blk.id, String(entry.timestamp || ''));
        res.reviewerLaunched = true;
      } else if (blk.name === 'SendMessage' && st.reviewerAgents.has(String(blk.input.to || ''))) {
        st.reviewerAgents.get(String(blk.input.to)).launch = seq;   // a follow-up review run
        st.reviewerAgents.get(String(blk.input.to)).at = String(entry.timestamp || '');
      } else if (blk.name === 'TaskOutput' && st.background.has(blk.input.task_id)) {
        Object.assign(rec, st.background.get(blk.input.task_id), { editSeq: -1, taskId: blk.input.task_id });
      }
      if (blk.name === 'Agent') st.helperCalls.set(blk.id, seq);
      if (rec.editSeq !== -1 || rec.verifySeq !== -1 || rec.providerSeq !== -1 || rec.rangeDiffSeq !== -1) st.pending.set(blk.id, rec);
      continue;
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.helperCalls.has(blk.tool_use_id)) {
      const launch = st.helperCalls.get(blk.tool_use_id);
      st.helperCalls.delete(blk.tool_use_id);
      const t = entry.toolUseResult || {};
      const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
      if (id && blk.is_error !== true && t.status !== 'completed') st.helpersRunning.set(id, launch);
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.reviewerCalls.has(blk.tool_use_id)) {
      const launch = st.reviewerCalls.get(blk.tool_use_id);
      st.reviewerCalls.delete(blk.tool_use_id);
      const t = entry.toolUseResult || {};
      const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
      const at = st.reviewerAt.get(blk.tool_use_id) || '';
      st.reviewerAt.delete(blk.tool_use_id);
      if (id && blk.is_error !== true) st.reviewerAgents.set(id, { launch, at });
      if (id && t.status === 'completed') reviewDone(st, at, String(entry.timestamp || ''));
      // A synchronous reviewer returns its finished report in this result: its notes count (2026-11-12).
      if (id && t.status === 'completed' && blk.is_error !== true) addReport(st, resultText(blk, null), id + '@' + launch, seq, entry.timestamp);
      if (id && t.status === 'completed' && launch > res.lastReviewerRun) { res.lastReviewerRun = launch; res.lastReviewerResult = seq; }
      continue;
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.stopCalls.has(blk.tool_use_id)) {
      const id = st.stopCalls.get(blk.tool_use_id);
      st.stopCalls.delete(blk.tool_use_id);
      const said = String((entry.toolUseResult || {}).message || '') + '\n' + resultText(blk, entry);
      if (blk.is_error !== true && !userRejected(blk, entry) && st.background.has(id) &&
          /\bsuccessfully\s+(?:stopped|killed|terminated|cancell?ed)\b/i.test(said)) cancel(st, id);
      continue;
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.pending.has(blk.tool_use_id)) {
      const rec = st.pending.get(blk.tool_use_id);
      st.pending.delete(blk.tool_use_id);
      settle(st, rec, blk, entry);
    }
  }
}

// A background check stopped with TaskStop never reports back: it is cancelled, neither a
// pass nor still running (2026-11-09: two stopped checks stayed "pending" for good and refused
// a PR). Only a later pass of the same command clears it here; the push guard also accepts a
// later passing evidence receipt of the outgoing tree (lastCancelledVerify).
function cancel(st, id) {
  const rec = st.background.get(id);
  st.background.delete(id); st.finishedUncollected.delete(id);
  const state = st.verificationStates.get(rec.verifyKey);
  if (rec.verifySeq !== -1 && state && state.outcome === 'pending' && state.seq === rec.verifySeq) st.verificationStates.set(rec.verifyKey, { ...state, outcome: 'cancelled' });
  const provider = st.providerStates.get(rec.verifyKey);
  if (rec.providerSeq !== -1 && provider && provider.outcome === 'pending' && provider.seq === rec.providerSeq) st.providerStates.set(rec.verifyKey, { ...provider, outcome: 'cancelled' });
}

function creditEdit(st, rec) {
  const res = st.res;
  if (rec.editSeq > res.lastEdit) { res.lastEdit = rec.editSeq; res.lastEditPath = rec.editPath; res.lastGitRepo = GIT_CHANGE.test(rec.editPath) ? rec.gitRepo || '' : ''; }
  // The last edit that was not a git merge/switch/pull: the same-tree memo falls back to it.
  if ((rec.nonGitEditSeq ?? -1) > res.lastNonGitEdit) res.lastNonGitEdit = rec.nonGitEditSeq;
  // The last change that was not a move to a fetched remote ref, and those moves themselves.
  if ((rec.nonRemoteEditSeq ?? -1) > res.lastNonRemoteEdit) res.lastNonRemoteEdit = rec.nonRemoteEditSeq;
  for (const c of rec.remotes || []) st.remoteCheckouts.push(c);
}

// Credit a collected result: a tool_result, or a background task's completion.
function settle(st, rec, blk, entry) {
  const res = st.res;
  if (userRejected(blk, entry)) return;              // nothing ran
  const isErr = blk.is_error === true;
  const outcome = rec.hidden ? hiddenVerificationResult(blk, entry, rec.hidden) : verificationResult(blk, entry);
  // The host names the task in the result's fields or only in its text ("…running in background with ID: b1a2…");
  // without the id, the finish notice can never be matched and the run stays "running" (2026-11-06).
  const taskId = entry.toolUseResult?.backgroundTaskId || entry.toolUseResult?.background_task_id || rec.taskId ||
    (/running in (?:the )?background with ID:\s*([A-Za-z0-9_-]+)/i.exec(resultText(blk, entry)) || [])[1];
  if (outcome === 'pending' && taskId) st.background.set(taskId, rec);
  else if (taskId) st.background.delete(taskId);
  // An Edit/Write that errored changed nothing; a shell segment that
  // wrote a file usually did, even if a later segment failed.
  if (rec.editSeq !== -1 && !(isErr && rec.verifySeq === -1)) creditEdit(st, rec);
  if (rec.verifySeq !== -1) {
    const receipt = rec.evidence ? checkReceipt(blk, entry) : null;
    const key = receipt?.key || rec.verifyKey;
    const checkOutcome = rec.evidence && outcome !== 'pending' ? receipt?.outcome || 'failed' : outcome;
    if (receipt && checkOutcome !== 'pending') {
      const launch = st.verificationStates.get(rec.verifyKey);
      if (launch?.outcome === 'pending' && launch.seq === rec.verifySeq) st.verificationStates.delete(rec.verifyKey);
    }
    if (checkOutcome === 'none') {
      // A hidden exit code and no marker either way proves nothing; its own launch is no longer running (H4).
      const launch = st.verificationStates.get(key);
      if (launch?.outcome === 'pending' && launch.seq === rec.verifySeq) st.verificationStates.delete(key);
    } else {
      const previous = st.verificationStates.get(key);
      if (!previous || rec.verifySeq >= previous.seq) st.verificationStates.set(key, { seq: rec.verifySeq, outcome: checkOutcome, command: rec.command });
      if (checkOutcome === 'passed') st.passes.push({ seq: rec.verifySeq, command: rec.command });
      if (checkOutcome === 'passed') {
        if (receipt && rec.verifySeq > res.lastBoundCheck) { res.completedCheck = receipt.record; res.lastBoundCheck = rec.verifySeq; }
        // Every tree a passing receipt verified: the same tree is the same code wherever it is checked out.
        const tree = receipt && receipt.record && receipt.record.source && String(receipt.record.source.treeAfter || '');
        if (tree && /^[0-9a-f]{40,64}$/i.test(tree) && !res.passedTrees.includes(tree)) res.passedTrees.push(tree);
        // Every passing receipt, for the push guard: a receipt of the outgoing repository and tree counts
        // even when a later receipt covered another tree or folder (2026-11-12, audit H8/H15).
        if (receipt) {
          const source = receipt.record.source || {};
          const slash = (v) => typeof v === 'string' ? v.replace(/\\/g, '/') : '';
          res.passingReceipts.push({ toplevel: slash(source.toplevel), treeBefore: String(source.treeBefore || ''), treeAfter: String(source.treeAfter || ''), cwd: slash(receipt.record.cwd), seq: rec.verifySeq });
        }
        if (rec.verifySeq > res.lastVerify) res.lastVerify = rec.verifySeq;
        res.lastVerifyResult = st.seq;
      }
    }
  }
  if (rec.rangeDiffSeq !== -1 && outcome === 'passed') res.lastRangeDiff = Math.max(res.lastRangeDiff, rec.rangeDiffSeq);
  if (rec.providerSeq !== -1) {
    const previous = st.providerStates.get(rec.verifyKey);
    if (!previous || rec.providerSeq >= previous.seq) st.providerStates.set(rec.verifyKey, { seq: rec.providerSeq, outcome });
    if (outcome === 'passed') {
      res.lastProviderRun = Math.max(res.lastProviderRun, rec.providerSeq);
      res.lastProviderResult = st.seq;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper agents. Their transcripts sit next to the session's, in
// <transcript without .jsonl>/subagents/agent-*.jsonl. A helper's code edit changes the code the
// session ships, so it counts as an edit at its own time (2026-11-12, audit H10: a sonnet-worker's
// edits were never edits). Only edits: a helper's verdict lines, receipts and check results are not
// this session's evidence.
// ---------------------------------------------------------------------------

function helperFolder(transcriptPath) { return String(transcriptPath).replace(/\.jsonl$/i, '') + '/subagents'; }

const HELPER_TOOL = /"name":"(?:Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell)"/;
function feedHelperLine(st, file, l, pos) {
  if (l.startsWith('{"type":"api-request')) return;
  // Only an Edit-like or shell call, or the result of one that edits, can matter here.
  const call = l.includes('"tool_use"') && HELPER_TOOL.test(l);
  const ids = l.includes('"tool_result"') ? [...l.matchAll(RESULT_ID)].map((m) => m[1]) : null;
  if (!call && !(ids && (!ids.length || ids.some((id) => st.helperPending.has(file + '\n' + id))))) return;
  let entry = null;
  try { entry = JSON.parse(l); } catch (e) { return; }
  if (!entry || /^api-request/.test(String(entry.type || '')) || !entry.message || !Array.isArray(entry.message.content)) return;
  for (const blk of entry.message.content) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.type === 'tool_use' && blk.input && typeof blk.input === 'object' && (EDIT_TOOLS.has(blk.name) || SHELL_TOOLS.has(blk.name))) {
      const rec = emptyRecord(false);
      fillToolRecord(rec, blk, entry, 0, true);
      if (rec.editSeq !== -1) {
        st.helperPending.set(file + '\n' + blk.id, { editPath: rec.editPath, nonGit: rec.nonGitEditSeq !== -1, nonRemote: rec.nonRemoteEditSeq !== -1,
          gitRepo: rec.gitRepo, remotes: rec.remotes.map((r) => r.repo), verifies: rec.verifySeq !== -1, at: String(entry.timestamp || '') });
      }
    } else if (blk.type === 'tool_result' && blk.tool_use_id && st.helperPending.has(file + '\n' + blk.tool_use_id)) {
      const key = file + '\n' + blk.tool_use_id;
      const edit = st.helperPending.get(key);
      st.helperPending.delete(key);
      // The same rule as the session's own edits (settle): a rejected or failed edit changed nothing.
      if (userRejected(blk, entry) || (blk.is_error === true && !edit.verifies)) continue;
      const t = Date.parse(entry.timestamp || edit.at || '');
      if (!Number.isFinite(t)) continue;
      // Kept in time order (then file, then place in the file), so every read order gives the same queue.
      const item = { t, file, pos, edit };
      const before = (a, b) => a.t - b.t || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.pos - b.pos;
      let lo = 0, hi = st.helperEdits.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (before(st.helperEdits[mid], item) <= 0) lo = mid + 1; else hi = mid; }
      st.helperEdits.splice(lo, 0, item);
    }
  }
}

// Helper edits made before this session entry's time take their place before it. Read order does not
// matter: the same edits land at the same place however the files grew.
function placeHelperEdits(st, timestamp) {
  if (!st.helperEdits.length) return;
  const t = Date.parse(timestamp || '');
  if (!Number.isFinite(t)) return;
  while (st.helperEdits.length && st.helperEdits[0].t < t) creditHelperEdit(st, st.helperEdits.shift());
}
function creditHelperEdit(st, { edit }) {
  const s = ++st.seq;
  creditEdit(st, { editSeq: s, editPath: edit.editPath, nonGitEditSeq: edit.nonGit ? s : -1, nonRemoteEditSeq: edit.nonRemote ? s : -1,
    remotes: edit.remotes.map((repo) => ({ seq: s, repo })), gitRepo: edit.gitRepo });
}

// ---------------------------------------------------------------------------
// The scan cache: one small file per transcript under <state>/scan-cache/, holding the byte offset
// already read, the scan state at that offset, and the same for each helper file. It is used only
// when it is surely the same file and the same code: the transcript is not shorter than the offset,
// its first and last 4 KB before the offset are unchanged, and the version and the scanner's own
// files are the same. Anything else, or a cache that does not parse, starts from zero. Writes go
// through a temp file and a rename, so a reader sees a whole file; two hooks at once: last wins.
// ---------------------------------------------------------------------------

const SCAN_CACHE_VERSION = 1;
const MARK_BYTES = 4096;
const CHECKPOINT_MS = 2000;
function fileMark(fd, offset) {
  const crypto = require('crypto');
  const head = readBytes(fd, 0, Math.min(MARK_BYTES, offset));
  const edge = readBytes(fd, Math.max(0, offset - MARK_BYTES), Math.min(MARK_BYTES, offset));
  return crypto.createHash('sha1').update(head).update('|').update(edge).digest('hex');
}
// A change to the scanner or the command grammar it uses makes cached decisions stale. With no
// file to stamp (a test sandbox), nothing is cached.
function codeStamp() {
  if (typeof __filename !== 'string' || typeof __dirname !== 'string') return '';
  try {
    return [__filename, path.join(__dirname, 'shell-command.cjs'), path.join(__dirname, 'verification-target.cjs')]
      .map((f) => { const s = fs.statSync(f); return s.size + ':' + s.mtimeMs; }).join('|');
  } catch (e) { return ''; }
}
// The hooks' state folder: the scan cache, the notes lock's start time, the stop gate's block counter.
function stateFolder() {
  return (proc && proc.env && proc.env.SANAD_STATE_DIR) || path.join(require('os').homedir(), '.claude', 'state');
}
// The user's own state folder is written for real sessions only (a transcript under .claude/projects);
// anything else (a test's transcript) only where SANAD_STATE_DIR points.
function stateAllowed(transcriptPath) {
  return !!(proc && proc.env && proc.env.SANAD_STATE_DIR) || /\/\.claude\/projects\//i.test(path.resolve(String(transcriptPath || '')).replace(/\\/g, '/'));
}
function cacheFolder() { return path.join(stateFolder(), 'scan-cache'); }

// The notes lock's start time (2026-11-12, follow-up A): reports that arrived before it give no notes, so
// a session already running when the lock came is not blocked by its history (one had 232 old notes).
// The time is kept in <state>/review-notes-since; the first scan without it writes the current time. A
// file that cannot be read or holds no time means no start time: every report counts (the lock stays shut).
const SINCE_FILE = 'review-notes-since';
function readSince(file) { const t = String(fs.readFileSync(file, 'utf8')).trim(); return Number.isFinite(Date.parse(t)) ? t : ''; }
function notesSince() {
  const file = path.join(stateFolder(), SINCE_FILE);
  try { return readSince(file); } catch (e) { if (!e || e.code !== 'ENOENT') return ''; }
  try {
    const now = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, now + '\n', { flag: 'wx' });
    return now;
  } catch (e) {
    try { return readSince(file); } catch (e2) { return ''; }   // another hook wrote it first, or it cannot be written
  }
}
// since: part of the cache's validity, so a cached state never mixes two start times.
function cachedScan(file, transcript, fd, size, stamp, since) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (!c || c.v !== SCAN_CACHE_VERSION || c.code !== stamp || c.since !== since || typeof c.path !== 'string' || c.path.toLowerCase() !== transcript.toLowerCase() ||
      !Number.isInteger(c.offset) || c.offset < 0 || c.offset > size || !c.helpers || typeof c.helpers !== 'object' || Array.isArray(c.helpers)) return null;
  for (const h of Object.values(c.helpers)) if (!h || !Number.isInteger(h.offset) || h.offset < 0 || typeof h.mark !== 'string') return null;
  if (c.offset > 0 && fileMark(fd, c.offset) !== c.mark) return null;
  const st = restoreState(c.state);
  return st ? { st, offset: c.offset, helpers: c.helpers } : null;
}
function writeCache(file, data) {
  const tmp = file + '.' + (proc ? proc.pid : 0) + '-' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* nothing left to clean */ }
  }
}
// Old sessions' caches go after two weeks; checked when a new cache file is first written.
function pruneCache(folder) {
  try {
    const old = Date.now() - 14 * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(folder)) {
      const f = path.join(folder, name);
      try { if (/\.(?:json|tmp)$/.test(name) && fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true }); } catch (e) { /* in use or gone */ }
    }
  } catch (e) { /* no folder yet */ }
}

// Read the new complete lines of each helper file into the state. known: { name: { offset, mark } },
// updated in place. Returns null when a helper file shrank or was rewritten (its earlier edits are
// already in the state, so the caller starts over), else { changed, tails } (unfinished last lines).
function readHelpers(st, transcriptPath, known) {
  const folder = helperFolder(transcriptPath);
  let names;
  try { names = fs.readdirSync(folder).filter((n) => /^agent-[^\\/]+\.jsonl$/i.test(n)).sort(); } catch (e) { names = []; }
  let changed = false;
  const tails = [];
  for (const name of names) {
    let fd;
    try { fd = fs.openSync(folder + '/' + name, 'r'); } catch (e) { continue; }
    try {
      const size = fs.fstatSync(fd).size;
      const seen = known[name] || { offset: 0, mark: '' };
      if (size < seen.offset) return null;
      if (size === seen.offset) continue;
      if (seen.offset > 0 && fileMark(fd, seen.offset) !== seen.mark) return null;
      const { done, tail } = readLines(fd, seen.offset, size, (line, end) => feedHelperLine(st, name, line, end));
      if (done !== seen.offset) { known[name] = { offset: done, mark: fileMark(fd, done) }; changed = true; }
      if (tail) tails.push({ name, tail, pos: size });
    } finally { fs.closeSync(fd); }
  }
  return { changed, tails };
}

function scanTranscript(transcriptPath) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch (e) { return newScanState().res; }
  try { return scanOpen(String(transcriptPath), fd); } finally { try { fs.closeSync(fd); } catch (e) { /* already closed */ } }
}

function scanOpen(transcriptPath, fd) {
  const size = fs.fstatSync(fd).size;
  const stamp = codeStamp();
  const transcript = path.resolve(transcriptPath).replace(/\\/g, '/');
  // The user's own state folder holds caches of real sessions only; anything else (a test's transcript)
  // is cached only where SANAD_STATE_DIR points.
  const allowed = stateAllowed(transcript);
  const cacheable = !!stamp && allowed;
  // The notes lock's start time; a transcript that may not use the state folder has none (every report counts).
  const since = allowed ? notesSince() : '';
  const sinceMs = since ? Date.parse(since) : null;
  const file = cacheable ? path.join(cacheFolder(), require('crypto').createHash('sha1').update(transcript.toLowerCase()).digest('hex') + '.json') : '';
  const cached = file ? cachedScan(file, transcript, fd, size, stamp, since) : null;
  let st = cached ? cached.st : newScanState();
  st.since = sinceMs;
  let offset = cached ? cached.offset : 0;
  let helpers = cached ? cached.helpers : {};
  if (file && !cached) pruneCache(path.dirname(file));
  // A long first read saves its progress every few seconds: if the host stops the hook at its timeout,
  // the next call continues from there instead of starting over each time (2026-11-12).
  let saved = cached ? offset : -1, savedAt = Date.now();
  const save = (at) => {
    writeCache(file, { v: SCAN_CACHE_VERSION, code: stamp, since, path: transcript, offset: at, mark: at > 0 ? fileMark(fd, at) : '', helpers, state: saveState(st) });
    saved = at; savedAt = Date.now();
  };
  const checkpoint = (at) => { if (file && Date.now() - savedAt > CHECKPOINT_MS) save(at); };
  let read = readHelpers(st, transcriptPath, helpers);
  if (!read) {
    st = newScanState(); st.since = sinceMs; offset = 0; helpers = {};
    read = readHelpers(st, transcriptPath, helpers) || { changed: true, tails: [] };
    read.changed = true;
  }
  if (read.changed) { saved = -1; checkpoint(offset); }
  const { done, tail } = readLines(fd, offset, size, (line) => feedLine(st, line), checkpoint);
  if (file && done !== saved) save(done);
  // Lines not finished yet (or a file without a final newline) count now and are read again next time.
  if (tail) feedLine(st, tail);
  for (const h of read.tails) feedHelperLine(st, h.name, h.tail, h.pos);
  return finishScan(st);
}

// The verdicts from a state. Runs on a state that is not saved again.
function finishScan(st) {
  // Helper edits later than every session entry read so far happened last.
  while (st.helperEdits.length) creditHelperEdit(st, st.helperEdits.shift());
  const res = st.res;
  const { verificationStates, providerStates, retirements, probes, passes, background, pending, helpersRunning, finishedUncollected, remoteCheckouts, reviews } = st;
  // The same failed check is retired only by its named replacement passing AFTER the line.
  const retired = (state) => retirements.some((r) => r.failed.includes(state.command) && r.seq > state.seq &&
    passes.some((p) => r.replacement.includes(p.command) && p.seq > r.seq));
  const probed = (state) => probes.some((p) => p.command.includes(state.command) && p.seq > state.seq);
  for (const state of verificationStates.values()) {
    const { seq, outcome } = state;
    if (outcome === 'failed' && !retired(state)) {
      res.lastFailedVerify = Math.max(res.lastFailedVerify, seq);   // push guard: every failure counts
      if (probed(state)) res.lastProbeFailure = Math.max(res.lastProbeFailure, seq);
      else if (seq > res.lastFailedVerifyStop) { res.lastFailedVerifyStop = seq; res.lastFailedVerifyStopCommand = state.command; }
    }
    if (outcome === 'pending') res.lastPendingVerify = Math.max(res.lastPendingVerify, seq);
    if (outcome === 'cancelled' && seq > res.lastCancelledVerify && !passes.some((p) => p.command === state.command && p.seq > seq)) {
      res.lastCancelledVerify = seq; res.lastCancelledVerifyCommand = state.command;
    }
  }
  for (const { seq, outcome } of providerStates.values()) {
    if (outcome === 'failed') res.lastFailedProvider = Math.max(res.lastFailedProvider, seq);
    // A stopped provider run proves nothing: it stays owed until a later provider run passes.
    if (outcome === 'pending' || (outcome === 'cancelled' && res.lastProviderRun <= seq)) res.lastPendingProvider = Math.max(res.lastPendingProvider, seq);
  }
  // Moves to a fetched remote ref after every other change: the gates check their folders are clean.
  res.remoteCheckouts = remoteCheckouts.filter((c) => c.seq > res.lastNonRemoteEdit);
  // At a stop, only a background command still known to be running holds it (see below); a launch
  // that was never matched to its finish does not (2026-11-06).
  res.lastPendingVerifyStop = -1;
  for (const rec of [...background.values(), ...pending.values()]) {
    res.lastPendingVerify = Math.max(res.lastPendingVerify, rec.verifySeq);
    res.lastPendingProvider = Math.max(res.lastPendingProvider, rec.providerSeq);
  }
  // At a stop the turn is over: a foreground command with no recorded result has
  // finished and its result was lost (the host sometimes drops one). Only a
  // background command can still be running (2026-11-05: lost results held the
  // stop at "still running" for hours). The push guard keeps the strict count.
  res.lastRunningHelper = helpersRunning.size ? Math.max(...helpersRunning.values()) : -1;
  res.reviews = reviews;
  // For the task timer: a background check with a finish notice still to come, or a helper, works on at
  // this stop, whatever the stop verdict is (2026-11-11: a stop after a later passing check counted ten
  // minutes of a full suite on the test machine as waiting).
  res.workRunning = helpersRunning.size > 0 || [...background].some(([id, rec]) => rec.verifySeq !== -1 && !finishedUncollected.has(id));
  const holdStop = (rec) => { if (rec.verifySeq > res.lastPendingVerifyStop) { res.lastPendingVerifyStop = rec.verifySeq; res.lastPendingVerifyStopCommand = rec.command || ''; } };
  // A held run that no finish notice can bring back (its notice came without an exit code, or the
  // launch has no task id) is "stuck": the stop gate blocks on it instead of waiting (2026-11-07).
  res.lastStuckVerifyStop = -1;
  const stuck = (rec) => { if (rec.verifySeq > res.lastStuckVerifyStop) { res.lastStuckVerifyStop = rec.verifySeq; res.lastStuckVerifyStopCommand = rec.command || ''; } };
  for (const [id, rec] of background) { holdStop(rec); if (finishedUncollected.has(id)) stuck(rec); }
  for (const rec of pending.values()) if (rec.background) { holdStop(rec); stuck(rec); }
  // Reviewer notes with no outcome yet: the stop gate and the push guard refuse while any is open (2026-11-12).
  // The report seqs and the user's kept words let the stop gate apply the final text's outcome lines too.
  res.openReviewNotes = res.reviewNotes.filter((n) => !n.outcome);
  res.reviewNoteSeqs = st.noteSeqs;
  res.reviewUserWords = st.userWords;
  return res;
}

module.exports = {
  EDIT_TOOLS, SHELL_TOOLS,
  isCodePath, splitSegments, tokenize, segmentIsVerify, hasVerify, segmentIsProvider,
  segmentEditPaths, shellEditPaths, shellWriteTargets, verifyFailed, resultText,
  scanTranscript,
  verificationCommand,
  reportNotes, claimsReview, openNotesMessage, openNotesAfter, stateFolder, stateAllowed,
};

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

// 2026-11-18: WHAT is code is one rule shared with the push guard (lib/code-paths.cjs): every file but plain
// prose. The old list of extensions, and the exemption of any folder named specs, memory or .claude, let an
// edit of index.html, nginx.conf or data/seed.json pass unseen after the review.
const { isProsePath, isCodePath: isCodeFile, collapseDots, inTempWorkTree, TEMP_DIR, stripQuotes } = require('./code-paths.cjs');
// Paths that never oblige a verify, for isContentPath (the note check's wider rule): Claude's and Codex's own
// config, memory, scratch, specs, vendored/VCS-internal trees, device files. The temp folder
// (the session scratchpad lives in it) is named literally or by its variable.
const EXEMPT =/((^|[/\\])\.claude([/\\]|$)|(^|[/\\])\.codex([/\\]|$)|[/\\]memory[/\\]|[/\\]specs[/\\]|[/\\]node_modules[/\\]|[/\\]\.git[/\\]|^\/tmp\/|^\/private\/tmp\/|^\/(?:private\/)?var\/folders\/|^\$\{?(?:TEMP|TMP|TMPDIR)\}?[/\\]|^\$env:(?:TEMP|TMP)[/\\]|^%(?:TEMP|TMP)%[/\\]|^\/dev\/|^\/proc\/)/i;
// The Windows temp folder is exempt only outside a git work tree (see code-paths.cjs).

// A relative name written by a shell command lands in the folder that command is
// in (its `cd`, else the tool's folder). Judge it there: `cd <scratchpad> && sed -i
// … find.sql` writes the scratchpad, not the project (2026-11-08). Unknown folder or
// an unexpanded variable: the name is judged as written (conservative).
function inFolder(p, base) {
  const s = stripQuotes(p);
  if (!base || !s || /^(?:[A-Za-z]:[\\/]|[\\/~$%<])/.test(s)) return s;
  return String(base).replace(/[\\/]+$/, '') + '/' + s;
}

// The file rule is code-paths.cjs's (the same one the push guard uses).
const isCodePath = isCodeFile;
// A name read out of a shell command's words (not a file the Edit tool names): the words of a command are
// many things (`s/a/b/`, a folder, a branch), so such a name counts only when it looks like a file: an
// extension, or a well-known extensionless build file (2026-11-18).
const BUILD_NAMES = /(?:^|[/\\])(?:Makefile|GNUmakefile|Dockerfile[^/\\]*|Jenkinsfile|Procfile|Gemfile|Rakefile|Vagrantfile|Brewfile|Podfile|Fastfile|BUILD|WORKSPACE)$/i;
function isCodeToken(p) {
  const s = stripQuotes(p).replace(/[),;]+$/, '');
  return isCodeFile(s) && (/\.[A-Za-z0-9_-]+$/.test(s.replace(/\\/g, '/').split('/').pop()) || BUILD_NAMES.test(s));
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
// 2026-11-20: a name must be a whole word (END): `vitest-ish`, `pytest-foo`, `make tests`, `docker buildx` were
// credited as verification, with or without an `X=` prefix before them.
const END = '(?![\\w-])';
const VERIFY_BODY =
  'dotnet\\s+(build|test|publish)' + END + '|' +
  '(npm|pnpm|yarn|bun)\\s+(test' + END + '|build' + END + '|run\\s+(build|test|typecheck|check|lint)(?:[\\s:]|$))|' +
  'npx\\s+(vitest|jest|playwright\\s+test|tsc|mocha|eslint)' + END + '|' +
  'deno\\s+(test|check)' + END + '|node\\s+--(check|test)\\b|' +
  'pytest' + END + '|python3?\\s+-m\\s+(pytest|unittest)' + END + '|' +
  'go\\s+(test|build|vet)' + END + '|cargo\\s+(test|build|check|clippy)' + END + '|' +
  'mvn' + END + '|gradlew?' + END + '|make\\s+(test|check|build)' + END + '|' +
  'mix\\s+(test|compile)' + END + '|swift\\s+(test|build)' + END + '|flutter\\s+(test|build)' + END + '|' +
  'docker\\s+(compose\\s+)?build' + END + '|' +
  'vitest' + END + '|jest' + END + '|phpunit' + END + '|rspec' + END + '|tsc' + END;
const VERIFY_ANCHORED = new RegExp('^(?:' + VERIFY_BODY + ')', 'i');

function verificationWords(seg) {
  const s = String(seg).trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '') // VAR=val prefixes
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
  // A listing or a clean runs no test and builds nothing: `dotnet test -t` / `--list-tests`, `vitest list`,
  // `jest --listTests`, `playwright test --list`, `tsc --build --clean`, `npm test --if-present` (2026-11-18). Vitest's and
  // jest's own `-t` is a name filter and still runs tests; only dotnet's `-t` lists.
  if (/(?:^|\s)(?:--list|--listTests|--clean|--if-present)(?:\s|=|$)/i.test(command) ||
      /^(?:npx\s+)?vitest\s+list\b/i.test(command) || (/^dotnet\s+test\b/i.test(command) && /(?:^|\s)-t(?:\s|$)/.test(command))) return false;
  // A fixer rewrites the code it checks: it is an edit, not a passing check (2026-11-12, audit H14).
  if (/(?:^|\s)--fix(?:\s|=|$)/i.test(command)) return false;
  // TypeScript inventory/help commands can exit 0 without checking any source.
  if (/^(?:npx\s+)?tsc\b/i.test(command) && /(?:^|\s)(?:--listFilesOnly|--showConfig|--help|--version|-h|-v)(?:\s|=|$)/i.test(command)) return false;
  // A red-proof run that ends with green on the fixed tree runs the tests on the code as it is: a test run
  // (2026-11-11, TUW-242: a proved tree left the stop asking for tests on every turn of a paused task). Its
  // other modes (warm, drop copies, restore, show the remote command, check the break plan: 2026-11-19) and a
  // run without --then-green test no fixed tree.
  if (/^node(?:\.exe)?\s+\S*red-proof\.mjs(?:\s|$)/i.test(command)) {
    const own = command.split(/\s--\s/)[0];
    return /(?:^|\s)--then-green(?:\s|$)/.test(own) && !/(?:^|\s)--(?:warm|drop-copies|restore|show-remote|check-plan)(?:\s|$)/.test(own);
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
  const s = String(seg).trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '');
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
  const environment = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/.exec(String(seg).trim())[0];
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
const WRITE_TOOL = /(^|[\s(])(sed\s+(-[a-zA-Z]*i|--in-place)|tee(\s+-a)?\s|Set-Content|Out-File|Add-Content|WriteAllText|WriteAllLines|AppendAllText|cp\s|mv\s|copy\s|move\s|Copy-Item|Move-Item|csharpier\s+format|perl\s+-[a-zA-Z]*i|Rename-Item|rni\s|ren\s|rename\s|sc\s|ac\s)/i;
// 2026-11-18: `git clean -f` deletes untracked files (dry run -n or --dry-run does not).
// A script run by its file name (`node scripts/codemod.mjs`, `python rename_all.py`) is not judged: what it writes
// cannot be known from the command. Only an interpreter whose own text calls a write counts (see interpreterWrites).
const PATHLESS_WRITE = /(^|[\s(])(git\s+apply|patch\s|git(?:\.exe)?\s+clean\s+(?=[^;&|\n]*-[a-zA-Z]*f)(?![^;&|\n]*(?:-[a-zA-Z]*n\b|--dry-run))|dotnet\s+ef\s+migrations\s+add|npm\s+(install|i|uninstall|remove|add|rm)\b|pnpm\s+(add|remove|install)\b|yarn\s+(add|remove)\b|dotnet\s+(add|remove)\s+(package|reference)|pip-compile\b|uv\s+pip\s+compile\b|uv\s+(?:add|remove|lock)\b|poetry\s+(?:add|remove|lock|update)\b)/i;   // 2026-11-18 (round 3): the Python tools rewrite the manifest too
// Git operations that replace working-tree content change the code as surely as
// an edit: evidence collected before them no longer describes the source.
const GIT_CONTENT_CHANGE = /(^|[\s(;&|"'])git(?:\.exe)?(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|(?:\\.|\S)+))*\s+(?:merge|pull|rebase|cherry-pick|revert|reset|switch|checkout|restore|am|stash(?!\s+(?:list|show)(?=\s|$)))(?=[\s"']|$)/i;
// A text tool only reads or prints its words: `sed -i 's/… then PC 2 git pull + install …/…/' notes.md` runs
// no git (2026-11-17: three stops were blocked for it as "a git merge/reset/switch/stash", in the session's
// own folder). Judged by the program that runs, as deletes are. Every other program keeps the wide rule
// (`bash -c "git pull"` is a change), and so does text that can run a command: `$(…)`, a backtick, `<(…)`,
// and GNU sed's own `e` command (`1e git pull`) or `e` flag (`s/x/git pull /e`).
const TEXT_PROGRAM = /^(?:sed|grep|egrep|fgrep|rg|echo|printf)$/;
// A bracket that starts a word also runs its inside (PowerShell `echo (git stash pop)`, `@(…)`).
const RUNS_INSIDE = /\$\(|`|[<>]\(/;
const RUNS_BRACKET = /(?:^|[\s=,;])@?\(/;   // outside quotes only: a message may hold a (note)
const SED_RUNS = /(?:^|[\s'";{}0-9$\/])e\s+git\b|[\/#|,@:!][a-zA-Z0-9]*e[a-zA-Z0-9]*['"](?:\s|$)/;
// Any other program is judged by the git outside its quotes and outside a trailing comment (2026-11-17:
// `git commit -m "… git switch …"`, `Write-Host "run git pull"`, `# then git pull later` are no git run),
// unless it runs the text it is given: a shell, an interpreter, a shell keyword, `xargs`.
const RUNNER_PROGRAM = /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|eval|exec|xargs|ssh|source|iex|invoke-expression|start-process|wsl|node|nodejs|python\d*|py|perl|ruby|php|deno|bun|if|while|until|for|then|do|else|elif|!|\{)$/;
// A shell that reads the command from its input: `echo git stash pop | bash`.
const STDIN_SHELL = /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell)$/;
function readsStdin(seg) {
  const { program, args } = programArgs(seg);
  if (/^(?:iex|invoke-expression)$/.test(program)) return true;
  return STDIN_SHELL.test(program) && args.every((a) => /^(?:-s|-|-command|-noprofile|-nologo|-noninteractive)$/i.test(a));
}
// The command text without the bodies of its heredocs (the terminator line stays).
function withoutHeredocBodies(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const m = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(i));
    if (!m) { out += s.slice(i); break; }
    const at = i + m.index + m[0].length;
    const eol = s.indexOf('\n', at);
    if (eol === -1) { out += s.slice(i); break; }
    out += s.slice(i, eol + 1);
    let j = eol + 1, end = s.length;
    while (j < s.length) {
      let nl = s.indexOf('\n', j);
      if (nl === -1) nl = s.length;
      if (s.slice(j, nl).replace(/^\t+/, '').trim() === m[2]) { end = j; break; }
      j = nl + 1;
    }
    i = end;
  }
  return out;
}
// wide: the next segment runs this one's output as commands.
function gitContentChange(seg, wide) {
  if (!GIT_CONTENT_CHANGE.test(seg)) return false;
  const { program, args } = programArgs(seg);
  // 2026-11-18 (finding 8): a commit, tag or note with its message in a heredoc (`-m "$(cat <<'EOF' … git pull … EOF)"`)
  // runs no git of the message's words. Judged by the text outside quotes and outside the heredoc body; a command
  // substitution inside the quotes still counts (`-m "$(git pull)"`).
  if (program === 'git' && !wide && /^(?:commit|tag|notes)$/.test(gitSubcommand(args).sub)) {
    const bare = withoutHeredocBodies(seg);
    const inner = [...bare.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].map((m) => m[1] || m[2]).join('\n');
    return GIT_CONTENT_CHANGE.test(blankQuoted(bare).replace(/\s#.*$/, '')) || GIT_CONTENT_CHANGE.test(inner);
  }
  const runs = !!wide || RUNS_INSIDE.test(seg) || RUNS_BRACKET.test(blankQuoted(seg));
  if (TEXT_PROGRAM.test(program)) return runs || (program === 'sed' && SED_RUNS.test(seg));
  if (RUNNER_PROGRAM.test(program) || runs) return true;
  return GIT_CONTENT_CHANGE.test(blankQuoted(seg).replace(/\s#.*$/, ''));
}
const REDIRECT =/(^|[^0-9&>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g;
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
    if (/^\d*>/.test(t)) { if (/^\d*>{1,2}$/.test(t)) i++; continue; }   // 2026-11-18: a redirection word is no source or destination
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

// A switch, pull, merge, reset or checkout run as plain git (at most one `-C <dir>` before it) may only
// bring in upstream code. The stop gate decides it later from the folder: clean, with HEAD's tree equal to
// a remote branch tip's tree (2026-11-14: `git switch -q main && git pull -q` in a clean clone asked for a
// build). git -c, --git-dir, --work-tree or a GIT_* variable can move the change elsewhere: no sync then.
// Returns { dir } (the -C folder, or '') or null.
const SYNC_SUBCOMMANDS = new Set(['switch', 'pull', 'merge', 'reset', 'checkout']);
function gitSync(seg) {
  const words = tokenize(String(seg).trim());
  if (!/^git(?:\.exe)?$/i.test(String(words[0] || '').split(/[\\/]/).pop())) return null;
  let i = 1, dir = '';
  if (words[i] === '-C') { dir = String(words[i + 1] || ''); i += 2; if (!dir) return null; }
  return SYNC_SUBCOMMANDS.has(String(words[i] || '')) ? { dir } : null;
}
// The folder a relative name lands in, from a known absolute folder; '' when it cannot be known
// (no base, ~, a variable, `cd -` or an option). Git Bash on Windows spells C:/ as /c/ (2026-11-14).
function joinFolder(p, base, gitBash) {
  let s = stripQuotes(p);
  if (gitBash) s = s.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(s)) return s;
  if (!base || !s || /^[~$%<-]/.test(s)) return '';
  return String(base).replace(/[\\/]+$/, '') + '/' + s;
}

// 2026-11-18 (stop gate promise, finding 4): a rewrite done through an interpreter. Only an interpreter whose own
// text (a `-e` / `-c` one-liner, or a heredoc body) calls a write on a path that is code counts, as '<generated>':
// reading and reporting one-liners run all the time and are never an edit. A script run by its file name cannot
// be known from the command and is left. A path built at run time (a variable) is not read either.
const INTERPRETER = /^(?:node|nodejs|python\d*|py|perl|ruby|pwsh|powershell)$/;
const SCRIPT_WRITE = /\b(?:writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync|cpSync|writeFile|appendFile|unlink)\s*\(|\.(?:write_text|write_bytes)\s*\(|\bopen\s*\([^)]*['"][wax]\+?b?['"]|\bos\.(?:rename|remove|unlink)\s*\(|\bshutil\.(?:move|copy\w*|rmtree)\s*\(|Set-Content|Out-File|Add-Content|Remove-Item|Rename-Item|Move-Item/i;
// 2026-11-18 (false edits, rule 6): the target of each write call is read. A string literal that is no code path is
// no edit; a target that is a variable or an expression is unknown and counts ('<unknown>'), except when the
// command runs in a temp folder (see commandFolder) and no absolute code path appears in its text.
const LIT_ARG = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`)\s*$/;
const litOf = (a) => { const m = LIT_ARG.exec(String(a)); return m ? (m[1] ?? m[2] ?? m[3]) : null; };
// The first `max` top-level arguments of the call whose '(' is at text[open].
function callArgs(text, open, max) {
  const args = []; let depth = 0, q = null, cur = '';
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === '\\') { cur += text[++i] || ''; } else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { args.push(cur); return args; } depth--; }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; if (args.length >= max) return args; continue; }
    cur += ch;
  }
  args.push(cur);
  return args;
}
const JS_WRITE = /\b(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|copyFileSync|cpSync|writeFile|appendFile|unlink)\s*\(/g;
const PY_WRITE = /\b(?:os\.(?:rename|remove|unlink)|shutil\.(?:move|copy\w*|rmtree))\s*\(/g;
const PS_WRITE = /\b(?:Set-Content|Out-File|Add-Content|Remove-Item|Rename-Item|Move-Item)\b/gi;
function writeCalls(text) {
  const calls = [];   // each: a literal target, or null when it is not a string literal
  const add = (a) => calls.push(a === undefined ? null : a);   // the raw text of the target; resolved by interpreterWrites
  for (const m of text.matchAll(JS_WRITE)) {
    const a = callArgs(text, m.index + m[0].length - 1, 2);
    if (/^(?:renameSync|copyFileSync|cpSync)$/.test(m[1])) { if (m[1] === 'renameSync') add(a[0]); add(a[1]); } else add(a[0]);
  }
  for (const m of text.matchAll(/\bopen\s*\(/g)) {
    const a = callArgs(text, m.index + m[0].length - 1, 3);
    const mode = a.length > 1 ? litOf(a[1].replace(/^\s*mode\s*=/, '')) : null;   // (the mode, not the target)
    if (mode !== null && /[wax]/.test(mode) && /^[rwax+bt]+$/.test(mode)) add(a[0]);
  }
  for (const m of text.matchAll(PY_WRITE)) for (const x of callArgs(text, m.index + m[0].length - 1, 2)) add(x);
  for (const m of text.matchAll(/\.(?:write_text|write_bytes)\s*\(/g)) {
    const r = /Path\(\s*('[^']*'|"[^"]*")\s*\)\s*$/.exec(text.slice(0, m.index));
    calls.push(r ? r[1] : null);
  }
  for (const m of text.matchAll(PS_WRITE)) {
    const rest = text.slice(m.index + m[0].length).split(/[|;\n]|&&|\|\|/)[0];
    const w = tokenize(rest);
    let target;
    const n = w.findIndex((x) => /^-(?:path|filepath|literalpath|destination)$/i.test(x));
    if (n !== -1) target = w[n + 1]; else target = pathArgs(w)[0];
    calls.push(target !== undefined && !/[$`(]/.test(target) ? JSON.stringify(target) : null);
  }
  return calls;
}
// The temp folder (and only when no git work tree lives there) is never the project.
function tempFolder(base) {
  if (!base) return false;
  const b = stripQuotes(base).replace(/\\/g, '/').replace(/\/+$/, '');
  return (TEMP_DIR.test(b) || /^\/(?:private\/)?tmp(?:\/|$)/.test(b)) && !isCodeFile(b + '/zz');
}
// A code name, also with a glob in it (`scripts/remote/*.sh` is a code target: isCodePath rejects the star itself).
function codeTarget(p, base) {
  const s = inFolder(p, base);
  return isCodeToken(s) || (/[*?]/.test(s) && isCodeToken(s.replace(/[*?]+/g, 'x')));
}
// The folder a command works in: the first `cd <dir>` of the command line when it is in the temp folder
// ('' for none). The segments' variables are already expanded. Returns { base, from } (from: the segment index).
function commandFolder(segs) {
  for (let i = 0; i < segs.length; i++) {
    const { program, args } = programArgs(segs[i]);
    if (!/^(?:cd|pushd|set-location|sl|chdir)$/.test(program)) continue;
    const d = args.find((a) => !/^-/.test(a));
    if (d === undefined) return { base: undefined, from: i };
    const dir = stripQuotes(d).replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
    return { base: tempFolder(dir) ? dir : undefined, from: i };
  }
  return { base: undefined, from: -1 };
}
function interpreterWrites(seg, base) {
  const { program } = programArgs(seg);
  if (!INTERPRETER.test(program) || !SCRIPT_WRITE.test(seg)) return [];
  const text = String(seg).replace(/\\(["'])/g, '$1');
  const calls = writeCalls(text);
  const out = [];
  if (!calls.length) {   // a write the call reader does not know: any string that is a code name
    for (const re of [/'([^'\r\n]*)'/g, /"([^"\r\n]*)"/g, /`([^`\r\n]*)`/g]) {
      for (const m of text.matchAll(re)) {
        const lit = m[1];
        // The tail of a path built at run time (`process.env.TEMP + '/x.json'`) is not a place in the project.
        if (/^[/\\]/.test(lit) && /\+$/.test(text.slice(0, m.index).trimEnd())) continue;
        if (/^[^\s'"`()=;|&<>]+$/.test(lit) && isCodeToken(inFolder(lit, base))) out.push(lit);
      }
    }
    return out;
  }
  // `process.argv[N]` / `sys.argv[N]` is the N-th word after the one-liner's text (`node -e "<text>" a b`).
  const words = tokenize(seg);
  const flag = words.findIndex((w) => /^(?:-e|-c|-p|--eval|-command)$/i.test(w));
  const extras = flag === -1 ? [] : words.slice(flag + 2);
  let unknown = false;
  for (let c of calls) {
    let lit = c === null ? null : litOf(c);
    // The tail of a path built at run time (`process.env.TEMP + '/x.json'`, `dir + "/a.ts"`) is not a place in the project.
    if (c !== null && /^\s*[^'"`\s+][^'"`+]*\+\s*(?:'[\\/][^']*'|"[\\/][^"]*"|`[\\/][^`$]*`)\s*$/.test(c)) continue;
    if (lit === null && c !== null) {
      // a variable set once from the arguments or a literal (`const p = process.argv[1]`, `p = "a.ts"`)
      const alias = /^\s*([A-Za-z_]\w*)\s*$/.exec(c);
      const defs = alias ? [...text.matchAll(new RegExp('(?:\\b(?:const|let|var)\\s+|^|[;\\n]\\s*)' + alias[1] + '\\s*=\\s*([^;\\n,]+)', 'g'))].map((d) => d[1].trim()) : [];
      if (defs.length === 1) c = defs[0];
      lit = litOf(c);
    }
    if (lit === null && c !== null) {
      const v =/^\s*(?:process|sys)\.argv\[(\d+)\]\s*$/.exec(c);
      const w = v ? extras[Number(v[1]) - 1] : undefined;
      if (w !== undefined && !/[$`]/.test(w)) lit = w;
    }
    if (lit === null) unknown = true;
    else if (codeTarget(lit, base)) out.push(lit);
  }
  if (unknown) {
    const temp = tempFolder(base);
    // In a temp folder a target that is a variable lands there; only an absolute code path in the text could leave it.
    const leaves = temp && [...text.matchAll(/(['"`])((?:[A-Za-z]:[\\/]|\/|~)[^'"`\r\n]*)\1/g)].some((m) => codeTarget(m[2], undefined));
    if (!temp || leaves) out.push('<unknown>');
  }
  return out;
}
// splitSegments drops a heredoc's body, so an interpreter fed by one (`python - <<'EOF' … open('src/App.ts','w') … EOF`)
// is read from the whole command: the index of the segment that starts such a heredoc, or -1.
const HEREDOC_START = /<<-?\s*["']?[A-Za-z_]/;
function heredocWriteSegment(segs, cmd, base) {
  const s = String(cmd || '');
  if (!HEREDOC_START.test(s)) return -1;
  const re = /^([^\n]*?)<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n/gm;
  let m, writes = false;
  while ((m = re.exec(s)) !== null) {
    const start = re.lastIndex;
    let j = start, end = s.length;
    while (j < s.length) {
      let nl = s.indexOf('\n', j);
      if (nl === -1) nl = s.length;
      if (s.slice(j, nl).replace(/^\t+/, '').trim() === m[3]) { end = j; break; }
      j = nl + 1;
    }
    if (interpreterWrites(m[1].split(/&&|\|\||;|\|/).pop() + ' ' + s.slice(start, end), base).length) writes = true;
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return writes ? segs.findIndex((x) => INTERPRETER.test(programArgs(x).program) && HEREDOC_START.test(x)) : -1;
}
// A download written onto a file: `curl -o <file>`, `wget -O <file>`, `-OutFile <file>`.
function downloadWrites(seg, base) {
  const { program, args } = programArgs(seg);
  if (!/^(?:curl|wget|invoke-webrequest|iwr)$/.test(program)) return [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    if (program === 'curl' && (a === '--output' || /^-[a-zA-Z]*o$/.test(a))) v = args[++i];                 // -o f, -sSo f
    else if (program === 'curl' && /^-[a-zA-Z]*o[^-\s]+$/.test(a)) v = a.replace(/^-[a-zA-Z]*?o/, '');       // -of
    else if (program === 'wget' && (a === '-O' || a === '--output-document')) v = args[++i];
    else if (/^(?:invoke-webrequest|iwr)$/.test(program) && /^-outfile$/i.test(a)) v = args[++i];
    else if (/^--(?:output|output-document)=/i.test(a)) v = a.slice(a.indexOf('=') + 1);
    // 2026-11-18 (false edits): a download counts only when it is saved as a source file (a .json, .zip or page
    // saved for a look is data); folder and relative name are judged in the command's folder.
    if (v && SOURCE_END.test(stripQuotes(v)) && codeTarget(v, base)) out.push(stripQuotes(v));
  }
  return out;
}
const SOURCE_END = /\.(?:cs|ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|kt|rs|swift|sh|ps1|sql|css|scss)$/i;

// base: the folder the segment runs in, for relative names (see inFolder).
// afterCheck: the segment before this one is a build/test run, so a display step here (`| tee build.log`,
// `| tail`) only shows that run's output and writes no code (2026-11-18: a log is a file, and files are code now).
const REPORT_FILE = /\.(?:txt|log|diff|patch)$/i;
function isReporter(seg) {
  const { program, args } = programArgs(seg);
  if (program === 'ls') return true;
  if (program === 'git') return /^(?:diff|log|show|status)$/.test(gitSubcommand(args).sub);
  if (program === 'gh') return String(args[0]).toLowerCase() === 'pr' && /^(?:view|diff)$/i.test(String(args[1]));
  return false;
}
// afterReader: the segment before this one is a read-only reporter (see isReporter).
function segmentEditPaths(seg, base, wide, afterCheck, afterReader) {
  const out = [];
  let m;
  // A command sent over ssh runs on another machine: its git checkout or file writes change nothing
  // here (2026-11-08: a checkout on the remote test machine blocked two stops here). Only a local
  // redirection of its output can write a file here.
  if (/^(?:ssh|scp)(?:\.exe)?$/i.test(String(tokenize(seg)[0] || '').split(/[\\/]/).pop())) {
    const unquoted = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    REDIRECT.lastIndex = 0;
    while ((m = REDIRECT.exec(unquoted)) !== null) if (isCodeToken(inFolder(m[2], base))) out.push(stripQuotes(m[2]));
    return [...new Set(out)];
  }
  if (afterCheck && isDisplaySegment(seg)) return [];   // callers pass afterCheck for a build/test run or an evidence run
  // The output of a build or test run sent to a file is the run's report, not code it wrote.
  const checkRun = segmentIsVerify(seg) || isEvidenceCommand(seg);
  // 2026-11-18 (round 3): the targets come from redirectTargets, which blanks quoted text first (`=>`, `->` and `>` in
  // a script, a query or a commit message are no redirection). A read-only reporter (git diff/log/show/status,
  // gh pr view/diff, ls) saved to a .txt/.log/.diff/.patch file writes a report, not code; so does `| tee <that>` after one.
  const reporter = isReporter(seg), teeAfterReader = !!afterReader && programArgs(seg).program === 'tee';
  const isReport = (t) => (reporter || teeAfterReader) && REPORT_FILE.test(stripQuotes(t));
  if (!checkRun) for (const t of redirectTargets(seg)) if (!isReport(t) && codeTarget(t, base)) out.push(stripQuotes(t));
  // 2026-11-18 (false edits): the write words are looked for outside quotes (a "copy" in a --set text is no cp),
  // except in a nested shell (`bash -c "cp a b"`).
  const shellWords = /^(?:bash|sh|zsh|dash|pwsh|powershell|cmd)$/.test(programArgs(seg).program);
  if (WRITE_TOOL.test(shellWords ? seg : blankQuoted(seg))) {
    const tokens = tokenize(seg);
    const program = String(tokens[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
    let written = COPY_PROGRAM.test(program) ? copyWrites(tokens) : null;
    // `docker cp <container>:<file> <dest>` reads a file out of a container: only a local destination is written.
    if (/^(?:docker|podman)$/i.test(program) && /^cp$/i.test(tokens[1] || '')) {
      const rest = tokens.slice(2).filter((t) => !t.startsWith('-'));
      const dest = rest.length > 1 ? rest[rest.length - 1] : null;
      written = dest && !/^[^\s\\/:]{2,}:/.test(dest) ? [dest] : [];
    }
    for (const t of written || tokens) if (!isReport(t) && codeTarget(t, base)) out.push(stripQuotes(t));
  }
  for (const t of deletedPaths(seg)) if (codeTarget(t, base)) out.push(stripQuotes(t));
  out.push(...downloadWrites(seg, base));
  if (interpreterWrites(seg, base).length) out.push('<generated>');
  if (PATHLESS_WRITE.test(seg) || formatterWrites(seg)) out.push('<generated>');
  if (gitContentChange(seg, wide)) out.push(remoteCheckout(seg) ? '<git-remote>' : '<git>');
  return [...new Set(out)];
}

// 2026-11-18 (audit 3 repair): a content change, for the note check's refutation: any change that can alter what a
// checker read after its launch. Wider than isCodePath: every file but prose (.md) and the places that are never
// the project (EXEMPT, the temp folder); a git move, git apply and patch; a shell write to a named non-code file.
// A formatter run (<generated>) is left out, as in noteEditSeq.
function isContentPath(p) {
  p = stripQuotes(p).replace(/[),;]+$/, '');
  // 2026-11-18 (scoped staleness): prose (.md) counts too, with its path: a refutation that cites README.md:1 is
  // cancelled when README.md changes. A change cancels a refutation by its path (see changeCancels), so a prose edit
  // of another file still cancels nothing.
  if (!p) return false;
  p = collapseDots(p.replace(/\\/g, '/')).replace(/^.*(?:^|\/)\.claude\/worktrees\/[^/]+\//i, '');
  if (EXEMPT.test(p)) return false;
  return !TEMP_DIR.test(p) || inTempWorkTree(p);
}
const WIDE_WRITE = /(^|[\s(])(?:sed\s+(?:-[a-zA-Z]*i|--in-place)|Set-Content|WriteAllText|WriteAllLines|cp\s|mv\s|copy\s|move\s|Copy-Item|Move-Item)/i;
// 2026-11-18 (scoped staleness): returns the paths the segment writes; '' is a change with no known path (git apply,
// patch); [] is no change.
function contentChange(seg, base) {
  const s = String(seg);
  if (/^(?:ssh|scp)(?:\.exe)?$/i.test(String(tokenize(s)[0] || '').split(/[\\/]/).pop())) return [];
  // 2026-11-18 (repair 6): patch and git apply count only as the program of the segment, and a git apply that only
  // checks (--check, --stat, --numstat, --summary) changes no file; the word "patch" in a curl method or a grep is no patch.
  const head = programArgs(s.replace(/^\s*\(\s*/, ''));
  if (head.program === 'patch') return [''];
  if (head.program === 'git') {
    const g = gitSubcommand(head.args);
    if (g.sub === 'apply' && !g.rest.some((a) => /^--(?:check|stat|numstat|summary)$/.test(a))) return [''];
  }
  const hasExt = (t) => /\.[A-Za-z0-9]{1,10}["']*$/.test(String(t)) && isContentPath(inFolder(t, base));
  // 2026-11-18 (repair 3): a shell write or delete of any file, prose too (>, >>, tee, Add-Content, Out-File, rm, git rm,
  // del, Remove-Item), by the same reader check-lock-guard uses; a heredoc body is text, not a command.
  const wrote = segmentWritePaths(withoutHeredocBodies(s)).filter(hasExt);
  if (!WIDE_WRITE.test(s)) return wrote;
  const tokens = tokenize(s);
  const program = String(tokens[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  const copied = COPY_PROGRAM.test(program) ? copyWrites(tokens) : null;
  return [...new Set([...wrote, ...(copied || tokens.slice(1)).filter(hasExt).map((t) => stripQuotes(String(t)))])];
}
// 2026-11-18 (repair 6): a git command that moves no file content: a new branch from where it stands, a soft or mixed
// reset, a restore of the index only. It cancels no refutation (the note check only). Every other git form stays a move.
function gitMovesNoContent(seg) {
  const s = String(seg);
  if (/\$\(|`|[<>]\(/.test(s)) return false;
  const { program, args } = programArgs(s.replace(/^\s*\(\s*/, ''));
  if (program !== 'git') return false;
  const { sub, rest } = gitSubcommand(args);
  const flags = rest.filter((a) => a.startsWith('-')), plain = rest.filter((a) => !a.startsWith('-'));
  if (sub === 'checkout') return flags.length === 1 && /^-[bB]$/.test(flags[0]) && plain.length === 1;
  if (sub === 'switch') return flags.length === 1 && /^-[cC]$/.test(flags[0]) && plain.length === 1;
  if (sub === 'reset') return !flags.some((a) => /^--(?:hard|merge|keep)$/.test(a));
  if (sub === 'restore') return flags.some((a) => /^(?:--staged|-S)$/.test(a)) && !flags.some((a) => /^(?:--worktree|-W)$/.test(a) || /^-[A-Za-z]*W/.test(a));
  return false;
}

// A deleted code file changes the code like an edit; a formatter or fixer rewrites the files it is
// given (2026-11-12, audit H14: neither counted, and `eslint --fix` even passed as a check). Judged
// by the program that runs, never by text inside quotes.
const DELETE_PROGRAM = /^(?:rm|rmdir|rd|del|erase|ri|remove-item|rimraf|unlink)$/;
// PowerShell options whose value is not a path.
const VALUE_OPTION = /^-(?:value|encoding|itemtype|filter|include|exclude|inputobject|delimiter|stream|width|erroraction|ea|warningaction|wa)$/i;
function programArgs(seg) {
  const s = String(seg).trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/, '')
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
    // 2026-11-18: a backslash escapes the next character (`\"` inside a double-quoted string, `\"` outside quotes).
    if (ch === '\\' && q !== "'" && i + 1 < s.length) { out += q ? '__' : ch + s[i + 1]; i++; continue; }
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
  const segs = expandVariables(splitSegments(cmd));
  // 2026-11-18 (false edits): a name is judged in the folder the command moved into, when that is a temp folder.
  const folder = commandFolder(segs);
  if (heredocWriteSegment(segs, cmd, folder.base) !== -1) out.push('<generated>');
  for (let i = 0; i < segs.length; i++) out.push(...segmentEditPaths(segs[i], i > folder.from ? folder.base : undefined, i + 1 < segs.length && readsStdin(segs[i + 1]), i > 0 && (segmentIsVerify(segs[i - 1]) || isEvidenceCommand(segs[i - 1])), i > 0 && isReporter(segs[i - 1])).map((p) => GIT_CHANGE.test(p) ? '<git>' : p));
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

// 2026-11-18 (stop gate promise, finding 6): failure-SHAPED words in the output of a run that passed: a log line
// "3 failed rows listed", a passing test named "... 2 failed checks ...". The runner's own exit code (0, visible)
// and its own pass line outrank such words; the strong markers (Build FAILED, Failed!, an exit-code line, npm ERR!,
// a test listed as failed) always count. Hidden exit codes keep every marker (see hiddenVerificationResult).
const LOOSE_FAIL = new Set(FAIL_MARKERS.filter((re) => [/\b[1-9]\d* failed\b/i, /\[FAIL\]/, /\berror (CS|MSB|TS|NU|NETSDK)\d{3,5}\b/, /\): error [A-Z]{2,}\d{2,}\s*:/].some((x) => x.source === re.source)));
const RUNNER_PASS_LINES = [].concat(...Object.values(PASS_MARKERS));
function verifyFailed(text, isError, exitZero) {
  if (isError) return true;
  const t = String(text || '').replace(ANSI, '');
  const loose = exitZero === true && RUNNER_PASS_LINES.some((re) => re.test(t));
  return FAIL_MARKERS.some((re) => !(loose && LOOSE_FAIL.has(re)) && re.test(t));
}

// 2026-11-18 (finding 2): a run that tested nothing earns no credit: a mistyped filter ("No test matches the given
// testcase filter"), go's "[no tests to run]", jest's "No tests found", vitest's "No test files found", pytest's
// "no tests ran", a total of 0. Not when the same output also shows tests that passed (several test projects).
const NO_TEST_RAN = /\bNo tests? (?:matches|found|files? found|is available|to run|ran)\b|\[no tests to run\]|\bcollected 0 items\b|\bTotal(?: tests)?:\s+0\b|^\s*(?:ℹ |# )tests 0\s*$|\bTests:\s+0 total\b|^\s*Tests\s+no tests\b|\bPassed:\s+0,\s+Skipped:\s+\d+,\s+Total:\s+0\b/im;
const SOME_TEST_PASSED = /\bPassed:\s+[1-9]|\bTests\s+(?:\d+ \w+ \| )?[1-9]\d* passed|\bTests:.*\b[1-9]\d* passed|^\s*(?:ℹ |# )pass [1-9]|^\s*\d+ passed\b|\b[1-9]\d* passed\b/im;
function noTestRan(text) {
  const t = String(text || '').replace(ANSI, '');
  return NO_TEST_RAN.test(t) && !SOME_TEST_PASSED.test(t);
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
// The expert seats (2026-11-16): launched without that marker, a run of one is an expert run. Its report gives
// only its questions for the user as notes, and it never counts as a reviewer run.
const EXPERT_AGENTS = new Set(['braintrust-expert', 'braintrust-expert-sonnet', 'routing-boss']);
// The seat of a run (2026-11-17, review score): several reviewers run per task and nobody measured which
// one earns its time. Each note keeps the seat that wrote it (res.reviewNoteSeats, same index as the note),
// so skills/gate/scripts/review-score.mjs can count, per seat, the notes that led to a change.
// A re-check is read first: real re-check prompts also say "FRESH EYES re-check after a fix round" or
// "re-check (whole-diff pass on the changed lines only)", and one said it only in its Agent description.
function reviewerSeat(prompt, description) {
  if (/re-check/i.test(prompt) || /re-check/i.test(description)) return 're-check';
  if (prompt.includes('FRESH EYES')) return 'fresh eyes';
  if (/risk files pass/i.test(prompt)) return 'risk files';
  if (/whole-diff pass/i.test(prompt)) return 'whole diff';
  return 'reviewer';
}
// An expert's prompt starts `Seat: <name>`: the name up to the first comma or full stop, in lower case. A
// bracket, a long dash or a colon ends it too ("Seat: Skeptic (workflow audit)." is the skeptic), so one
// seat keeps one name across tasks. A boss, or a prompt that names no seat, is 'expert'.
const SEAT_NAME = /^\s*Seat:[ \t]*([^,.(:—–\n]{1,60})/i;
function expertSeat(prompt) {
  const m = SEAT_NAME.exec(prompt);
  const name = m ? m[1].replace(/\s+/g, ' ').trim().toLowerCase() : '';
  return name ? 'expert: ' + name : 'expert';
}
// A report read from a file (the other engine's review) has no agent run: this is its seat.
const FILE_SEAT = 'file report';
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
  const exitSeen = exit !== undefined && exit !== null;
  if (verifyFailed(text, block.is_error === true, !exitSeen || Number(exit) === 0) || t.interrupted === true ||
      (exitSeen && Number(exit) !== 0) ||
      /^(failed|killed|cancelled|canceled)$/.test(t.task?.status || '')) return 'failed';
  if (stillRunning(t, text)) return 'pending';
  // A run that tested nothing proves nothing: no credit, no failure (finding 2, 2026-11-18).
  if (noTestRan(text)) return 'none';
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
  if (noTestRan(text)) return 'none';
  const runners = hidden.runners || [];
  return runners.length && runners.every((r) => (PASS_MARKERS[r] || []).some((re) => re.test(text))) ? 'passed' : 'none';
}

// ---------------------------------------------------------------------------
// Red-proof runs (2026-11-15). red-proof.mjs --then-green first runs the changed tests on the tree as it is.
// When that green run passed, the tests ran green after the launch, whatever the proof said next: NOT RED or
// a break not caught is the proof's own failure, still a failed check for the push guard, but no missing test
// run for the stop gate. A proof run in the background with its output sent to a file (`… > proof-run.out
// 2>&1; echo "exit $?" >> proof-run.out`) shows no line of its own here, so its green run never counted: the
// stop asked for a check three times in one task. red-proof writes one record per --then-green run when it
// ends (skills/gate/scripts/run-record.mjs: <state>/proof/runs/<start ms>-<pid>.json). When the result shows
// no line of the proof's own, that record decides, if it is this run's: the same arguments, started after
// the launch and ended before the result, and its tree the same at its start and its end. A proof never
// makes an evidence receipt: the push guard still needs evidence.mjs.
// ---------------------------------------------------------------------------
const GREEN_PASSED = /^\s*GREEN ✓/m;
const GREEN_FAILED = /^\s*GREEN ✗/m;
// The proof stopped for a reason that is not the code: nothing it said about green counts.
const PROOF_STOPPED = /RED-PROOF: (?:SETUP|ENVIRONMENT|TIMEOUT|REMOTE-DOWN|RESTORE FAILED|failed —)/;
// The host's times and the proof's own clock are the same machine's; a little room for rounding.
const RUN_SLACK_MS = 2000;
// What a proof's own lines say about its green run: true (passed), false, or null (no line about it).
function greenInText(text) {
  if (GREEN_FAILED.test(text) || PROOF_STOPPED.test(text)) return false;
  return GREEN_PASSED.test(text) ? true : null;
}
// A proof's arguments in one comparable form: path separators, Git Bash's /c/ for C:/, and case do not
// matter. A word the shell changes in another way (`~`, a variable set outside the command) does not match:
// no record, so no credit, as before.
function proofWords(words) { return words.map((w) => String(w).replace(/\\/g, '/').replace(/^\/([A-Za-z])(?=\/|$)/, '$1:').toLowerCase()); }
function proofLaunch(segs, expanded, at) {
  const checks = segs.map((s, i) => i).filter((i) => segmentIsVerify(segs[i]));
  if (checks.length !== 1 || checkRunner(segs[checks[0]]) !== 'red-proof') return null;
  // shown: the result holds the proof's own lines and nothing else. The proof ends the command, only a `cd`
  // stands before it, and its output goes to no file (2026-11-19; see proofRefusedShown).
  const last = checks[0] === segs.length - 1 && segs.slice(0, checks[0]).every((s) => LEADING_CD.test(String(s)));
  const toFile = tokenize(segs[checks[0]]).some((w) => !/^\d*>&(?:\d+|-)$/.test(w) && /^(?:&>|\d*>>?|<)/.test(w));
  return { args: proofWords(stripRedirects(verificationWords(expanded[checks[0]])).slice(2)), at: String(at || ''), shown: last && !toFile };
}

// A usage refusal of red-proof (2026-11-19). A mistyped option ended the proof in two seconds with exit 2
// and ran nothing. The scan read that as a failed check, so the push guard asked for a CHECK RETIRED line.
// Such a run is no result now: no credit, no failure, as a run that tested nothing already is. red-proof
// prints this exact line last, and only for a usage refusal. A refusal that judged the break plan (a break
// that matches twice, an unproven break) does not print it and stays a failed check.
const PROOF_REFUSED = 'RED-PROOF: REFUSED — nothing ran';
// The proof's own exit code is 2 and nothing else in the result says failed. Never when a later step hides
// the code (rec.hidden): then only the run record can say it.
function proofExitTwo(rec, t, text) {
  if (rec.hidden) return false;
  const exit = t.task?.exitCode ?? t.exitCode ?? t.exit_code ?? (/^Exit code (-?\d+)/m.exec(text) || [])[1];
  if (exit === undefined || exit === null || Number(exit) !== 2) return false;
  return !FAIL_MARKERS.some((re) => re !== EXIT_LINE && re.test(text)) && !/RED-PROOF: PROVED\b/.test(text);
}
// The result itself shows the refusal: exit 2, and its last line is exactly the refusal line.
function proofRefusedShown(rec, t, text) {
  if (!rec.proof.shown || !proofExitTwo(rec, t, text)) return false;
  const rows = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  return rows.length > 0 && rows[rows.length - 1] === PROOF_REFUSED;
}
// The run's own record says the same: exit 2, the refusal line as its last RED-PROOF line, no green run.
function proofRefusedRecord(run) {
  return run.exit === 2 && run.verdict === PROOF_REFUSED && run.green === 'none';
}

// This run's record, or null: one record only, of the same arguments, that started after the launch and
// ended before the result came (doneAt). No times, no state folder, or two such records: null.
function proofRunRecord(st, proof, doneAt) {
  const from = Date.parse(proof.at || ''), to = Date.parse(doneAt || '');
  if (!st.proofRuns || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  let names;
  try { names = fs.readdirSync(st.proofRuns); } catch (e) { return null; }
  const want = JSON.stringify(proof.args);
  const found = [];
  for (const name of names) {
    const m = /^(\d{10,16})-\d+\.json$/.exec(String(name));
    if (!m || Number(m[1]) < from - RUN_SLACK_MS || Number(m[1]) > to + RUN_SLACK_MS) continue;
    let run = null;
    try { run = JSON.parse(fs.readFileSync(path.join(st.proofRuns, String(name)), 'utf8')); } catch (e) { continue; }
    if (!run || typeof run !== 'object' || !Array.isArray(run.argv) || JSON.stringify(proofWords(run.argv)) !== want) continue;
    const start = Date.parse(run.startedAt || ''), end = Date.parse(run.endedAt || '');
    if (!(start >= from - RUN_SLACK_MS) || !(end >= start) || !(end <= to + RUN_SLACK_MS)) continue;
    found.push(run);
  }
  return found.length === 1 ? found[0] : null;
}

// A red-proof check's result: { outcome, green }. outcome as for any check (pending, passed, failed, none);
// green: its green run passed on the tree it launched on. The proof's own lines decide when the result shows
// them; else its run record. The command's own exit code, when it reached the tool, keeps deciding pass or
// fail; behind `; echo` (outcome 'none') the record's exit code does: 0 passed, any other failed.
function proofResult(st, rec, blk, entry, outcome) {
  const t = entry.toolUseResult || {};
  if (outcome === 'pending' || t.interrupted === true || /^(?:killed|cancelled|canceled)$/.test(t.task?.status || '')) return { outcome, green: false };
  const text = resultText(blk, entry).replace(ANSI, '');
  const said = greenInText(text);
  if (said !== null) {
    const exit = rec.hidden ? undefined : (t.task?.exitCode ?? t.exitCode ?? t.exit_code ?? (/^Exit code (-?\d+)/m.exec(text) || [])[1]);
    return { outcome, green: said && (exit === undefined || exit === null || Number(exit) === 0 || Number(exit) === 1) };
  }
  // A usage refusal that ran nothing is no result (2026-11-19).
  if (proofRefusedShown(rec, t, text)) return { outcome: 'none', green: false };
  const run = proofRunRecord(st, rec.proof, entry.timestamp);
  if (!run) return { outcome, green: false };
  // The same refusal with its lines in a file: the record decides only where the result gave no line of the
  // proof's own (outcome 'none'), or showed its exit code 2 and no other failure.
  if (proofRefusedRecord(run) && (outcome === 'none' || proofExitTwo(rec, t, text))) return { outcome: 'none', green: false };
  const sameTree = /^[0-9a-f]{40,64}$/i.test(String(run.treeStart || '')) && run.treeStart === run.treeEnd;
  const green = run.green === 'passed' && (run.exit === 0 || run.exit === 1) && sameTree;
  if (outcome !== 'none') return { outcome, green };
  return { outcome: run.exit === 0 ? (green ? 'passed' : 'none') : 'failed', green };
}

// 2026-11-18 (finding 5): a stream redirection (`2>&1`, `> check.log`) is no part of the command, and the spec
// may be given as `--spec=<file>`. The installed helper lives under some user's .claude folder; any other
// evidence.mjs is a stray script.
function isEvidenceCommand(segment) {
  const words = stripRedirects(tokenize(segment));
  if (!(/^node(?:\.exe)?$/i.test((words[0] || '').split(/[\\/]/).pop()) &&
    /(?:^|\/)\.claude\/skills\/gate\/scripts\/evidence\.mjs$/i.test((words[1] || '').replace(/\\/g, '/')))) return false;
  return (words.length === 4 && words[2] === '--spec') || (words.length === 3 && /^--spec=\S/.test(words[2]));
}
// The one evidence run of a command, in its common honest forms: a leading `cd <dir> &&`, a display tail
// (`| tail`, `| head`, `| tee`) after it, a redirect of its output. { decorated } is true when its output may not
// reach the result (a redirect to a file, a tail that cuts it): no receipt line then is no failure, only no credit.
// Anything else around it (a second command) is not read.
const LEADING_CD = /^\s*(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*$/i;
function evidenceRun(segs) {
  const at = segs.findIndex(isEvidenceCommand);
  if (at === -1 || segs.slice(at + 1).some((s) => !isDisplaySegment(s))) return null;
  if (segs.slice(0, at).some((s) => !LEADING_CD.test(String(s)))) return null;
  const toFile = tokenize(segs[at]).some((w) => !/^\d*>&(?:\d+|-)$/.test(w) && /^(?:&>|\d*>>?|<)/.test(w));
  return { decorated: toFile || at < segs.length - 1 };
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
      const seen = !invalidTarget && record.status === 'passed' && record.nativeExitCode === 0 && !record.reason && !record.signal ? verificationResult(block, entry) : 'failed';
      // A receipt of a run that tested nothing ('none') is no passing receipt and no failure (finding 2, 2026-11-18).
      return { key: record.cwd.replace(/\\/g, '/').toLowerCase() + '\n' + JSON.stringify([record.executable, ...record.args]), outcome: seen === 'passed' ? 'passed' : seen === 'none' ? 'none' : 'failed', record };
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
const QUALIFIER = '(?:\\*\\*|__)?(?:\\s*(?:\\([^()\\n]{1,80}\\)|\\[[^\\[\\]\\n]{1,80}\\])){0,2}(?:\\*\\*|__)?';
const NOTE_LINE = new RegExp('^(\\s*)((?:[-*•]|\\d{1,3}[.)])\\s+)?(?:(?:\\*\\*|__)\\s*)?' +
  '(?:(Blocker|Bug|Gap|Question)' + QUALIFIER + '(?:\\s+[—–](?:\\s|$)|\\s+-(?:\\s|$)|\\s*:)|(EXTRA TEST)' + QUALIFIER + ':)');
const FENCE_LINE = /^\s*(```|~~~)/;
const NOTE_CHARS = 300;
// A finding line that only says there is none (2026-11-22, owner: "EXTRA TEST: none." is no note). The whole text is
// none, n/a, nothing or not applicable, with a full stop at most. Only an EXTRA TEST line may add a reason after a dash
// ("EXTRA TEST: none — the tests cover it"), and only one that names no file:line and no defect: "Bug: none — the save
// drops page 2" stays a note (attack, 2026-11-22). Such a line keeps its number, closed at once (see addReport).
const NONE_ONLY = /^(?:none|n\/a|nothing|not applicable)\s*[.!]?$/i;
const NONE_REASON = /^(?:none|n\/a|nothing|not applicable)\s*[.!]?\s*[—–-]\s+(.+)$/i;
// The reason must say why no test is missing (re-check, 2026-11-22: "none — retries duplicate invoices" names a defect
// in words no list of defect words holds): it says the tests cover it, or that nothing is missing, and names no
// file:line and no "but".
const COVERED_REASON = /\b(?:cover(?:s|ed|ing)?|already (?:tested|covered|checked)|tested (?:above|already)|nothing (?:else|more|to add|missing)|no (?:gap|extra test|other case|case left)|not needed)\b/i;
const DEFECT_WORDS = /\w\.\w+[`*_"']*:\d|\b(?:but|except|however|although|though|missing|untested|not tested|fails?|failing|wrong|broken|bug|crash\w*|drops?|loses?|leaks?)\b/i;
function noneFinding(kind, rest) {
  const text = String(rest || '').replace(/[*_`]+/g, '').trim();
  if (NONE_ONLY.test(text)) return true;
  const r = kind === 'EXTRA TEST' ? NONE_REASON.exec(text) : null;
  return Boolean(r) && COVERED_REASON.test(r[1]) && !DEFECT_WORDS.test(r[1]);
}
// A finding-shaped line the note parser did not read (2026-11-17, audit 2): a severity or priority tag at the start of
// the line (after an optional list mark and bold), then text: [P0]..[P4], P1: / P1 —, [High], High:, Critical, Major,
// Severe, Medium, Low, Severity:, Issue, Finding, Problem, Defect, Vulnerability. Narrow on purpose: prose, headings,
// trace-list lines and "none" lines are no finding. A word tag needs its separator (a colon or a dash).
// Repair (2026-11-17): a leading list mark, heading or quote mark, bold, backticks or a status emoji may stand before
// the tag; the bare "P2:" of the places list is no tag (a bare P<n> counts only when a file:line follows it at once);
// Blocker, Bug and Gap in a form NOTE_LINE does not read ([Blocker], BLOCKER:, Bug 1:) are tags; one noun may sit
// between a severity word and its separator (Critical bug, High severity).
const SEP = '(?:\\*\\*|__)?[ \\t]*(?:[:—–]|-(?=\\s))(?:\\*\\*|__)?';
const TAG_MARKS = '^[ \\t]*(?:(?:[-*•>]|#{1,6}|\\d{1,3}[.)])[ \\t]+)*(?:\\*\\*|__|`)*[ \\t]*(?:\\p{Extended_Pictographic}[\\uFE0F\\u200D]*[ \\t]*)*(?:\\*\\*|__|`)*[ \\t]*';
const LABEL_WORDS = '(?:Severity|Priority|Issues?|Findings?|Problems?|Defects?|Vulnerabilit(?:y|ies)|Vulns?)';
const QUAL = '(?:[ \\t]*\\([^()\\n]{1,80}\\))?';
const FINDING_SHAPE = new RegExp(TAG_MARKS + '(?:' +
  '\\[(?:P[0-4]|Critical|High|Medium|Low|Major|Minor|Severe|Blocker|Bug|Gap)\\]' +
  '|\\((?:P[0-4]|Critical|High|Medium|Low|Major|Severe)\\)' +
  '|P[0-4](?=[ \\t]*(?:[:—–-][ \\t]*)?[\\w./\\\\-]+\\.\\w+:\\d)' +
  '|(?:Critical|High|Major|Severe|Medium|Low)(?:[ \\t]+(?:bug|issue|severity|priority|risk|finding))?' + QUAL + SEP +
  '|(?:Blocker|Bug|Gap)(?:[ \\t]*#?\\d{1,3})?' + QUAL + SEP +
  '|(?:Severity|Priority)[ \\t]*:' +
  '|' + LABEL_WORDS.replace('Severity|Priority|', '') + '(?:[ \\t]*#?\\d{1,3})?' + QUAL + SEP +
  ')(?:\\*\\*|__|`)*[ \\t]*(?=\\S)', 'iu');
// A field label of a finding (Severity: High, Problem: ...): quiet when it sits right under a note that was read.
const LABEL_LINE = new RegExp(TAG_MARKS + LABEL_WORDS + '\\b', 'iu');
const NO_FINDING_TEXT = /^[\s*_(`]*(?:none|no|n\/a|nothing|not applicable)(?![A-Za-z0-9])/i;
// A count-only text ("1 Bug, 1 Gap", "0") is no finding; a number inside a sentence is.
const COUNT_WORDS = /\d+|\b(?:blockers?|bugs?|gaps?|findings?|issues?|notes?|questions?|critical|high|medium|low|major|minor|and|in total|total)\b|[\s*_(),;/&+.:`-]/gi;
const noFindingText = (t) => NO_FINDING_TEXT.test(t) || (/\d/.test(t) && !t.replace(COUNT_WORDS, ''));
// A line that asks the user to decide is a question for the user, in any format (2026-11-16, PR #784: an
// expert wrote "you decide" in a plain line; it never became a note and the user was never asked).
// "your call" (and "user's call") counts only as a choice marker: "(your call)", "— your call" ending a clause,
// "your call:", or "your call." ending a sentence; never "your call to fetch()". "ask the user" counts only before
// whether / which / if / to decide / to choose / before; never "the page should ask the user to confirm".
const CALL = "(?:your|user['’]s) call";
const ASKS_USER = new RegExp('\\b(?:you decide|user decides|for the user to decide)\\b' +
  '|\\(\\s*(?:the\\s+)?' + CALL + '\\s*\\)' +
  '|[—–-]\\s*' + CALL + '\\s*(?=[.,;:!?)]|$)' +
  '|\\b' + CALL + '\\s*:' +
  '|\\b' + CALL + '\\.(?=\\s|$)' +
  '|\\bask the user(?:\\*\\*|__)?[:,]?\\s+(?:whether|which|if|to decide|to choose|before)\\b', 'i');
// An OUTSIDE PR line (and its list) is an end-of-task item the user answers at the end: never a note (2026-11-16).
const OUTSIDE_LINE = /^\s*(?:(?:[-*•]|\d{1,3}[.)])\s+)?(?:(?:\*\*|__)\s*)?OUTSIDE PR(?:\*\*|__)?\s*:/i;
const LIST_START = /^(\s*)((?:[-*•]|\d{1,3}[.)])\s+)?/;
const asksUser = (l) => ASKS_USER.test(l) && !OUTSIDE_LINE.test(l);
// The end (exclusive) of row i's lines: its more-indented continuation lines, or, when nothing follows its
// separator (said is empty), the lines below it up to a blank line. A finding line or a code fence ends it.
function rowsOf(rows, i, said) {
  const indent = (l) => /^\s*/.exec(l)[0].length;
  let j = i + 1;
  for (; j < rows.length; j++) {
    const next = rows[j];
    if (!next.trim() || NOTE_LINE.test(next) || FENCE_LINE.test(next) || (said && indent(next) <= indent(rows[i]))) break;
  }
  return j;
}
// The review-checklist line a finding names in its qualifier (2026-11-17, review score): `Bug (CLIENT STATE) — …`
// gives 'CLIENT STATE', so the kinds of finding that repeat across tasks can be counted. Only upper-case words
// count (letters, spaces, slashes, hyphens: the checklist's own names, as FAILURES / LOCALES and HALF-DONE);
// `Gap (low) —` and a line with no qualifier give ''. head: the part of the line NOTE_LINE matched, where the
// qualifiers are round or square brackets, up to two; the first that is a class name wins.
const CLASS_NAME = /^[A-Z]+(?:(?: ?\/ ?|[ -])[A-Z]+)*$/;
function noteClass(head) {
  const pair = /\(([^()\n]{1,80})\)|\[([^\[\]\n]{1,80})\]/g;
  for (let q = pair.exec(head); q; q = pair.exec(head)) {
    const name = (q[1] || q[2]).replace(/\s+/g, ' ').trim();
    if (name.length > 1 && CLASS_NAME.test(name)) return name.replace(/ ?\/ ?/g, ' / ');
  }
  return '';
}
// Each note of a report, in order: { kind, text, asks? }. Text: the line without its list marker, plus its
// more-indented continuation lines, cut to 300 characters. A note with nothing after its separator
// (`EXTRA TEST:` over a list) takes the lines below it up to a blank line. Lines in a code block are examples.
// A line that asks the user to decide (ASKS_USER) and is no finding line is a Question note; a continuation
// line belongs to its note, which then asks the user too (asks: true), so no line counts twice (2026-11-16).
// classes: an array, when given, takes each note's checklist line (see noteClass) at the note's index; the
// note objects keep their shape.
// unread: an array, when given, takes each finding-shaped line that no note took (see FINDING_SHAPE), as text.
function reportNotes(report, classes, unread) {
  const rows = String(report || '').replace(/\r/g, '').split('\n');
  const notes = [];
  let fence = '', taken = -1;   // taken: the last row already part of a note or an OUTSIDE PR item
  let under = false;            // under: the rows since the last note have had no blank line (its field labels)
  for (let i = 0; i < rows.length; i++) {
    const f = FENCE_LINE.exec(rows[i]);
    if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = ''; continue; }
    if (fence) continue;
    if (!rows[i].trim()) under = false;
    const m = NOTE_LINE.exec(rows[i]);
    if (!m && i <= taken) continue;
    if (!m && OUTSIDE_LINE.test(rows[i])) { under = false; taken = rowsOf(rows, i, rows[i].replace(OUTSIDE_LINE, '').replace(/^\s*(?:\*\*|__)/, '').trim()) - 1; continue; }
    if (!m && !asksUser(rows[i])) {
      const shaped = Array.isArray(unread) && FINDING_SHAPE.test(rows[i]);
      // Repair (2026-11-17): "Severity: High" or "Problem: ..." right under a note that was read is its field label,
      // unless it names a file and line (then it is a finding of its own).
      if (shaped && under && LABEL_LINE.test(rows[i]) && !/\w\.\w+[`*_"']*:\d+/.test(rows[i])) continue;
      if (rows[i].trim()) under = false;
      if (shaped && !noFindingText(rows[i].replace(FINDING_SHAPE, ''))) unread.push(rows[i].trim().slice(0, NOTE_CHARS));
      continue;
    }
    under = true;
    const start = m || LIST_START.exec(rows[i]);
    const parts = [rows[i].slice(start[1].length + (start[2] || '').length)];
    const end = rowsOf(rows, i, m ? rows[i].slice(m[0].length).trim() : parts[0].trim());
    for (let j = i + 1; j < end; j++) parts.push(rows[j]);
    taken = end - 1;
    const note = { kind: m ? m[3] || m[4] : 'Question', text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS) };
    // 2026-11-22: a line that only says there is none (noneFinding) stays in the list, so every later note keeps its
    // number; it is marked, and addReport closes it at once.
    if (m && end === i + 1 && noneFinding(note.kind, rows[i].slice(m[0].length))) note.none = true;
    if (rows.slice(i, end).some(asksUser)) note.asks = true;
    notes.push(note);
    if (Array.isArray(classes)) classes.push(m ? noteClass(m[0]) : '');
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
// 2026-11-18 (finding 7): is this a second copy of a report this agent already gave? A queued or delivered second
// copy of an old hand-back, arriving after a SendMessage moved the run's launch, would otherwise credit the
// follow-up run before it has reported. A run reaches the transcript through two channels, its hand-back ('hand')
// and its finish notice ('notice'). Judged by the report text: an identical text whose run has not yet come through
// both channels is a copy (the same channel again, or the other one); once both came, the run is complete and the
// same text later is a new run's report (a re-check that finds the same thing). Remembers what it saw.
function reportSeen(agent, text, kind) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return false;
  const mark = require('crypto').createHash('sha1').update(t).digest('hex');
  if (!agent.seen || typeof agent.seen !== 'object' || Array.isArray(agent.seen)) agent.seen = {};
  const kinds = agent.seen[mark];
  if (Array.isArray(kinds) && !(kinds.includes('hand') && kinds.includes('notice'))) {
    if (!kinds.includes(kind)) kinds.push(kind);
    return true;
  }
  agent.seen[mark] = [kind];
  return false;
}
// A reviewer run is complete: credit it for the push gate and the task timer.
function creditReviewer(st, agent, seq, at) {
  reviewDone(st, agent.at, String(at || ''), agent.call, agent.seat);
  agent.done = true;   // 2026-11-18: this run has reported (res.lastRunningReviewer, the review record)
  if (agent.launch > st.res.lastReviewerRun) { st.res.lastReviewerRun = agent.launch; st.res.lastReviewerResult = seq; }
}

// The other engine's report is read from a file: a tool result with a line that starts with its
// verdict. The report runs from that line on. The Read tool shows a number and a tab before each line.
const RECOMMEND_LINE = /^RECOMMEND: (?:PASS|FAIL)(?![|\w])/m;
const READ_NUMBERED = /^\s*\d+[\t→]RECOMMEND: (?:PASS|FAIL)(?![|\w])/m;
function recommendReport(text) {
  let s = String(text || '').replace(/﻿/g, '');   // a Bash cat keeps a file's BOM
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
// questionsOnly: an expert seat's report (2026-11-16). Only what it asks the user to decide is a note, as a
// Question; its Bug/Gap/… lines are design input for the author, not review notes.
// seat: who wrote the report (see reviewerSeat, expertSeat, FILE_SEAT). Each note's seat and the checklist line
// it names go in st.noteSeats and st.noteClasses, at the note's index (2026-11-17, review score).
const expertReadKey = (id, expert) => (expert.msg ? id + '@' + expert.launch + '~' + expert.msg : '');
// readKey: the note checker's one-reading key, which a SendMessage to it changes while its launch stays (2026-11-18).
function addReport(st, report, key, seq, at, seat, questionsOnly = false, readKey = '') {
  if (typeof st.since === 'number') { const t = Date.parse(at || ''); if (Number.isFinite(t) && t < st.since) return; }
  // A note checker's report (2026-11-17, user decision): its REFUTED lines make a note refutable; it adds no note.
  if (seat === NOTE_CHECK_SEAT) { readRefutations(st, report, key, readKey); return; }
  const notes = st.res.reviewNotes;
  const classes = [];
  const unread = [];
  const read = reportNotes(report, classes, unread);
  // Audit 4 (2026-11-17): a FAIL report that no note could be read from must not become an empty pass.
  // One Blocker, once per report (a keyless file report is keyed by its own text).
  // Audit 2 (2026-11-17): the same Blocker when notes were read but a finding-shaped line was not (a severity tag the
  // reader does not know), so one minor note cannot hide a serious finding; its text counts and quotes those lines.
  const noneRead = !read.some((n) => !n.none && /^(?:Blocker|Bug|Gap)$/.test(n.kind));
  // 2026-11-22 (owner): a verdict line inside a fenced code block (a reviewer's test) is an example, not the verdict.
  if (!questionsOnly && (noneRead || unread.length) && FAIL_VERDICT.test(String(report || '').replace(/\r/g, '').replace(FENCED, ''))) {
    const failKey = (key || 'file@' + require('crypto').createHash('sha1').update(String(report).replace(/\r/g, '').trim()).digest('hex')) + '#fail';
    if (!st.reportKeys.includes(failKey)) {
      st.reportKeys.push(failKey);
      const text = noneRead ? UNREADABLE_FAIL : unreadLinesText(unread);
      notes.push({ n: notes.length + 1, kind: 'Blocker', text, outcome: null });
      st.noteSeqs.push(seq); st.noteSeats.push(seat || 'reviewer'); st.noteClasses.push('');
    }
  }
  for (const [i, found] of read.entries()) {
    if (questionsOnly && found.kind !== 'Question' && !found.asks) continue;
    const note = questionsOnly ? { kind: 'Question', text: found.text } : found;
    const seen = key ? st.reportKeys.some((k) => k.startsWith(key + '#') && (notes[Number(k.slice(key.length + 1)) - 1] || {}).text === note.text)
      : notes.some((n) => n.text === note.text);
    if (seen) continue;
    // asks (2026-11-18, audit 3): a Gap or Bug that asks the user to decide is the user's, like a Question.
    // A "none" line keeps its number, closed from the start (outcome 'none'): no answer is asked for it.
    notes.push({ n: notes.length + 1, kind: note.kind, text: note.text, outcome: found.none ? 'none' : null, ...(note.asks ? { asks: true } : {}) });
    st.noteSeqs.push(seq);
    st.noteSeats.push(seat || 'reviewer');
    st.noteClasses.push(classes[i] || '');
    if (key) st.reportKeys.push(key + '#' + notes.length);
  }
}

// Audit 4 (2026-11-17): the verdict line of a FAIL report, and the Blocker a FAIL report with no readable finding gives.
const FAIL_VERDICT = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_]*RECOMMEND:[`*_ \t]*FAIL(?![|\w])/m;
const UNREADABLE_FAIL = 'the reviewer said FAIL but no finding line could be read: ask it to restate each finding as a line that starts with Blocker, Bug, Gap or Question';
const unreadLinesText = (unread) => 'the report holds ' + unread.length + ' line(s) the guards could not read as findings, the first: "' + unread[0].slice(0, 160) +
  '": ask the reviewer to restate each finding as a line that starts with Blocker, Bug, Gap or Question';
// The note checker (2026-11-17, user decision): an independent run whose prompt starts "Seat: Note check" may refute
// a note; the author alone never can. Its `REFUTED <n> — <evidence>` lines make note n refutable (st.refutable:
// { n, evidence }) when the note exists, is open, was written before that run started and is no Blocker.
const NOTE_CHECK_PROMPT = /^\s*Seat:[ \t]*Note check\b/i;
const NOTE_CHECK_SEAT = 'expert: note check';
// Only the guards' own numbers count: a K number belongs to one note-check brief, not to a NOTE number.
// The shapes of note-check.mjs are read: lead-in marks, a colon after REFUTED, backticks around the number.
const REFUTED_RE = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_ \t]*REFUTED:?[ \t]+(?:NOTE[ \t]+)?[`*_]*(\d{1,4})[`*_]*[ \t]*(?:[—–:]|-)[ \t]*[`*_]*[ \t]*(\S.*)$/gim;
const FILE_LINE = /\w\.\w+[`*_"']*:\d+/;
// A CONFIRMED or UNSURE line for a note, in the same shapes (a separator after the number, so "CONFIRMED 3 files" is prose).
// Repair (2026-11-17): as wide as note-check.mjs's own reader (marks after the verdict word, no separator needed after
// the number, "K1", "1 and 2"); a prose line such as "CONFIRMED 1 file holds it" then only withdraws a refutation,
// which is the safe side. m[1]: the numbers of the line.
const NOT_REFUTED_RE = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_ \t]*(?:CONFIRMED|UNSURE)[`*_]*[ \t]*:?[ \t]*[`*_]*(?:NOTE[ \t]+|K[ \t]*)?[`*_]*(\d{1,4}(?:(?:[ \t]*,[ \t]*|[ \t]+(?:and|&)[ \t]+)(?:K[ \t]*)?\d{1,4})*)(?!\d)/gim;
// 2026-11-18 (audit 3, user decision): a note kind the checker never refutes. A Blocker and a Question go to the user;
// the checker gives its view, the user's words close them.
// A note that asks the user to decide (a Gap or Bug line with "you decide", asks: true) is the user's too.
const NEVER_REFUTED = /^(?:Blocker|Question)$/;
const neverRefuted = (note) => NEVER_REFUTED.test(note.kind) || note.asks === true;
// One verdict of the checker run launched at `launch` for note n. refuted: the evidence of a valid REFUTED line, or
// null for a verdict that is not a refutation (CONFIRMED, UNSURE, an invalid REFUTED); confirmed: a CONFIRMED line.
// Verdicts apply in the order the checkers were LAUNCHED, not the order their results arrive: a result of an older
// launch changes nothing for a note once a newer launch gave a verdict for it (st.verdictLaunch: { n, launch }).
// A refutation holds for the newest launch only; a newer CONFIRMED reopens a note closed as refuted, while a note
// closed by the user's words or as fixed stays closed.
// 2026-11-18 (scoped staleness): answers are ordered by (launch, then the order the answers completed). reading is that
// order: the number of the answer reading (the count of keys in st.reportKeys when it was read, which only grows). A later
// answer of the SAME checker (a follow-up to it) beats its earlier one: REFUTED, then a CONFIRMED of the follow-up reopens.
function giveVerdict(st, n, launch, reading, refuted, confirmed) {
  const note = st.res.reviewNotes[n - 1];
  if (!note || !(st.noteSeqs[n - 1] < launch)) return;
  const known = st.verdictLaunch.find((v) => v.n === n);
  if (known && known.launch > launch) return;
  if (known) known.launch = launch; else st.verdictLaunch.push({ n, launch });
  const at = st.refutable.findIndex((r) => r.n === n);
  const held = at === -1 ? null : st.refutable[at];
  if (refuted !== null) {
    if (note.outcome || neverRefuted(note)) return;
    if (held && held.reading === reading) return;   // the same answer named it twice: the first line stands
    if (at !== -1) st.refutable.splice(at, 1);
    st.refutable.push({ n, evidence: refuted.slice(0, NOTE_CHARS), launch, reading });
    return;
  }
  if (!held) return;
  if (!note.outcome) { st.refutable.splice(at, 1); return; }
  if (confirmed && note.outcome === 'refuted' && held.reading !== reading) {
    st.refutable.splice(at, 1);
    note.outcome = null; delete note.evidence; delete note.problem;
  }
}
function readRefutations(st, report, key, readKey = '') {
  const launch = key ? Number(String(key).slice(String(key).lastIndexOf('@') + 1)) : NaN;
  if (!Number.isFinite(launch)) return;
  const raw = String(report || '').replace(/\r/g, '');
  // A refutation is read fence-free (code blocks blanked, same places); a CONFIRMED or UNSURE line is read in a code block
  // too, as it only withdraws or reopens (2026-11-18, audit 3 repair: note-check.mjs reads it there as well).
  const text = raw.replace(FENCED, (b) => b.replace(/[^\n]/g, ' '));
  readSameLines(st, text, launch);
  // The checker's last verdict for a note wins (2026-11-17): the verdict lines of both kinds, in the order written.
  const verdicts = [...[...text.matchAll(REFUTED_RE)].map((m) => ({ at: m.index, m })), ...[...raw.matchAll(NOT_REFUTED_RE)].map((m) => ({ at: m.index, m, other: true }))]
    .sort((a, b) => a.at - b.at);
  // One reading per checker run: a second copy of the run (hand-back and finish notice) must not re-arm a refutation
  // that a later run withdrew. A SendMessage to the checker gives a reading of its own (readKey), never a new launch.
  if (verdicts.length) {
    // 2026-11-18 (repair 5): the reading is keyed by the answer's own text, not by a SendMessage number: another text from the
    // same checker is a later reading (a follow-up sent by id or by name, or none seen); the same text is a copy.
    const ncKey = key + '#nc~' + require('crypto').createHash('sha1').update(raw.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
    if (st.reportKeys.includes(ncKey)) return;
    st.reportKeys.push(ncKey);
  }
  const reading = st.reportKeys.length;   // the order the answers were read in (see giveVerdict)
  for (const { m, other } of verdicts) {
    if (other) {
      // CONFIRMED or UNSURE: an open note is no longer refutable. A CONFIRMED of a newer launch also reopens a note
      // closed as refuted (2026-11-18); a note closed by the user's words or as fixed stays closed.
      const confirmed = /^[^A-Za-z]*CONFIRMED/i.test(m[0]);
      for (const num of m[1].match(/\d+/g)) giveVerdict(st, Number(num), launch, reading, null, confirmed);
      continue;
    }
    // A REFUTED line without a file and line, or too short, is no refutation: for the newest launch it withdraws one.
    const evidence = m[2].replace(/[`*_\s]+$/, '').trim();
    giveVerdict(st, Number(m[1]), launch, reading, evidence.length < 12 || !FILE_LINE.test(evidence) ? null : evidence, false);
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
function keepUserWords(st, seq, words) {
  if (oldestOpenReport(st) === Infinity) return;
  st.userWords.push({ seq, text: userText(words).slice(0, USER_WORDS_CHARS) });
  pruneUserWords(st);
}
// A carried decision (2026-11-19, the owner's yes; off unless he sets `git config sanad.carryDecision true`).
// An answer the owner gave in the AskUserQuestion dialog is kept with its call id (st.decisions), also when
// no note is open. It may close a LATER note only when all of these hold: the independent note checker wrote
// `SAME <n> = <k>`, note k was closed by that dialog answer, the quoted words are in that answer, no file
// either note names changed since the answer, and note n is no Blocker and names no security or ticket-line
// matter. The author never links two notes: only the checker's line does.
const DECISIONS_KEPT = 40;
const DECISION_CHARS = 2000;
function keepDecision(st, id, seq, words) {
  st.decisions.push({ id: String(id), seq, text: userText(words).slice(0, DECISION_CHARS) });
  if (st.decisions.length > DECISIONS_KEPT) st.decisions.splice(0, st.decisions.length - DECISIONS_KEPT);
}
// The checker's line, read outside code blocks: `SAME 7 = 3`, `SAME: NOTE 7 = NOTE 3`, with list or bold marks.
const SAME_RE = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_]*SAME[`*_]*[ \t]*:?[ \t]*(?:NOTE[ \t]+)?[`*_]*(\d{1,4})[`*_]*[ \t]*=[ \t]*(?:NOTE[ \t]+)?[`*_]*(\d{1,4})[`*_]*(?![\d.,]*\d)/gm;
// Each SAME line of the checker run launched at `launch`: both notes exist and were written before that run
// started. The newest launch's line for a note stands (st.sameAs: { n, k, launch }).
function readSameLines(st, text, launch) {
  for (const m of text.matchAll(SAME_RE)) {
    const n = Number(m[1]), k = Number(m[2]);
    if (n === k || !st.res.reviewNotes[n - 1] || !st.res.reviewNotes[k - 1]) continue;
    if (!(st.noteSeqs[n - 1] < launch) || !(st.noteSeqs[k - 1] < launch)) continue;
    const at = st.sameAs.findIndex((x) => x.n === n);
    if (at !== -1 && st.sameAs[at].launch > launch) continue;
    if (at !== -1) st.sameAs.splice(at, 1);
    st.sameAs.push({ n, k, launch });
  }
}
// A note the owner's earlier answer never closes: it reopens a round, whatever was decided before.
const NEVER_CARRIED = /\b(?:secur\w+|auth\w*|access|permission\w*|roles?|tenant\w*|secret\w*|token\w*|password\w*|injection|idor|xss|csrf|ticket|data[ \t]+loss|saved[ \t]+data)\b|\b[TC]\d+\b/i;
// A tag (T3, C2) names a ticket line or a check, in brackets, grouped ([C1, C2]) or bare: the same limit as the word ticket.
const neverCarried = (note) => note.kind === 'Blocker' || NEVER_CARRIED.test(String(note.text || ''));
// The owner's switch, read only when every other condition of a carried decision holds (a rare line).
const carrySwitches = new Map();
function carrySwitch(cwd) {
  const dir = String(cwd || '');
  if (!dir) return false;
  if (!carrySwitches.has(dir)) {
    let on = false;
    try {
      on = require('child_process').execFileSync('git', ['config', '--get', 'sanad.carryDecision'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }).trim().toLowerCase() === 'true';
    } catch (e) { on = false; }
    carrySwitches.set(dir, on);
  }
  return carrySwitches.get(dir);
}
// The note k whose dialog answer may close note n with the quoted words, or 0.
function carriedFrom(notes, n, note, quote, c) {
  const link = (c.same || []).find((x) => x.n === n);
  if (!link || !(link.launch < c.seq) || neverCarried(note)) return 0;
  const first = notes[link.k - 1];
  // The limit holds for the earlier note too: its answer is never reused for a limited matter.
  if (!first || neverCarried(first)) return 0;
  const by = first && first.outcome === 'user' ? (c.closedBy || []).find((b) => b.n === link.k) : null;
  const said = by ? (c.decisions || []).find((d) => d.id === by.id) : null;
  if (!said || !said.text.includes(quote)) return 0;
  const changed = (c.changes || []).some((e) => { const ch = typeof e === 'number' ? { seq: e, path: '' } : e; return ch.seq > said.seq && ch.seq < c.seq && (changeCancels(ch, note, '') || changeCancels(ch, first, '')); });
  if (changed) return 0;
  return typeof c.carry === 'function' && c.carry() === true ? link.k : 0;
}
function humanTurn(st, words) {
  const seq = ++st.seq;
  st.res.turnClaim = false;
  keepUserWords(st, seq, words);
}

// The user's answers in an AskUserQuestion result (2026-11-16: `NOTE 38: user — "Leave it for now
// (Recommended)"` stayed open, as the dialog's answer was not the user's words). The host writes
//   Your questions have been answered: "<question>"="<answer>", "<question>"="<answer>". You can now continue…
// (an older host: `User has answered your questions: …`), and this host also keeps toolUseResult.answers. An
// "Other" answer the user typed comes the same way. Only the answers count: the question is the assistant's text.
// questions: the call's own question texts; an answer is read only after its own question's `"<question>"="`.
const ASK_ANSWERED = /^\s*(?:Your questions have been answered|User has answered your questions?)\s*:\s*/i;
const ASK_PAIR = /"([^"\n]*)"="([\s\S]*?)"(?=\s*,\s*"|\s*\.\s+\S|\s*\.?\s*$)/g;
function askAnswers(blk, entry, questions) {
  const text = resultText(blk, null);
  const head = ASK_ANSWERED.exec(text);
  if (!head) return [];
  const t = entry.toolUseResult;
  if (t && typeof t === 'object' && t.answers && typeof t.answers === 'object' && !Array.isArray(t.answers)) {
    return Object.values(t.answers).filter((a) => typeof a === 'string' && a.trim());
  }
  const s = text.slice(head[0].length);
  // No question texts kept (a call without them): the pairs as written; a question holds no quote here.
  if (!questions.length) return [...s.matchAll(ASK_PAIR)].map((m) => m[2]).filter((a) => a.trim());
  const starts = [];
  let from = 0;
  for (const q of questions) {
    const at = s.indexOf('"' + q + '"="', from);
    if (at === -1) { starts.push(null); continue; }
    starts.push({ at, body: at + q.length + 4 });
    from = at + q.length + 4;
  }
  const out = [];
  starts.forEach((p, i) => {
    // An answer whose next question was not found has no known end: it could hold that question's text.
    if (!p || (i + 1 < starts.length && !starts[i + 1])) return;
    const next = starts[i + 1];
    let a = s.slice(p.body, next ? next.at : s.length);
    a = next ? a.replace(/"\s*,\s*$/, '') : a.slice(0, Math.max(0, a.lastIndexOf('"')));
    if (a.trim()) out.push(a);
  });
  return out;
}

// An outcome line in an assistant text (code blocks already removed): optional list marker, bold or
// backtick, then `NOTE <n>: fixed|user —`.
const OUTCOME_RE = /^[ \t]*(?:[-*•][ \t]+)?(?:\*\*|`)?NOTE[ \t]+(\d{1,4})[ \t]*:[ \t]*(fixed|user|refuted|Fixed|User|Refuted|FIXED|USER|REFUTED)\b(?:\*\*)?[ \t]*[—–-][ \t]*(.*)$/gm;
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// Each outcome line of a text (code blocks removed) on notes; seqs: each note's report seq; words: the
// user's words kept for open notes. A note already closed stays as it is, so applying twice changes nothing.
function applyOutcomes(notes, seqs, words, plain, ctx) {
  if (!notes.length || !/NOTE[ \t]+\d/.test(plain)) return false;
  for (const m of plain.matchAll(OUTCOME_RE)) applyOutcome(notes, seqs, words, Number(m[1]), m[2], m[3], ctx);
  return true;
}
// The notes still open once the final text's own outcome lines count: the host hands the stop gate that
// text before the transcript may hold it (2026-11-12, follow-up C). The scan result is not changed.
function openNotesAfter(r, text) {
  const notes = (r && Array.isArray(r.reviewNotes) ? r.reviewNotes : []).map((n) => ({ ...n }));
  applyOutcomes(notes, (r && r.reviewNoteSeqs) || [], (r && r.reviewUserWords) || [], String(text || '').replace(FENCED, ''),
    { seq: Infinity, edits: (r && r.reviewEditSeqs) || [], changes: (r && r.reviewChangeSeqs) || [], passes: (r && r.reviewPassSeqs) || [], refutable: (r && r.reviewRefutable) || [],
      same: (r && r.reviewSame) || [], decisions: (r && r.reviewDecisions) || [], closedBy: [...((r && r.reviewClosedBy) || [])], carry: () => carrySwitch(r && r.reviewCwd) });
  return notes.filter((n) => !n.outcome);
}
const FIXED_NEEDS_CHANGE = 'a fixed line needs a code change and a passing test after the note; a note that needs no change, or a text-only fix (a doc, a locale or a config file), is refuted by the note check or closed by the words the user typed';
const REFUTE_NEEDS_CHECK = 'only a note the note check refuted can be closed as refuted (a Blocker or a Question: never)';
const REFUTE_QUESTION = 'a Question is closed only by the words the user typed: the note check gives its view to the user, it never closes a Question (nor a note that asks the user to decide)';
const REFUTE_STALE = 'the code or a test changed after the note check started: run the note check again, and refute only on its newest answer';
function applyOutcome(notes, seqs, words, n, kind, rest, ctx) {
  const note = notes[n - 1];
  if (!note || note.outcome) return;
  const said = String(rest).replace(/[`*\s]+$/, '').trim();
  const c = ctx || { seq: Infinity, edits: [], changes: [], passes: [], refutable: [] };
  if (kind.toLowerCase() === 'fixed') {
    // `<what changed and its test>` is the format example, not an answer.
    if (!(said.length >= 12 && !/^<[^>]*>$/.test(said))) { note.problem = 'a fixed line must say what changed and its test (12 characters or more)'; return; }
    // Audit 3 (2026-11-17): a claim alone closes nothing. After the note's report and before this line there must be a
    // code or test edit, and a passing check launched after that edit.
    const after = seqs[n - 1];
    const edit = c.edits.find((e) => e > after && e < c.seq);
    if (edit === undefined || !c.passes.some((p) => p > edit && p < c.seq)) { note.problem = FIXED_NEEDS_CHANGE; return; }
    note.outcome = 'fixed'; delete note.problem;
    return;
  }
  if (kind.toLowerCase() === 'refuted') {
    // Only an independent note checker may refute, never a Blocker (user decision 2026-11-17) or a Question (2026-11-18).
    if (note.kind === 'Question' || note.asks === true) { note.problem = REFUTE_QUESTION; return; }
    const hit = note.kind !== 'Blocker' && c.refutable.find((r) => r.n === n);
    if (!hit) { note.problem = REFUTE_NEEDS_CHECK; return; }
    // 2026-11-18: the check holds only for the code it looked at: a code or test edit after its launch cancels it.
    // Any content change counts (a git move, git apply, a locale file), not only a code or test edit (audit 3 repair).
    // 2026-11-18 (scoped staleness): only a change of a file the note or the evidence names, or one with no known path.
    if ((c.changes || []).some((e) => { const ch = typeof e === 'number' ? { seq: e, path: '' } : e; return ch.seq > hit.launch && ch.seq < c.seq && changeCancels(ch, note, hit.evidence); })) { note.problem = REFUTE_STALE; return; }
    note.outcome = 'refuted'; note.evidence = hit.evidence; delete note.problem;
    return;
  }
  const q = /["“]([^"“”]*)["”]/.exec(said);
  const quote = q ? userText(q[1]) : '';
  if (quote.length < 8) { note.problem = 'a user line needs the user\'s exact words in quotes (8 characters or more)'; return; }
  const after = seqs[n - 1];
  const typed = words.find((w) => w.seq > after && w.text.includes(quote));
  if (typed) {
    note.outcome = 'user'; delete note.problem;
    // Closed by a dialog answer: its call id is kept, so the note checker may tie a later note to it.
    const answer = (c.decisions || []).find((d) => d.seq === typed.seq && d.text.includes(quote));
    if (answer && Array.isArray(c.closedBy) && !c.closedBy.some((b) => b.n === n)) c.closedBy.push({ n, id: answer.id });
    return;
  }
  const from = carriedFrom(notes, n, note, quote, c);
  if (from) { note.outcome = 'user'; note.carried = from; delete note.problem; }
  else note.problem = 'the quoted words are not in a message the user typed after this report';
}

// The final text claims the review passed: a line that starts with `REVIEW: PASS` or `GATE: PASS`
// (code blocks included: shown to the user, it still reads as a pass), or a code block with a command
// that runs `git push` or `gh pr create` (the user pushes by hand when the author hands one over).
// 2026-11-18: the push command counts wherever it stands in the text: a code block, inline backticks, quotes or
// plain words ("Run `git push origin HEAD:x`" was not seen before). The command may follow a backtick or quote.
const CLAIM_LINE = /^[ \t]*(?:REVIEW|GATE):[ \t]*PASS\b/m;
// 2026-11-18 (round 3): the command may follow any character but a word, dot or dash (bold, curly quotes, a path,
// a prompt `C:\repo>`), and git options may stand between git and push (`git --no-pager push`).
const PUSH_COMMAND = /(?<![A-Za-z0-9.-])git(?:\.exe)?["']?(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+push\b|(?<![A-Za-z0-9.-])gh(?:\.exe)?["']?\s+pr\s+create\b/;
function claimsReview(text) {
  const s = String(text || '');
  return CLAIM_LINE.test(s) || PUSH_COMMAND.test(s);
}

// The open notes as the stop gate and the push guard show them; at most 40 lines of notes.
const SHOWN_NOTES = 40;
function openNotesMessage(open) {
  const list = Array.isArray(open) ? open : [];
  if (!list.length) return '';
  const rows = list.slice(0, SHOWN_NOTES).map((n) => 'NOTE ' + n.n + ' (' + n.kind + '): ' + String(n.text).slice(0, 140) + (n.problem ? ' — still open: ' + n.problem : ''));
  if (list.length > SHOWN_NOTES) rows.push('… and ' + (list.length - SHOWN_NOTES) + ' more open notes, up to NOTE ' + list[list.length - 1].n + '.');
  const k = list[0].n;
  // The NOTE lines go in a message with no tool call (2026-11-16): text in a message that also runs a tool
  // may never reach the transcript, so its outcome lines never counted.
  return 'Reviewer notes without an outcome (rule 5: every reviewer note is fixed, or the user decides it):\n' + rows.join('\n') + '\n' +
    'To ask the user about a note, stop with the question and no verdict line or push command.\n' +
    'Answer each one in your next message, on its own line: `NOTE ' + k + ': fixed — <what changed and its test>` (only after a code change and a passing test that follow the note), `NOTE ' + k + ': refuted — <the note check\'s evidence>` (only a note the note check refuted, never a Blocker) or `NOTE ' + k + ': user — "<the user\'s exact words>"`. ' +
    'The NOTE lines go in a message with no tool call (text in a message that also runs a tool may never reach the record). A note is never closed by the author\'s own judgement. (SG-NOTES)';
}

// The reducer state of one scan: plain data only (Maps and Sets become arrays in the cache), so a
// later call continues where the last one stopped (2026-11-12, audit H17).
function newScanState() {
  return {
    res: { lastEdit: -1, lastEditPath: '', lastNonGitEdit: -1, lastNonRemoteEdit: -1, remoteCheckouts: [], lastNonSyncEdit: -1, lastNonSyncEditPath: '', syncMoves: [], lastGitRepo: '', passedTrees: [], passingReceipts: [], lastVerify: -1, lastVerifyResult: -1, lastFailedVerify: -1, lastFailedVerifyStop: -1, lastProbeFailure: -1, lastGreenProof: -1, lastPendingVerify: -1, lastPendingVerifyStop: -1, lastCancelledVerify: -1, lastCancelledVerifyCommand: '', lastGate: -1, lastGateVerdict: '', lastGateAt: '', lastReview: -1, lastReviewVerdict: '', completedCheck: null, lastBoundCheck: -1, lastProviderRun: -1, lastProviderResult: -1, lastFailedProvider: -1, lastPendingProvider: -1, lastReviewerRun: -1, lastReviewerResult: -1, lastReviewText: '', lastRangeDiff: -1, lastRangeDiffProof: -1, lastRangeDiffNew: [], lastRangeDiffOld: [], lastRangeDiffChanged: -1, lastRunningReviewer: -1,
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
    reviewerAgents: new Map(), // agent id -> { launch, at, seat } (latest run, incl. SendMessage follow-ups)
    // Expert seats (2026-11-16): their reports give Question notes only, and never a reviewer run.
    expertCalls: new Map(),    // Agent tool_use id -> launch seq (braintrust-expert(-sonnet) or routing-boss)
    expertAgents: new Map(),   // agent id -> { launch, seat } (latest run, incl. SendMessage follow-ups)
    seatCalls: new Map(),      // Agent tool_use id of a reviewer or expert launch -> its seat (2026-11-17; see reviewerSeat)
    askCalls: new Map(),       // AskUserQuestion tool_use id -> its question texts (its answers are the user's words)
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
    syncMoves: [],             // those moves and the git syncs (see gitSync): { seq, repo, remote } (2026-11-14)
    helperEdits: [],           // helper agents' edits not yet placed in time: { t, file, pos, edit }
    helperPending: new Map(),  // '<helper file>\n<tool_use id>' -> a helper's edit awaiting its result
    editSeqs: [],              // seq of every code or test edit (audit 3: a fixed line needs one after its note)
    changeSeqs: [],            // every content change: { seq, path } (path '' = unknown; see creditContent; 2026-11-18)
    refutable: [],             // notes a note checker refuted: { n, evidence, launch, reading }
    verdictLaunch: [],         // the newest checker launch that gave a verdict for a note: { n, launch } (see giveVerdict)
    noteSeqs: [],            // the seq of the report each reviewer note came in (same order as res.reviewNotes)
    noteSeats: [],             // the seat that wrote each note (same order; 2026-11-17, review score)
    noteClasses: [],           // the checklist line each note names, or an empty string (same order; see noteClass)
    reportKeys: [],            // each note a reviewer run gave: '<agent id>@<launch seq>#<note number>' (see addReport)
    userWords: [],             // what the user typed while a note was open: { seq, text } (see pruneUserWords)
    decisions: [],             // the owner's dialog answers: { id (the AskUserQuestion call), seq, text } (see keepDecision)
    sameAs: [],                // the note checker's SAME lines: { n, k, launch } (see readSameLines)
    closedBy: [],              // notes closed by a dialog answer: { n, id } (see applyOutcome)
    cwd: '',                   // the session's folder, from its newest entry (the owner's switch is read there)
  };
}
const STATE_MAPS = ['pending', 'background', 'verificationStates', 'providerStates', 'reviewerCalls', 'reviewerAgents', 'reviewerAt', 'helperCalls', 'helpersRunning', 'stopCalls', 'helperPending', 'expertCalls', 'expertAgents', 'askCalls', 'seatCalls'];
const STATE_LISTS = ['reviews', 'retirements', 'probes', 'passes', 'remoteCheckouts', 'syncMoves', 'helperEdits', 'noteSeqs', 'editSeqs', 'changeSeqs', 'refutable', 'verdictLaunch', 'noteSeats', 'noteClasses', 'reportKeys', 'userWords', 'decisions', 'sameAs', 'closedBy'];
function saveState(st) {
  const o = { ...st, finishedUncollected: [...st.finishedUncollected] };
  for (const k of STATE_MAPS) o[k] = [...st[k]];
  delete o.since;   // the start time belongs to the cache record, which is used only with the same one
  delete o.proofRuns;   // set by each scan (see scanOpen)
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
  if (typeof o.cwd !== 'string') return null;
  st.res = o.res; st.seq = o.seq; st.cwd = o.cwd;
  return st;
}

// The edit (and check) facts of an Edit-like or shell tool use, the same for the session and its helpers
// (editsOnly: a helper's, whose checks never count; only whether it verifies is kept, for the error rule).
function fillToolRecord(rec, blk, entry, seq, editsOnly = false) {
  if (EDIT_TOOLS.has(blk.name)) {
    const p = String(blk.input.file_path || blk.input.notebook_path || '');
    if (isCodePath(p)) { rec.editSeq = seq; rec.editPath = p; rec.nonGitEditSeq = seq; rec.noteEditSeq = seq; rec.nonRemoteEditSeq = seq; rec.nonSyncEditSeq = seq; rec.nonSyncEditPath = p; }
    if (isContentPath(p)) noteContentChange(rec, seq, p);   // 2026-11-18: any file counts for the note check, with its path
    return;
  }
  const segs = splitSegments(String(blk.input.command || ''));
  // A failed compound command must be retried as a whole; a success in
  // another directory or only its last test cannot erase that failure.
  // Display tails and redirections are not part of the identity (see identitySegments).
  if (!editsOnly) {
    rec.verifyKey = String(blk.input.cwd || blk.input.workdir || entry.cwd || '') + '\n' + identitySegments(segs).map(verificationIdentity).join(' ; ');
    rec.command = commandIdentity(blk.input.command);
    const evidenceCall = evidenceRun(segs);
    if (evidenceCall) { rec.evidence = true; rec.verifySeq = seq + 0.001; if (evidenceCall.decorated) rec.evidenceDecorated = true; }
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
  // For the remote-tip check (2026-11-14): the same folder with a relative `cd` joined to the one before,
  // since the stop gate's git runs in the hook's folder, not the shell's; '' once it cannot be followed
  // (popd, `cd` alone). A GIT_* variable set in the command can point git elsewhere: no sync in it then.
  const gitBash = blk.name === 'Bash' && !!proc && proc.platform === 'win32';
  let syncDir = joinFolder(cdDir, '', gitBash);
  const heredocAt = heredocWriteSegment(segs, String(blk.input.command || ''), cdDir);   // an interpreter fed a heredoc that writes (2026-11-18)
  const gitEnv = segs.some((s) => /(?:^|[\s;&|(])(?:export\s+|set\s+|\$env:)?GIT_[A-Za-z_]+\s*=/i.test(String(s)));
  for (let i = 0; i < segs.length; i++) {
    const frac = seq + (i + 1) / 1000;
    const cd = /^\s*(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*$/i.exec(String(expanded[i]));
    if (cd) { cdDir = stripQuotes(cd[1]); syncDir = joinFolder(cd[1], syncDir, gitBash); }
    else if (/^\s*\(?\s*(?:cd|chdir|sl|Set-Location|pushd|popd|Push-Location|Pop-Location)(?:\s|$)/i.test(String(expanded[i]))) syncDir = '';
    if (segmentIsVerify(segs[i])) rec.verifySeq = frac;
    if (!editsOnly && segs.length === 1 && segmentIsProvider(segs[i])) rec.providerSeq = frac;
    if (!editsOnly && segs.length === 1 && /^git(?:\.exe)?\s+range-diff\s/i.test(String(segs[i]).trim())) {
      rec.rangeDiffSeq = frac;
      // 2026-11-17 (audit H1): only a bare run can be read as proof; a redirect, a substitution or a one-sided filter hides the new/changed commits.
      rec.rangeDiffReadable = rangeDiffCommandReadable(String(segs[i]));
    }
    const paths = [...segmentEditPaths(expanded[i], cdDir, i + 1 < expanded.length && readsStdin(expanded[i + 1]), i > 0 && (segmentIsVerify(segs[i - 1]) || isEvidenceCommand(segs[i - 1])), i > 0 && isReporter(segs[i - 1])), ...(i === heredocAt ? ['<generated>'] : [])].filter((p) => !(stashBundle && p === '<git>' && /\bstash\b/i.test(segs[i])));
    // 2026-11-18 (audit 3 repair; scoped staleness): each change keeps its path; a git move has none ('').
    const noMove = gitMovesNoContent(expanded[i]);   // 2026-11-18 (repair 6): a git form that moves no file content
    for (const p of paths) if (p !== '<generated>' && !(noMove && GIT_CHANGE.test(p))) noteContentChange(rec, frac, GIT_CHANGE.test(p) ? '' : p);
    for (const p of contentChange(expanded[i], cdDir)) noteContentChange(rec, frac, p);
    if (paths.length) {
      rec.editSeq = frac; rec.editPath = paths[0];
      if (paths.some((p) => !GIT_CHANGE.test(p))) rec.nonGitEditSeq = frac; if (paths.some((p) => !GIT_CHANGE.test(p) && p !== '<generated>')) rec.noteEditSeq = frac; // a git move or a formatter run is no author edit
      if (paths.some((p) => p !== '<git-remote>')) rec.nonRemoteEditSeq = frac;
      if (paths.some((p) => GIT_CHANGE.test(p))) {
        const dashC = /\bgit(?:\.exe)?\s+-C\s+("[^"]+"|'[^']+'|\S+)/i.exec(String(expanded[i]));
        const repo = dashC ? stripQuotes(dashC[1]) : cdDir;
        if (GIT_CHANGE.test(paths[0])) rec.gitRepo = repo;
        if (paths.includes('<git-remote>')) rec.remotes.push({ seq: frac, repo });
      }
      // A git sync (or fetched-ref move) the stop gate may judge by its folder's state (2026-11-14); every
      // other path of the segment is a change of its own. The marker stays '<git>', so the push guard is unchanged.
      const sync = !gitEnv && paths.some((p) => GIT_CHANGE.test(p)) ? gitSync(expanded[i]) : null;
      const synced = (p) => !!sync && GIT_CHANGE.test(p);
      // Its path too (2026-11-17): when the syncs after it are credited, the stop gate names this edit, not them.
      if (paths.some((p) => !synced(p))) { rec.nonSyncEditSeq = frac; rec.nonSyncEditPath = paths.find((p) => !synced(p)); }
      if (sync) rec.syncs.push({ seq: frac, repo: sync.dir ? joinFolder(sync.dir, syncDir, gitBash) : syncDir, remote: paths.includes('<git-remote>') });
    }
  }
  // A check whose exit code a later part of the command hides is judged by its output alone (H4).
  if (!editsOnly && rec.verifySeq !== -1 && !rec.evidence) {
    const hidden = hiddenCheckRunners(String(blk.input.command || ''));
    if (hidden) rec.hidden = hidden;
    // A red-proof run, the only check of its command: its arguments and launch time find its run record.
    const proof = proofLaunch(segs, expanded, entry.timestamp);
    if (proof) rec.proof = proof;
  }
}
const emptyRecord = (background) => ({ editSeq: -1, editPath: '', nonGitEditSeq: -1, noteEditSeq: -1, contentChangeSeq: -1, contentChanges: [], nonRemoteEditSeq: -1, remotes: [], nonSyncEditSeq: -1, nonSyncEditPath: '', syncs: [], verifySeq: -1, verifyKey: '', evidence: false, providerSeq: -1, rangeDiffSeq: -1, gitRepo: '', background });

// Each finished run is its own entry, even when two share a launch time (2026-11-20): id = the tool-use id of
// the launch, seat = who it was. An entry saved by an older scan has no id: it stays valid, and the first run
// with the same launch time fills in its id and seat instead of adding a second entry.
function reviewDone(st, launchAt, doneAt, id, seat) {
  if (!launchAt || !doneAt) return;
  if (!id) {
    if (!st.reviews.some((r) => r.launchAt === launchAt)) st.reviews.push({ launchAt, doneAt });
    return;
  }
  if (st.reviews.some((r) => r.id === id)) return;
  const old = st.reviews.find((r) => r.launchAt === launchAt && !r.id);
  if (old) { old.id = id; old.seat = seat || 'reviewer'; return; }
  st.reviews.push({ launchAt, doneAt, id, seat: seat || 'reviewer' });
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
  if (l.includes('"type":"tool_result"') && !answersAny(l, [st.pending, st.helperCalls, st.reviewerCalls, st.stopCalls, st.expertCalls, st.askCalls]) && !l.includes('RECOMMEND: ')) return;
  let entry = null;
  try { entry = JSON.parse(l); } catch (e) { return; }
  if (!entry || /^api-request/.test(String(entry.type || ''))) return;
  placeHelperEdits(st, entry.timestamp);
  if (typeof entry.cwd === 'string' && entry.cwd) st.cwd = entry.cwd;
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
    const expert = st.expertAgents.get(handed.id);
    if (agent) {
      // 2026-11-18 (finding 7): a second copy of a report this agent already gave credits no follow-up run.
      if (reportSeen(agent, handed.report, 'hand')) return;
      const seq = ++st.seq;
      addReport(st, handed.report, handed.id + '@' + agent.launch, seq, entry.timestamp, agent.seat);
      creditReviewer(st, agent, seq, entry.timestamp);
    } else if (expert) {
      // An expert seat's hand-back: its questions for the user only, and no reviewer credit (2026-11-16).
      addReport(st, handed.report, handed.id + '@' + expert.launch, ++st.seq, entry.timestamp, expert.seat || 'expert', true, expertReadKey(handed.id, expert));
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
          { toolUseResult: { task: { id: note.id, status: note.status, exitCode: note.exitCode } }, timestamp: entry.timestamp });
      } else if (st.background.has(note.id)) st.finishedUncollected.add(note.id);
      if (st.helpersRunning.has(note.id) && /^(?:completed|failed|killed|cancelled|canceled|stopped)$/.test(note.status)) st.helpersRunning.delete(note.id);
      // An independent reviewer agent finished: credit the run it completed. A notice sent while it still
      // waits on its own background work is no finish (2026-11-12, follow-up E: such a run counted as a
      // completed review before its report existed); its hand-back or a later notice finishes it.
      const agent = st.reviewerAgents.get(note.id);
      const finished = !!agent && note.status === 'completed' && !interimNotice(note) && !(note.result && reportSeen(agent, note.result, 'notice'));
      // Its finish notice can carry its report too (see addReport: each note counts once per run).
      if (finished && note.result) addReport(st, note.result, note.id + '@' + agent.launch, st.seq, entry.timestamp, agent.seat);
      if (finished) creditReviewer(st, agent, st.seq, entry.timestamp);
      // An expert seat's finish notice can carry its report too: its questions only, never a reviewer run.
      const expert = st.expertAgents.get(note.id);
      if (expert && note.status === 'completed' && !interimNotice(note) && note.result) addReport(st, note.result, note.id + '@' + expert.launch, st.seq, entry.timestamp, expert.seat || 'expert', true, expertReadKey(note.id, expert));
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
      if (applyOutcomes(res.reviewNotes, st.noteSeqs, st.userWords, plain, { seq, edits: st.editSeqs, changes: st.changeSeqs, passes: st.passes.map((p) => p.seq), refutable: st.refutable, same: st.sameAs, decisions: st.decisions, closedBy: st.closedBy, carry: () => carrySwitch(st.cwd) })) pruneUserWords(st);
      continue;
    }

    // A reviewer report in a tool result: the other engine's report read from a file (2026-11-12). Only in
    // a session that launched an independent reviewer: an old report file or a test fixture read during
    // other work is no review (follow-up D).
    // An expert seat's own result is never read as such a report (2026-11-16: it gives its questions only).
    if (blk.type === 'tool_result' && res.reviewerLaunched && !(blk.tool_use_id && (st.reviewerCalls.has(blk.tool_use_id) || st.expertCalls.has(blk.tool_use_id))) && l.includes('RECOMMEND: ')) {
      const report = recommendReport(resultText(blk, null));
      if (report) addReport(st, report, '', seq, entry.timestamp, FILE_SEAT);
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
        st.seatCalls.set(blk.id, reviewerSeat(String(blk.input.prompt || ''), String(blk.input.description || '')));
        res.reviewerLaunched = true;
      } else if (blk.name === 'Agent' && (EXPERT_AGENTS.has(String(blk.input.subagent_type || '')) || NOTE_CHECK_PROMPT.test(String(blk.input.prompt || '')))) {
        st.expertCalls.set(blk.id, seq);                    // an expert seat (2026-11-16): never a reviewer run
        st.seatCalls.set(blk.id, NOTE_CHECK_PROMPT.test(String(blk.input.prompt || '')) ? NOTE_CHECK_SEAT : expertSeat(String(blk.input.prompt || '')));
      } else if (blk.name === 'SendMessage' && st.reviewerAgents.has(String(blk.input.to || ''))) {
        st.reviewerAgents.get(String(blk.input.to)).launch = seq;   // a follow-up review run
        st.reviewerAgents.get(String(blk.input.to)).done = false;
        st.reviewerAgents.get(String(blk.input.to)).at = String(entry.timestamp || '');
      } else if (blk.name === 'SendMessage' && st.expertAgents.has(String(blk.input.to || ''))) {
        // A follow-up expert run: a new report. The note checker keeps its first launch (the launch order and the edit rule
        // use it); the message number only keys its next reading (2026-11-18, audit 3 repair).
        const expert = st.expertAgents.get(String(blk.input.to));
        if (expert.seat === NOTE_CHECK_SEAT) expert.msg = seq; else expert.launch = seq;
      } else if (blk.name === 'AskUserQuestion') {
        const questions = Array.isArray(blk.input.questions) ? blk.input.questions : [];
        st.askCalls.set(blk.id, questions.map((q) => String((q && q.question) || '')).filter(Boolean));
      } else if (blk.name === 'TaskOutput' && st.background.has(blk.input.task_id)) {
        Object.assign(rec, st.background.get(blk.input.task_id), { editSeq: -1, taskId: blk.input.task_id });
      }
      if (blk.name === 'Agent') st.helperCalls.set(blk.id, seq);
      if (rec.editSeq !== -1 || rec.contentChangeSeq !== -1 || rec.verifySeq !== -1 || rec.providerSeq !== -1 || rec.rangeDiffSeq !== -1) st.pending.set(blk.id, rec);
      continue;
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.helperCalls.has(blk.tool_use_id)) {
      const launch = st.helperCalls.get(blk.tool_use_id);
      st.helperCalls.delete(blk.tool_use_id);
      const t = entry.toolUseResult || {};
      const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
      if (id && blk.is_error !== true && t.status !== 'completed') st.helpersRunning.set(id, launch);
    }

    // An expert seat launched (2026-11-16): its agent id, for its hand-back and finish notice. One that answers
    // at once returns its report here. Only its questions count; it is never a reviewer run.
    if (blk.type === 'tool_result' && blk.tool_use_id && st.expertCalls.has(blk.tool_use_id)) {
      const launch = st.expertCalls.get(blk.tool_use_id);
      st.expertCalls.delete(blk.tool_use_id);
      const seat = st.seatCalls.get(blk.tool_use_id) || 'expert';
      st.seatCalls.delete(blk.tool_use_id);
      const t = entry.toolUseResult || {};
      const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
      if (id && blk.is_error !== true) st.expertAgents.set(id, { launch, seat });
      if (id && t.status === 'completed' && blk.is_error !== true) addReport(st, resultText(blk, null), id + '@' + launch, seq, entry.timestamp, seat, true);
      continue;
    }

    // The user's answers in the AskUserQuestion dialog are the user's own words (2026-11-16). The turn goes
    // on, so this is no new user turn: a pass claimed earlier in the turn still counts.
    if (blk.type === 'tool_result' && blk.tool_use_id && st.askCalls.has(blk.tool_use_id)) {
      const questions = st.askCalls.get(blk.tool_use_id);
      st.askCalls.delete(blk.tool_use_id);
      if (blk.is_error !== true && !userRejected(blk, entry)) for (const answer of askAnswers(blk, entry, questions)) { keepUserWords(st, seq, answer); keepDecision(st, blk.tool_use_id, seq, answer); }
      continue;
    }

    if (blk.type === 'tool_result' && blk.tool_use_id && st.reviewerCalls.has(blk.tool_use_id)) {
      const launch = st.reviewerCalls.get(blk.tool_use_id);
      st.reviewerCalls.delete(blk.tool_use_id);
      const seat = st.seatCalls.get(blk.tool_use_id) || 'reviewer';
      st.seatCalls.delete(blk.tool_use_id);
      const t = entry.toolUseResult || {};
      const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
      const at = st.reviewerAt.get(blk.tool_use_id) || '';
      st.reviewerAt.delete(blk.tool_use_id);
      if (id && blk.is_error !== true) {
        const agent = { launch, at, seat, call: blk.id, done: t.status === 'completed' };
        if (agent.done) { reportSeen(agent, resultText(blk, null), 'hand'); reportSeen(agent, resultText(blk, null), 'notice'); }
        st.reviewerAgents.set(id, agent);
      }
      if (id && t.status === 'completed') reviewDone(st, at, String(entry.timestamp || ''), blk.tool_use_id, seat);
      // A synchronous reviewer returns its finished report in this result: its notes count (2026-11-12).
      if (id && t.status === 'completed' && blk.is_error !== true) addReport(st, resultText(blk, null), id + '@' + launch, seq, entry.timestamp, seat);
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
  if (typeof rec.noteEditSeq === 'number' && rec.noteEditSeq !== -1) st.editSeqs.push(rec.noteEditSeq); // audit 3 (2026-11-17): the author's own edit, not a git move or a formatter run
  if (rec.editSeq > res.lastEdit) { res.lastEdit = rec.editSeq; res.lastEditPath = rec.editPath; res.lastGitRepo = GIT_CHANGE.test(rec.editPath) ? rec.gitRepo || '' : ''; }
  // The last edit that was not a git merge/switch/pull: the same-tree memo falls back to it.
  if ((rec.nonGitEditSeq ?? -1) > res.lastNonGitEdit) res.lastNonGitEdit = rec.nonGitEditSeq;
  // The last change that was not a move to a fetched remote ref, and those moves themselves.
  if ((rec.nonRemoteEditSeq ?? -1) > res.lastNonRemoteEdit) res.lastNonRemoteEdit = rec.nonRemoteEditSeq;
  for (const c of rec.remotes || []) st.remoteCheckouts.push(c);
  // The last change that was not a git sync, and the syncs (2026-11-14). A record without the field counts whole.
  // Syncs before a later change are never judged again: dropped, so the cached state stays small.
  // Its path is kept (2026-11-17), so the stop gate can name the edit that is owed once the syncs after it are credited.
  const nonSync = rec.nonSyncEditSeq ?? rec.editSeq;
  if (nonSync > res.lastNonSyncEdit) { res.lastNonSyncEdit = nonSync; res.lastNonSyncEditPath = rec.nonSyncEditPath || rec.editPath || ''; st.syncMoves = st.syncMoves.filter((c) => c.seq > nonSync); }
  for (const c of rec.syncs || []) st.syncMoves.push(c);
}

// A content change at seq (2026-11-18, audit 3 repair): it ends every refutation of a check launched before it. A note
// already closed as refuted by such a check opens again, whether the author wrote the line before or after the change;
// an open note keeps its refutable entry, and the line is refused when written (applyOutcome).
// 2026-11-18 (scoped staleness): the change keeps its path ('' = unknown: a git move, git apply, patch). It cancels the
// refutation of note n only when its path is unknown or is a file the note's text or the refutation's evidence names
// (changeCancels); a change of any other file cancels nothing, so the check can run while plainly right notes are fixed.
function noteContentChange(rec, seq, path) {
  rec.contentChangeSeq = seq;
  if (!Array.isArray(rec.contentChanges)) rec.contentChanges = [];
  rec.contentChanges.push({ seq, path: String(path || '') });
}
// 2026-11-18 (repair 1, 2): no drive prefix ("C:") and no leading "/", "./" or "../", so "C:\repos\x\src\Policy.cs", "/src/Policy.cs"
// and "..\src\Policy.cs" are compared as folder names.
const pathKey = (p) => stripQuotes(String(p || '')).replace(/\\/g, '/').replace(/[),;]+$/, '').replace(/:\d+(?::\d+)?$/, '').toLowerCase().replace(/^[a-z]:(?=\/)/, '').replace(/^(?:\.{0,2}\/)+/, '');
// The file names a text cites: a word with an extension, as "Upload.cs:9", "src/App.cs", "README.md:1", "ar.json", "C:\a\b.cs:4",
// "app/[id]/page.tsx", "src/My Upload.cs". The name class holds [ ] ( ) + and a space; a match with spaces is also read word by word.
const CITED_FILE = /(?:[A-Za-z]:)?[\w@.\-\/\\\[\]()+ ]+\.[A-Za-z]\w{0,9}(?![\w])/g;
function citedFiles(...texts) {
  const out = new Set();
  const add = (x) => { const k = pathKey(x).replace(/\.+$/, ''); if (k && /\.[a-z]\w{0,9}$/.test(k)) out.add(k); };
  for (const t of texts) for (const m of String(t || '').matchAll(CITED_FILE)) { add(m[0]); for (const w of m[0].split(/\s+/)) add(w); }
  return [...out];
}
const baseName = (k) => k.slice(k.lastIndexOf('/') + 1);
// The changed path against a cited name: slashes made uniform, no case, one is the end of the other at a folder
// border; failing that, the bare file name is the same (a diff prefix "b/", a folder the checker wrote another way).
function pathMatches(changed, named) {
  const c = pathKey(changed), n = pathKey(named);
  if (!c || !n) return false;
  return c === n || c.endsWith('/' + n) || n.endsWith('/' + c) || baseName(c) === baseName(n);
}
function changeCancels(change, note, evidence) {
  const path = change && typeof change === 'object' ? change.path : '';
  if (!path) return true;   // no known path: any file may have changed
  return citedFiles(note && note.text, evidence).some((n) => pathMatches(path, n));
}
function creditContent(st, seq, path = '') {
  st.changeSeqs.push({ seq, path: String(path || '') });
  for (const r of st.refutable) {
    const note = st.res.reviewNotes[r.n - 1];
    if (note && note.outcome === 'refuted' && r.launch < seq && changeCancels({ path }, note, r.evidence)) { note.outcome = null; delete note.evidence; note.problem = REFUTE_STALE; }
  }
}

// The marks of the pair lines of a git range-diff output: "=" equal, "!" changed, "<" only old, ">" only new.
function rangeDiffPairs(text) { return rangeDiffSeries(text).marks; }

// The pairs of a range-diff output with their hashes. A "!" pair whose body shows no changed patch line
// (only the commit message, a "(cherry picked from …)" trailer or a context line changed) counts as equal:
// the added and removed lines are the same, so the reviewed patch is the pushed patch (audit 2026-11-17, F4).
function rangeDiffSeries(text) {
  const out = { marks: [], oldHashes: [], newHashes: [] };
  let bang = null;                      // the open "!" pair: { patchChanged, inMessage }
  const close = () => { if (bang) { out.marks[bang.index] = bang.patchChanged ? '!' : '='; bang = null; } };
  for (const line of String(text || '').replace(ANSI, '').split(/\r?\n/)) {
    const m = /^\s{0,2}(?:\d+|-):\s+([0-9a-f]+|-+)\s+([=!<>])\s+(?:\d+|-):\s+([0-9a-f]+|-+)(?:\s|$)/i.exec(line);
    if (m) {
      close();
      out.marks.push(m[2]);
      out.oldHashes.push(/^-/.test(m[1]) ? '' : m[1]); out.newHashes.push(/^-/.test(m[3]) ? '' : m[3]);
      if (m[2] === '!') bang = { index: out.marks.length - 1, patchChanged: false, inMessage: false };
      continue;
    }
    if (!bang) continue;
    const body = /^ {4}(.*)$/.exec(line);
    if (!body) continue;
    const t = body[1];
    if (/^[ +-]\s*## Commit message ##/.test(t)) { bang.inMessage = true; continue; }
    if (/^[ +-]\s*## .* ##\s*$/.test(t)) { bang.inMessage = false; if (/^[+-]/.test(t)) bang.patchChanged = true; continue; }
    if (bang.inMessage) continue;
    // Outside the message, an outer "+"/"-" with an inner "+"/"-" is a changed added/removed line; an inner space or "@" is context or a hunk header only.
    if (/^[+-][+-]/.test(t)) bang.patchChanged = true;
  }
  close();
  return out;
}

// Only a bare run can be read as proof (audit 2026-11-17, F1/F2/F5): no substitution, no one-sided filter, no path limiter
// (git drops every commit that misses the path), and exactly two ranges or three commits. A redirect of stderr (2>&1) hides nothing.
function rangeDiffCommandReadable(seg) {
  const cmd = seg.replace(/(?:^|\s)\d?>&\d(?=\s|$)/g, ' ').trim();
  if (/[<>`]|\$\(/.test(cmd) || /--(?:left|right)-only/i.test(cmd) || /(?:^|\s)--(?:\s|$)/.test(cmd)) return false;
  const words = cmd.replace(/^git(?:\.exe)?\s+range-diff\s+/i, '').split(/\s+/).filter((w) => w && !/^-/.test(w));
  const ranges = words.filter((w) => w.includes('..')).length;
  return (words.length === 2 && ranges === 2) || (words.length === 1 && ranges === 1) || (words.length === 3 && ranges === 0);
}

// Credit a collected result: a tool_result, or a background task's completion.
function settle(st, rec, blk, entry) {
  const res = st.res;
  if (userRejected(blk, entry)) return;              // nothing ran
  const isErr = blk.is_error === true;
  let outcome = rec.hidden ? hiddenVerificationResult(blk, entry, rec.hidden) : verificationResult(blk, entry);
  // A red-proof run: its green run decides the stop gate's credit; its record stands in for output sent to a file.
  let green = false;
  if (rec.proof && rec.verifySeq !== -1) ({ outcome, green } = proofResult(st, rec, blk, entry, outcome));
  // The host names the task in the result's fields or only in its text ("…running in background with ID: b1a2…");
  // without the id, the finish notice can never be matched and the run stays "running" (2026-11-06).
  const taskId = entry.toolUseResult?.backgroundTaskId || entry.toolUseResult?.background_task_id || rec.taskId ||
    (/running in (?:the )?background with ID:\s*([A-Za-z0-9_-]+)/i.exec(resultText(blk, entry)) || [])[1];
  if (outcome === 'pending' && taskId) st.background.set(taskId, rec);
  else if (taskId) st.background.delete(taskId);
  // An Edit/Write that errored changed nothing; a shell segment that
  // wrote a file usually did, even if a later segment failed.
  if (rec.editSeq !== -1 && !(isErr && rec.verifySeq === -1)) creditEdit(st, rec);
  if ((rec.contentChangeSeq ?? -1) !== -1 && !(isErr && rec.verifySeq === -1)) {
    // Each change with its own seq and path (2026-11-18, scoped staleness); a record without the list is one unknown path.
    if (Array.isArray(rec.contentChanges) && rec.contentChanges.length) for (const c of rec.contentChanges) creditContent(st, c.seq, c.path);
    else creditContent(st, rec.contentChangeSeq, '');
  }
  if (rec.verifySeq !== -1) {
    const receipt = rec.evidence ? checkReceipt(blk, entry) : null;
    const key = receipt?.key || rec.verifyKey;
    // A decorated run (output sent to a file, cut by a tail) may show no receipt line: no credit, not a failure.
    const checkOutcome = rec.evidence && outcome !== 'pending' ? receipt?.outcome || (rec.evidenceDecorated ? 'none' : 'failed') : outcome;
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
      // green: a failed proof whose green run passed (see finishScan).
      if (!previous || rec.verifySeq >= previous.seq) st.verificationStates.set(key, { seq: rec.verifySeq, outcome: checkOutcome, command: rec.command, ...(green && checkOutcome === 'failed' ? { green: true } : {}) });
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
  if (rec.rangeDiffSeq !== -1 && outcome === 'passed') {
    res.lastRangeDiff = Math.max(res.lastRangeDiff, rec.rangeDiffSeq);
    // 2026-11-17 (audit H1): range-diff exits 0 when the series differ, so its OUTPUT decides: at least one pair line and every pair line equal.
    const series = rangeDiffSeries(resultText(blk, entry));
    const pairs = series.marks;
    // A range compared with itself proves nothing: the old side must differ from the new side (audit F1, case 4).
    const same = series.oldHashes.length > 0 && series.oldHashes.every((h, k) => h === series.newHashes[k]);
    if (rec.rangeDiffReadable && pairs.length > 0 && pairs.every((m) => m === '=') && !same) {
      if (rec.rangeDiffSeq > res.lastRangeDiffProof) { res.lastRangeDiffProof = rec.rangeDiffSeq; res.lastRangeDiffNew = series.newHashes; res.lastRangeDiffOld = series.oldHashes; /* 2026-11-18: the old side, for the review record */ }
    }
    else if (rec.rangeDiffReadable && pairs.some((m) => m !== '=')) res.lastRangeDiffChanged = Math.max(res.lastRangeDiffChanged, rec.rangeDiffSeq);
  }
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
      if (rec.editSeq !== -1 || rec.contentChangeSeq !== -1) {
        st.helperPending.set(file + '\n' + blk.id, { editPath: rec.editPath, nonGit: rec.nonGitEditSeq !== -1, noteEdit: rec.noteEditSeq !== -1, content: rec.contentChangeSeq !== -1, contentPaths: rec.contentChanges.map((c) => c.path), nonRemote: rec.nonRemoteEditSeq !== -1,
          gitRepo: rec.gitRepo, remotes: rec.remotes.map((r) => r.repo), verifies: rec.verifySeq !== -1, at: String(entry.timestamp || ''),
          nonSync: rec.nonSyncEditSeq !== -1, nonSyncPath: rec.nonSyncEditPath, syncs: rec.syncs.map((c) => ({ repo: c.repo, remote: c.remote })) });
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
  if (edit.content === undefined ? edit.nonGit : edit.content) {   // an edit kept before this field counts as before
    const paths = Array.isArray(edit.contentPaths) && edit.contentPaths.length ? edit.contentPaths : [''];
    for (const p of new Set(paths)) creditContent(st, s, p);
  }
  if (!edit.editPath) return;   // a content change with no code path (a locale file) is no code edit
  creditEdit(st, { editSeq: s, editPath: edit.editPath, nonGitEditSeq: edit.nonGit ? s : -1, noteEditSeq: (edit.noteEdit === undefined ? edit.nonGit : edit.noteEdit) ? s : -1, nonRemoteEditSeq: edit.nonRemote ? s : -1,
    remotes: edit.remotes.map((repo) => ({ seq: s, repo })), gitRepo: edit.gitRepo,
    // An edit kept without these fields (2026-11-14) is a change of its own, never a sync.
    nonSyncEditSeq: edit.nonSync === false ? -1 : s, nonSyncEditPath: edit.nonSyncPath || '', syncs: Array.isArray(edit.syncs) ? edit.syncs.map((c) => ({ seq: s, repo: c.repo, remote: c.remote })) : [] });
}

// ---------------------------------------------------------------------------
// The scan cache: one small file per transcript under <state>/scan-cache/, holding the byte offset
// already read, the scan state at that offset, and the same for each helper file. It is used only
// when it is surely the same file and the same code: the transcript is not shorter than the offset,
// its first and last 4 KB before the offset are unchanged, and the version and the scanner's own
// files are the same. Anything else, or a cache that does not parse, starts from zero. Writes go
// through a temp file and a rename, so a reader sees a whole file; two hooks at once: last wins.
// ---------------------------------------------------------------------------

// 2: the saved state gained the owner's dialog answers, the SAME lines and the session folder (2026-11-19).
const SCAN_CACHE_VERSION = 2;
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
// 2026-11-20: an Orca session keeps its transcript under <orca>/claude-profiles/<id>/home/projects/..., not under
// .claude/projects, so the stop gate had no memory there and blocked the same failure on every stop (6 blocks in
// one session). The real path of the transcript must lie INSIDE one trusted root: ~/.claude/projects, the projects
// folder of CLAUDE_CONFIG_DIR, or <APPDATA>/orca/claude-profiles/<id>/home/projects. A folder of the same names
// anywhere else (a test fixture, a temp folder) is not a session and writes no user state. The roots are one rule in
// session-root.cjs, shared with the task timer (2026-11-22).
function stateAllowed(transcriptPath) {
  if (proc && proc.env && proc.env.SANAD_STATE_DIR) return true;
  return require('./session-root.cjs').inSessionRoot(transcriptPath, (proc && proc.env) || {});
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
  // red-proof's run records (see "Red-proof runs"): read from the same state folder, under the same rule.
  const proofRuns = allowed ? path.join(stateFolder(), 'proof', 'runs') : '';
  st.proofRuns = proofRuns;
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
    st = newScanState(); st.since = sinceMs; st.proofRuns = proofRuns; offset = 0; helpers = {};
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
  // 2026-11-20: a replacement named by a CHECK RETIRED line that then failed itself is still the same check. A later
  // CHECK RETIRED line for the original check, with another replacement that passes, retires it too (before, that
  // second failure stayed open and the stop was blocked on it after the proof had passed). Only when the first line
  // named that replacement BEFORE it ran (r0.seq < at): a failure named as a replacement only afterwards is not covered.
  // F2: the link from a retirement to its replacement ends when the replacement has passed once, and at any code edit
  // after the line: a replacement that fails for real after a new edit is a new failure, not the retired check.
  // Round 2, R2 (2026-11-20): only a CODE edit ends the link (the same isCodePath rule as "Code files were edited"); a docs edit
  // (README.md, *.md) did, and an honest retirement was refused after a README change. A change with no known path still counts.
  const editAts = [...st.editSeqs, ...st.changeSeqs.filter((c) => !c.path || isCodePath(c.path)).map((c) => c.seq)];
  const linked = (r0, command, at) => !editAts.some((e) => e > r0.seq && e < at) && !passes.some((p) => p.command === command && p.seq > r0.seq && p.seq < at);
  const namesFailed = (r, command, at) => r.failed.includes(command) ||
    retirements.some((r0) => r0.seq < at && r0.replacement.includes(command) && r0.failed.some((f) => r.failed.includes(f)) && linked(r0, command, at));
  const retired = (state) => retirements.some((r) => namesFailed(r, state.command, state.seq) && r.seq > state.seq &&
    passes.some((p) => r.replacement.includes(p.command) && p.seq > r.seq));
  const probed = (state) => probes.some((p) => p.command.includes(state.command) && p.seq > state.seq);
  for (const state of verificationStates.values()) {
    const { seq, outcome } = state;
    if (outcome === 'failed' && !retired(state)) {
      res.lastFailedVerify = Math.max(res.lastFailedVerify, seq);   // push guard: every failure counts
      if (probed(state)) res.lastProbeFailure = Math.max(res.lastProbeFailure, seq);
      // A proof that failed after its green run passed (NOT RED, a break not caught): the tests ran green, so
      // the stop gate counts a test run; the push guard still counts the failure (2026-11-15).
      else if (state.green === true) res.lastGreenProof = Math.max(res.lastGreenProof, seq);
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
  // Git syncs after every other change: the stop gate checks each folder is clean at a remote tip (2026-11-14).
  res.syncMoves = st.syncMoves.filter((c) => c.seq > res.lastNonSyncEdit);
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
  // 2026-11-18: the newest reviewer launch that has not reported (a launch with no result yet counts too);
  // the review record is written only when none runs after the last change.
  res.lastRunningReviewer = Math.max(-1, ...[...st.reviewerAgents.values()].filter((a) => a && a.done !== true).map((a) => a.launch), ...st.reviewerCalls.values());
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
  res.reviewEditSeqs = st.editSeqs;
  res.reviewChangeSeqs = st.changeSeqs;
  res.reviewPassSeqs = st.passes.map((p) => p.seq);
  res.reviewRefutable = st.refutable;
  // Notes closed by the note check, with its evidence, for the ship brief (2026-11-17).
  res.refutedNotes = res.reviewNotes.filter((n) => n.outcome === 'refuted').map((n) => ({ n: n.n, kind: n.kind, text: n.text, evidence: n.evidence || '' }));
  res.reviewUserWords = st.userWords;
  // Carried decisions (2026-11-19): what the final text's outcome lines need, and each note closed that way,
  // with the note whose answer closed it, for the ship brief.
  res.reviewSame = st.sameAs;
  res.reviewDecisions = st.decisions;
  res.reviewClosedBy = st.closedBy;
  res.reviewCwd = st.cwd;
  res.carriedNotes = res.reviewNotes.filter((n) => n.outcome === 'user' && n.carried).map((n) => ({ n: n.n, kind: n.kind, text: n.text, from: n.carried }));
  // Each note's seat and the checklist line it names, same index as reviewNotes (2026-11-17, review score).
  res.reviewNoteSeats = st.noteSeats;
  res.reviewNoteClasses = st.noteClasses;
  return res;
}

module.exports = {
  EDIT_TOOLS, SHELL_TOOLS,
  isCodePath, isProsePath, splitSegments, tokenize, segmentIsVerify, hasVerify, segmentIsProvider,
  segmentEditPaths, shellEditPaths, shellWriteTargets, verifyFailed, resultText,
  scanTranscript,
  verificationCommand,
  humanWords, reportNotes, claimsReview, openNotesMessage, openNotesAfter, stateFolder, stateAllowed,
};

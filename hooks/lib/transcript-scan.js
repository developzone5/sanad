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
const { invalidVerificationTarget, nativeVerificationTarget } = require('./verification-target.cjs');

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
// scratch, specs, vendored/VCS-internal trees, device files.
const EXEMPT = /((^|[/\\])\.claude([/\\]|$)|(^|[/\\])\.codex([/\\]|$)|[/\\]memory[/\\]|[/\\]specs[/\\]|AppData[/\\]Local[/\\]Temp|[/\\]node_modules[/\\]|[/\\]\.git[/\\]|^\/tmp\/|^\/dev\/|^\/proc\/)/i;

function stripQuotes(s) { return String(s || '').replace(/^["']+|["']+$/g, ''); }

function isCodePath(p) {
  p = stripQuotes(p).replace(/[),;]+$/, '');
  if (!p) return false;
  // Claude-managed worktrees contain application code, even though their
  // absolute path starts inside .claude. Apply exemptions within that checkout.
  p = p.replace(/\\/g, '/').replace(/^.*(?:^|\/)\.claude\/worktrees\/[^/]+\//i, '');
  if (EXEMPT.test(p)) return false;
  return CODE_EXT.test(p) || CODE_BASENAME.test(p) || CODE_JSON.test(p) || MANIFEST_BASENAME.test(p);
}

// ---------------------------------------------------------------------------
// Shell command shape
// ---------------------------------------------------------------------------

// One command grammar for every hook: segment splitting and tokenizing live in
// shell-command.cjs (quote- and heredoc-aware); re-exported here unchanged.
const { splitSegments, tokenize } = require('./shell-command.cjs');

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
  const target = nativeVerificationTarget(tokens[0], tokens.slice(1));
  return [target.executable, ...target.args];
}

function verificationCommand(seg) { return verificationWords(seg).join(' '); }

function segmentIsVerify(seg) {
  const command = verificationCommand(seg);
  if (/(?:^|\s)(?:--list-tests|--collect-only|--collectonly|--passWithNoTests|--help|--version)(?:\s|=|$)/i.test(command)) return false;
  // TypeScript inventory/help commands can exit 0 without checking any source.
  if (/^(?:npx\s+)?tsc\b/i.test(command) && /(?:^|\s)(?:--listFilesOnly|--showConfig|--help|--version|-h|-v)(?:\s|=|$)/i.test(command)) return false;
  return VERIFY_ANCHORED.test(command);
}

function hasVerify(cmd) { return splitSegments(cmd).some(segmentIsVerify); }

// Preserve environment overrides in retry identity; they may choose a different
// provider/configuration even when the executable and test arguments are equal.
function verificationIdentity(seg) {
  const environment = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/.exec(String(seg).trim())[0];
  return environment + verificationCommand(seg);
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

function segmentEditPaths(seg) {
  const out = [];
  let m;
  REDIRECT.lastIndex = 0;
  while ((m = REDIRECT.exec(seg)) !== null) {
    if (isCodePath(m[2])) out.push(stripQuotes(m[2]));
  }
  if (WRITE_TOOL.test(seg)) {
    const tokens = tokenize(seg);
    const program = String(tokens[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
    const written = COPY_PROGRAM.test(program) ? copyWrites(tokens) : null;
    for (const t of written || tokens) if (isCodePath(t)) out.push(stripQuotes(t));
  }
  if (PATHLESS_WRITE.test(seg)) out.push('<generated>');
  if (GIT_CONTENT_CHANGE.test(seg)) out.push('<git>');
  return [...new Set(out)];
}

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

function shellEditPaths(cmd) {
  const out = [];
  for (const seg of expandVariables(splitSegments(cmd))) out.push(...segmentEditPaths(seg));
  return [...new Set(out)];
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
];

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
  const t = String(text || '');
  return FAIL_MARKERS.some((re) => re.test(t));
}

function userRejected(block, entry) {
  if (entry && entry.toolDenialKind) return true;
  const t = block && typeof block.content === 'string' ? block.content : '';
  return /doesn't want to proceed|user rejected|was rejected/i.test(t);
}

// ---------------------------------------------------------------------------
// Transcript loading. Normal transcripts are read whole. A pathologically large
// one (> 80 MB) is scanned from its 16 MB tail only — the verdict needs just the
// LAST edit / verify / gate, and those live near the end.
// ---------------------------------------------------------------------------

function readTranscript(p) {
  const FULL_READ_MAX = 80 * 1024 * 1024;
  const TAIL_BYTES = 16 * 1024 * 1024;
  const size = fs.statSync(p).size;
  if (size <= FULL_READ_MAX) return fs.readFileSync(p, 'utf8');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    const n = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const s = buf.toString('utf8', 0, n);
    const nl = s.indexOf('\n');
    return nl === -1 ? '' : s.slice(nl + 1);
  } finally { fs.closeSync(fd); }
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

const MAYBE_LINE = /"tool_use"|"tool_result"|GATE:|REVIEW:|CHECK RETIRED:|PROBE EXPECTED:|"commandMode":"task-notification"/;
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
function commandIdentity(text) { return splitSegments(String(text || '')).map(verificationIdentity).join(' ; ').trim().replace(/\s+/g, ' '); }

function verificationResult(block, entry) {
  const t = entry.toolUseResult || {};
  const text = resultText(block, entry);
  const exit = t.task?.exitCode ?? t.exitCode ?? t.exit_code;
  if (verifyFailed(text, block.is_error === true) || t.interrupted === true ||
      (exit !== undefined && exit !== null && Number(exit) !== 0) ||
      /^(failed|killed|cancelled|canceled)$/.test(t.task?.status || '')) return 'failed';
  if (t.backgroundTaskId || t.background_task_id ||
      /^(running|pending|queued)$/.test(t.task?.status || '') ||
      /^(timeout|not_ready)$/.test(t.retrieval_status || '') ||
      /running in background|running in the background|command still running/i.test(text)) return 'pending';
  return 'passed';
}

function isEvidenceCommand(segment) {
  const words = tokenize(segment);
  return words.length === 4 && /^node(?:\.exe)?$/i.test((words[0] || '').split(/[\\/]/).pop()) &&
    words[1].replace(/\\/g, '/').toLowerCase() === 'c:/users/asus/.claude/skills/gate/scripts/evidence.mjs' && words[2] === '--spec';
}

function checkReceipt(block, entry) {
  for (const line of resultText(block, entry).split('\n')) {
    if (!line.startsWith('CHECK_COMPLETED ')) continue;
    try {
      const record = JSON.parse(line.slice('CHECK_COMPLETED '.length));
      if (!/^[a-f0-9-]{36}$/i.test(record.runId || '') || typeof record.cwd !== 'string' || typeof record.executable !== 'string' || !Array.isArray(record.args) || record.args.some(arg => typeof arg !== 'string') || !['passed', 'failed'].includes(record.status)) continue;
      const command = [record.executable, ...record.args].map(word => '"' + word.replace(/"/g, '\\"') + '"').join(' ');
      if (!segmentIsVerify(command)) continue;
      const invalidTarget = invalidVerificationTarget(record.executable, record.args, record.cwd);
      const passed = !invalidTarget && record.status === 'passed' && record.nativeExitCode === 0 && !record.reason && !record.signal && verificationResult(block, entry) === 'passed';
      return { key: record.cwd.replace(/\\/g, '/').toLowerCase() + '\n' + JSON.stringify([record.executable, ...record.args]), outcome: passed ? 'passed' : 'failed', record };
    } catch { /* incomplete or forged output is not a completed check */ }
  }
  return null;
}

// A host-written background completion: { id, status, exitCode, file } or null.
function taskNotification(entry) {
  const a = entry.attachment;
  if (!a || a.commandMode !== 'task-notification' || typeof a.prompt !== 'string') return null;
  const field = name => (new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(a.prompt) || [])[1];
  const id = field('task-id');
  if (!id) return null;
  const exit = /\(exit code (-?\d+)\)/.exec(field('summary') || '');
  return { id, status: field('status') || '', exitCode: exit ? Number(exit[1]) : undefined, file: field('output-file') };
}

function scanTranscript(transcriptPath) {
  const res = { lastEdit: -1, lastEditPath: '', lastVerify: -1, lastVerifyResult: -1, lastFailedVerify: -1, lastFailedVerifyStop: -1, lastProbeFailure: -1, lastPendingVerify: -1, lastGate: -1, lastGateVerdict: '', lastReview: -1, lastReviewVerdict: '', completedCheck: null, lastBoundCheck: -1, lastProviderRun: -1, lastProviderResult: -1, lastFailedProvider: -1, lastPendingProvider: -1, lastReviewerRun: -1, lastReviewerResult: -1, lastReviewText: '', lastRangeDiff: -1 };
  let lines;
  try { lines = readTranscript(transcriptPath).split('\n'); } catch (e) { return res; }

  const pending = new Map(); // tool_use_id -> { editSeq, editPath, verifySeq }
  const background = new Map(); // task id -> originating command (not its polling command)
  const verificationStates = new Map(); // retries clear only the same command's failure
  const providerStates = new Map();
  const reviewerCalls = new Map();  // Agent tool_use id -> launch seq (reviewer prompt)
  const reviewerAgents = new Map(); // agent id -> { launch } (latest run, incl. SendMessage follow-ups)
  const retirements = []; // CHECK RETIRED lines: { seq, failed, replacement }
  const probes = [];      // PROBE EXPECTED lines: { seq, command }
  const passes = [];      // passing verifications: { seq, command }
  let seq = 0;

  for (const l of lines) {
    if (!MAYBE_LINE.test(l)) continue;
    let entry = null;
    try { entry = JSON.parse(l); } catch (e) { continue; }
    if (!entry) continue;
    const note = taskNotification(entry);
    if (note) {
      // This host reports a finished background command as a task-notification
      // attachment instead of a TaskOutput result. The command's saved output
      // file is its collected result; a completion without an exit code stays pending.
      seq++;
      if (background.has(note.id) && (note.status !== 'completed' || note.exitCode !== undefined)) {
        let output = '';
        try { output = note.file ? fs.readFileSync(note.file, 'utf8') : ''; } catch (e) { output = ''; }
        settle({ ...background.get(note.id), editSeq: -1, taskId: note.id },
          { type: 'tool_result', content: output, is_error: false },
          { toolUseResult: { task: { id: note.id, status: note.status, exitCode: note.exitCode } } });
      }
      // An independent reviewer agent finished: credit the run it completed.
      const agent = reviewerAgents.get(note.id);
      if (agent && note.status === 'completed' && agent.launch > res.lastReviewerRun) { res.lastReviewerRun = agent.launch; res.lastReviewerResult = seq; }
      continue;
    }
    const msg = entry.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : (Array.isArray(entry.content) ? entry.content : null);
    if (!content) continue;

    for (const blk of content) {
      seq++;
      if (!blk || typeof blk !== 'object') continue;

      if (blk.type === 'text' && typeof blk.text === 'string' && msg && msg.role === 'assistant') {
        const plain = blk.text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
        const g = [...plain.matchAll(GATE_RE)].pop();
        if (g) { res.lastGate = seq + (g.index + 1) / (plain.length + 1); res.lastGateVerdict = g[1]; }
        const rv = [...plain.matchAll(REVIEW_RE)].pop();
        if (rv) {
          res.lastReview = seq + (rv.index + 1) / (plain.length + 1); res.lastReviewVerdict = rv[1];
          res.lastReviewText = plain.slice(rv.index).split('\n')[0];
        }
        for (const m of plain.matchAll(RETIRE_RE)) {
          try {
            const r = JSON.parse(m[1]);
            if ([r.failed, r.replacement, r.reason].every((v) => typeof v === 'string' && v.trim())) {
              retirements.push({ seq: seq + (m.index + 1) / (plain.length + 1), failed: commandIdentity(r.failed), replacement: commandIdentity(r.replacement) });
            }
          } catch (e) { /* a malformed retirement retires nothing */ }
        }
        for (const m of plain.matchAll(PROBE_RE)) {
          try {
            const p = JSON.parse(m[1]);
            if ([p.command, p.reason].every((v) => typeof v === 'string' && v.trim())) {
              probes.push({ seq: seq + (m.index + 1) / (plain.length + 1), command: commandIdentity(p.command) });
            }
          } catch (e) { /* a malformed probe declaration covers nothing */ }
        }
        continue;
      }

      if (blk.type === 'tool_use' && blk.input && typeof blk.input === 'object') {
        const rec = { editSeq: -1, editPath: '', verifySeq: -1, verifyKey: '', evidence: false, providerSeq: -1, rangeDiffSeq: -1 };
        if (EDIT_TOOLS.has(blk.name)) {
          const p = String(blk.input.file_path || blk.input.notebook_path || '');
          if (isCodePath(p)) { rec.editSeq = seq; rec.editPath = p; }
        } else if (SHELL_TOOLS.has(blk.name)) {
          const segs = splitSegments(String(blk.input.command || ''));
          // A failed compound command must be retried as a whole; a success in
          // another directory or only its last test cannot erase that failure.
          rec.verifyKey = String(blk.input.cwd || blk.input.workdir || entry.cwd || '') + '\n' + segs.map(verificationIdentity).join(' ; ');
          rec.command = commandIdentity(blk.input.command);
          if (segs.length === 1 && isEvidenceCommand(segs[0])) { rec.evidence = true; rec.verifySeq = seq + 0.001; }
          const expanded = expandVariables(segs);
          // A red-proof bundle (`git stash push; <test>; git stash pop`) restores
          // the code it set aside, so its stash steps are not a net change; its
          // own failure accounting (setup/cleanup markers) still applies.
          const stashBundle = segs.some((s) => /\bgit(?:\.exe)?\s+stash(?:\s+(?:push|save))?(?:\s|$)/i.test(s) && !/\bstash\s+(?:pop|apply|list|show)\b/i.test(s)) &&
            segs.some((s) => /\bgit(?:\.exe)?\s+stash\s+(?:pop|apply)\b/i.test(s));
          for (let i = 0; i < segs.length; i++) {
            const frac = seq + (i + 1) / 1000;
            if (segmentIsVerify(segs[i])) rec.verifySeq = frac;
            if (segs.length === 1 && segmentIsProvider(segs[i])) rec.providerSeq = frac;
            if (segs.length === 1 && /^git(?:\.exe)?\s+range-diff\s/i.test(String(segs[i]).trim())) rec.rangeDiffSeq = frac;
            const paths = segmentEditPaths(expanded[i]).filter((p) => !(stashBundle && p === '<git>' && /\bstash\b/i.test(segs[i])));
            if (paths.length) { rec.editSeq = frac; rec.editPath = paths[0]; }
          }
        } else if (blk.name === 'Agent' && REVIEWER_PROMPT.test(String(blk.input.prompt || ''))) {
          reviewerCalls.set(blk.id, seq);                  // agent id arrives with the result
        } else if (blk.name === 'SendMessage' && reviewerAgents.has(String(blk.input.to || ''))) {
          reviewerAgents.get(String(blk.input.to)).launch = seq;   // a follow-up review run
        } else if (blk.name === 'TaskOutput' && background.has(blk.input.task_id)) {
          Object.assign(rec, background.get(blk.input.task_id), { editSeq: -1, taskId: blk.input.task_id });
        }
        if (rec.editSeq !== -1 || rec.verifySeq !== -1 || rec.providerSeq !== -1 || rec.rangeDiffSeq !== -1) pending.set(blk.id, rec);
        continue;
      }

      if (blk.type === 'tool_result' && blk.tool_use_id && reviewerCalls.has(blk.tool_use_id)) {
        const launch = reviewerCalls.get(blk.tool_use_id);
        reviewerCalls.delete(blk.tool_use_id);
        const t = entry.toolUseResult || {};
        const id = String(t.agentId || (/agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(blk, entry)) || [])[1] || '');
        if (id && blk.is_error !== true) reviewerAgents.set(id, { launch });
        // A synchronous reviewer returns its finished report in this result.
        if (id && t.status === 'completed' && launch > res.lastReviewerRun) { res.lastReviewerRun = launch; res.lastReviewerResult = seq; }
        continue;
      }

      if (blk.type === 'tool_result' && blk.tool_use_id && pending.has(blk.tool_use_id)) {
        const rec = pending.get(blk.tool_use_id);
        pending.delete(blk.tool_use_id);
        settle(rec, blk, entry);
      }
    }
  }

  // Credit a collected result: a tool_result, or a background task's completion.
  function settle(rec, blk, entry) {
    if (userRejected(blk, entry)) return;              // nothing ran
    const isErr = blk.is_error === true;
    const outcome = verificationResult(blk, entry);
    const taskId = entry.toolUseResult?.backgroundTaskId || entry.toolUseResult?.background_task_id || rec.taskId;
    if (outcome === 'pending' && taskId) background.set(taskId, rec);
    else if (taskId) background.delete(taskId);
    if (rec.editSeq !== -1 && !(isErr && rec.verifySeq === -1)) {
      // An Edit/Write that errored changed nothing; a shell segment that
      // wrote a file usually did, even if a later segment failed.
      if (rec.editSeq > res.lastEdit) { res.lastEdit = rec.editSeq; res.lastEditPath = rec.editPath; }
    }
    if (rec.verifySeq !== -1) {
      const receipt = rec.evidence ? checkReceipt(blk, entry) : null;
      const key = receipt?.key || rec.verifyKey;
      const checkOutcome = rec.evidence && outcome !== 'pending' ? receipt?.outcome || 'failed' : outcome;
      if (receipt && checkOutcome !== 'pending') {
        const launch = verificationStates.get(rec.verifyKey);
        if (launch?.outcome === 'pending' && launch.seq === rec.verifySeq) verificationStates.delete(rec.verifyKey);
      }
      const previous = verificationStates.get(key);
      if (!previous || rec.verifySeq >= previous.seq) verificationStates.set(key, { seq: rec.verifySeq, outcome: checkOutcome, command: rec.command });
      if (checkOutcome === 'passed') passes.push({ seq: rec.verifySeq, command: rec.command });
      if (checkOutcome === 'passed') {
        if (receipt && rec.verifySeq > res.lastBoundCheck) { res.completedCheck = receipt.record; res.lastBoundCheck = rec.verifySeq; }
        if (rec.verifySeq > res.lastVerify) res.lastVerify = rec.verifySeq;
        res.lastVerifyResult = seq;
      }
    }
    if (rec.rangeDiffSeq !== -1 && outcome === 'passed') res.lastRangeDiff = Math.max(res.lastRangeDiff, rec.rangeDiffSeq);
    if (rec.providerSeq !== -1) {
      const previous = providerStates.get(rec.verifyKey);
      if (!previous || rec.providerSeq >= previous.seq) providerStates.set(rec.verifyKey, { seq: rec.providerSeq, outcome });
      if (outcome === 'passed') {
        res.lastProviderRun = Math.max(res.lastProviderRun, rec.providerSeq);
        res.lastProviderResult = seq;
      }
    }
  }
  const retired = (state) => retirements.some((r) => r.failed === state.command && r.seq > state.seq &&
    passes.some((p) => p.command === r.replacement && p.seq > r.seq));
  const probed = (state) => probes.some((p) => p.command === state.command && p.seq > state.seq);
  for (const state of verificationStates.values()) {
    const { seq, outcome } = state;
    if (outcome === 'failed' && !retired(state)) {
      res.lastFailedVerify = Math.max(res.lastFailedVerify, seq);   // push guard: every failure counts
      if (probed(state)) res.lastProbeFailure = Math.max(res.lastProbeFailure, seq);
      else res.lastFailedVerifyStop = Math.max(res.lastFailedVerifyStop, seq);
    }
    if (outcome === 'pending') res.lastPendingVerify = Math.max(res.lastPendingVerify, seq);
  }
  for (const { seq, outcome } of providerStates.values()) {
    if (outcome === 'failed') res.lastFailedProvider = Math.max(res.lastFailedProvider, seq);
    if (outcome === 'pending') res.lastPendingProvider = Math.max(res.lastPendingProvider, seq);
  }
  for (const rec of [...background.values(), ...pending.values()]) {
    res.lastPendingVerify = Math.max(res.lastPendingVerify, rec.verifySeq);
    res.lastPendingProvider = Math.max(res.lastPendingProvider, rec.providerSeq);
  }
  return res;
}

module.exports = {
  EDIT_TOOLS, SHELL_TOOLS,
  isCodePath, splitSegments, tokenize, segmentIsVerify, hasVerify, segmentIsProvider,
  segmentEditPaths, shellEditPaths, verifyFailed, resultText,
  readTranscript, scanTranscript,
  verificationCommand,
};

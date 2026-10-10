/*
 * shell-command.cjs — the one command grammar shared by the guard hooks
 * (policy-guard, precommit-guard, csharpier-guard) and transcript-scan.
 *
 * Pure: requires only path and ./verification-target.cjs; no filesystem reads,
 * no child processes. Detection is over-inclusive (tripwire); resolution is
 * conservative: a directory change, git retarget or wrapper outside the closed
 * grammar below yields `cwd: null` / `certain: false`, and each guard decides
 * what an uncertain target means for it (its ON_UNKNOWN policy).
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const path = require('path');
const { nativeVerificationTarget } = require('./verification-target.cjs');

// ---------------------------------------------------------------------------
// Segments and tokens
// ---------------------------------------------------------------------------

// Split a command line into segments on && || ; | & and newlines — but only
// OUTSIDE quotes, and skipping heredoc bodies (a heredoc that writes a script
// containing "dotnet build" must not read as a verify, and its ';'s are text).
function splitSegments(cmd) {
  cmd = String(cmd || '');
  const segs = [];
  let cur = '';
  let q = null;
  let i = 0;
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
    // Heredoc: <<EOF / <<-EOF / <<'EOF' / <<"EOF" — swallow through the terminator line.
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) {
        const term = m[2];
        const eol = cmd.indexOf('\n', i);
        if (eol === -1) { cur += cmd.slice(i); i = cmd.length; continue; }
        cur += cmd.slice(i, eol);       // rest of the command line (keeps the redirect target)
        let j = eol + 1;
        let end = cmd.length;
        while (j < cmd.length) {
          let nl = cmd.indexOf('\n', j);
          if (nl === -1) nl = cmd.length;
          if (cmd.slice(j, nl).replace(/^\t+/, '').trim() === term) { end = nl; break; }
          j = nl + 1;
        }
        i = end;                          // body (and terminator) skipped entirely
        continue;
      }
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) { segs.push(cur); cur = ''; i += 2; continue; }
    if (ch === ';' || ch === '\n' || ch === '|') { segs.push(cur); cur = ''; i++; continue; }
    if (ch === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { segs.push(cur); cur = ''; i++; continue; }
    cur += ch;
    i++;
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter(Boolean);
}

// Tokenize one segment the way a shell forms words: quoted runs join the
// surrounding text (`--title="a b"`, `alias.x="!git push"` are one word) and
// the quotes are removed. Inside double quotes a backslash pair is kept
// verbatim (PowerShell has no backslash escape; Windows paths stay intact).
function tokenize(seg) {
  const s = String(seg == null ? '' : seg);
  const out = [];
  let cur = '', started = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; }
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { out.push(cur); cur = ''; started = false; } continue; }
    cur += ch; started = true;
  }
  if (started) out.push(cur);
  return out;
}

// Strip env-var prefixes and benign wrappers so the real program is at col 0.
function normalize(seg) {
  return String(seg).trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, '')
    .replace(/^(?:sudo|time|env|command|timeout\s+\d+[smh]?)\s+/, '')
    .replace(/^&\s+/, '');                          // PowerShell call operator
}

// `git`, `"C:\…\git.exe"`, `npm.cmd`, `node …/npm-cli.js` → one program name.
function programName(first, rest = []) {
  const target = nativeVerificationTarget(first, rest);
  return { program: target.executable.replace(/\.ps1$/i, ''), args: target.args };
}

// ---------------------------------------------------------------------------
// Paths: resolve a literal the way the target shell would, or return null
// ---------------------------------------------------------------------------

// Git Bash maps /c/… to C:\… and /tmp to the Windows temp directory; Node's
// path.resolve would turn /c/Users into C:\c\Users. Anything this closed set
// cannot translate literally (variables, globs, arrays, providers, UNC paths,
// drive-relative paths, other MSYS mounts) is unresolved: null.
function shellPath(p, cwd, opts = {}) {
  p = String(p == null ? '' : p);
  if (!p || /[$%`*?[\]{},]|::/.test(p) || /^(?:\\\\|\/\/)/.test(p)) return null;
  if (/^[A-Za-z]{2,}:/.test(p) || /^[A-Za-z]:(?![\\/])/.test(p)) return null;
  if (p === '~' || /^~[\\/]/.test(p)) return opts.home ? path.resolve(opts.home, p.slice(2) || '.') : null;
  if (p.startsWith('~')) return null;
  if (opts.tool === 'Bash') {
    const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p);
    if (drive) return path.resolve(drive[1].toUpperCase() + ':\\', drive[2] || '.');
    if (/^\/tmp(?:\/|$)/.test(p)) return opts.tmp ? path.resolve(opts.tmp, p.slice(5) || '.') : null;
    if (p.startsWith('/')) return null;
  } else if (/^[\\/]/.test(p)) {
    return null;                                    // PowerShell: rooted on the current drive
  }
  if (/^[A-Za-z]:[\\/]/.test(p)) return path.resolve(p);
  if (cwd == null) return null;
  return path.resolve(cwd, p);
}

// ---------------------------------------------------------------------------
// Blocks, wrappers and nested shells
// ---------------------------------------------------------------------------

const PAREN = '\\((?:[^()]|\\([^()]*\\))*\\)';
const BLOCK_OPEN = [
  new RegExp('^(?:if|elseif|while|until|switch|foreach|for)\\s*' + PAREN + '\\s*\\{\\s*', 'i'),
  /^(?:else|try|finally|do)\s*\{\s*/i,
  /^catch\s*(?:\[[^\]]*\]\s*)?\{\s*/i,
  /^[&.]?\s*\{\s*/,
  /^\$?\(\s*/,
  /^(?:then|else|do)\s+/i,                         // bash: if …; then git push; fi
];

function unwrapSegment(raw) {
  let s = String(raw).trim();
  const env = {};
  let opened = 0, closed = 0, opaque = '';
  for (let pass = 0; pass < 32; pass++) {
    const before = s;
    for (const re of BLOCK_OPEN) {
      const m = re.exec(s);
      if (m) { s = s.slice(m[0].length); opened++; }
    }
    const close = /\s*[})]+\s*$/.exec(s);
    if (close && !/^["']/.test(s.slice(close.index).trim())) {
      closed += (close[0].match(/[})]/g) || []).length;
      s = s.slice(0, close.index);
    }
    let m;
    if ((m = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']*)(?:\s+|$)/.exec(s))) {
      env[m[1].toUpperCase()] = m[2].replace(/^["']|["']$/g, '');
      s = s.slice(m[0].length);
    } else if ((m = /^env(?:\s+|$)/i.exec(s))) {
      s = s.slice(m[0].length);
      if (/^-/.test(s)) opaque = 'env options';
    } else if ((m = /^(?:sudo|time|command|nohup|builtin|exec|timeout\s+[\d.]+[smhd]?)\s+/i.exec(s))) {
      s = s.slice(m[0].length);
    } else if ((m = /^&\s*(?=["'A-Za-z0-9_.\\/$:-])/.exec(s))) {
      s = s.slice(m[0].length);                     // PowerShell call operator
    }
    s = s.trim();
    if (s === before) break;
  }
  return { text: s, env, opened, closed, opaque };
}

const SHELLS = /^(?:bash|sh|zsh|dash|ksh)$/;
const OPAQUE_TEXT = /\$\(|`|\b(?:eval|Invoke-Command|Start-Process|Start-Job)\b|-EncodedCommand\b/i;
const GIT_ENV = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_NAMESPACE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG.*|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/;
const GIT_ENV_ASSIGN = /\$env:GIT_[A-Z_]+\s*=|^(?:export|set|setx)\s+GIT_[A-Z_]+=|\benv:GIT_[A-Z_]+\b/i;
const XARGS_VALUE = new Set(['-n', '-L', '-I', '-d', '-P', '-s', '-a', '-E', '--max-args', '--max-lines', '--replace', '--delimiter', '--max-procs', '--arg-file', '--eof']);

function quoteToken(t) { return /[\s"']/.test(t) ? '"' + String(t).replace(/"/g, '\\"') + '"' : t; }

// The inner command of a nested shell/wrapper, or '' when there is none.
function nestedCommand(program, tokens, text) {
  if (SHELLS.test(program)) {
    const i = tokens.findIndex((t, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
    return i > 0 && tokens[i + 1] !== undefined ? { inner: tokens[i + 1], tool: 'Bash' } : null;
  }
  if (program === 'cmd') {
    const m = /^\S+(?:\s+\/(?![ck]\b)[^\s]+)*\s+\/[ck]\s+/i.exec(text);
    if (!m) return null;
    let inner = text.slice(m[0].length).trim();
    if (/^".*"$/.test(inner)) inner = inner.slice(1, -1);
    return { inner, tool: 'PowerShell' };
  }
  if (program === 'powershell' || program === 'pwsh') {
    const i = tokens.findIndex((t, n) => n > 0 && /^-(?:c|co|com|comm|comma|comman|command)$/i.test(t));
    return i > 0 && tokens.length > i + 1 ? { inner: tokens.slice(i + 1).join(' '), tool: 'PowerShell' } : null;
  }
  if (program === 'iex' || program === 'invoke-expression') {
    const rest = tokens.slice(1).filter((t) => !/^-command$/i.test(t));
    return rest.length ? { inner: rest.join(' '), tool: 'PowerShell' } : null;
  }
  if (program === 'eval') {
    return tokens.length > 1 ? { inner: tokens.slice(1).join(' '), tool: 'Bash' } : null;
  }
  if (program === 'xargs') {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) { if (XARGS_VALUE.has(tokens[i])) i++; i++; }
    return i < tokens.length ? { inner: tokens.slice(i).map(quoteToken).join(' '), tool: null, keepState: true } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// git and gh invocations
// ---------------------------------------------------------------------------

const GIT_VALUE_OPTS = /^--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source)$/;
const GIT_RETARGET = /^--(?:git-dir|work-tree|namespace)(?:=|$)/;

function gitInvocation(tokens, rec, state, opts) {
  let dir = rec.cwd, why = '', retarget = false;
  const config = {};
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '--') { i++; break; }
    if (t === '-C') {
      const value = tokens[i + 1];
      dir = value === undefined ? null : shellPath(value, dir, opts);
      if (dir === null && !why) why = 'git -C target is not a literal path';
      i += 2; continue;
    }
    if (t === '-c') {
      const kv = String(tokens[i + 1] || '');
      const eq = kv.indexOf('=');
      config[(eq < 0 ? kv : kv.slice(0, eq)).toLowerCase()] = eq < 0 ? 'true' : kv.slice(eq + 1);
      i += 2; continue;
    }
    if (GIT_RETARGET.test(t)) { retarget = true; why = why || 'git ' + t.split('=')[0] + ' retargets the repository'; }
    if (GIT_VALUE_OPTS.test(t)) { i += 2; continue; }
    i++;
  }
  let args = tokens.slice(i);
  let sub = String(args.shift() || '').toLowerCase();
  const alias = config['alias.' + sub];
  if (alias !== undefined) {
    if (alias.startsWith('!')) { why = why || 'git -c alias runs a shell command'; retarget = true; }
    const expanded = tokenize(alias.replace(/^!/, ''));
    sub = String(expanded.shift() || '').toLowerCase();
    args = [...expanded, ...args];
  }
  if (Object.keys(config).some((k) => /^(?:core\.(?:worktree|bare|hookspath)|include\.path|includeif\..*)$/.test(k))) {
    retarget = true; why = why || 'git -c changes repository/hook configuration';
  }
  if (Object.keys(rec.env).some((k) => GIT_ENV.test(k)) || state.gitTaint) {
    retarget = true; why = why || 'a GIT_* environment variable retargets git';
  }
  if (dir === null && !why) why = 'working directory could not be resolved';
  return { sub, args, cwd: dir, certain: dir !== null && !retarget, why, config };
}

// gh accepts inherited flags (-R/--repo) before the command and the subcommand.
function ghInvocation(tokens) {
  let repo = null, command = '', sub = '';
  const rest = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-R' || t === '--repo') { repo = tokens[++i] || ''; continue; }
    if (/^--repo=/.test(t)) { repo = t.slice(7); continue; }
    if (/^-R./.test(t)) { repo = t.slice(2); continue; }
    if (!command && !t.startsWith('-')) { command = t.toLowerCase(); continue; }
    // `gh api` has no subcommand: its endpoint and flags stay in order.
    if (command && command !== 'api' && !sub && !t.startsWith('-')) { sub = t.toLowerCase(); continue; }
    rest.push(t);
  }
  return { command, sub, args: rest, repo };
}

// ---------------------------------------------------------------------------
// Whole-command walk
// ---------------------------------------------------------------------------

const DIR_CHANGE = /^(?:cd|chdir|sl|set-location|pushd|push-location|popd|pop-location)$/;

function changeDirectory(program, tokens, state, opts) {
  if (program === 'popd' || program === 'pop-location') {
    state.cwd = state.stack.length ? state.stack.pop() : null;
    return;
  }
  const targets = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^-(?:path|literalpath)$/i.test(t)) { targets.push(tokens[++i]); continue; }
    if (/^-(?:stackname)$/i.test(t)) { i++; continue; }
    if (/^-(?:passthru|[LPe@])$/i.test(t) || t === '--') continue;
    targets.push(t);
  }
  const next = targets.length === 1 && targets[0] !== '-' ? shellPath(targets[0], state.cwd, opts) : null;
  if (program === 'pushd' || program === 'push-location') state.stack.push(state.cwd);
  state.cwd = next;
}

function walk(text, state, opts, out, depth) {
  for (const raw of splitSegments(text)) {
    const u = unwrapSegment(raw);
    for (let n = 0; n < u.opened; n++) state.blocks.push(state.cwd);
    const tokens = tokenize(u.text);
    if (GIT_ENV_ASSIGN.test(u.text)) state.gitTaint = true;
    if (tokens.length) {
      const { program, args } = programName(tokens[0], tokens.slice(1));
      const rec = {
        raw, text: u.text, tokens, env: u.env, program: program.toLowerCase(), args,
        cwd: state.cwd, certain: state.cwd !== null, nested: depth > 0,
        opaque: u.opaque || (OPAQUE_TEXT.test(u.text) ? 'unparsed substitution or wrapper' : ''),
      };
      if (rec.program === 'git') rec.git = gitInvocation(tokens, rec, state, opts);
      else if (rec.program === 'gh') rec.gh = ghInvocation(tokens);
      out.push(rec);
      if (DIR_CHANGE.test(rec.program)) changeDirectory(rec.program, tokens, state, opts);
      const nested = depth < 4 ? nestedCommand(rec.program, tokens, u.text) : null;
      if (nested) {
        if (nested.keepState) walk(nested.inner, state, opts, out, depth + 1);
        else {
          const child = { cwd: state.cwd, stack: [...state.stack], blocks: [], gitTaint: state.gitTaint };
          walk(nested.inner, child, { ...opts, tool: nested.tool || opts.tool }, out, depth + 1);
        }
      }
    }
    // Leaving a block in which the directory changed: bash subshells restore it,
    // PowerShell blocks keep it. Do not guess which — the cwd becomes unknown.
    for (let n = 0; n < u.closed; n++) {
      if (!state.blocks.length) break;
      if (state.blocks.pop() !== state.cwd) state.cwd = null;
    }
  }
}

// parseCommand(cmd, { cwd, tool: 'Bash'|'PowerShell', home, tmp }) → segment records:
// { raw, text, tokens, env, program, args, cwd|null, certain, nested, opaque,
//   git?: { sub, args, cwd|null, certain, why, config }, gh?: { command, sub, args, repo } }
function parseCommand(cmd, o = {}) {
  const opts = { tool: o.tool === 'Bash' ? 'Bash' : 'PowerShell', home: o.home || '', tmp: o.tmp || '' };
  const state = { cwd: o.cwd ? path.resolve(String(o.cwd)) : null, stack: [], blocks: [], gitTaint: false };
  const out = [];
  walk(String(cmd || ''), state, opts, out, 0);
  return out;
}

// Over-inclusive text detector: which guarded actions might this command
// perform? A hit with no parsed invocation is only text (an echo, a PR body)
// when the command has nothing opaque; otherwise the guard's ON_UNKNOWN applies.
function tripwire(cmd) {
  const t = String(cmd || '');
  const hits = new Set();
  const git = '\\bgit(?:\\.exe|\\.cmd|\\.bat)?["\']?\\s[^\\n]*?\\b';
  if (new RegExp(git + 'commit\\b', 'i').test(t)) hits.add('commit');
  if (new RegExp(git + 'push\\b', 'i').test(t)) hits.add('push');
  if (/\bgh(?:\.exe)?["']?\s[^\n]*?\bmerges?\b/i.test(t)) hits.add('gh-merge');
  if (/\bgh(?:\.exe)?["']?\s[^\n]*?\breleases?\b/i.test(t)) hits.add('gh-release');
  if (/\b(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe|\.ps1)?["']?\s[^\n]*?\b(?:un)?publish\b/i.test(t) || /\bnuget\b[^\n]*\bpush\b/i.test(t)) hits.add('publish');
  if (/(?:^|[\s;&|({"'])(?:rm|rmdir|rd|del|erase|ri|Remove-Item|rimraf)(?:\.exe)?["']?\s/i.test(t)) hits.add('delete');
  return hits;
}

function opaque(cmd) { return OPAQUE_TEXT.test(String(cmd || '')); }

module.exports = { splitSegments, tokenize, normalize, programName, shellPath, parseCommand, tripwire, opaque };

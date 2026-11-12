/*
 * shell-command.cjs — the one command grammar shared by the guard hooks
 * (policy-guard, precommit-guard, csharpier-guard) and transcript-scan.
 *
 * Pure: requires only path and ./verification-target.cjs; no filesystem reads,
 * no child processes (a guard may pass its own git alias resolver). Commands
 * handed to another program — `bash -c`, `ssh host "…"`, a heredoc fed to a
 * shell, `wsl -- …` — are parsed too; records from another machine carry
 * `remote`. Detection is over-inclusive (tripwire); resolution is
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

// Split a command line into parts on && || ; | & and newlines — but only
// OUTSIDE quotes. A heredoc body is cut out of the line (a heredoc that writes a
// script containing "dotnet build" must not read as a verify, and its ';'s are
// text) and kept on the part whose `<<WORD` named it, with the separator that
// ended each part, so the walk can tell which program reads it.
// 2026-11-12: the rest of the `<<WORD` line is split like any other line (a
// `| bash` or `&& git push` after the marker used to vanish into the heredoc),
// and the escape character follows the shell: a backslash before a quote is an
// escape only in Bash; PowerShell's escape is the backtick. With no tool given
// the old Bash rule stays, for callers that do not pass one.
function splitParts(cmd, tool) {
  cmd = String(cmd || '');
  const parts = [];
  const pending = [];                       // heredocs named on this line; their bodies follow it
  const backslash = tool !== 'PowerShell';
  const backtick = tool === 'PowerShell';
  let cur = { text: '', heredocs: [], sep: '' };
  let q = null;
  let i = 0;
  const cut = (sep, width) => { cur.sep = sep; parts.push(cur); cur = { text: '', heredocs: [], sep: '' }; i += width; };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (q) {
      cur.text += ch;
      if (ch === q) q = null;
      else if (q === '"' && i + 1 < cmd.length && ((backslash && ch === '\\') || (backtick && ch === '`'))) { cur.text += cmd[i + 1]; i++; }
      i++;
      continue;
    }
    if (backtick && ch === '`' && i + 1 < cmd.length) { cur.text += ch + cmd[i + 1]; i += 2; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur.text += ch; i++; continue; }
    if (cmd.startsWith('<<<', i)) { cur.text += '<<<'; i += 3; continue; }      // here-string: its word stays on the line
    // Heredoc: <<EOF / <<-EOF / <<'EOF' / <<"EOF" / <<\EOF — the body starts after this line.
    if (cmd.startsWith('<<', i)) {
      const m = /^<<-?\s*\\?(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(cmd.slice(i));
      if (m) { pending.push({ part: cur, term: m[2] }); cur.text += m[0]; i += m[0].length; continue; }
    }
    if (ch === '\n' && pending.length) {
      i = readHeredocs(cmd, i + 1, pending.splice(0));
      cut('\n', 1);
      continue;
    }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) { cut(cmd.slice(i, i + 2), 2); continue; }
    if (ch === ';' || ch === '\n' || ch === '|') { cut(ch, 1); continue; }
    if (ch === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') { cut('&', 1); continue; }
    cur.text += ch;
    i++;
  }
  parts.push(cur);
  return parts;
}

// Read the bodies of the heredocs named on one line, in order, starting at j.
// Returns the index of the newline that ends the last terminator line.
function readHeredocs(cmd, j, list) {
  let stop = cmd.length;
  for (const h of list) {
    const lines = [];
    let found = false;
    while (j < cmd.length) {
      let nl = cmd.indexOf('\n', j);
      if (nl === -1) nl = cmd.length;
      const line = cmd.slice(j, nl);
      j = nl + 1;
      if (line.replace(/^\t+/, '').trim() === h.term) { found = true; stop = nl; break; }
      lines.push(line);
    }
    h.part.heredocs.push(lines.join('\n'));
    if (!found) return cmd.length;
  }
  return stop;
}

function splitSegments(cmd, tool) {
  return splitParts(cmd, tool).map((p) => p.text.trim()).filter(Boolean);
}

// Tokenize one segment the way a shell forms words: quoted runs join the
// surrounding text (`--title="a b"`, `alias.x="!git push"` are one word) and
// the quotes are removed. Inside double quotes a backslash pair is kept
// verbatim by default (Windows paths stay intact). 2026-11-12: with a tool the
// shell's own rule applies — Bash turns \" \\ \$ \` into the plain character
// (so `bash -c "… \"a b\" && git push"` hands the inner shell real quotes);
// PowerShell keeps every backslash and escapes with the backtick instead.
function tokenize(seg, tool) {
  const s = String(seg == null ? '' : seg);
  const out = [];
  let cur = '', started = false, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (q === '"' && ch === '\\' && i + 1 < s.length && tool !== 'PowerShell') {
        const next = s[i + 1];
        if (tool === 'Bash' && /["\\$`]/.test(next)) cur += next;
        else if (!(tool === 'Bash' && next === '\n')) cur += ch + next;   // Bash: backslash-newline joins lines
        i++;
      }
      else if (q === '"' && ch === '`' && tool === 'PowerShell' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; }
      else cur += ch;
      continue;
    }
    if (tool === 'PowerShell' && ch === '`' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; started = true; continue; }
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
  if (opts.remote) return null;                     // 2026-11-12: a path on another machine names nothing here
  if (!p ||/[$%`*?[\]{},]|::/.test(p) || /^(?:\\\\|\/\/)/.test(p)) return null;
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

// 2026-11-12: a program behind a run-it-for-me wrapper was invisible to both
// guards (`timeout -k 5 600 git push` read as program "timeout"). Each pattern
// eats the wrapper and its own options, so the real program is at column 0.
const WRAPPERS = [
  /^(?:nohup|builtin|winpty(?:\s+-X\S+)*)\s+/i,
  /^time(?:\s+-p)?\s+/i,
  /^command(?:\s+-p)?\s+(?!-[vV]\b)/i,                         // `command -v x` only looks x up
  /^exec(?:\s+(?:-a\s+\S+|-[cl]+))*\s+/i,
  /^timeout(?:\s+(?:-[ks]\s*\S+|--(?:kill-after|signal)(?:=|\s+)\S+|--preserve-status|--foreground|--verbose|-v))*\s+[\d.]+[smhd]?\s+/i,
  /^nice(?:\s+(?:-n\s*-?\d+|-\d+|--adjustment=-?\d+))?\s+/i,
  /^stdbuf(?:\s+(?:-[ioe]\s*\S+|--(?:input|output|error)=\S+))+\s+/i,
  /^sudo(?:\s+(?:-[ugChprtTU]\s+\S+|--[a-z-]+=\S+|-[A-Za-z]+|--[a-z-]+))*\s+/i,
];

function unwrapSegment(raw) {
  let s = String(raw).trim();
  const env = {};
  let opened = 0, closed = 0, opaque = '', chdir = false;
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
      // env's own options: -i/-0/-v and -u NAME change nothing about the program;
      // -C DIR moves the directory; -S splits one string into the command.
      s = s.slice(m[0].length);
      for (;;) {
        let o = /^(?:-[i0v]+|-|--ignore-environment|--null|--debug)(?:\s+|$)/.exec(s) || /^(?:-u\s*|--unset[=\s]\s*)\S+(?:\s+|$)/.exec(s);
        if (!o && (o = /^(?:-C\s*|--chdir[=\s]\s*)\S+(?:\s+|$)/.exec(s))) chdir = true;
        if (o) { s = s.slice(o[0].length); continue; }
        if ((o = /^(?:-S|--split-string)(?:=|\s+)/.exec(s))) {
          s = s.slice(o[0].length).trim();
          const one = /^(["'])(.*)\1$/s.exec(s);
          if (one) s = one[2];
        } else if (/^-/.test(s)) opaque = 'env options';
        break;
      }
    } else if (WRAPPERS.some((re) => (m = re.exec(s)))) {
      s = s.slice(m[0].length);
    } else if ((m = /^&\s*(?=["'A-Za-z0-9_.\\/$:-])/.exec(s))) {
      s = s.slice(m[0].length);                     // PowerShell call operator
    }
    s = s.trim();
    if (s === before) break;
  }
  return { text: s, env, opened, closed, opaque, chdir };
}

const SHELLS = /^(?:bash|sh|zsh|dash|ksh)$/;
const OPAQUE_TEXT = /\$\(|`|\b(?:eval|Invoke-Command|Start-Process|Start-Job)\b|-EncodedCommand\b/i;
const GIT_ENV = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_NAMESPACE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CONFIG.*|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/;
const GIT_ENV_ASSIGN = /\$env:GIT_[A-Z_]+\s*=|^(?:export|set|setx)\s+GIT_[A-Z_]+=|\benv:GIT_[A-Z_]+\b/i;
const XARGS_VALUE = new Set(['-n', '-L', '-I', '-d', '-P', '-s', '-a', '-E', '--max-args', '--max-lines', '--replace', '--delimiter', '--max-procs', '--arg-file', '--eof']);

function quoteToken(t) { return /[\s"']/.test(t) ? '"' + String(t).replace(/"/g, '\\"') + '"' : t; }

// 2026-11-12: here-document markers and here-strings are input, not words of the
// command: `<<EOF`, `<< EOF`, `<<<word`, `<<< word`. Returns the other words and
// the here-string texts (which, like a heredoc body, become the program's input).
function inputWords(tokens) {
  const rest = [], strings = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '<<<') { if (tokens[i + 1] !== undefined) strings.push(tokens[++i]); continue; }
    if (t.startsWith('<<<')) { strings.push(t.slice(3)); continue; }
    if (/^<<-?$/.test(t)) { i++; continue; }
    if (/^<<-?\\?[A-Za-z_][A-Za-z0-9_]*$/.test(t)) continue;
    rest.push(t);
  }
  return { rest, strings };
}

// ssh [options] host [command…]: the options that take a value, alone or ending a cluster.
const SSH_VALUE = /^-[46AaCfGgKkMNnqsTtVvXxYy]*[BbcDEeFIiJLlmOoPpQRSWw]$/;
function sshRemote(tokens) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '--') { i++; break; }
    i += SSH_VALUE.test(tokens[i]) ? 2 : 1;
  }
  return i < tokens.length ? { host: tokens[i], words: tokens.slice(i + 1) } : null;
}

// The remote shell is unknown: Sanad's machines run Windows (cmd: `cd /d C:\…`),
// other hosts a POSIX shell. Windows paths read with the no-backslash-escape grammar.
function remoteTool(inner) { return /(?:^|[\s;&|(])cd\s+\/d\s|\b[A-Za-z]:\\/i.test(inner) ? 'PowerShell' : 'Bash'; }

// A shell started without -c runs the commands it reads on stdin, unless it was
// given a script file to run (then the input is that script's data).
function shellReadsInput(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-s') return true;
    if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(t)) { i++; continue; }
    if (/^[-+]/.test(t) || /^\d*[<>]/.test(t)) continue;
    return false;
  }
  return true;
}

// The inner command of a nested shell/wrapper, or null when there is none.
// `input` is what the program reads on stdin (heredoc, here-string or pipe).
// Result: { inner, tool, remote?, cwd?: null when the directory is unknown,
// consumed?: true when `inner` IS the input (the child gets no further input) }.
function nestedCommand(program, tokens, text, input) {
  if (SHELLS.test(program)) {
    const i = tokens.findIndex((t, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
    if (i > 0) return tokens[i + 1] !== undefined ? { inner: tokens[i + 1], tool: 'Bash' } : null;
    return input && shellReadsInput(tokens) ? { inner: input, tool: 'Bash', consumed: true } : null;
  }
  if (program === 'ssh') {
    // 2026-11-12: the command ssh runs on the other machine was never parsed.
    const r = sshRemote(tokens);
    if (!r) return null;
    const inner = r.words.join(' ');                  // ssh joins its words with spaces, as the remote shell sees them
    if (inner.trim()) return { inner, tool: remoteTool(inner), remote: r.host, cwd: null };
    return input ? { inner: input, tool: remoteTool(input), remote: r.host, cwd: null, consumed: true } : null;
  }
  if (program === 'wsl') {
    let i = 1, cd = false;
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^(?:-d|--distribution|-u|--user|--shell-type)$/i.test(t)) { i++; continue; }
      if (/^--cd$/i.test(t)) { cd = true; i++; continue; }
      if (/^--system$/i.test(t)) continue;
      if (/^(?:-e|--exec|--)$/.test(t)) { i++; break; }
      if (t.startsWith('-')) return null;             // --install, --shutdown, -l …: no command
      break;
    }
    const words = tokens.slice(i);
    if (words.length) return { inner: words.map(quoteToken).join(' '), tool: 'Bash', ...(cd ? { cwd: null } : {}) };
    return input ? { inner: input, tool: 'Bash', consumed: true, ...(cd ? { cwd: null } : {}) } : null;
  }
  if (program === 'cmd') {
    const m = /^\S+(?:\s+\/(?![ck]\b)[^\s]+)*\s+\/[ck]\s+/i.exec(text);
    if (!m) return input ? { inner: input, tool: 'PowerShell', consumed: true } : null;
    let inner = text.slice(m[0].length).trim();
    if (/^".*"$/.test(inner)) inner = inner.slice(1, -1);
    return { inner, tool: 'PowerShell' };
  }
  if (program === 'powershell' || program === 'pwsh') {
    const i = tokens.findIndex((t, n) => n > 0 && /^-(?:c|co|com|comm|comma|comman|command)$/i.test(t));
    const inner = i > 0 ? tokens.slice(i + 1).join(' ') : '';
    if (inner && inner !== '-') return { inner, tool: 'PowerShell' };
    // `-Command -`, or no command and no script file: the commands come from stdin.
    const file = tokens.findIndex((t, n) => n > 0 && /^-(?:f|fi|fil|file)$/i.test(t));
    const fromInput = i > 0 || file < 0 || tokens[file + 1] === '-';
    return input && fromInput ? { inner: input, tool: 'PowerShell', consumed: true } : null;
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
// Git's own commands. Git never lets an alias replace one of them, so only a
// word outside this set can be an alias (and is looked up, once).
const GIT_COMMANDS = new Set(('add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore ' +
  'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree ' +
  'config count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack ' +
  'filter-branch for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb ' +
  'interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree ' +
  'mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs prune prune-packed pull push range-diff read-tree ' +
  'rebase reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm send-email shortlog show show-branch ' +
  'show-index show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects update-index ' +
  'update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree lfs').split(' '));

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
  let shell = '';
  // Git ignores an alias that would shadow one of its own commands.
  let alias = GIT_COMMANDS.has(sub) ? undefined : config['alias.' + sub];
  let source = 'git -c alias';
  // 2026-11-12: a saved alias (`git config alias.pf "push --force"`, then `git pf`)
  // hid the push from both guards. The guard passes a resolver (it may run git);
  // this file stays free of processes. Looked up once, in the command's folder.
  if (alias === undefined && sub && dir && !GIT_COMMANDS.has(sub) && typeof opts.resolveAlias === 'function' && /^[A-Za-z0-9][\w.-]*$/.test(sub)) {
    const saved = opts.resolveAlias(sub, dir);
    if (saved) { alias = String(saved); source = 'the git alias `' + sub + '`'; }
  }
  if (alias !== undefined) {
    if (alias.startsWith('!')) {
      // A shell alias runs its text (plus the arguments) in a shell at the repository
      // top level: the walk parses it as a nested command whose folder is unknown.
      why = why || source + ' runs a shell command'; retarget = true;
      shell = alias.slice(1) + (args.length ? ' ' + args.map(quoteToken).join(' ') : '');
      sub = '!'; args = [];
    } else {
      const expanded = tokenize(alias);
      sub = String(expanded.shift() || '').toLowerCase();
      args = [...expanded, ...args];
    }
  }
  if (Object.keys(config).some((k) => /^(?:core\.(?:worktree|bare|hookspath)|include\.path|includeif\..*)$/.test(k))) {
    retarget = true; why = why || 'git -c changes repository/hook configuration';
  }
  if (Object.keys(rec.env).some((k) => GIT_ENV.test(k)) || state.gitTaint) {
    retarget = true; why = why || 'a GIT_* environment variable retargets git';
  }
  if (dir === null && !why) why = 'working directory could not be resolved';
  return { sub, args, cwd: dir, certain: dir !== null && !retarget, why, config, shell };
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

// What a part sends down a pipe to the next one: its heredoc/here-string body,
// the words echo/printf print, or (cat/tee with no file) the input it read.
function pipedText(rec, here, input) {
  if (here) return here;
  if (/^(?:echo|printf)$/.test(rec.program)) {
    const words = [...rec.args];
    while (words.length && /^-[neE]+$/.test(words[0])) words.shift();
    return words.join(' ');
  }
  if (/^(?:cat|tee)$/.test(rec.program) && !rec.args.some((a) => !String(a).startsWith('-'))) return input;
  return '';
}

// Records carry `remote` (the ssh host, '' when the command runs on this machine)
// and `stdin` (heredoc, here-string or piped text the program reads, when known).
function walk(text, state, opts, out, depth, stdin = '') {
  let piped = '';
  for (const part of splitParts(text, opts.tool)) {
    const raw = part.text.trim();
    const fromPipe = piped;
    piped = '';
    if (!raw) continue;
    const u = unwrapSegment(raw);
    for (let n = 0; n < u.opened; n++) state.blocks.push(state.cwd);
    const tokens = tokenize(u.text, opts.tool);
    if (GIT_ENV_ASSIGN.test(u.text)) state.gitTaint = true;
    if (tokens.length) {
      const { program, args } = programName(tokens[0], tokens.slice(1));
      const words = inputWords(tokens);
      const here = [...part.heredocs, ...words.strings].join('\n');
      const input = here || fromPipe || stdin;
      const cwd = u.chdir ? null : state.cwd;
      const rec = {
        raw, text: u.text, tokens, env: u.env, program: program.toLowerCase(), args,
        cwd, certain: cwd !== null, nested: depth > 0, remote: opts.remote || '',
        opaque: u.opaque || (OPAQUE_TEXT.test(u.text) ? 'unparsed substitution or wrapper' : ''),
      };
      if (input) rec.stdin = input;
      if (rec.program === 'git') rec.git = gitInvocation(tokens, rec, state, opts);
      else if (rec.program === 'gh') rec.gh = ghInvocation(tokens);
      out.push(rec);
      if (DIR_CHANGE.test(rec.program)) changeDirectory(rec.program, tokens, state, opts);
      if (part.sep === '|') piped = pipedText(rec, here, input);
      let nested = null;
      if (depth < 4) {
        nested = nestedCommand(rec.program, words.rest, u.text, input);
        if (!nested && rec.git && rec.git.shell) nested = { inner: rec.git.shell, tool: 'Bash', cwd: null };
      }
      if (nested) {
        if (nested.keepState) walk(nested.inner, state, opts, out, depth + 1);
        else {
          const local = nested.cwd !== null;
          const child = local ? { cwd: state.cwd, stack: [...state.stack], blocks: [], gitTaint: state.gitTaint }
            : { cwd: null, stack: [], blocks: [], gitTaint: !nested.remote && state.gitTaint };
          walk(nested.inner, child, { ...opts, tool: nested.tool || opts.tool, remote: nested.remote || opts.remote || '' }, out, depth + 1,
            nested.consumed ? '' : input);
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

// parseCommand(cmd, { cwd, tool: 'Bash'|'PowerShell', home, tmp, resolveAlias? }) → segment records:
// { raw, text, tokens, env, program, args, cwd|null, certain, nested, remote, stdin?, opaque,
//   git?: { sub, args, cwd|null, certain, why, config, shell }, gh?: { command, sub, args, repo } }
// resolveAlias(word, dir) → the saved `alias.<word>` text or '' (the caller may run git).
function parseCommand(cmd, o = {}) {
  const opts = { tool: o.tool === 'Bash' ? 'Bash' : 'PowerShell', home: o.home || '', tmp: o.tmp || '', remote: '',
    resolveAlias: typeof o.resolveAlias === 'function' ? o.resolveAlias : null };
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

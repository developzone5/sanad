// proof-select.mjs — the test command for one break: only the tests the break's mustFail names.
//
// 2026-11-19 (speed review, problem 17): every break ran the whole test command; on day 3 of the role-sync
// task that was 163 tests per break, though each break is judged by the few tests its mustFail names.
//
// The promise: the command made here runs every test the break's mustFail names. When that cannot be said for
// sure, the same command comes back with the reason. The proof runner still checks the named failures.
//
// A pure function: it reads no file and starts nothing, so the machine that runs the tests builds the command
// itself and no test title crosses ssh quoting. It imports only ./proof-record.mjs, so red-proof's proofScripts
// copies it to the test machine.
//
// selectCommand(command, mustFail, declared, { cwd }) -> { command, narrowed, why }
//   command   the test command as an argv array (no shell).
//   mustFail  the break's parts; a part names a test as survivors() of red-proof.mjs matches it (namedBy).
//   declared  test declarations across the files this command covers. For JS, testSpans includes table tests.
//   cwd       the folder the command runs in: relative to the repository's top folder ('' is the top), as the
//             files of `declared` are; an absolute folder also works. Only vitest and jest need it.
//
// dotnet test: one --filter of FullyQualifiedName~Class.Method terms joined with |, built from the class and
//   method names only. An inherited test (the runner prints the class that derives) uses .Method alone. A
//   filter the command already has is kept: (old)&(new). A DisplayName is never used: display names hold
//   brackets, commas and colons, which a filter cannot carry.
// vitest and jest (node <entry>, or the runner itself): the file list becomes the test files that hold the
//   named tests, and -t gets their exact titles as one escaped pattern.
// The full command, unchanged, when: a part names no declared test; a title has placeholders (a table row's
//   name is made at run time); the runner is not known; the command is a shell wrapper; there are more than 40
//   terms; the command already picks tests by name, or only lists them; an option's value cannot be told from
//   a file.
import { namedBy } from './proof-record.mjs';

export const MAX_TERMS = 40;

// A runner can replace these parts of a table or template title.
const PLACEHOLDER = /\$\{|%[sdifjoc#p$%]|\$[$\p{ID_Continue}]/u;
const IDENT = /^[A-Za-z_]\w*$/;
const SHELL = /^(?:cmd|sh|bash|zsh|dash|ksh|fish|powershell|pwsh|wsl|env|sudo|time|xargs)(?:\.exe)?$/;
const SHELL_SCRIPT = /\.(?:cmd|bat|ps1|sh)$/;
// vitest words that are not a plain run of the tests.
const VITEST_OTHER = /^(?:watch|dev|related|bench|init|list|typecheck)$/;
// Options that already pick tests by name or by change, or that only list them.
const PICKS = /^(?:-t|--testNamePattern|--test-name-pattern|--listTests|--list-tests|--findRelatedTests|--runTestsByPath|--onlyChanged|-o|--changed|--changedSince|--lastCommit|--onlyFailures|-f|--shard)$/;
// Options that move the folder the file list is read from.
const MOVES = /^(?:-r|--root|--dir|--rootDir|--roots|--project|--projects|--selectProjects|--workspace)$/;
// Options known to take no value, and options known to take one. Any other option is not guessed.
const NO_VALUE = new Set(['--run', '--passWithNoTests', '--globals', '--dom', '--color', '--isolate', '--allowOnly',
  '--update', '-u', '--ci', '--runInBand', '-i', '--verbose', '--forceExit', '--detectOpenHandles', '--hideSkippedTests', '--logHeapUsage',
  '--fileParallelism', '--clearScreen', '--expandSnapshotDiff', '--disableConsoleIntercept', '--printConsoleTrace', '--useStderr', '--json',
  '--debug', '--errorOnDeprecated', '--noStackTrace', '--no-coverage', '--no-cache']);
// (An option that may take several words, such as jest's --reporters, is left out on purpose.)
const TAKES_VALUE = new Set(['-c', '--config', '--reporter', '--outputFile', '--pool', '--environment', '--env', '--testEnvironment',
  '--mode', '--testTimeout', '--hookTimeout', '--teardownTimeout', '--retry', '--maxWorkers', '--minWorkers', '--maxConcurrency',
  '--slowTestThreshold', '--exclude', '--coverageDirectory', '--logLevel', '--seed']);
const NODE_FLAGS = new Set(['--no-warnings', '--enable-source-maps', '--experimental-vm-modules']);

const baseName = (p) => String(p == null ? '' : p).split(/[\\/]/).pop().toLowerCase();
const slashes = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isAbsolute = (p) => /^(?:[A-Za-z]:\/|\/)/.test(p);
const full = (command, why) => ({ command, narrowed: false, why });

export function selectCommand(command, mustFail, declared, { cwd = '', platform = process.platform } = {}) {
  if (!Array.isArray(command) || !command.length) return full(command, 'there is no test command');
  const parts = (Array.isArray(mustFail) ? mustFail : []).map(String);
  if (!parts.length) return full(command, 'the break names no test (no mustFail part)');
  const tests = (Array.isArray(declared) ? declared : []).filter(d => d && Array.isArray(d.titles) && d.titles.length);
  // Every declared test a part names must run: that is the set survivors() wants to see failing.
  const wanted = new Set();
  for (const part of parts) {
    const hits = tests.filter(d => namedBy([part], d));
    if (!hits.length) return full(command, `mustFail part ${JSON.stringify(part)} names no declared test`);
    for (const d of hits) wanted.add(d);
  }
  const list = [...wanted];
  const exe = baseName(command[0]);
  if (SHELL.test(exe) || SHELL_SCRIPT.test(exe)) return full(command, 'the command is a shell wrapper');
  if (/^dotnet(?:\.exe)?$/.test(exe)) return command[1] === 'test' ? selectDotnet(command, list, tests) : full(command, 'the runner is not known');
  const runner = jsRunner(command);
  if (!runner) return full(command, 'the runner is not known');
  return selectJs(command, runner, list, cwd, platform);
}

function selectDotnet(command, list, tests) {
  const dash = command.indexOf('--', 2);
  const end = dash < 0 ? command.length : dash;
  const args = command.slice(2, end);
  // In dotnet test, -t is the short form of --list-tests: such a command runs no test.
  if (args.some(a => /^(?:-t|--list-tests)(?:$|[=:])/.test(a))) return full(command, 'the command only lists tests (-t or --list-tests)');
  // A filter given as a build property would not be joined with the one made here.
  if (args.some(a => /VSTestTestCaseFilter/i.test(a))) return full(command, 'the command sets its filter as a build property (VSTestTestCaseFilter)');
  if (args.some(a => /^(?:-s|--settings)(?:$|[=:])/.test(a)) ||
      command.slice(end + 1).some(a => /(?:^|\.)TestCaseFilter\s*=/i.test(a))) {
    return full(command, 'the command can set a filter in its run settings');
  }
  // Test declarations carry the classes of their files, including bases defined in another file.
  const bases = new Set();
  for (const test of tests) {
    for (const klass of test.classes || []) for (const base of klass.bases) bases.add(base);
  }
  const terms = new Set();
  for (const d of list) {
    const method = String(d.titles[0]);
    if (!/\.cs$/i.test(String(d.file || '')) || !IDENT.test(method) || (d.klass && !IDENT.test(String(d.klass)))) {
      return full(command, `test ${JSON.stringify(method)} in ${d.file || 'an unnamed file'} has no C# class and method name to filter by`);
    }
    // The runner prints an inherited test with the class that derives, so only its method is sure.
    terms.add('FullyQualifiedName~' + (d.klass && !d.inherited && !bases.has(d.klass) ? d.klass : '') + '.' + method);
  }
  if (terms.size > MAX_TERMS) return full(command, `${terms.size} test names, more than ${MAX_TERMS}`);
  const made = [...terms].join('|');
  const filters = [];
  for (let i = 2; i < end; i++) if (/^--filter(?:$|[=:])/.test(String(command[i]))) filters.push(i);
  if (filters.length > 1) return full(command, 'the command has more than one --filter');
  const both = (old) => (String(old).trim() ? `(${old})&(${made})` : made);
  const out = [...command];
  if (!filters.length) out.splice(end, 0, '--filter', made);
  else {
    const i = filters[0], arg = String(command[i]);
    if (arg !== '--filter') out[i] = arg.slice(0, 9) + both(arg.slice(9));
    else if (i + 1 < end && !String(command[i + 1]).startsWith('-')) out[i + 1] = both(command[i + 1]);
    else return full(command, '--filter has no value');
  }
  return { command: out, narrowed: true, why: `${terms.size} test name(s) in --filter` };
}

// vitest or jest, and where its entry is in the command: `node [node options] <entry> ...`, or the runner itself.
function jsRunner(command) {
  const kindOf = (name) => (/^vitest(?:\.[cm]?js)?$/.test(name) ? 'vitest' : /^jest(?:\.[cm]?js)?$/.test(name) ? 'jest' : null);
  const exe = baseName(command[0]);
  if (exe === 'vitest' || exe === 'jest') return { kind: exe, at: 0 };
  if (!/^node(?:\.exe)?$/.test(exe)) return null;
  let at = 1;
  while (NODE_FLAGS.has(command[at])) at++;
  if (command[at] === '--') at++;
  const kind = kindOf(baseName(command[at]));
  return kind ? { kind, at } : null;
}

// A test file as the command's folder sees it, or null when it is not under that folder. For an absolute folder
// the repository's top is not known: the longest tail of the folder that heads the file is cut off. That gives
// the true path or a tail of it, and both runners match a tail, so the file is never lost.
function relativeTo(cwd, file, platform) {
  const f = slashes(file), c = slashes(cwd);
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  if (!f) return null;
  if (isAbsolute(f)) return isAbsolute(c) && fold(f).startsWith(fold(c) + '/') ? f.slice(c.length + 1) : null;
  if (!c || c === '.') return f;
  if (!isAbsolute(c)) return fold(f).startsWith(fold(c) + '/') ? f.slice(c.length + 1) : null;
  const dirs = c.split('/'), names = f.split('/');
  for (let k = Math.min(dirs.length, names.length - 1); k > 0; k--) {
    if (fold(dirs.slice(-k).join('/')) === fold(names.slice(0, k).join('/'))) return names.slice(k).join('/');
  }
  return f;
}

// Check simple file words only. An absolute path or a Jest pattern may point somewhere else.
function covers(word, file, kind, platform) {
  let w = String(word);
  if (kind === 'vitest' && platform === 'win32') w = w.replace(/\\/g, '/');
  w = w.replace(/^(?:\.\/)+/, '');
  if (!w || isAbsolute(w) || w.split('/').includes('..')) return false;
  if (kind === 'jest' && /[\\*+?^${}()|[\]]/.test(w)) return false;
  return file.toLowerCase().includes(w.toLowerCase());
}

function selectJs(command, { kind, at }, list, cwd, platform) {
  const titles = new Set(), files = new Set();
  for (const d of list) {
    const title = String(d.titles[0]);
    if (/\.cs$/i.test(String(d.file || ''))) return full(command, `${d.file} holds a C# test, which ${kind} does not run`);
    if (d.titles.some(t => PLACEHOLDER.test(String(t)))) return full(command, `title ${JSON.stringify(title)} has placeholders, filled in at run time`);
    if (!title.trim() || /[\x00-\x1f]/.test(title)) return full(command, 'a title is empty or holds a line break');
    const rel = d.file ? relativeTo(cwd, d.file, platform) : null;
    if (rel === null) return full(command, `${d.file || 'a test with no file'} is not under the folder the command runs in`);
    if (/^-|[:\x00-\x1f]/.test(rel)) return full(command, `${rel} is not a plain test file path`);
    titles.add(title);
    files.add(rel);
  }
  if (titles.size > MAX_TERMS) return full(command, `${titles.size} titles, more than ${MAX_TERMS}`);
  let head = at + 1;
  const first = command[head] === undefined ? '' : String(command[head]);
  if (kind === 'vitest' && first === 'run') head++;
  else if (kind === 'vitest' && VITEST_OTHER.test(first)) return full(command, `"vitest ${first}" is not a plain run of the tests`);
  // The command's own file words. An option that is not known is not guessed at.
  const fileAt = [];
  for (let k = head; k < command.length; k++) {
    const a = String(command[k]);
    if (a === '--') return full(command, 'the command has a bare --');
    if (!a.startsWith('-')) { fileAt.push(k); continue; }
    const name = a.split('=')[0];
    if (PICKS.test(name)) return full(command, `the command already picks or lists tests (${name})`);
    if (MOVES.test(name)) return full(command, `${name} moves the folder the test files are read from`);
    if (NO_VALUE.has(name) || (a.includes('=') && TAKES_VALUE.has(name))) continue;
    const next = command[k + 1] === undefined ? undefined : String(command[k + 1]);
    if (TAKES_VALUE.has(name)) { if (next === undefined || next.startsWith('-')) return full(command, `${name} has no value`); k++; continue; }
    if (next !== undefined && !next.startsWith('-')) return full(command, `cannot tell whether ${next} is a file or the value of ${name}`);
    return full(command, `the command has an unknown option (${name})`);
  }
  // A test file the command's own file list leaves out is not added: the full command would not run it either.
  for (const f of files) {
    if (fileAt.length && !fileAt.some(k => covers(command[k], f, kind, platform))) return full(command, `the command's own file list does not hold ${f}`);
  }
  // jest reads a file word as a pattern, vitest as plain text.
  const fileArgs = [...files].map(f => (kind === 'jest' ? escapeRegex(f) : f));
  const insertAt = fileAt.length ? fileAt[0] : head;
  const out = [];
  for (let k = 0; k < command.length; k++) {
    if (k === insertAt) out.push(...fileArgs);
    if (!fileAt.includes(k)) out.push(command[k]);
  }
  if (insertAt >= command.length) out.push(...fileArgs);
  // Always in a group: the pattern then never starts with a dash, so no runner reads it as an option.
  out.push('-t', '(?:' + [...titles].map(escapeRegex).join('|') + ')');
  return { command: out, narrowed: true, why: `${titles.size} title(s) in ${files.size} test file(s)` };
}

// Write a break list from source lines. The proof checks and runs the list.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { isMain } from './is-main.mjs';
import { breakHits, markNewTests } from './red-proof.mjs';

const COMMON = ['--breaks', '--repo'];
const ADD = ['--file', '--line', '--to', '--put', '--put-file', '--put-from', '--must-fail'];
const PUTS = ['--put', '--put-file', '--put-from'];
const USAGE = [
  'Usage: breaks.mjs add --breaks <file> --repo <repo> --file <f> --line <n> [--to <n>] (--put <text> | --put-file <file> | --put-from <reviewed commit>:<a>[-<b>]) --must-fail <words>',
  '       breaks.mjs seed --breaks <file> --repo <repo> --base <ref>',
].join('\n');

function options(args) {
  const [command, ...rest] = args;
  const allowed = command === 'add' ? ADD : command === 'seed' ? ['--base'] : null;
  if (!allowed) throw new Error(USAGE);
  const flags = [...COMMON, ...allowed];
  const opts = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!flags.includes(flag)) throw new Error(`Unknown option: ${flag}`);
    if (opts.has(flag)) throw new Error(`Repeated option: ${flag}`);
    if (value === undefined || (flag !== '--put' && (!value || flags.includes(value)))) {
      throw new Error(`${flag} needs a value.`);
    }
    opts.set(flag, value);
  }
  const required = [...COMMON, ...(command === 'add' ? ['--file', '--line', '--must-fail'] : ['--base'])];
  for (const flag of required) if (!opts.has(flag)) throw new Error(`Missing ${flag}.\n${USAGE}`);
  if (command === 'add' && PUTS.filter((f) => opts.has(f)).length !== 1) {
    throw new Error('Supply one of --put, --put-file or --put-from. Use --put-file for code with quotes or shell symbols.');
  }
  return { command, opts };
}

function workingFile(repo, name) {
  const absolute = path.resolve(repo, name.replace(/\\/g, '/'));
  const inTree = (p) => {
    const relative = path.relative(repo, p);
    const first = relative.split(path.sep)[0].toLowerCase();
    return relative && !path.isAbsolute(relative) && first !== '..' && first !== '.git';
  };
  if (!inTree(absolute)) throw new Error(`--file must be inside the working tree: ${name}`);
  const real = fs.realpathSync.native(absolute);
  if (!inTree(real)) throw new Error(`--file must be inside the working tree: ${name}`);
  if (!fs.statSync(real).isFile()) throw new Error(`--file must be a regular file: ${name}`);
  return real;
}

function readText(file) {
  if (!fs.statSync(file).isFile()) throw new Error(`Expected a regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Expected UTF-8 text: ${file}`);
  return text;
}

function lineNumber(value, flag) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} needs a positive whole line number.`);
  return n;
}

function addEntry(repo, output, opts) {
  const source = workingFile(repo, opts.get('--file'));
  const replacement = opts.has('--put-file') ? fs.realpathSync.native(opts.get('--put-file')) : null;
  const file = path.relative(repo, source).split(path.sep).join('/');
  if (!path.relative(output, source) || (replacement && !path.relative(output, replacement))) {
    throw new Error('--breaks must be a separate file from the source and replacement.');
  }
  const from = lineNumber(opts.get('--line'), '--line');
  const to = opts.has('--to') ? lineNumber(opts.get('--to'), '--to') : from;
  const text = readText(source);
  // Keep the separators inside the range. Leave the last one in the source.
  const lines = text.split(/(\r?\n)/);
  const count = Math.floor(lines.length / 2) + (lines.at(-1) === '' ? 0 : 1);
  if (to < from || to > count) throw new Error(`Line range ${from}-${to} is outside ${file} (${count} lines).`);
  const find = lines.slice(2 * (from - 1), 2 * to - 1).join('');
  const hits = find ? breakHits(text, find) : 0;
  if (hits !== 1) throw new Error(`Selected text matches ${hits} time(s) in ${file}; it must match exactly once. Use --to to add more lines.`);
  const name = opts.get('--must-fail');
  if (!name.trim()) throw new Error('--must-fail needs words from a test title.');
  const put = replacement ? readText(replacement) : opts.has('--put-from') ? reviewedLines(repo, file, opts.get('--put-from')) : opts.get('--put');
  return { name, file, find, put, mustFail: [name] };
}

// 2026-11-22 (owner, PR 3 item 3): a bug the fix itself brought in passes on the base, so "red on the old code" cannot
// prove the reviewer's test for it. The break puts the REVIEWED commit's lines back instead: --put-from
// <commit>:<a>[-<b>] reads lines a..b of the same file as that commit holds them, never typed. The commit must be a
// review pin (refs/sanad/review/<task>/<round>, written by review-brief --pin), so the text is what the reviewer read.
function reviewedLines(repo, file, spec) {
  const m = /^([^:\s]+):(\d+)(?:-(\d+))?$/.exec(String(spec));
  if (!m) throw new Error('--put-from needs <reviewed commit>:<first line>[-<last line>], e.g. 4f52a6d0:38-41.');
  const sha = gitOut(repo, ['rev-parse', '--verify', '-q', `${m[1]}^{commit}`]);
  if (!sha) throw new Error(`--put-from: ${m[1]} is not a commit of this repository.`);
  const pins = gitOut(repo, ['for-each-ref', '--format=%(objectname)', 'refs/sanad/review/']).split(/\r?\n/).filter(Boolean);
  if (!pins.includes(sha)) throw new Error(`--put-from: ${m[1]} is not a reviewed commit (no review pin under refs/sanad/review/ holds it). Use the commit the reviewers read.`);
  // A file, not a folder: `git show` of a folder prints its listing (attack, 2026-11-22).
  if (gitOut(repo, ['cat-file', '-t', `${sha}:${file}`]) !== 'blob') throw new Error(`--put-from: ${file} is not a file in the reviewed commit ${sha.slice(0, 10)}.`);
  let text;
  try { text = execFileSync('git', ['-C', repo, 'cat-file', 'blob', `${sha}:${file}`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { throw new Error(`--put-from: ${file} is not a file in the reviewed commit ${sha.slice(0, 10)}.`); }
  const from = lineNumber(m[2], '--put-from'), to = m[3] ? lineNumber(m[3], '--put-from') : from;
  const lines = text.split(/(\r?\n)/);
  const count = Math.floor(lines.length / 2) + (lines.at(-1) === '' ? 0 : 1);
  if (to < from || to > count) throw new Error(`--put-from: lines ${from}-${to} are outside ${file} at ${sha.slice(0, 10)} (${count} lines).`);
  return lines.slice(2 * (from - 1), 2 * to - 1).join('');
}
function gitOut(repo, args) {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function seedEntries(repo, base) {
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  let from;
  try {
    const commit = git('rev-parse', '--verify', '--end-of-options', base + '^{commit}').trim();
    from = git('merge-base', commit, 'HEAD').trim();
  } catch {
    throw new Error(`No merge base with ${base}.`);
  }
  const top = fs.realpathSync.native(git('rev-parse', '--show-toplevel').trimEnd());
  if (path.relative(repo, top)) throw new Error('--repo must point to the repository root for seed.');
  const changes = git('diff', '--name-status', '-z', '--diff-filter=ADMRT', '--find-renames',
    '--no-ext-diff', '--no-textconv', from, '--').split('\0');
  const files = new Map();
  for (let i = 0; i < changes.length - 1;) {
    const status = changes[i++];
    const old = changes[i++];
    const file = status.startsWith('R') ? changes[i++] : old;
    files.set(file, { old: status === 'A' ? null : old, deleted: status === 'D' });
  }
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    files.set(file, { old: files.get(file)?.old ?? null, deleted: false });
  }
  const entries = [];
  for (const file of [...files.keys()].sort()) {
    const { old, deleted } = files.get(file);
    if (deleted || !TEST_FILE.test(file)) continue;
    const text = readText(workingFile(repo, file));
    const before = old === null ? null : git('show', `${from}:${old}`);
    for (const test of markNewTests(text, before, file)) {
      if (!test.isNew) continue;
      const name = test.titles.at(-1);
      if (name?.trim()) entries.push({ name, file: '', find: '', put: '', mustFail: [name] });
    }
  }
  return entries;
}

function readList(file) {
  let contents;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('--breaks must be a regular file.');
    contents = readText(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const list = JSON.parse(contents);
  if (!Array.isArray(list)) throw new Error('--breaks must hold a JSON array.');
  return list;
}

function updateList(file, update) {
  const lock = file + '.lock';
  const temp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Break list is locked: ${lock}`);
    throw error;
  }
  try {
    const list = readList(file);
    const written = update(list);
    if (written.length || !fs.existsSync(file)) {
      fs.writeFileSync(temp, JSON.stringify(list, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(temp, file);
    }
    return written;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
    fs.rmSync(temp, { force: true });
  }
}

const namesTest = (entry, name) => entry?.name === name && Array.isArray(entry.mustFail) &&
  entry.mustFail.length === 1 && entry.mustFail[0] === name;

function add(list, entry) {
  if (list.some(b => namesTest(b, entry.name) && b.file === entry.file && b.find === entry.find && b.put === entry.put)) {
    throw new Error(`Break already exists: ${JSON.stringify(entry.name)}`);
  }
  const slot = list.findIndex(b => namesTest(b, entry.name) && b.file === '' && b.find === '' && b.put === '');
  if (slot < 0) {
    list.push(entry);
    return [entry];
  }
  list[slot] = { ...list[slot], ...entry };
  return [list[slot]];
}

function seed(list, entries) {
  const counts = new Map();
  for (const b of list) if (namesTest(b, b?.name)) counts.set(b.name, (counts.get(b.name) || 0) + 1);
  const written = entries.filter(b => {
    const count = counts.get(b.name) || 0;
    if (count) counts.set(b.name, count - 1);
    return !count;
  });
  for (const entry of written) list.push(entry);
  return written;
}

function main(args) {
  const { command, opts } = options(args);
  const repo = fs.realpathSync.native(opts.get('--repo'));
  if (!fs.statSync(repo).isDirectory()) throw new Error('--repo must be a directory.');
  const target = path.resolve(opts.get('--breaks'));
  const output = path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));
  if (command === 'add') {
    const entry = addEntry(repo, output, opts);
    const [written] = updateList(output, list => add(list, entry));
    console.log(JSON.stringify(written));
  } else {
    const entries = seedEntries(repo, opts.get('--base'));
    const written = updateList(output, list => seed(list, entries));
    for (const entry of written) console.log(JSON.stringify(entry));
    console.log(`Seeded ${written.length} break(s).`);
  }
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`BREAKS: ${error.message}`); process.exitCode = 2; }
}

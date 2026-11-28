// kept.mjs — a result kept for the exact code and the exact inputs, so the same search does not run twice.
//
// 2026-11-28 (owner, batch b task 2): in test 4 the places search ran 30 times inside the checks before review and the
// size check 11 times fresh, plus once more in every one-job check and five times in the review brief, on code that
// had not changed. A result is kept by a key of everything its answer depends on:
//   - the code: the tree of the working folder, uncommitted and untracked (not ignored) files included (workTree);
//   - the inputs: what the caller passes (the names, the base commit and its merge base, ...);
//   - the tools: the text of every script in this folder and the Node version, so a new release never reads an old answer.
// One changed byte in the working folder is another tree, so another key: the work runs again. Any doubt (git cannot
// give a tree, the store cannot be read) gives no key, and the work runs as before. Nothing here decides pass or stop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEEP = 60;
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
function git(cwd, args, env) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch { return ''; }
}

/** The working folder as one tree id (HEAD plus every uncommitted and untracked, not ignored, file), or ''. */
export function workTreeId(repo) {
  const real = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmp = path.join(os.tmpdir(), `sanad-kept-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp);
    // Each step must succeed: an `add` that failed would give the tree of the index alone, another tree than the folder's.
    const strict = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_INDEX_FILE: tmp }, maxBuffer: 64 * 1024 * 1024 }).trim();
    if (!real || !fs.existsSync(real)) strict(['read-tree', 'HEAD']);
    strict(['add', '-A']);
    const tree = strict(['write-tree']);
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : '';
  } catch { return ''; } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } }
}

let toolsOnce = '';
/** The id of the tools: every script of this folder and of the hooks' lib folder (size-check.mjs loads code-paths.cjs from
 *  there), by name and text, and the Node version. A hooks lib folder that is not there adds nothing. */
export function toolsId() {
  if (toolsOnce) return toolsOnce;
  const h = crypto.createHash('sha256').update(process.version);
  try { for (const n of fs.readdirSync(here).filter((x) => /\.(?:mjs|cjs|js)$/.test(x)).sort()) h.update(n + '\0' + fs.readFileSync(path.join(here, n))); }
  catch { return ''; }
  const hooksLib = path.resolve(here, '../../../hooks/lib');
  let libs = [];
  try { libs = fs.readdirSync(hooksLib).filter((x) => /\.(?:mjs|cjs|js)$/.test(x)).sort(); } catch { libs = []; }
  try { for (const n of libs) h.update('hooks/lib/' + n + '\0' + fs.readFileSync(path.join(hooksLib, n))); } catch { return ''; }
  toolsOnce = h.digest('hex');
  return toolsOnce;
}

const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const topOf = (repo) => { const t = git(repo, ['rev-parse', '--show-toplevel']) || path.resolve(repo); return path.resolve(t).replace(/\\/g, '/').toLowerCase(); };
const storeFile = (kind, repo) => path.join(stateDir(), 'kept', `${kind}-${sha(topOf(repo)).slice(0, 16)}.json`);

/** The key of one result: the kind, the tree, the inputs and the tools. '' when the tree or the tools are unknown. */
export function keyOf(kind, tree, inputs) {
  const tools = toolsId();
  if (!tree || !tools) return '';
  return sha(JSON.stringify([kind, tree, inputs, tools]));
}

/** The kept value of `key`, or null: { value, at }. */
export function readKept(kind, repo, key) {
  if (!key) return null;
  try {
    const all = JSON.parse(fs.readFileSync(storeFile(kind, repo), 'utf8'));
    const hit = all && all.entries && all.entries[key];
    return hit && typeof hit === 'object' && 'value' in hit ? { value: hit.value, at: String(hit.at || '') } : null;
  } catch { return null; }
}

/** Keeps each [key, value] of `entries` only when the working folder is still `tree` (review, batch b: a file that changed
 *  while the work ran gives an answer of other code than the key's tree). `now`: the tree now (tests give their own).
 *  True when they were kept. */
export function keepIfSame(kind, repo, entries, tree, now = () => workTreeId(repo)) {
  if (!entries.length || !tree || now() !== tree) return false;
  for (const [key, value] of entries) writeKept(kind, repo, key, value);
  return true;
}

/** Keeps `value` under `key`; the oldest go past KEEP entries. A write that fails keeps nothing. */
export function writeKept(kind, repo, key, value) {
  if (!key) return;
  const file = storeFile(kind, repo);
  let all = { entries: {} };
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.entries === 'object' && j.entries) all = j; } catch { /* a new store */ }
  all.entries[key] = { value, at: new Date().toISOString() };
  const keys = Object.keys(all.entries).sort((a, b) => Date.parse(all.entries[a].at) - Date.parse(all.entries[b].at));
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all.entries[k];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, file);
  } catch { /* not kept: the next run does the work again */ }
}
